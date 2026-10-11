import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../scripts/migrations.mjs';
import { isolatedDatabase, prepareTestDatabase } from './helpers/database.js';

describe('database-wide migration coordination (real PostgreSQL)', () => {
  let admin, database, url, pools;
  beforeEach(async () => {
    const source = process.env.TEST_DATABASE_URL || 'postgresql://ziwei:changeme_in_production@localhost:45432/ziwei';
    admin = new pg.Pool({ connectionString: source });
    database = `test_migrations_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${database}`);
    url = new URL(source); url.pathname = `/${database}`; url.searchParams.delete('options');
    pools = [];
  });
  afterEach(async () => {
    await Promise.all((pools || []).map((pool) => pool.end()));
    if (database) await admin.query(`DROP DATABASE ${database}`);
    await admin?.end();
  });
  function pool(schema = 'public') {
    const scoped = new URL(url); scoped.searchParams.set('options', `-csearch_path=${schema},public -cstatement_timeout=10000`);
    const result = new pg.Pool({ connectionString: scoped.toString(), max: 1 }); pools.push(result); return result;
  }
  async function applications(count) {
    const owner = pool();
    const names = Array.from({ length: count }, (_, index) => `app_${index}`);
    for (const name of names) await owner.query(`CREATE SCHEMA ${name}`);
    return names.map((name) => pool(name));
  }
  const extension = async (db) => (await db.query(`SELECT e.oid,n.nspname FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'`)).rows;

  it('serializes fresh cross-schema migrations and retains extension identity on concurrent replay', async () => {
    const apps = await applications(6);
    await Promise.all(apps.map((db) => migrateDatabase(db)));
    const original = await extension(apps[0]);
    expect(original).toHaveLength(1); expect(original[0].nspname).toMatch(/^app_[0-5]$/u);
    const snapshots = await Promise.all(apps.map(async (db) => (await db.query('SELECT version,name,checksum FROM starter_migrations ORDER BY version')).rows));
    expect(snapshots.every((rows) => rows.length === 7)).toBe(true);
    await Promise.all(apps.map((db) => migrateDatabase(db)));
    expect(await extension(apps[0])).toEqual(original);
    for (const [index, db] of apps.entries()) {
      expect((await db.query('SELECT version,name,checksum FROM starter_migrations ORDER BY version')).rows).toEqual(snapshots[index]);
    }
  }, 30000);

  it('does not relocate an existing extension from its custom schema', async () => {
    const owner = pool();
    await owner.query('CREATE SCHEMA existing_extensions');
    await owner.query('CREATE EXTENSION pgcrypto WITH SCHEMA existing_extensions');
    const original = await extension(owner);
    const apps = await applications(2);
    await Promise.all(apps.map((db) => migrateDatabase(db)));
    expect(await extension(owner)).toEqual(original);
    expect(original[0].nspname).toBe('existing_extensions');
  }, 30000);

  it('prepares the shared extension before parallel raw-schema and database-CLI fixtures', async () => {
    const apps = await applications(2);
    const schemaSql = await readFile(new URL('../../scripts/schema.sql', import.meta.url), 'utf8');
    await Promise.all([
      (async () => { await prepareTestDatabase(pool()); await apps[0].query(schemaSql); })(),
      (async () => {
        await prepareTestDatabase(pool());
        await promisify(execFile)(process.execPath, ['scripts/database.mjs', 'migrate'], {
          cwd: new URL('../../', import.meta.url),
          env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: apps[1].options.connectionString }, timeout: 20000,
        });
      })(),
    ]);
    const original = await extension(apps[1]);
    expect(original).toHaveLength(1); expect(original[0].nspname).toBe('public');
    await apps[0].query('DROP SCHEMA app_0 CASCADE');
    expect(await extension(apps[1])).toEqual(original);
    expect((await apps[1].query('SELECT count(*)::int AS count FROM starter_migrations')).rows[0].count).toBe(7);
  }, 30000);

  it('rolls back failed setup and releases its connection and transaction lock for retry', async () => {
    const [db] = await applications(1);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'starter-migration-failure-'));
    try {
      await writeFile(path.join(directory, '002-failure.sql'), 'SELECT missing_migration_fixture_function();');
      await expect(migrateDatabase(db, { directory })).rejects.toMatchObject({ code: '42883' });
      expect(await extension(db)).toHaveLength(0);
      expect((await db.query("SELECT to_regclass('app_0.starter_migrations') AS name")).rows[0].name).toBeNull();
      await migrateDatabase(db);
      expect((await db.query('SELECT count(*)::int AS count FROM starter_migrations')).rows[0].count).toBe(7);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);

  it('keeps the shared test extension after disposing an isolated schema', async () => {
    const fixtures = await Promise.all([isolatedDatabase(), isolatedDatabase()]);
    try {
      const original = await extension(fixtures[1].db);
      expect(original).toHaveLength(1); expect(original[0].nspname).toBe('public');
      await fixtures[0].close(); fixtures[0] = null;
      expect(await extension(fixtures[1].db)).toEqual(original);
      expect((await fixtures[1].db.query('SELECT count(*)::int AS count FROM starter_migrations')).rows[0].count).toBe(7);
    } finally { await Promise.all(fixtures.filter(Boolean).map((fixture) => fixture.close())); }
  }, 30000);
});
