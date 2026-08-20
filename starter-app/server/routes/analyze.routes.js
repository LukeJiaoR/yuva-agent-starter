import express from 'express';
import { PricingCatalog } from '../domain/pricing.config.js';
import { DomainPrompts } from '../domain/prompts.js';

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

      // 2. Build domain prompt context
      const context = adapter.buildContext(facts, [], input.query);
      const prompt = DomainPrompts.formatAnalysisPrompt(context);

      return res.json({
        success: true,
        fingerprint: snapshot.fingerprint,
        pricing: PricingCatalog.features.quick_analysis,
        facts: snapshot.facts,
        computed_at: snapshot.computed_at,
        prepared_prompt: prompt,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
