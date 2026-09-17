import express from 'express';
import crypto from 'node:crypto';
import {
  createAgentRuntime,
  createStreamEmitter,
  writeSseEvent,
  setSseHeaders,
  streamProviderText,
  countUnicodeTokens,
  createMeteredProvider,
  createBudgetedProvider,
  executionRequest,
  createSyntheticProviderResult,
} from '@yuva/ai-engine';
import { allocateContextBudget } from '@yuva/context-engine';
import {
  createOperationStore,
  getCreditBalance,
  assertCapability,
} from '@yuva/billing-core';
import { DomainPrompts } from '../domain/prompts.js';
import { createAiProduct, publicQuote } from '../domain/aiProduct.js';
import { createUsageStore } from '../stores/usageStore.js';
import { toPublicError } from '../http/errors.js';

export function createChatStreamRoutes({
  db,
  adapter,
  callAIStream,
  validateOutput,
  operationStore = createOperationStore({ db }),
  usageStore = createUsageStore({ db }),
  env = process.env,
  product = createAiProduct({ env }),
} = {}) {
  const router = express.Router();
  const { provider, model, executionLimits, capabilities } = product;
  const identity = (input, accountId, clientRequestId) => ({
    accountId, clientRequestId, featureKey: product.featureKey,
    taskType: 'text', mode: 'stream', inputVersion: '1',
    input: { question: input.question, subject: input.subject || 'Default Subject', parameters: input.parameters || {},
      conversationId: input.conversationId || input.conversation_id || null, domainKey: adapter.domainKey },
  });
  const operationBilling = product.createBilling({ db, operationStore, usageStore });
  function existingOperation(operation) {
    const status = operation.financialStatus;
    if (['settled', 'no_charge'].includes(status) && operation.fulfillment?.status === 'ready') {
      return { isExisting: true, replayed: true, request: { status: 'settled', financialStatus: status,
        pricing: publicQuote(operation.quote), creditsUsed: operation.decision?.credits ?? 0,
        client_request_id: operation.clientRequestId, assistant_text: operation.fulfillment.artifacts.find((a) => a.type === 'text')?.text || '' } };
    }
    if (status === 'released') return { rejected: true, status: 409, code: 'request_released', error: 'Request was released' };
    return { isExisting: true, statusCode: 202, status: 202,
      body: { request_id: operation.clientRequestId, status: status === 'reserved' ? 'generating' : status },
      request: { status: 'generating', client_request_id: operation.clientRequestId } };
  }

  function normalizeRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const error = new Error('Request body must be an object');
      error.status = 400;
      error.code = 'invalid_request';
      throw error;
    }
    assertCapability({ taskType: body.taskType ?? 'text', mode: body.mode ?? 'stream' });
    const question = String(body.question || '').trim();
    if (!question || question.length > 4000) {
      const error = new Error('Question must contain between 1 and 4000 characters');
      error.status = 400;
      error.code = 'invalid_request';
      throw error;
    }
    const requestId = String(body.requestId || body.clientRequestId || body.request_id || '').trim();
    if (requestId && (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/u.test(requestId))) {
      const error = new Error('Request ID is invalid');
      error.status = 400;
      error.code = 'invalid_request';
      throw error;
    }
    const conversationId = String(body.conversationId || body.conversation_id || '').trim();
    if (conversationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(conversationId)) {
      const error = new Error('Conversation ID must be a UUID');
      error.status = 400;
      error.code = 'invalid_request';
      throw error;
    }
    return { ...body, question, ...(requestId ? { requestId } : {}), ...(conversationId ? { conversationId } : {}) };
  }

  // 1. Domain Port (Ensures deterministic facts & tenant-isolated conversation history)
  const domainPort = {
    async prepare({ request, user, db: activeDb }) {
      const input = normalizeRequest(request);
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
          operationInput: identity(input, user.id, clientRequestId),
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
    async createDelivery({ request }) {
      let buffer = '';
      let approvedText = '';
      return {
        async push(delta) {
          buffer += delta;
        },
        async flush({ providerResult }) {
          if (['safety_refusal', 'provider_error'].includes(providerResult?.outcome)) {
            throw Object.assign(new Error('Provider did not produce an accepted result'), { code: 'provider_refusal', status: 422 });
          }
          const text = buffer.trim();
          if (!text) {
            throw new Error('Assistant generated an empty response');
          }
          const validation = typeof validateOutput === 'function'
            ? await validateOutput({ text, request })
            : { valid: true, visibleText: text };
          if (validation === false || validation?.valid === false) {
            const error = new Error('Generated output did not pass validation');
            error.code = 'unsafe_output';
            error.status = 422;
            throw error;
          }
          const visibleText = typeof validation?.visibleText === 'string'
            ? validation.visibleText.trim()
            : text;
          if (!visibleText) {
            const error = new Error('Validated output is empty');
            error.code = 'unsafe_output';
            error.status = 422;
            throw error;
          }
          approvedText = visibleText;
          return {
            visibleText,
            valid: true,
          };
        },
        async commit({ onCommit }) {
          if (approvedText) onCommit(approvedText);
        },
      };
    },
  };

  // 5. Billing Port (Using real @yuva/billing-core with full two-phase ledger persistence)
  const billingPort = {
    async getRequest({ request, user, db: activeDb }) {
      const clientRequestId = request.requestId || request.clientRequestId || request.request_id;
      if (!clientRequestId) return null;

      const operation = await operationStore.find({ accountId: user.id, clientRequestId,
        operation: identity(request, user.id, clientRequestId) });
      if (operation) return existingOperation(operation);
      {
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
      }
      return null;
    },

    async reserve({ request, user, db: activeDb }) {
      const requiredCredits = product.policy.quote(request.operationInput, executionLimits).reserveCredits;

      const result = await operationBilling.reserve({ request, user });
      if (result.kind === 'existing') {
        return existingOperation(result.operation);
      }
      if (result.kind === 'legacy') result.kind = 'existing';

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
        operation: result.operation,
        reservedCredits: result.operation.quote.reserveCredits,
        reservationId: result.request?.id,
        request: result.request,
        balance: result.balance,
      };
    },

    async settle(context) {
      const { request, user, db: activeDb, providerResult, output } = context;
      const textToSave = output;
      const billableTokens = providerResult?.usage?.source === 'provider'
        ? providerResult.usage.totalTokens ?? null : null;
      const settlement = await operationBilling.settle(context);
      if (!['settled', 'no_charge'].includes(settlement.status)) return settlement;

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
        status: settlement.status,
        creditsUsed: settlement.creditsUsed,
        billableTokens,
      };
    },

    async release(context) {
      return operationBilling.release(context);
    },
    onFailure: (context) => operationBilling.onFailure(context),
  };

  // 6. Stream Port (Completely Request-Scoped with terminal error support)
  const streamPort = {
    emitPending(emitter, { settlement }) {
      emitter?.emit?.('pending', { status: settlement.status });
    },
    createEmitter({ req, res, requestId, pipelineRunId }) {
      if (!res) return null;
      setSseHeaders(res);
      return createStreamEmitter({
        requestId,
        pipelineRunId,
        write: (event) => writeSseEvent(res, event),
      });
    },

    emitStart(emitter, { request, reservation }) {
      emitter?.emit?.('start', {
        conversation_id: request?.conversationId,
        pipeline_run_id: request?.pipelineRunId,
        pricing: reservation?.operation?.quote ? publicQuote(reservation.operation.quote) : undefined,
      });
    },

    emitTextDelta(emitter, delta) {
      emitter?.emit?.('text_delta', { text: delta });
    },

    emitDone(emitter, { settlement } = {}) {
      emitter?.emit?.('done', {
        delivery_status: 'delivered',
        stop_reason: 'complete',
        credits_used: settlement?.creditsUsed,
        financial_status: settlement?.status,
      });
    },

    emitError(emitter, error) {
      const publicError = toPublicError(error);
      emitter?.emit?.('error', {
        code: publicError.code,
        message: publicError.message,
        retryable: error?.retryable ?? false,
        financial_status: error?.financialStatus,
      });
    },

    async streamProviderText(options = {}) {
      if (typeof callAIStream === 'function') {
        return callAIStream(options);
      }

      const provider = env.AI_PROVIDER || 'openai';
      if (provider === 'mock') {
        if ((env.NODE_ENV || process.env.NODE_ENV) === 'production') {
          const error = new Error('Mock provider is disabled in production');
          error.code = 'provider_unavailable';
          error.status = 503;
          throw error;
        }
        const text = `Starter response for: ${options.userPrompt || options.messages?.at(-1)?.content || 'your question'}`;
        await options.onText(text);
        return createSyntheticProviderResult({ text, provider: 'mock', model: 'starter-local' });
      }
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
        options: options.options,
      });
    },

    async replayExisting({ existing, res }) {
      if (!res) return { handled: true, streamed: false, statusCode: 200, body: existing };
      setSseHeaders(res);
      const emitter = createStreamEmitter({
        requestId: existing.client_request_id,
        write: (event) => writeSseEvent(res, event),
      });

      emitter.emit('start', { conversation_id: existing.conversation_id, pricing: existing.pricing });
      if (existing.assistant_text) {
        emitter.emit('text_delta', { text: existing.assistant_text });
      }
      emitter.emit('done', {
        delivery_status: 'delivered',
        stop_reason: 'complete',
        replayed: true,
        credits_used: existing.creditsUsed ?? existing.settled_credits,
        financial_status: existing.financialStatus ?? existing.status,
      });
      res.end();

      return {
        handled: true,
        streamed: true,
        terminalStatus: existing.financialStatus || 'settled',
        replayed: true,
      };
    },
  };

  // Initialize Generic Agent Runtime
  const runtime = createAgentRuntime({
    prepareBeforeReserve: true,
    executionPort: { preflight: ({ promptPayload }) => executionRequest({ taskType: 'text', limits: executionLimits,
      provider, model, input: promptPayload, capabilities }) },
    domainPort,
    contextPort,
    promptPort,
    validationPort,
    billingPort,
    streamPort,
    usagePort: {
      invoke({ invoke, options, reservation }) {
        const metered = createMeteredProvider({ store: usageStore, operation: reservation.operation, provider, model,
          attempt: reservation.request?.attempt_no || 1, invoke });
        return createBudgetedProvider({ operation: reservation.operation, provider, model, capabilities, invoke: metered })(options);
      },
    },
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

      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort('client_disconnect'); };
      req.once?.('aborted', disconnected);
      res.once?.('close', disconnected);
      let result;
      try { result = await runtime({
        request: normalizeRequest(req.body),
        user,
        req,
        res,
        db,
        env,
        signal: controller.signal,
        abortReason: () => controller.signal.aborted ? 'client_disconnect' : null,
      }); } finally {
        req.off?.('aborted', disconnected);
        res.off?.('close', disconnected);
      }

      if (!result.streamed && !res.headersSent) {
        return res.status(result.statusCode || result.status || 200).json(result.body || result);
      }
      if (result.streamed && !res.writableEnded) {
        res.end();
      }
    } catch (err) {
      const publicError = toPublicError(err);
      if (!res.headersSent) {
        return res.status(publicError.status).json({
          error: publicError.code,
          message: publicError.message,
        });
      }
      try {
        writeSseEvent(res, {
          event: 'error',
          data: {
            error: publicError.code,
            message: publicError.message,
          },
        });
      } catch {}
      res.end();
    }
  });

  return router;
}
