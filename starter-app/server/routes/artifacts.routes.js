import express from 'express';

export function createArtifactRoutes({ store }) {
  const router = express.Router();
  if (!store) return router;
  router.get('/api/artifacts/:id', async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.auth?.kind !== 'authenticated' || !req.user?.id) return res.status(401).json({ code: 'authentication_required' });
    try {
      const result = await store.get({ accountId: req.user.id, id: req.params.id });
      res.set({ 'Content-Type': 'image/png', 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin' });
      return res.send(result.bytes);
    } catch { return res.status(404).json({ code: 'artifact_unavailable' }); }
  });
  return router;
}
