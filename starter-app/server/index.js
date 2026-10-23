import { createOperationsReadRoutes } from './routes/operations.routes.js';
import express from 'express';
import { configuredMockCheckout } from './application/mockCheckout.js';
import { createMockCheckoutRoutes } from './routes/mockCheckout.routes.js';
import { configuredMockImageUseCase, createImageArtifactAuthorizer } from './application/mockImageUseCase.js';
import { createImageRoutes } from './routes/images.routes.js';
import { configuredStagedArtifactPipeline } from './artifacts/staging.js';
import { configuredRemoteArtifactIngestor } from './artifacts/remoteIngestion.js';
import { configuredArtifactStore } from './artifacts/localStore.js';
import { createArtifactRoutes } from './routes/artifacts.routes.js';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import { pathToFileURL } from 'node:url';
import { createDatabasePool } from './db/index.js';
import { DomainKnowledgeAdapter } from './domain/adapter.js';
import { createAiProduct } from './domain/aiProduct.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { createAnalyzeRoutes } from './routes/analyze.routes.js';
import { createChatStreamRoutes } from './routes/chatStream.routes.js';
import { createOptionalAuth, hardenJsonResponse } from '@yuva/auth-core';
import { sendPublicError, toPublicError } from './http/errors.js';
import { authMode } from './auth/config.js';
import { createSelfHostedAuth } from './auth/selfHosted.js';

dotenv.config();

export function createServer({
  db,
  adapter,
  callAIStream,
  validateOutput,
  operationStore,
  usageStore,
  aiProduct,
  auth,
  sendAuthMail,
  config = {},
} = {}) {
  const env = config.env || process.env;
  const product = aiProduct ?? createAiProduct({ env, configuration: config.pricing, modelCatalog: config.modelCatalog, inputVersion: config.inputVersion });
  const app = express();
  const artifactStore = configuredArtifactStore(env);
  app.locals.artifactStore = artifactStore;
  const artifactPipeline = configuredStagedArtifactPipeline(env, artifactStore);
  app.locals.artifactPipeline = artifactPipeline;
  app.locals.artifactIngestor = configuredRemoteArtifactIngestor(env, artifactPipeline || artifactStore);
  const mode = authMode(env);
  if (mode === 'self-hosted' && auth) throw new Error('Self-hosted mode cannot be combined with a custom auth adapter');
  const activeDb = db || createDatabasePool({ databaseUrl: env.DATABASE_URL });
  const selfHosted = mode === 'self-hosted' ? createSelfHostedAuth({ db: activeDb, env, sendMail: sendAuthMail }) : null;
  app.locals.selfHostedAuth = selfHosted;

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
  if (selfHosted) {
    app.use(selfHosted.csrf);
    app.use('/api/auth', selfHosted.router);
  } else {
    app.get('/api/auth/config', (req, res) => res.json({ mode, enabled: false, capture: false }));
  }
  app.use(express.json({ limit: env.JSON_BODY_LIMIT || '256kb' }));

  // Response Hardening Middleware (prevents token leakage & sets security headers)
  app.use((req, res, next) => {
    hardenJsonResponse(res);
    next();
  });

  const activeAdapter = adapter || new DomainKnowledgeAdapter(config.domainKey || env.DOMAIN_KEY || 'vertical-agent-saas');

  // Optional Authentication Middleware (@yuva/auth-core)
  const optionalAuth = createOptionalAuth({
    db: activeDb,
    env,
    verifyRequest: selfHosted?.verifyRequest || auth?.verifyRequest,
    findUser: selfHosted?.findUser || auth?.findUser,
  });
  app.use(optionalAuth);

  const mockImages = configuredMockImageUseCase({ env, db: activeDb, artifactStore, artifactPipeline, profile: config.imageProfile });
  app.locals.mockImages = mockImages;
  app.use(createArtifactRoutes({ store: artifactStore, authorizeArtifact: createImageArtifactAuthorizer({ db: activeDb, strict: Boolean(mockImages) }) }));
  app.use(createImageRoutes({ images: mockImages }));

  app.use(createOperationsReadRoutes({ db: activeDb, enabled: env.OPERATIONS_VIEW === 'read-only',
    operationsReadCapabilities: config.operationsReadCapabilities }));

  const mockCheckout = configuredMockCheckout({ env, db: activeDb });
  app.locals.mockCheckout = mockCheckout;
  app.use(createMockCheckoutRoutes({ checkout: mockCheckout }));

  // Mount API routes
  app.use(createHealthRoutes({ adapter: activeAdapter, db: activeDb, authHealth: selfHosted?.readiness }));
  app.use(createAnalyzeRoutes({ adapter: activeAdapter }));
  app.get('/api/pricing', (req, res) => res.json(product.publicPricing));
  app.use(createChatStreamRoutes({
    db: activeDb,
    adapter: activeAdapter,
    callAIStream,
    validateOutput,
    operationStore,
    usageStore,
    product,
    env,
  }));

  // Global error handler (Fail-Closed)
  app.use((err, req, res, next) => {
    console.error('[Server Error]', { code: toPublicError(err).code });
    if (!res.headersSent) {
      sendPublicError(res, err);
    }
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  && process.env.NODE_ENV !== 'test' && !process.env.TEST_MODE) {
  const port = process.env.PORT || 3000;
  const app = createServer();
  const host = app.locals.mockImages || app.locals.mockCheckout || app.locals.selfHostedAuth?.config.mailMode === 'capture' ? '127.0.0.1' : undefined;
  app.listen(port, host, () => {
    console.log(`[Starter App] Server running at http://localhost:${port}`);
  });
}
