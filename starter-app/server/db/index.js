import pg from 'pg';
const { Pool } = pg;

export function createDatabasePool(config = {}) {
  const connectionString = config.databaseUrl || process.env.DATABASE_URL;
  if (!connectionString) {
    // Return a dummy pool interface if no DB is configured in test/dev
    return {
      query: async (sql, params) => ({ rows: [] }),
      on: () => {},
      end: async () => {},
    };
  }

  const pool = new Pool({
    connectionString,
    max: config.maxConnections || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[Database Pool] Unexpected error on idle client:', err);
  });

  return pool;
}
