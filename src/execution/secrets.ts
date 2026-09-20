import { providerCredentialPatterns } from '../security/credentials.js';

export interface SecretRule {
  rule: string;
  pattern: RegExp;
}

/**
 * Credential formats that must never be committed or persisted as evidence. Provider token shapes come from
 * `security/credentials.ts`, so a provider added there is redacted here without a second edit.
 */
export const secretRules: readonly SecretRule[] = [
  { rule: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { rule: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { rule: 'linear-api-key', pattern: /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}\b/ },
  { rule: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'stripe-live-key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  ...providerCredentialPatterns,
  { rule: 'credential-assignment', pattern: /(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{24,}["']/i },
];

const secretVariableName = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL)/i;
const minimumSecretLength = 8;

/**
 * Values of credentials present in the orchestrator environment. They are matched literally in commits and evidence,
 * which catches secrets whose format no rule describes.
 */
export function collectKnownSecrets(environment: NodeJS.ProcessEnv): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value.length < minimumSecretLength || !secretVariableName.test(name)) continue;
    secrets.add(value);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const password = decodeURIComponent(new URL(value).password);
        if (password.length >= minimumSecretLength) secrets.add(password);
      } catch {
        // Not a parseable URL.
      }
    }
  }
  return [...secrets];
}

/** Names of rules matched by a line, plus `known-secret` for a literal orchestrator credential. Never the value. */
export function detectSecrets(text: string, knownSecrets: readonly string[]): string[] {
  const rules = secretRules.filter(({ pattern }) => pattern.test(text)).map(({ rule }) => rule);
  if (knownSecrets.some((secret) => text.includes(secret))) rules.push('known-secret');
  return rules;
}

/** Replaces credentials in untrusted text, such as command output, before it is logged, persisted, or prompted. */
export function redactSecrets(text: string, knownSecrets: readonly string[]): string {
  let redacted = text;
  // Longer values first so a secret containing another is replaced whole.
  for (const secret of [...knownSecrets].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  for (const { pattern } of secretRules) {
    redacted = redacted.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[REDACTED]');
  }
  return redacted;
}
