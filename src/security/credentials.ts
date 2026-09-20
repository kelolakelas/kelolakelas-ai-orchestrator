/**
 * Every credential name this orchestrator knows about, in one place, so adding a provider never means remembering to
 * update a logger, a secret detector, and a validation list separately.
 */

/** Orchestrator credentials that must never reach an agent or a repository command. */
export const withheldEnvironment = ['DATABASE_URL', 'LINEAR_API_KEY', 'ORCHESTRATOR_OPERATOR_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;

/**
 * Credential variable names that identify a model provider. Repository setup and check commands execute code written by
 * a model, so they never receive any of these, whichever provider is configured.
 */
export const providerCredentialEnvironment = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'TOGETHER_API_KEY',
  'PERPLEXITY_API_KEY',
] as const;

/** Every name that must be redacted from logs and stripped from untrusted command environments. */
export const allCredentialEnvironment: readonly string[] = [...withheldEnvironment, ...providerCredentialEnvironment];

/**
 * Credential shapes worth detecting without a configured provider: a leaked token in model output must be caught even
 * when the provider it belongs to is not configured here.
 */
export const providerCredentialPatterns: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'openai-api-key', pattern: /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { rule: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { rule: 'xai-api-key', pattern: /\bxai-[A-Za-z0-9]{20,}\b/ },
  { rule: 'groq-api-key', pattern: /\bgsk_[A-Za-z0-9]{20,}\b/ },
  { rule: 'openrouter-api-key', pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/ },
];
