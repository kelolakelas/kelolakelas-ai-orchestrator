import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { tasks } from '../db/schema.js';

export class TaskRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async claimNextQueuedTask(): Promise<typeof tasks.$inferSelect | undefined> {
    return this.db.transaction(async (transaction) => {
      const candidates = await transaction
        .select()
        .from(tasks)
        .where(eq(tasks.state, 'QUEUED'))
        .limit(1)
        .for('update', { skipLocked: true });
      const task = candidates[0];
      if (!task) return undefined;

      const claimed = await transaction
        .update(tasks)
        .set({ state: 'ANALYZING', updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), inArray(tasks.state, ['QUEUED'])))
        .returning();
      return claimed[0];
    });
  }
}
