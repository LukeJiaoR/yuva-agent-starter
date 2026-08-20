import express from 'express';
import crypto from 'node:crypto';
import {
  createAgentRuntime,
  createStreamEmitter,
  writeSseEvent,
  setSseHeaders,
  streamProviderText,
  countUnicodeTokens,
} from '../../../packages/ai-engine/index.js';
import { allocateContextBudget } from '../../../packages/context-engine/index.js';
import {
  reserveFeatureCredits,
  settleFeatureCredits,
  releaseFeatureCredits,
  getCreditBalance,
} from '../../../packages/billing-core/index.js';
import { DomainPrompts } from '../domain/prompts.js';
import { PricingCatalog } from '../domain/pricing.config.js';

export function createChatStreamRoutes({
  db,
  adapter,
  callAIStream,
  env = process.env,
} = {}) {
  const router = express.Router();

  // 1. Domain Port
  const domainPort = {
    async prepare({ request, user, db: activeDb }) {
      const input = request || {};
      const conversationId = input.conversationId || input.conversation_id || crypto.randomUUID();
      const clientRequestId = input.requestId || input.clientRequestId || input.request_id || crypto.randomUUID();
      const question = input.question || 'Hello!';

      // Load conversation history from database
      let history = [];
      try {
        const histRes = await activeDb.query(
          'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 20',
          [conversationId],
        );
        history = histRes.rows || [];
      } catch {
        history = [];
      }

      // Compute deterministic domain facts
      const facts = await adapter.computeFacts(input);
      const snapshot = adapter.createSnapshot(facts);
      const domainContext = adapter.buildContext(facts, history, question);

      return {
        valid: true,
        request: {
          clientRequestId,
          conversationId,
          question,
          factsSnapshot: snapshot,
          domainContext,
          history,
        },
      };
    },
  };

  // 2. Context Port (Using @yuva/context-engine allocateContextBudget)
  const contextPort = {
    async resolveContext({ request }) {
      const units = [
        {
          key: 'system.facts',
          category: 'knowledge',
          channel: 'system',
          required: true,
          text: JSON.stringify(request.factsSnapshot?.facts || {}),
        },
        {
          key: 'user.question',
          category: 'question',
          channel: 'message',
          required: true,
          text: request.question,
        },
        ...(request.history || []).map((m, idx) => ({
          key: `history.${idx}`,
          category: 'history',
          channel: 'message',
          required: false,
          text: `${m.role}: ${m.content}`,
        })),
      ];

      const budgetResult = allocateContextBudget({
        units,
        budgetTokens: 6000,
        tokenCounter: countUnicodeTokens,
      });

      return {
        budget: budgetResult,
        contextPayload: request.domainContext,
        messageUnits: budgetResult.messageUnits,
        systemUnits: budgetResult.systemUnits,
      };
    },
  };

  // 3. Prompt Port (Injects grounded facts and historical turns into messages array)
  const promptPort = {
    async composePrompt({ request, context }) {
      const systemPrompt = DomainPrompts.formatSystemPrompt(context?.contextPayload || {});
      const messages = [
        ...(request.history || []).map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: request.question },
      ];

      return {
        systemPrompt,
        messages,
        userPrompt: request.question,
      };
    },
  };

  // 4. Validation Port (Using real createDelivery buffer & safety check)
  const validationPort = {
    async createDelivery({ onCommit }) {
      let buffer = '';
      return {
        async push(delta) {
          buffer += delta;
          onCommit(delta);
        },
        async flush() {
          if (!buffer.trim()) {
            throw new Error('Assistant generated an empty response');
          }
          return {
            visibleText: buffer,
            valid: true,
          };
        },
      };
    },
  };

  // 5. Billing Port (Using real @yuva/billing-core with database transactions & locks)
  const billingPort = {
    async getRequest({ request, user, db: activeDb }) {
      const clientRequestId = request.requestId || request.clientRequestId || request.request_id;
      if (!clientRequestId) return null;

      try {
        const res = await activeDb.query(
          'SELECT * FROM credit_usage_requests WHERE user_id = $1 AND client_request_id = $2',
          [user.id, clientRequestId],
        );
        const existing = res.rows[0];
        if (!existing) return null;

        if (existing.status === 'generating' || existing.status === 'reserved') {
          return {
            isExisting: true,
            replayed: false,
            streamed: false,
            statusCode: 202,
            body: {
              request_id: existing.client_request_id,
              status: existing.status,
              message: 'Request is currently processing',
            },
          };
        }
        if (existing.status === 'settled') {
          return {
            isExisting: true,
            replayed: true,
            request: existing,
          };
        }
      } catch {
        return null;
      }
      return null;
    },

    async reserve({ request, user, db: activeDb }) {
      const requiredCredits = PricingCatalog.features.deep_reasoning.credits;
      const featureKey = PricingCatalog.features.deep_reasoning.key;

      const result = await reserveFeatureCredits({
        db: activeDb,
        userId: user.id,
        featureKey,
        clientRequestId: request.clientRequestId,
        credits: requiredCredits,
      });

      if (result.kind === 'insufficient' || result.kind === 'debt') {
        return {
          rejected: true,
          status: 402,
          code: 'insufficient_credits',
          error: 'Insufficient credits to start stream',
          body: {
            error: 'insufficient_credits',
            code: 'insufficient_credits',
            required_credits: requiredCredits,
            available_credits: result.balance?.available ?? 0,
          },
          balance: result.balance,
        };
      }

      if (result.kind === 'existing') {
        return {
          isExisting: true,
          replayed: true,
          request: result.request,
          balance: result.balance,
        };
      }

      return {
        kind: 'reserved',
        reservedCredits: requiredCredits,
        reservationId: result.request?.id,
        request: result.request,
        balance: result.balance,
      };
    },

    async settle({ request, reservation, user, db: activeDb, providerResult, output, rawOutput }) {
      const textToSave = output || rawOutput || '';
      const billableTokens = providerResult?.billableTokens || countUnicodeTokens(textToSave);
      const creditsUsed = reservation?.reservedCredits || PricingCatalog.features.deep_reasoning.credits;

      await settleFeatureCredits({
        db: activeDb,
        userId: user.id,
        requestId: reservation?.reservationId || reservation?.request?.id,
        creditsUsed,
        billableTokens,
        assistantText: textToSave,
      });

      // Persist user and assistant messages for conversation multi-turn history
      if (request?.conversationId) {
        await activeDb.query(
          `INSERT INTO conversations (id, user_id, domain_key, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
          [request.conversationId, user.id, adapter.domainKey],
        ).catch(() => {});

        await activeDb.query(
          `INSERT INTO messages (conversation_id, role, content, created_at)
           VALUES ($1, 'user', $2, NOW()), ($1, 'assistant', $3, NOW())`,
          [request.conversationId, request.question, textToSave],
        ).catch(() => {});
      }

      return {
        status: 'settled',
        creditsUsed,
        billableTokens,
      };
    },

    async release({ reservation, user, db: activeDb, failureClass }) {
      await releaseFeatureCredits({
        db: activeDb,
        userId: user.id,
        requestId: reservation?.reservationId || reservation?.request?.id,
        failureClass: failureClass || 'unknown_failure',
      });
      return { status: 'released' };
    },
  };

  // 6. Stream Port (Completely Request-Scoped: No Shared Closure Variables!)
  const streamPort = {
    createEmitter({ req, res, requestId, pipelineRunId }) {
      if (!res) return null;
      setSseHeaders(res);
      return createStreamEmitter({
        requestId,
        pipelineRunId,
        write: (event) => writeSseEvent(res, event),
      });
    },

    emitStart(emitter, { request }) {
      emitter?.emit?.('start', {
        conversation_id: request?.conversationId,
        pipeline_run_id: request?.pipelineRunId,
      });
    },

    emitTextDelta(emitter, delta) {
      emitter?.emit?.('text_delta', { text: delta });
    },

    emitDone(emitter) {
      emitter?.emit?.('done', {
        delivery_status: 'delivered',
        stop_reason: 'complete',
      });
    },

    async streamProviderText(options = {}) {
      if (typeof callAIStream === 'function') {
        return callAIStream(options);
      }

      const provider = env.AI_PROVIDER || 'openai';
      const isAnthropic = provider === 'anthropic';
      const apiKey = isAnthropic ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
      const model = isAnthropic
        ? (env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022')
        : (env.OPENAI_MODEL || 'gpt-4o');

      return streamProviderText({
        provider,
        apiKey,
        baseUrl: env.OPENAI_BASE_URL,
        model,
        systemPrompt: options.systemPrompt,
        messages: options.messages || [{ role: 'user', content: options.userPrompt }],
        onText: options.onText,
        abortSignal: options.signal,
      });
    },

    async replayExisting({ existing, res }) {
      if (!res) return { handled: true, streamed: false, statusCode: 200, body: existing };
      setSseHeaders(res);
      const emitter = createStreamEmitter({
        requestId: existing.client_request_id,
        write: (event) => writeSseEvent(res, event),
      });

      emitter.emit('start', { conversation_id: existing.conversation_id });
      if (existing.assistant_text) {
        emitter.emit('text_delta', { text: existing.assistant_text });
      }
      emitter.emit('done', {
        delivery_status: 'delivered',
        stop_reason: 'complete',
        replayed: true,
      });
      res.end();

      return {
        handled: true,
        streamed: true,
        terminalStatus: 'settled',
        replayed: true,
      };
    },
  };

  // Initialize Generic Agent Runtime
  const runtime = createAgentRuntime({
    domainPort,
    contextPort,
    promptPort,
    validationPort,
    billingPort,
    streamPort,
  });

  router.post('/api/chat/stream', async (req, res, next) => {
    try {
      const user = req.user || {
        id: req.headers['x-user-id'] || '00000000-0000-0000-0000-000000000001',
        email: req.headers['x-user-email'] || 'guest@example.com',
      };

      const result = await runtime({
        request: req.body,
        user,
        req,
        res,
        db,
        env,
      });

      if (!result.streamed && !res.headersSent) {
        return res.status(result.statusCode || result.status || 200).json(result.body || result);
      }
      if (result.streamed && !res.writableEnded) {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        return res.status(err.status || 500).json({
          error: err.code || 'runtime_error',
          message: err.message || 'Internal Server Error',
        });
      }
      res.end();
    }
  });

  return router;
}
