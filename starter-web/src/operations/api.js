export const FINANCIAL_STATUSES = ['unreserved', 'reserved', 'settled', 'no_charge', 'released', 'reconciliation_required'];
export const PAGE_SIZE = 20;
export const MAX_OFFSET = 10000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isOperationId = (value) => typeof value === 'string' && uuid.test(value);

function invalid() { throw new Error('Invalid history filter.'); }
export function historyQuery({ operator = false, accountId = '', status = '', offset = 0, limit = PAGE_SIZE } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) invalid();
  if (typeof accountId !== 'string' || typeof status !== 'string') invalid();
  if (!operator && (accountId || status)) invalid();
  if (accountId && !uuid.test(accountId)) invalid();
  if (status && !FINANCIAL_STATUSES.includes(status)) invalid();
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (accountId) query.set('accountId', accountId);
  if (status) query.set('status', status);
  return query.toString();
}
async function read(path, signal) {
  const response = await fetch(path, { method: 'GET', credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    // Never show arbitrary response/error bodies: they may include private data.
    const error = new Error('History request failed.');
    error.status = response.status;
    throw error;
  }
  return response.json();
}
export const readCapabilities = (signal) => read('/api/operations/capabilities', signal);
export const readOperations = (options, signal) => read(`${options.operator ? '/api/ops/operations' : '/api/operations'}?${historyQuery(options)}`, signal);
export function readOperation(operationId, operator, signal) {
  if (!isOperationId(operationId)) invalid();
  return read(`${operator ? '/api/ops/operations' : '/api/operations'}/${encodeURIComponent(operationId)}`, signal);
}
export function historyError(error) {
  if (error.status === 401) return 'Your session has expired. Sign in again to view history.';
  if (error.status === 403) return 'You do not have permission to view this history.';
  if (error.status === 404) return 'History is unavailable or this operation could not be found.';
  return 'History could not be loaded. Please try again.';
}
