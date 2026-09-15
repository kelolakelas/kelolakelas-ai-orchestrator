import { loadConfig } from './config/config.js';

const configPath = process.env.ORCHESTRATOR_CONFIG ?? './orchestrator.config.example.yaml';

async function main(): Promise<void> {
  const config = await loadConfig(configPath);
  console.log(JSON.stringify({ event: 'configuration_validated', timezone: config.timezone }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
