import express from 'express';
import crypto from 'node:crypto';
import {
  createAgentRuntime,
  createStreamEmitter,
  writeSseEvent,
  setSseHeaders,
  streamProviderText,
} from '../../../packages/ai-engine/index.js';
import { planContextBudget } from '../../../packages/context-engine/index.js';
import { DomainPrompts } from '../domain/prompts.js';
import { PricingCatalog } from '../domain/pricing.config.js';

export function createChatStreamRoutes({
  db,
  adapter,
  callAIStream,
  env = process.env,
} = {}) {
  const router = express.Router();

  // 1. Construct Domain Port
  const domainPort = {
    async prepare({ request }) {
      const input = request || {};
      const facts = await adapter.computeFacts(input);
      const snapshot = adapter.createSnapshot(facts);
      const context = adapter.buildContext(facts, [], input.question);

      return {
        valid: true,
        canonicalRequest: {
          requestId: input.requestId || input.request_id || crypto.randomUUID(),
          conversationId: input.conversationId || input.conversation_id || crypto.randomUUID(),
          question: input.question || 'Hello!',
          factsSnapshot: snapshot,
          domainContext: context,
        },
      };
    },
  };

  // 2. Construct Context Port
  const contextPort = {
    async resolveContext({ request }) {
      const budget = planContextBudget({
        queryLength: (request.question || '').length,
        hasDeepContext: Boolean(request.factsSnapshot),
      });
      return {
        budget,
        contextPayload: request.domainContext,
      };
    },
  };

  // 3. Construct Prompt Port
  const promptPort = {
    async composePrompt({ request, context }) {
      return {
        systemPrompt: DomainPrompts.formatSystemPrompt(context?.contextPayload || {}),
        userPrompt: request.question,
      };
    },
  };

  // 4. Construct Validation Port
  const validationPort = {
    async validate({ text }) {
      if (!text || text.trim().length === 0) {
        return { valid: false, reason: 'Empty response generated' };
      }
      return { valid: true };
    },
  };

  // 5. Construct Billing Port
  const billingPort = {
    async getRequest({ request, user }) {
      const clientRequestId = request.requestId || request.request_id;
      if (!clientRequestId) return null;
      const res = await db.query(
        'SELECT * FROM credit_usage_requests WHERE user_id = $1 AND client_request_id = $2',
        [user.id, clientRequestId],
      ).catch(() => ({ rows: [] }));
      const existing = res.rows[0];
      if (!existing) return null;

      if (existing.status === 'generating') {
        return {
          isExisting: true,
          replayed: false,
          streamed: false,
          statusCode: 202,
          body: {
            request_id: existing.client_request_id,
            status: existing.status,
            message: 'Request is already being processed.',
          },
        };
      }
      return {
        isExisting: true,
        replayed: true,
        request: existing,
      };
    },

    async reserve({ request, user }) {
      const requiredCredits = PricingCatalog.features.deep_reasoning.credits;
      const res = await db.query(
        'SELECT available, reserved, debt FROM credit_balances WHERE user_id = $1',
        [user.id],
      ).catch(() => ({ rows: [{ available: 10, reserved: 0, debt: 0 }] }));
      const balance = res.rows[0] || { available: 10, reserved: 0, debt: 0 };

      if (balance.available < requiredCredits) {
        return {
          rejected: true,
          status: 402,
          code: 'insufficient_credits',
          error: 'Insufficient credits to start stream',
          body: {
            error: 'insufficient_credits',
            required: requiredCredits,
            available: balance.available,
          },
        };
      }

      return {
        kind: 'reserved',
        reservedCredits: requiredCredits,
        balance: {
          available: balance.available - requiredCredits,
          reserved: balance.reserved + requiredCredits,
          debt: balance.debt,
        },
      };
    },

    async settle({ request, user, metered }) {
      await db.query(
        `INSERT INTO credit_usage_requests (user_id, client_request_id, status, settled_credits, billable_tokens, assistant_text)
         VALUES ($1, $2, 'settled', $3, $4, $5)
         ON CONFLICT (user_id, client_request_id) DO UPDATE
         SET status = 'settled', settled_credits = $3, billable_tokens = $4, assistant_text = $5, settled_at = NOW()`,
        [user.id, request.requestId, metered?.creditsUsed || 1, metered?.billableTokens || 0, metered?.assistantText || ''],
      ).catch(() => {});
      return { status: 'settled' };
    },

    async release({ request, user, failureClass }) {
      await db.query(
        `UPDATE credit_usage_requests SET status = 'released', failure_class = $3
         WHERE user_id = $1 AND client_request_id = $2`,
        [user.id, request.requestId, failureClass || 'unknown'],
      ).catch(() => {});
      return { status: 'released' };
    },
  };

  // 6. Construct Stream Port (SSE Emitter & Replay)
  let activeRes = null;
  const streamPort = {
    createEmitter({ requestId, pipelineRunId }) {
      if (!activeRes) return null;
      setSseHeaders(activeRes);
      return createStreamEmitter({
        requestId,
        pipelineRunId,
        write: (event) => writeSseEvent(activeRes, event),
      });
    },

    emitStart(emitter, { request }) {
      emitter?.emit?.('start', { conversation_id: request?.conversationId });
    },

    emitTextDelta(emitter, delta) {
      emitter?.emit?.('text_delta', { text: delta });
    },

    emitDone(emitter) {
      emitter?.emit?.('done', { delivery_status: 'delivered', stop_reason: 'complete' });
      activeRes?.end?.();
    },

    async streamProviderText(options = {}) {
      if (typeof callAIStream === 'function') {
        return callAIStream(options);
      }

      return streamProviderText({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_MODEL || 'gpt-4o',
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        onText: options.onText,
        abortSignal: options.signal,
      });
    },

    async replayExisting({ existing, res }) {
      const targetRes = res || activeRes;
      if (!targetRes) return { handled: true, streamed: false, statusCode: 200, body: existing };
      setSseHeaders(targetRes);
      const emitter = createStreamEmitter({
        requestId: existing.client_request_id,
        write: (event) => writeSseEvent(targetRes, event),
      });

      emitter.emit('start', { conversation_id: existing.conversation_id });
      if (existing.assistant_text) {
        emitter.emit('text_delta', { text: existing.assistant_text });
      }
      emitter.emit('done', { delivery_status: 'delivered', stop_reason: 'complete', replayed: true });
      targetRes.end?.();

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
      activeRes = res;
      const user = req.user || { id: '00000000-0000-0000-0000-000000000001', email: 'guest@example.com' };
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
    } catch (err) {
      if (!res.headersSent) {
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
      }
      res.end();
    } finally {
      activeRes = null;
    }
  });

  return router;
}
