import type pg from 'pg';

/**
 * Empties orchestrator tables between integration tests. DELETE is used instead of TRUNCATE because TRUNCATE fsyncs a
 * new relation file per table, which can exceed test timeouts on a busy disk.
 */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DELETE FROM operator_actions; DELETE FROM state_transitions; DELETE FROM task_checkpoints; DELETE FROM task_attempts;
    DELETE FROM external_operations; DELETE FROM task_dependencies; DELETE FROM task_work_units; DELETE FROM tasks;
    DELETE FROM intake_quarantines;
    UPDATE orchestrator_controls SET pause_new_work = false, schedule_override = 'normal', kill_switch = false;
  `);
}
