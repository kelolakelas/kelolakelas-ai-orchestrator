import type { AgentUsage } from '../agent-runner.js';

/**
 * Codex's JSONL event stream, as `codex exec --json` writes it. Codex vocabulary lives only here and in the argv the
 * adapter builds, so adding another provider never means editing this file.
 */
interface CodexEvent {
  type?: unknown;
  usage?: unknown;
  message?: unknown;
  error?: unknown;
}

/** Parses one JSON event line. Codex also prints human-readable progress, which is not JSON and is ignored. */
export function parseCodexEvent(line: string): CodexEvent | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? value as CodexEvent : undefined;
  } catch {
    return undefined;
  }
}

/** Failure text Codex reports in the stream, when an event carries any. */
export function codexEventError(event: CodexEvent): string | undefined {
  if (event.type === 'error' && typeof event.message === 'string') return event.message;
  if (event.type === 'turn.failed' && event.error !== null && typeof event.error === 'object') {
    const message = (event.error as { message?: unknown }).message;
    return typeof message === 'string' ? message : 'turn failed';
  }
  return undefined;
}

/**
 * Adds the cumulative token counts Codex reports per turn. Every field is optional, so an absent one counts as zero
 * rather than making the whole event unusable.
 */
export function addCodexUsage(current: AgentUsage | null, raw: unknown): AgentUsage | null {
  if (raw === null || typeof raw !== 'object') return current;
  const value = raw as Record<string, unknown>;
  const read = (key: string) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : 0);
  const base = current ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  return {
    inputTokens: base.inputTokens + read('input_tokens'),
    cachedInputTokens: base.cachedInputTokens + read('cached_input_tokens'),
    outputTokens: base.outputTokens + read('output_tokens'),
    reasoningOutputTokens: base.reasoningOutputTokens + read('reasoning_output_tokens'),
  };
}
