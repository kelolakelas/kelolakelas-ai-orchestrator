import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export function createDatabase(connectionString = process.env.DATABASE_URL): ReturnType<typeof drizzle> {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool);
}
