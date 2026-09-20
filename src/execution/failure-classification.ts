/**
 * Classifies a provider failure message. Every adapter funnels exit messages through this so pause and retry behaviour is
 * identical whichever provider produced them.
 */

/** Parses a provider hint such as "try again in 12 minutes". */
export function parseRetryAfter(message: string, now: Date): Date | null {
  const match = /try again in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?/i.exec(message);
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) return null;
  const seconds = Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? new Date(now.getTime() + Math.ceil(seconds) * 1_000) : null;
}

export function classifyRunnerFailure(message: string): 'usage-limit' | 'rate-limit' | 'failed' {
  if (/usage limit|usage_limit|insufficient_quota|quota exceeded|exceeded your current quota|plan limit/i.test(message)) return 'usage-limit';
  if (/rate limit|rate_limit|too many requests|\b429\b/i.test(message)) return 'rate-limit';
  return 'failed';
}
