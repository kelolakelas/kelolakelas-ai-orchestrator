import type { AgentRunRequest, AgentRunner, AgentRunResult } from './agent-runner.js';
import type { ProviderRegistry } from './provider-registry.js';

/**
 * Dispatches each run to the adapter of the provider the routing selected. Stages depend only on this port, so which
 * provider serves a role is a configuration fact rather than a code path: a stage cannot tell providers apart, and a
 * request always reaches the adapter the router named.
 */
export class DispatchingAgentRunner implements AgentRunner {
  constructor(private readonly registry: ProviderRegistry) {}

  async run<T>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    const handle = this.registry.forSelection(request.model);
    if (handle === undefined) {
      return {
        kind: 'failed',
        message: `No provider serves model selection ${request.model.provider}/${request.model.tier} (${request.model.model})`,
        usage: null,
        durationMs: 0,
      };
    }
    return handle.runner.run(request);
  }
}
