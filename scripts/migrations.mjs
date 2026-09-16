import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
/** One short, schema-scoped transaction serializes setup and verifies applied files. */
export async function migrateDatabase(pool, { directory = path.join(root, 'migrations') } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':starter-migrations', 0))");
    await client.query(`CREATE TABLE IF NOT EXISTS starter_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const files = (await fs.readdir(directory)).filter((name) => /^\d{3}-.*\.sql$/u.test(name)).sort();
    const migrations = [{ version: 1, name: 'schema.sql', sql: await fs.readFile(path.join(root, 'schema.sql'), 'utf8') }];
    for (const name of files) migrations.push({ version: Number(name.slice(0, 3)), name, sql: await fs.readFile(path.join(directory, name), 'utf8') });
    const applied = new Map((await client.query('SELECT * FROM starter_migrations ORDER BY version')).rows.map((row) => [row.version, row]));
    if ([...applied.keys()].some((version) => !migrations.some((m) => m.version === version))) throw new Error('Database migration version is newer than this application');
    for (let index = 0; index < migrations.length; index++) {
      const migration = migrations[index];
      if (migration.version !== index + 1) throw new Error('Migrations must be consecutively numbered');
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const previous = applied.get(migration.version);
      if (previous) {
        if (previous.checksum !== checksum || previous.name !== migration.name) throw new Error(`Migration checksum mismatch: ${migration.name}`);
        continue;
      }
      // Existing v1 installs have a version marker but no checksum ledger. Adopt
      // that baseline once; do not replay or rewrite their financial data.
      const legacy = migration.version === 1
        && (await client.query("SELECT to_regclass(format('%I.starter_schema_versions', current_schema())) AS name")).rows[0].name;
      const initialized = legacy && (await client.query('SELECT 1 FROM starter_schema_versions WHERE version=1')).rowCount;
      if (!initialized) await client.query(migration.sql);
      await client.query('INSERT INTO starter_migrations(version,name,checksum) VALUES ($1,$2,$3)', [migration.version, migration.name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
