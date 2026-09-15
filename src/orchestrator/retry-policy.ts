import type { OrchestratorConfig } from '../config/schema.js';

export type RetryKind = 'implementation' | 'qualityFix' | 'review';

export function canRetry(config: OrchestratorConfig, kind: RetryKind, attempts: number): boolean {
  const limit = kind === 'implementation'
    ? config.limits.maxImplementationAttempts
    : kind === 'qualityFix'
      ? config.limits.maxQualityFixAttempts
      : config.limits.maxReviewCycles;
  return attempts < limit;
}
