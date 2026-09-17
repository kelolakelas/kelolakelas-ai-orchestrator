import { backupDatabase } from './database-backup.js';

/**
 * Usage: node dist/src/ops/backup.js <directory> [keepDays]
 * Reads DATABASE_URL. Prints the manifest as JSON.
 */
const [directory, keepDays] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (directory === undefined || databaseUrl === undefined) {
  console.error('Usage: DATABASE_URL=... backup <directory> [keepDays]');
  process.exit(2);
}
try {
  const manifest = await backupDatabase({ databaseUrl, directory, ...(keepDays === undefined ? {} : { keepDays: Number(keepDays) }) });
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
