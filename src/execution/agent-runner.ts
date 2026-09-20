import type { z } from 'zod';
import type { AgentRole, ModelSelection } from '../types/model.js';

export type { AgentRole } from '../types/model.js';
export { classifyRunnerFailure, parseRetryAfter } from './failure-classification.js';

/** `read-only` agents inspect worktrees; `workspace-write` agents may write only inside the task directory. */
export type AgentAccess = 'read-only' | 'workspace-write';

export interface AgentUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface AgentRunRequest<T> {
  role: AgentRole;
  /** Chosen by deterministic routing, never by a model. */
  model: ModelSelection;
  prompt: string;
  /** Working root: the task directory that contains only the declared repository worktrees. */
  taskDirectory: string;
  access: AgentAccess;
  resultSchema: z.ZodType<T>;
  timeoutMs: number;
  signal: AbortSignal;
}

interface RunMetrics {
  usage: AgentUsage | null;
  durationMs: number;
}

export type AgentRunResult<T> = RunMetrics & (
  | { kind: 'completed'; output: T }
  /** The run finished but its final message is missing, oversized, not JSON, or fails the result schema. */
  | { kind: 'invalid-output'; message: string }
  | { kind: 'usage-limit'; message: string; retryAfter: Date | null }
  | { kind: 'rate-limit'; message: string; retryAfter: Date | null }
  | { kind: 'timeout'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string }
);

export type AgentRunKind = AgentRunResult<unknown>['kind'];

/** Port for model runners. Implementations must honour `access`, `timeoutMs`, and `signal`, and validate results. */
export interface AgentRunner {
  run<T>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>>;
}
