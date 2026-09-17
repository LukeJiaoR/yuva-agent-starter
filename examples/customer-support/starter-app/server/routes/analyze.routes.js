import express from 'express';
import { PricingCatalog } from '../domain/pricing.config.js';

export function createAnalyzeRoutes({ adapter } = {}) {
  const router = express.Router();

  router.post('/api/analyze', async (req, res, next) => {
    try {
      const { input } = req.body;
      if (!input) {
        return res.status(400).json({ error: 'Missing input data' });
      }

      // 1. Compute deterministic facts
      const facts = await adapter.computeFacts(input);
      const snapshot = adapter.createSnapshot(facts);

      // 2. Return the immutable facts snapshot and fingerprint without exposing internal prompt templates
      return res.json({
        success: true,
        fingerprint: snapshot.fingerprint,
        pricing: PricingCatalog.features.quick_analysis,
        facts: snapshot.facts,
        computed_at: snapshot.computed_at,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
