import type { CircuitBreakerConfig } from '../config/schema.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitEvents {
  /** Called on every state change; `openUntil` is set while the circuit is open. */
  onStateChange?(state: CircuitState, openUntil: Date | null): void;
  /** Called once per call: `ok`, `failure` (counted), `error` (not counted), or `rejected` (short-circuited). */
  onCall?(result: 'ok' | 'failure' | 'error' | 'rejected'): void;
}

/** A call refused without contacting the provider because its circuit is open. */
export class CircuitOpenError extends Error {
  constructor(public readonly provider: string, public readonly retryAfter: Date) {
    super(`${provider} circuit open until ${retryAfter.toISOString()}`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Consecutive-failure circuit breaker for one provider. After `failureThreshold` counted failures, calls are rejected
 * for `openSeconds`; then a single probe is allowed, and its result closes or re-opens the circuit. A provider hint such
 * as a rate-limit reset can open the circuit until that time immediately. State is per process: each worker protects
 * itself, and every rejected call surfaces as a retryable wait, never as a task failure.
 */
export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = 'closed';
  private openUntil: Date | null = null;
  private probeInFlight = false;

  constructor(
    public readonly provider: string,
    private readonly config: CircuitBreakerConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly events: CircuitEvents = {},
  ) {}

  status(): { state: CircuitState; openUntil: Date | null; consecutiveFailures: number } {
    this.refresh();
    return { state: this.state, openUntil: this.openUntil, consecutiveFailures: this.failures };
  }

  /**
   * Runs `operation` unless the circuit is open. `classify` decides whether an error counts toward opening the circuit
   * and may return a time until which the provider asked callers to wait.
   */
  async execute<T>(operation: () => Promise<T>, classify: (error: unknown) => { counted: boolean; retryAfter?: Date | null }): Promise<T> {
    this.refresh();
    if (this.state === 'open' || (this.state === 'half-open' && this.probeInFlight)) {
      this.events.onCall?.('rejected');
      throw new CircuitOpenError(this.provider, this.openUntil ?? new Date(this.clock().getTime() + this.config.openSeconds * 1_000));
    }
    const probe = this.state === 'half-open';
    if (probe) this.probeInFlight = true;
    try {
      const result = await operation();
      this.failures = 0;
      if (this.state !== 'closed') this.transition('closed', null);
      this.events.onCall?.('ok');
      return result;
    } catch (error) {
      const { counted, retryAfter } = classify(error);
      this.events.onCall?.(counted ? 'failure' : 'error');
      if (counted) {
        this.failures += 1;
        const hinted = retryAfter !== undefined && retryAfter !== null && retryAfter > this.clock() ? retryAfter : null;
        if (probe || hinted !== null || this.failures >= this.config.failureThreshold) {
          const cooldown = new Date(this.clock().getTime() + this.config.openSeconds * 1_000);
          this.transition('open', hinted !== null && hinted > cooldown ? hinted : hinted ?? cooldown);
        }
      } else if (probe) {
        // The provider answered; an uncounted error such as a rejected request proves it is reachable.
        this.failures = 0;
        this.transition('closed', null);
      }
      throw error;
    } finally {
      if (probe) this.probeInFlight = false;
    }
  }

  private refresh(): void {
    if (this.state === 'open' && this.openUntil !== null && this.clock() >= this.openUntil) this.transition('half-open', null);
  }

  private transition(state: CircuitState, openUntil: Date | null): void {
    this.state = state;
    this.openUntil = openUntil;
    this.events.onStateChange?.(state, openUntil);
  }
}
