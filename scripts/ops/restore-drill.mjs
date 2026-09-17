import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { migrateDatabase } from '../migrations.mjs';
import { grantCredits, reserveFeatureCredits, settleFeatureCredits } from '@yuva/billing-core';

// This drill only creates/drops its own random schema; no user-supplied schema.
const url = new URL(process.env.TEST_DATABASE_URL || '');
if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Restore drill requires a loopback TEST_DATABASE_URL');
if (process.env.NODE_ENV === 'production') throw new Error('Restore drill is disabled in production');
const schema = 'restore_drill_' + randomUUID().replaceAll('-', '');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuva-restore-'));
const admin = new pg.Pool({ connectionString: url.toString() });
let db;
const started = Date.now();
function pgTool(tool, args, input) {
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1), PGOPTIONS: '' };
  const container = process.env.PG_TOOL_CONTAINER;
  const command = container ? 'docker' : path.join(process.env.PG_TOOLS_BIN || '', tool);
  const commandArgs = container ? ['exec', '-i', ...['PGUSER','PGPASSWORD','PGDATABASE'].flatMap((key) => ['-e', key]),
    '-e', 'PGHOST=127.0.0.1', '-e', 'PGPORT=5432', container, tool, ...args] : args;
  try { return execFileSync(command, commandArgs, { env, input, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe','pipe','pipe'] }); }
  catch { throw new Error(`${tool} failed; check local PostgreSQL client/container version and test connectivity`); }
}
async function snapshot() {
  const names = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema])).rows.map((r) => r.tablename);
  const content = {};
  for (const name of names) {
    if (!/^[a-z_]+$/u.test(name)) throw new Error('Unexpected drill table name');
    const rows = (await db.query(`SELECT to_jsonb(t) AS data FROM ${schema}.${name} t`)).rows.map((r) => JSON.stringify(r.data)).sort();
    content[name] = rows;
  }
  return { tables: names.length, sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  db = new pg.Pool({ connectionString: url.toString() });
  await migrateDatabase(db);
  const accountId = randomUUID();
  await db.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [accountId, 'Synthetic restore fixture']);
  await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
  const reservation = await reserveFeatureCredits({ db, userId: accountId, featureKey: 'restore', clientRequestId: randomUUID(), credits: 2 });
  await settleFeatureCredits({ db, userId: accountId, requestId: reservation.request.id, creditsUsed: 2 });
  const before = await snapshot();
  const backup = pgTool('pg_dump', ['--format=custom','--no-owner','--no-acl',`--schema=${schema}`]);
  await fs.writeFile(path.join(temporary, 'fixture.dump'), backup, { mode: 0o600 });
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  pgTool('pg_restore', ['--dbname', url.pathname.slice(1), '--no-owner','--no-acl','--exit-on-error'], backup);
  const after = await snapshot();
  if (before.sha256 !== after.sha256) throw new Error('Restored financial/identity/schema data differs');
  await migrateDatabase(db);
  const report = { verifiedAt: new Date().toISOString(), fixture: 'synthetic ledger and migration schema', client: pgTool('pg_dump', ['--version']).toString().trim(),
    tables: after.tables, backupBytes: backup.length, restoredContentSha256: after.sha256, exactDataMatch: true, migrationRecheck: 'passed', durationMs: Date.now()-started,
    productionEvidence: false };
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await db?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await fs.rm(temporary,{recursive:true,force:true});
}
