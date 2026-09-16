import { restoreDatabase } from './database-backup.js';

/**
 * Usage: node dist/src/ops/restore.js <dump>
 * Reads RESTORE_DATABASE_URL, which must name a new, empty database. Never point it at the live database.
 */
const [dumpPath] = process.argv.slice(2);
const targetDatabaseUrl = process.env.RESTORE_DATABASE_URL;
if (dumpPath === undefined || targetDatabaseUrl === undefined) {
  console.error('Usage: RESTORE_DATABASE_URL=... restore <dump>');
  process.exit(2);
}
try {
  const { manifest, restored } = await restoreDatabase({ dumpPath, targetDatabaseUrl });
  console.log(JSON.stringify({ backup: { file: manifest.file, createdAt: manifest.createdAt, rowCounts: manifest.rowCounts }, restored }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
