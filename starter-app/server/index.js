import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createDatabasePool } from './db/index.js';
import { DomainKnowledgeAdapter } from './domain/adapter.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { createAnalyzeRoutes } from './routes/analyze.routes.js';
import { createChatStreamRoutes } from './routes/chatStream.routes.js';
import { createOptionalAuth, hardenJsonResponse } from '../../packages/auth-core/index.js';

dotenv.config();

export function createServer({
  db,
  adapter,
  callAIStream,
  config = {},
} = {}) {
  const env = config.env || process.env;
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Response Hardening Middleware (prevents token leakage & sets security headers)
  app.use((req, res, next) => {
    hardenJsonResponse(res);
    next();
  });

  const activeDb = db || createDatabasePool({ databaseUrl: env.DATABASE_URL });
  const activeAdapter = adapter || new DomainKnowledgeAdapter(config.domainKey || env.DOMAIN_KEY || 'vertical-agent-saas');

  // Optional Authentication Middleware (@yuva/auth-core)
  const optionalAuth = createOptionalAuth({
    db: activeDb,
    env,
  });
  app.use(optionalAuth);

  // Mount API routes
  app.use(createHealthRoutes({ adapter: activeAdapter }));
  app.use(createAnalyzeRoutes({ adapter: activeAdapter }));
  app.use(createChatStreamRoutes({
    db: activeDb,
    adapter: activeAdapter,
    callAIStream,
    env,
  }));

  // Global error handler (Fail-Closed)
  app.use((err, req, res, next) => {
    console.error('[Server Error]', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        error: err.code || 'internal_server_error',
        message: err.message || 'An unexpected error occurred.',
      });
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
