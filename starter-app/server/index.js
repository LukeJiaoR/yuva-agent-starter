import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createDatabasePool } from './db/index.js';
import { DomainKnowledgeAdapter } from './domain/adapter.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { createAnalyzeRoutes } from './routes/analyze.routes.js';
import { createChatStreamRoutes } from './routes/chatStream.routes.js';

dotenv.config();

export function createServer({
  db,
  adapter,
  callAIStream,
  config = {},
} = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const activeDb = db || createDatabasePool(config);
  const activeAdapter = adapter || new DomainKnowledgeAdapter(config.domainKey || process.env.DOMAIN_KEY || 'vertical-agent-saas');

  // Mount API routes
  app.use(createHealthRoutes({ adapter: activeAdapter }));
  app.use(createAnalyzeRoutes({ adapter: activeAdapter }));
  app.use(createChatStreamRoutes({
    db: activeDb,
    adapter: activeAdapter,
    callAIStream,
    env: config.env || process.env,
  }));

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[Server Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  });

  return app;
}

if (process.env.NODE_ENV !== 'test' && !process.env.TEST_MODE) {
  const port = process.env.PORT || 3000;
  const app = createServer();
  app.listen(port, () => {
    console.log(`[Starter App] Server running at http://localhost:${port}`);
  });
}
