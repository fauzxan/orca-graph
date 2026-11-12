import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow, useReactFlow, type Edge } from '@xyflow/react';
import { CleanupDialog, type CleanupRequest } from './CleanupDialog';
import { ContextMenu, type MenuState } from './ContextMenu';
import { layout } from './layout';
import { OrcaNode, type OrcaFlowNode } from './OrcaNode';
import { OrphansMenu } from './OrphansMenu';
import { OrphansPage } from './OrphansPage';
import { RefreshControl } from './RefreshControl';
import { usePollSeconds } from './settings';
import { SidePane } from './SidePane';
import { STATUS_LABEL, type Graph, type Status } from './types';

const nodeTypes = { orca: OrcaNode };
const LEGEND: Status[] = ['done', 'working', 'idle', 'input', 'error', 'offline'];
const ORPHANS_PATH = '/orphans';

function useGraph(pollMs: number) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // Polls start every pollMs, counted from the previous start. A slow poll is never overlapped:
    // the next one starts as soon as it finishes.
    const poll = async () => {
      clearTimeout(timer);
      const started = Date.now();
      try {
        const res = await fetch('/api/graph', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next: Graph = await res.json();
        if (!cancelled) {
          setGraph(next);
          setFetchError(null);
        }
      } catch (e) {
        if (!cancelled) setFetchError(`Can't reach the orca-graph server: ${String(e)}`);
      } finally {
        if (!cancelled) timer = setTimeout(poll, Math.max(0, pollMs - (Date.now() - started)));
      }
    };
    kick.current = poll;
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollMs]);

  const refresh = useCallback(() => kick.current(), []);
  return { graph, fetchError, refresh };
}

// Two views on one page, switched with the browser's history so Back works.
function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState(null, '', to);
    setPath(to);
  }, []);
  return [path, go] as const;
}

function GraphView({
  graph,
  pollMs,
  onCleanup,
}: {
  graph: Graph | null;
  pollMs: number;
  onCleanup: (req: NonNullable<CleanupRequest>) => void;
}) {
  const { fitView } = useReactFlow();
  const shape = useRef('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);

  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;

  // Close the pane when its session disappears, for example after the agent exits.
  useEffect(() => {
    if (graph && selectedId && !selected) setSelectedId(null);
  }, [graph, selectedId, selected]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as OrcaFlowNode[], edges: [] as Edge[] };
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.count > 1 ? `${e.count} tasks` : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `edge-${graph.nodes.find((n) => n.id === e.target)?.status ?? 'offline'}`,
    }));
    const nodes: OrcaFlowNode[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'orca',
      data: n,
      position: { x: 0, y: 0 },
      draggable: false,
      selected: n.id === selectedId,
    }));
    return { nodes: layout(nodes, edges), edges };
  }, [graph, selectedId]);

  // Refit only when the set of sessions changes, so a poll doesn't undo the user's pan and zoom.
  useEffect(() => {
    const next = nodes.map((n) => n.id).sort().join('|');
    if (next && next !== shape.current) {
      shape.current = next;
      requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }));
    }
  }, [nodes, fitView]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closePane = useCallback(() => setSelectedId(null), []);

  return (
    <main>
      <div className="canvas">
        {graph && graph.nodes.length === 0 ? (
          <div className="empty">No open agents in orca.</div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesConnectable={false}
            minZoom={0.2}
            onNodeClick={(_, n) => {
              setMenu(null);
              setSelectedId(n.id);
            }}
            onNodeContextMenu={(e, n) => {
              e.preventDefault();
              setMenu({ node: n.data, x: e.clientX, y: e.clientY });
            }}
            onPaneClick={() => setMenu(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
      {selected && <SidePane node={selected} pollMs={pollMs} onClose={closePane} />}
      <ContextMenu
        menu={menu}
        onClose={closeMenu}
        onOpen={(node) => {
          setMenu(null);
          setSelectedId(node.id);
        }}
        onPick={(node, mode) => {
          setMenu(null);
          onCleanup({ targets: [node], mode });
        }}
      />
    </main>
  );
}

export function App() {
  const [pollSeconds, setPollSeconds] = usePollSeconds();
  const pollMs = pollSeconds * 1000;
  const { graph, fetchError, refresh } = useGraph(pollMs);
  const { fitView } = useReactFlow();
  const [path, go] = usePath();
  const [cleanupRequest, setCleanupRequest] = useState<CleanupRequest>(null);
  const [toast, setToast] = useState<string | null>(null);
  const onOrphansPage = path === ORPHANS_PATH;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const counts = useMemo(() => {
    const c: Partial<Record<Status, number>> = {};
    graph?.nodes.forEach((n) => (c[n.status] = (c[n.status] ?? 0) + 1));
    return c;
  }, [graph]);

  const errors = [fetchError, ...(graph?.errors ?? [])].filter(Boolean) as string[];
  const orphans = graph?.orphans ?? [];

  return (
    <div className="app">
      <header>
        <h1>
          <button className="title-link" onClick={() => go('/')}>
            Orca Graph
          </button>
        </h1>
        {!onOrphansPage && (
          <div className="legend">
            {LEGEND.map((s) => (
              <span key={s} className={`legend-item status-${s}`}>
                <i />
                {STATUS_LABEL[s]} {counts[s] ?? 0}
              </span>
            ))}
          </div>
        )}
        <div className="updated">
          <OrphansMenu orphans={orphans} onOpenPage={() => go(ORPHANS_PATH)} />
          <span>{graph ? `Updated ${new Date(graph.generatedAt).toLocaleTimeString()}` : 'Loading…'}</span>
          <RefreshControl seconds={pollSeconds} onChange={setPollSeconds} />
          {!onOrphansPage && <button onClick={() => fitView({ padding: 0.15, duration: 300 })}>Fit</button>}
        </div>
      </header>
      {errors.length > 0 && (
        <div className="errors">
          {errors.slice(0, 3).map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      {onOrphansPage ? (
        <OrphansPage orphans={orphans} loading={!graph} onBack={() => go('/')} onCleanup={setCleanupRequest} />
      ) : (
        <GraphView graph={graph} pollMs={pollMs} onCleanup={setCleanupRequest} />
      )}

      <CleanupDialog
        request={cleanupRequest}
        onClose={() => setCleanupRequest(null)}
        onDone={(outcomes) => {
          const ok = outcomes.filter((o) => o.result.ok).length;
          setToast(ok === outcomes.length ? `Cleaned up ${ok} worker${ok > 1 ? 's' : ''}.` : `Cleaned up ${ok} of ${outcomes.length}. See the dialog for errors.`);
          refresh();
        }}
      />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
