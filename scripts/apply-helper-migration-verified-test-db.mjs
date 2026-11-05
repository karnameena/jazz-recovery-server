import fs from 'node:fs';
import pg from 'pg';

const migrationPath = process.argv[2];
const expectedHostPrefix = 'ep-flat-violet-b59l3i5r';
const expectedDatabase = 'jazz_recovery_test';
const engine = String(process.env.JAZZ_DB_ENGINE || '').toLowerCase();
const connectionString = process.env.DATABASE_URL || process.env.JAZZ_DATABASE_URL || process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL || '';

if (engine !== 'postgres' || !connectionString || !migrationPath || !fs.existsSync(migrationPath)) {
  console.log('MIGRATION_SKIPPED: PostgreSQL engine, recognized connection URL, or migration file is missing.');
  process.exit(20);
}

let url;
try { url = new URL(connectionString); } catch {
  console.log('MIGRATION_SKIPPED: configured database URL is not a valid URL.');
  process.exit(20);
}
const dbFromUrl = decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!url.hostname.startsWith(expectedHostPrefix) || dbFromUrl !== expectedDatabase) {
  console.log('MIGRATION_SKIPPED: URL does not match the isolated Jazz Recovery test host/database.');
  process.exit(21);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  const identity = await client.query('SELECT current_database() AS db');
  if (identity.rows[0]?.db !== expectedDatabase) {
    console.log('MIGRATION_SKIPPED: connected database identity did not match the isolated test database.');
    process.exitCode = 21;
  } else {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`MIGRATION_APPLIED: verified ${expectedDatabase} on approved test host.`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`MIGRATION_FAILED: ${error?.code || 'database error'}; transaction rolled back.`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`MIGRATION_SKIPPED: database connection/verification failed (${error?.code || 'connection error'}); no SQL was applied unless transaction had started after verification.`);
  process.exitCode = 22;
} finally {
  try { await client.end(); } catch { }
}
