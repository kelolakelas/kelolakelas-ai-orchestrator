import { loadConfig } from '../config/config.js';
import { checkCredentials } from './credential-check.js';

/**
 * Usage: ORCHESTRATOR_CONFIG=... node dist/src/ops/check-credentials.js
 * Reads GITHUB_TOKEN and LINEAR_API_KEY. Prints one JSON line per check and exits 1 when any check fails.
 * Never prints a credential.
 */
const config = await loadConfig(process.env.ORCHESTRATOR_CONFIG ?? './orchestrator.config.example.yaml');
const results = await checkCredentials({ config, githubToken: process.env.GITHUB_TOKEN, linearApiKey: process.env.LINEAR_API_KEY });
for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.some((result) => result.status === 'fail') ? 1 : 0;
