export type Status = 'done' | 'working' | 'idle' | 'input' | 'error' | 'offline';

// A type alias, not an interface: React Flow node data must fit Record<string, unknown>.
export type GraphNode = {
  id: string;
  kind: 'coordinator' | 'worker' | 'run' | 'session';
  name: string;
  runs: string[];
  status: Status;
  liveness?: string;
  dispatches?: { total: number; done: number };
  lastMessage: string;
  lastMessageFull: string;
  lastMessageAt: number | null;
  cleanup?: { allowed: boolean; reason: string | null; active: boolean; path: string };
};

export type CleanupMode = 'worktree' | 'worktree+transcripts';

export type Message = {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'result' | 'divider';
  text: string;
  name?: string;
  description?: string;
  error?: boolean;
  at?: number;
  // Mailbox messages shown in place of orca's "You have N orchestration messages" notice.
  from?: string;
  subject?: string;
};

export type SessionDetail = {
  ok: boolean;
  error?: string;
  id: string;
  kind: GraphNode['kind'];
  name: string;
  path?: string;
  messages: Message[];
  raw: string[];
  canSend: boolean;
  note?: string;
};

export type Orphan = {
  id: string;
  name: string;
  repo: string;
  path: string;
  branch: string;
  lastActivityAt: number | null;
  reason: string;
  outcome: string | null;
  runs: string[];
  tasks: number;
  lastMessage: string;
  uncommitted: number | null;
  cleanup: { allowed: boolean; reason: string | null; active: boolean; path: string };
};

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  count: number;
}

export interface Graph {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  orphans: Orphan[];
  errors: string[];
}

export const STATUS_LABEL: Record<Status, string> = {
  done: 'Done',
  working: 'Working',
  idle: 'Idle',
  input: 'Needs input',
  error: 'Error',
  offline: 'Offline',
};
