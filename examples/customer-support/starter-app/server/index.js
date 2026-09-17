import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import { createDatabasePool } from './db/index.js';
import { DomainKnowledgeAdapter } from './domain/adapter.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { createAnalyzeRoutes } from './routes/analyze.routes.js';
import { createChatStreamRoutes } from './routes/chatStream.routes.js';
import { createOptionalAuth, hardenJsonResponse } from '@yuva/auth-core';
import { sendPublicError } from './http/errors.js';

dotenv.config();

export function createServer({
  db,
  adapter,
  callAIStream,
  validateOutput,
  config = {},
} = {}) {
  const env = config.env || process.env;
  const app = express();

  const configuredOrigins = String(env.CORS_ORIGIN || env.FRONTEND_URL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const developmentOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const isProduction = env.NODE_ENV === 'production';
  const allowedOrigins = new Set([
    ...configuredOrigins,
    ...(!isProduction ? developmentOrigins : []),
  ]);

  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      const error = new Error('Origin is not allowed');
      error.status = 403;
      error.code = 'invalid_request';
      return callback(error);
    },
  }));
  app.use(express.json({ limit: env.JSON_BODY_LIMIT || '256kb' }));

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
  app.use(createHealthRoutes({ adapter: activeAdapter, db: activeDb }));
  app.use(createAnalyzeRoutes({ adapter: activeAdapter }));
  app.use(createChatStreamRoutes({
    db: activeDb,
    adapter: activeAdapter,
    callAIStream,
    validateOutput,
    env,
  }));

  // Global error handler (Fail-Closed)
  app.use((err, req, res, next) => {
    console.error('[Server Error]', err);
    if (!res.headersSent) {
      sendPublicError(res, err);
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
