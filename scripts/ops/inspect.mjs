import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Metadata-only probes; one invocation, no scheduling and no money mutation. */
export async function inspectDatabase(db) {
  const { rows: [row] } = await db.query(`SELECT
    COUNT(*) FILTER (WHERE status IN ('generating','reserved'))::int AS active_requests,
    COUNT(*) FILTER (WHERE status='released')::int AS released_requests,
    COUNT(*) FILTER (WHERE status='reconciliation_required')::int AS reconciliation_requests,
    COALESCE(MAX(EXTRACT(EPOCH FROM (NOW()-started_at))) FILTER (WHERE status IN ('generating','reserved')),0)::float AS oldest_active_seconds
    FROM credit_usage_requests`);
  return { ...row, providerCost: { status: 'unavailable', reason: 'Durable per-call cost integration is pending Epic 1; no zero-cost assumption' } };
}
export async function probe(base, fetchFn = fetch) {
  const url = new URL(base);
  if (url.username || url.password || url.search || !['https:', 'http:'].includes(url.protocol)) throw new Error('Probe base must be a credential-free HTTP origin');
  const statuses = {};
  for (const route of ['health', 'ready']) {
    const started = Date.now();
    try {
      const response = await fetchFn(new URL('/' + route, url), { signal: AbortSignal.timeout(5000), redirect: 'error' });
      statuses[route] = { ok: response.ok, status: response.status, durationMs: Date.now() - started };
    } catch { statuses[route] = { ok: false, status: null, durationMs: Date.now() - started }; }
  }
  return statuses;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = {};
  if (process.env.OPS_BASE_URL) output.probes = await probe(process.env.OPS_BASE_URL);
  if (process.env.DATABASE_URL) {
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    try { output.database = await inspectDatabase(db); } catch { output.database = { error: 'database_inspection_unavailable' }; process.exitCode = 1; }
    finally { await db.end(); }
  }
  if (!output.probes && !output.database) throw new Error('Configure OPS_BASE_URL and/or DATABASE_URL');
  if (output.probes && Object.values(output.probes).some((p) => !p.ok)) process.exitCode = 1;
  console.log(JSON.stringify(output, null, 2));
}
