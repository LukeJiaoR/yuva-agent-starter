import express from 'express';

export function createHealthRoutes({ adapter } = {}) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      domain: adapter?.domainKey || 'vertical-agent-saas',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
