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

  // 1. Domain Port (Ensures deterministic facts & tenant-isolated conversation history)
  const domainPort = {
    async prepare({ request, user, db: activeDb }) {
      const input = request || {};
      const conversationId = input.conversationId || input.conversation_id || crypto.randomUUID();
      const clientRequestId = input.requestId || input.clientRequestId || input.request_id || crypto.randomUUID();
      const question = input.question || 'Hello!';

      // Load conversation history from database with strict user ownership enforcement
      let history = [];
      try {
        const histRes = await activeDb.query(
          `SELECT m.role, m.content
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = $1 AND c.user_id = $2
            ORDER BY m.created_at DESC
            LIMIT 20`,
          [conversationId, user.id],
        );
        // Reverse recent 20 messages into chronological order
        history = (histRes.rows || []).slice().reverse();
      } catch {
        history = [];
      }

      // Compute deterministic domain facts and snapshot
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

  // 3. Prompt Port (Authoritative Messages: built strictly from allocated context units)
  const promptPort = {
    async composePrompt({ context }) {
      const systemPrompt = DomainPrompts.formatSystemPrompt(context?.contextPayload || {});
      const messageUnits = context?.messageUnits || [];

      const messages = messageUnits.map((unit) => {
        if (unit.key === 'user.question') {
          return { role: 'user', content: unit.text };
        }
        const colonIndex = unit.text.indexOf(': ');
        if (colonIndex > 0) {
          const role = unit.text.slice(0, colonIndex);
          const content = unit.text.slice(colonIndex + 2);
          if (role === 'user' || role === 'assistant' || role === 'system') {
            return { role, content };
          }
        }
        return { role: 'user', content: unit.text };
      });

      const userUnit = messageUnits.find((u) => u.key === 'user.question');
      const userPrompt = userUnit ? userUnit.text : '';

      return {
        systemPrompt,
        messages,
        userPrompt,
      };
    },
  };

  // 4. Validation Port (Buffered Delivery Hook & Validation Extension Point)
  const validationPort = {
    async createDelivery({ onCommit }) {
      let buffer = '';
      return {
        async push(delta) {
          buffer += delta;
          onCommit(delta);
        },
        async flush() {
          const text = buffer.trim();
          if (!text) {
            throw new Error('Assistant generated an empty response');
          }
          return {
            visibleText: text,
            valid: true,
          };
        },
      };
    },
  };

  // 5. Billing Port (Using real @yuva/billing-core with full two-phase ledger persistence)
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
            status: 202,
            body: {
              request_id: existing.client_request_id,
              status: existing.status,
              message: 'Request is currently processing',
            },
            request: existing,
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
        const status = result.request?.status;
        if (status === 'generating' || status === 'reserved') {
          return {
            isExisting: true,
            replayed: false,
            streamed: false,
            statusCode: 202,
            status: 202,
            body: {
              request_id: result.request.client_request_id,
              status: result.request.status,
              message: 'Request is currently processing',
            },
            request: result.request,
            balance: result.balance,
          };
        }
        if (status === 'settled') {
          return {
            isExisting: true,
            replayed: true,
            request: result.request,
            balance: result.balance,
          };
        }
        return {
          rejected: true,
          status: 409,
          code: `request_${status}`,
          error: `Request has terminal status ${status} and cannot be replayed`,
          body: {
            error: `request_${status}`,
            code: `request_${status}`,
            message: `Previous request has status ${status} and cannot be replayed.`,
            request_id: result.request.client_request_id,
            status,
          },
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
        persistResult: async (client, usageRequest) => {
          await client.query(
            `UPDATE credit_usage_requests
                SET assistant_text = $2,
                    billable_tokens = $3,
                    settled_at = NOW(),
                    updated_at = NOW()
              WHERE id = $1`,
            [usageRequest.id, textToSave, billableTokens],
          );
          return { id: usageRequest.id };
        },
        metadata: {
          conversation_id: request.conversationId,
        },
      });

      // Persist conversation & messages with strict tenant ownership
      if (request?.conversationId) {
        await activeDb.query(
          `INSERT INTO conversations (id, user_id, domain_key, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE
              SET updated_at = NOW()
            WHERE conversations.user_id = $2`,
          [request.conversationId, user.id, adapter.domainKey],
        ).catch(() => {});

        await activeDb.query(
          `INSERT INTO messages (conversation_id, role, content, created_at)
           SELECT c.id, 'user', $2, NOW()
             FROM conversations c
            WHERE c.id = $1 AND c.user_id = $4
            UNION ALL
           SELECT c.id, 'assistant', $3, NOW()
             FROM conversations c
            WHERE c.id = $1 AND c.user_id = $4`,
          [request.conversationId, request.question, textToSave, user.id],
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

  // 6. Stream Port (Completely Request-Scoped with terminal error support)
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

    emitError(emitter, error) {
      emitter?.emit?.('error', {
        code: error?.code || 'runtime_error',
        message: error?.message || 'Streaming terminated unexpectedly',
        retryable: error?.retryable ?? false,
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
        signal: options.signal || options.abortSignal,
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
      const isProduction = (env.NODE_ENV || process.env.NODE_ENV) === 'production';
      const allowDevGuest = String(env.ALLOW_DEV_GUEST || '').toLowerCase() === 'true';

      let user = req.user;
      if (!user) {
        if (isProduction || !allowDevGuest) {
          return res.status(401).json({
            error: 'unauthorized',
            message: 'Authentication required. Missing or invalid authentication token.',
          });
        }
        user = {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'dev-guest@example.local',
          display_name: 'Dev Guest',
        };
      }

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
      try {
        writeSseEvent(res, {
          event: 'error',
          data: {
            error: err.code || 'runtime_error',
            message: err.message || 'Streaming terminated unexpectedly',
          },
        });
      } catch {}
      res.end();
    }
  });

  return router;
}
