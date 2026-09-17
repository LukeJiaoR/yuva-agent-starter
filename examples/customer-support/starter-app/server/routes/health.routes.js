import express from 'express';

export function createHealthRoutes({ adapter, db } = {}) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      domain: adapter?.domainKey || 'vertical-agent-saas',
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (req, res) => {
    try {
      await db.query('SELECT 1');
      return res.json({
        status: 'ready',
        database: 'connected',
        domain: adapter?.domainKey || 'vertical-agent-saas',
      });
    } catch {
      return res.status(503).json({
        status: 'not_ready',
        database: 'unavailable',
      });
    }
  });

  return router;
}
