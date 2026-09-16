import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export interface DatabaseHandle {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
}

export function createDatabase(connectionString = process.env.DATABASE_URL): DatabaseHandle {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  return { db: drizzle(pool, { schema }), pool };
}
