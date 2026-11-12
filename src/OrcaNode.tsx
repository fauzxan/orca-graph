import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { STATUS_LABEL, type GraphNode } from './types';

export type OrcaFlowNode = Node<GraphNode, 'orca'>;

const KIND_LABEL: Record<GraphNode['kind'], string> = {
  coordinator: 'Coordinator',
  worker: 'Worker',
  run: 'Run',
  session: 'Agent session',
};

function ago(ms: number | null): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function OrcaNode({ data }: NodeProps<OrcaFlowNode>) {
  const meta = [
    KIND_LABEL[data.kind],
    data.dispatches && `${data.dispatches.done}/${data.dispatches.total} tasks done`,
    ago(data.lastMessageAt),
  ].filter(Boolean);

  return (
    <div className={`card status-${data.status}`} title={data.lastMessageFull || data.name}>
      <Handle type="target" position={Position.Top} />
      <div className="card-head">
        <span className="name">{data.name}</span>
        <span className="pill">{STATUS_LABEL[data.status]}</span>
      </div>
      <div className="meta">{meta.join(' · ')}</div>
      <div className="message">{data.lastMessage || <em>No messages yet</em>}</div>
      <div className="runs" title={data.runs.join('\n')}>
        {data.runs[0] ?? (data.kind === 'session' ? 'Not in an orchestration run' : '')}
        {data.runs.length > 1 && ` +${data.runs.length - 1}`}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
