import pg from 'pg';
const { Pool } = pg;

export function createDatabasePool(config = {}) {
  const connectionString = config.databaseUrl || process.env.DATABASE_URL;
  if (!connectionString) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Database Pool] DATABASE_URL is required in production mode (Fail-Closed).');
    }
    return {
      query: async () => {
        throw new Error('[Database Pool] Database is not configured. Provide DATABASE_URL in .env');
      },
      connect: async () => {
        throw new Error('[Database Pool] Database is not configured. Provide DATABASE_URL in .env');
      },
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

  pool.on('error', () => {
    // Driver errors may embed connection strings, SQL or private record data.
    console.error('[Database Pool] Unexpected error on idle client.');
  });

  return pool;
}
