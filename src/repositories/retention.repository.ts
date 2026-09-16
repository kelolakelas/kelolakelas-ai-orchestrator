import { sql } from 'drizzle-orm';
import type { Database } from './task.repository.js';

export interface RetentionResult {
  attemptEvidence: number;
  checkpoints: number;
  quarantines: number;
}

/**
 * Removes bulky operational artifacts that no workflow can use again. Only tasks in terminal states (`COMPLETED`,
 * `CANCELLED`) lose attempt evidence and checkpoint payloads; `BLOCKED` and `FAILED` tasks can be retried and keep
 * everything. Tasks, transitions, attempts (inputs, results, usage, failure categories), external operations, and
 * operator actions are the audit record and are never removed here.
 */
export class RetentionRepository {
  constructor(private readonly db: Database) {}

  async prune(input: { terminalBefore: Date; quarantineBefore: Date }): Promise<RetentionResult> {
    return this.db.transaction(async (transaction) => {
      const evidence = await transaction.execute(sql`
        update task_attempts a set evidence = null
        from tasks t
        where t.id = a.task_id and t.state in ('COMPLETED', 'CANCELLED') and t.updated_at < ${input.terminalBefore}::timestamptz
          and a.evidence is not null`);
      const checkpoints = await transaction.execute(sql`
        delete from task_checkpoints c using tasks t
        where t.id = c.task_id and t.state in ('COMPLETED', 'CANCELLED') and t.updated_at < ${input.terminalBefore}::timestamptz`);
      const quarantines = await transaction.execute(sql`delete from intake_quarantines where last_seen_at < ${input.quarantineBefore}::timestamptz`);
      return { attemptEvidence: evidence.rowCount ?? 0, checkpoints: checkpoints.rowCount ?? 0, quarantines: quarantines.rowCount ?? 0 };
    });
  }
}
