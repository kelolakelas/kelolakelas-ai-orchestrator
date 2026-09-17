import { sql } from 'drizzle-orm';
import type { TaskState } from '../types/domain.js';
import type { Database } from './task.repository.js';

export interface OperationalSnapshot {
  tasksByState: Array<{ state: TaskState; tasks: number; oldestStateAgeSeconds: number }>;
  staleLeases: number;
  manualIntervention: number;
  quarantined: number;
  attempts: Array<{ stage: TaskState; category: string; attempts: number }>;
  tokens: Array<{ model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }>;
  workUnitsAwaitingMerge: number;
}

const num = (value: unknown) => Number(value ?? 0);

/** Aggregates for metrics. Queries return counts and ages only, never task, issue, or pull request identifiers. */
export class MetricsRepository {
  constructor(private readonly db: Database) {}

  async snapshot(now = new Date()): Promise<OperationalSnapshot> {
    const states = await this.db.execute<{ state: TaskState; tasks: string; oldest: string | null }>(sql`
      select t.state, count(*) as tasks,
        max(extract(epoch from (${now}::timestamptz - coalesce(entered.at, t.created_at)))) as oldest
      from tasks t
      left join lateral (
        select max(st.created_at) as at from state_transitions st where st.task_id = t.id and st.to_state = t.state
      ) entered on true
      group by t.state`);
    const leases = await this.db.execute<{ stale: string; manual: string }>(sql`
      select count(*) filter (where lease_owner is not null and lease_expires_at < ${now}::timestamptz) as stale,
        count(*) filter (where requires_manual_intervention and state not in ('COMPLETED', 'CANCELLED')) as manual
      from tasks`);
    const quarantined = await this.db.execute<{ total: string }>(sql`select count(*) as total from intake_quarantines`);
    const attempts = await this.db.execute<{ stage: TaskState; category: string; attempts: string }>(sql`
      select stage, coalesce(failure_category, case when completed_at is null then 'in_progress' else 'succeeded' end) as category,
        count(*) as attempts
      from task_attempts group by 1, 2`);
    const tokens = await this.db.execute<{ model: string; input: string; cached: string; output: string; reasoning: string }>(sql`
      select coalesce(input -> 'model' ->> 'model', 'unknown') as model,
        sum(coalesce((usage ->> 'inputTokens')::numeric, 0)) as input,
        sum(coalesce((usage ->> 'cachedInputTokens')::numeric, 0)) as cached,
        sum(coalesce((usage ->> 'outputTokens')::numeric, 0)) as output,
        sum(coalesce((usage ->> 'reasoningOutputTokens')::numeric, 0)) as reasoning
      from task_attempts where usage is not null group by 1`);
    const awaitingMerge = await this.db.execute<{ total: string }>(sql`
      select count(*) as total from task_work_units wu join tasks t on t.id = wu.task_id
      where wu.pull_request_number is not null and wu.merge_commit is null and t.state in ('PR_CREATED', 'WAITING_CI', 'READY_FOR_HUMAN_REVIEW')`);

    return {
      tasksByState: states.rows.map((row) => ({ state: row.state, tasks: num(row.tasks), oldestStateAgeSeconds: Math.max(0, num(row.oldest)) })),
      staleLeases: num(leases.rows[0]?.stale),
      manualIntervention: num(leases.rows[0]?.manual),
      quarantined: num(quarantined.rows[0]?.total),
      attempts: attempts.rows.map((row) => ({ stage: row.stage, category: row.category, attempts: num(row.attempts) })),
      tokens: tokens.rows.map((row) => ({
        model: row.model,
        inputTokens: num(row.input),
        cachedInputTokens: num(row.cached),
        outputTokens: num(row.output),
        reasoningOutputTokens: num(row.reasoning),
      })),
      workUnitsAwaitingMerge: num(awaitingMerge.rows[0]?.total),
    };
  }
}
