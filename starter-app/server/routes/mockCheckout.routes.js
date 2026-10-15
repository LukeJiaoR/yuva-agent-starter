import express from 'express';
import { invariant } from '@yuva/billing-core';

export function createMockCheckoutRoutes({ checkout }) {
  const router = express.Router();
  if (!checkout) return router;
  const base = '/api/mock-checkout';
  const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
  router.use(base, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.status(403).json({ error: 'invalid_request' });
    if (req.auth?.kind !== 'authenticated' || !uuid(req.user?.id)) return res.status(401).json({ error: 'unauthorized' });
    // Actual Origin is required on mutations across ALL auth modes; never trust forwarded headers.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== checkout.trustedOrigin) {
      return res.status(403).json({ error: 'invalid_request' });
    }
    if (!(req.method === 'GET' && req.path === '/orders') && Object.keys(req.query).length) {
      return res.status(422).json({ error: 'invalid_request' });
    }
    next();
  });
  const handle = (fn) => async (req, res, next) => { try { res.json(await fn(req)); } catch (error) { next(error); } };
  router.get(`${base}/products`, handle(() => checkout.products()));
  router.post(`${base}/orders`, handle((req) => {
    invariant(req.body && !Array.isArray(req.body) && Object.keys(req.body).sort().join(',') === 'productId,requestId', 'invalid_request', 422);
    return checkout.create({ accountId: req.user.id, productId: req.body.productId, requestId: req.body.requestId });
  }));
  router.get(`${base}/orders`, handle((req) => {
    invariant(Object.keys(req.query).every((key) => ['limit', 'offset'].includes(key)), 'invalid_request', 422);
    for (const value of Object.values(req.query)) invariant(typeof value === 'string' && /^(?:0|[1-9]\d{0,4})$/u.test(value), 'invalid_request', 422);
    return checkout.list({ accountId: req.user.id, limit: req.query.limit === undefined ? 20 : Number(req.query.limit),
      offset: req.query.offset === undefined ? 0 : Number(req.query.offset) });
  }));
  router.get(`${base}/orders/:orderId`, handle((req) => checkout.get({ accountId: req.user.id, orderId: req.params.orderId })));
  router.post(`${base}/orders/:orderId/cancel`, handle((req) => {
    invariant(req.body == null || (!Array.isArray(req.body) && typeof req.body === 'object' && Object.keys(req.body).length === 0), 'invalid_request', 422);
    return checkout.cancel({ accountId: req.user.id, orderId: req.params.orderId });
  }));
  return router;
}
