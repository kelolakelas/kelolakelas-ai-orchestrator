import pino, { type LoggerOptions } from 'pino';

export const loggerOptions: LoggerOptions = {
  redact: {
    paths: [
      'apiKey',
      'authorization',
      'cookie',
      'password',
      'token',
      'databaseUrl',
      'headers.authorization',
      'headers.cookie',
      'headers.x-api-key',
      'environment.DATABASE_URL',
      'environment.LINEAR_API_KEY',
      'environment.OPENAI_API_KEY',
      'environment.ORCHESTRATOR_OPERATOR_TOKEN',
    ],
    censor: '[REDACTED]',
  },
};

export function createLogger() {
  return pino(loggerOptions);
}