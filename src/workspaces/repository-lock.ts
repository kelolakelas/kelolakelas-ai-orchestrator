import type pg from 'pg';

/** Serializes Git mutations of one local repository across tasks and processes. */
export interface RepositoryLock {
  withLock<T>(repository: string, operation: () => Promise<T>): Promise<T>;
}

export class RepositoryLockTimeoutError extends Error {
  constructor(repository: string) {
    super(`Timed out waiting for repository lock: ${repository}`);
    this.name = 'RepositoryLockTimeoutError';
  }
}

/**
 * PostgreSQL session advisory lock held on a dedicated connection for the duration of the operation. If the
 * connection is lost, PostgreSQL releases the lock with the session.
 */
export class PostgresRepositoryLock implements RepositoryLock {
  constructor(
    private readonly pool: pg.Pool,
    private readonly timeoutMs: number,
    private readonly pollIntervalMs = 250,
  ) {}

  async withLock<T>(repository: string, operation: () => Promise<T>): Promise<T> {
    const key = `kelolakelas.ai-orchestrator.repository:${repository}`;
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      const deadline = Date.now() + this.timeoutMs;
      for (;;) {
        const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
        if (result.rows[0]?.locked) break;
        if (Date.now() >= deadline) throw new RepositoryLockTimeoutError(repository);
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
      try {
        return await operation();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        } catch (error) {
          // Destroying the connection ends the session, which releases the lock.
          releaseError = error instanceof Error ? error : new Error('Failed to release repository lock');
        }
      }
    } finally {
      client.release(releaseError);
    }
  }
}

/** Single-process lock for tests and tools that do not share a database. */
export class InProcessRepositoryLock implements RepositoryLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async withLock<T>(repository: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(repository) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    this.tails.set(repository, run);
    try {
      return await run;
    } finally {
      if (this.tails.get(repository) === run) this.tails.delete(repository);
    }
  }
}
