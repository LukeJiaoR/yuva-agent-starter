import express from 'express';
import { createOperationsReadStore, financialStatuses, isOperationUuid } from '../stores/operationsReadStore.js';

const invalid = () => Object.assign(new Error('invalid_request'), { code: 'invalid_request', status: 422 });
function queryParameters(query, operator) {
  const allowed = operator ? ['limit', 'offset', 'accountId', 'status'] : ['limit', 'offset'];
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw invalid();
  const number = (key, fallback, minimum, maximum) => {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string' || !/^(0|[1-9]\d{0,4})$/u.test(query[key])) throw invalid();
    const value = Number(query[key]);
    if (value < minimum || value > maximum) throw invalid();
    return value;
  };
  if (query.accountId !== undefined && !isOperationUuid(query.accountId)) throw invalid();
  if (query.status !== undefined && !financialStatuses.includes(query.status)) throw invalid();
  return { limit: number('limit', 20, 1, 50), offset: number('offset', 0, 0, 10000),
    accountId: query.accountId ?? null, status: query.status ?? null };
}
/** Resolver is trusted server wiring, never a role/header/query permission source. */
export function createOperationsReadRoutes({ db, enabled = false, operationsReadCapabilities }) {
  const router = express.Router();
  if (!enabled) return router;
  const store = createOperationsReadStore({ db });
  async function operatorAllowed(req) {
    if (typeof operationsReadCapabilities !== 'function') return false;
    // Only verified identity identifiers, never token objects, raw requests or mutable profiles.
    const identity = Object.freeze({ auth: Object.freeze({ kind: 'authenticated', userId: req.auth.userId }),
      user: Object.freeze({ id: req.user.id }) });
    try {
      const capabilities = await operationsReadCapabilities(identity);
      return Array.isArray(capabilities) && capabilities.length === 1 && capabilities[0] === 'operations:read:any';
    } catch { return false; }
  }
  router.use(['/api/operations', '/api/ops/operations'], (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.auth?.kind !== 'authenticated' || !isOperationUuid(req.user?.id)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  router.get('/api/operations/capabilities', async (req, res, next) => {
    try {
      if (Object.keys(req.query).length) throw invalid();
      res.json({ enabled: true, selfRead: true, operatorRead: await operatorAllowed(req) });
    } catch (error) { next(error); }
  });
  for (const [base, operator] of [['/api/operations', false], ['/api/ops/operations', true]]) {
    router.use(base, async (req, res, next) => {
      if (operator && !await operatorAllowed(req)) return res.status(403).json({ error: 'forbidden' });
      next();
    });
    router.get(base, async (req, res, next) => {
      try {
        const query = queryParameters(req.query, operator);
        res.json(await store.list({ ...query, accountId: operator ? query.accountId : req.user.id }));
      } catch (error) { next(error); }
    });
    router.get(`${base}/:operationId`, async (req, res, next) => {
      try {
        if (!isOperationUuid(req.params.operationId) || Object.keys(req.query).length) throw invalid();
        const result = await store.detail({ operationId: req.params.operationId, accountId: operator ? null : req.user.id });
        if (!result) return res.status(404).json({ error: 'operation_not_found' });
        res.json(result);
      } catch (error) { next(error); }
    });
  }
  return router;
}
