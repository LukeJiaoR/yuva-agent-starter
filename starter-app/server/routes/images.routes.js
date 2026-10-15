import express from 'express';
import { invariant } from '@yuva/billing-core';

/** Mounted only by the explicitly enabled local mock composition. */
export function createImageRoutes({ images }) {
  const router = express.Router();
  if (!images) return router;
  router.use('/api/images', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.status(403).json({ error: 'invalid_request' });
    if (req.auth?.kind !== 'authenticated' || !req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  router.post('/api/images', async (req, res, next) => {
    try {
      invariant(req.body && Object.keys(req.body).sort().join(',') === 'prompt,requestId', 'invalid_request', 422);
      res.json(await images.submit({ accountId: req.user.id, prompt: req.body.prompt, requestId: req.body.requestId }));
    } catch (error) { next(error); }
  });
  router.get('/api/images/:operationId', async (req, res, next) => {
    try { res.json(await images.query({ accountId: req.user.id, operationId: req.params.operationId })); }
    catch (error) { next(error); }
  });
  router.post('/api/images/:operationId/recover', async (req, res, next) => {
    try {
      invariant(req.body == null || Object.keys(req.body).length === 0, 'invalid_request', 422);
      res.json(await images.recover({ accountId: req.user.id, operationId: req.params.operationId }));
    } catch (error) { next(error); }
  });
  return router;
}
