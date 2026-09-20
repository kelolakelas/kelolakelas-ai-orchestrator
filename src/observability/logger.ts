import pino, { type LoggerOptions } from 'pino';
import { allCredentialEnvironment } from '../security/credentials.js';

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
      // Every credential name the orchestrator knows, so a newly configured provider is redacted without a code change.
      ...allCredentialEnvironment.map((name) => `environment.${name}`),
      ...allCredentialEnvironment.map((name) => `env.${name}`),
    ],
    censor: '[REDACTED]',
  },
};

export function createLogger() {
  return pino(loggerOptions);
}