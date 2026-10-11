import express from 'express';
import { createStreamEmitter, writeSseEvent, setSseHeaders } from '@yuva/ai-engine';
import { createAiProduct, publicQuote } from '../domain/aiProduct.js';
import { createChatUseCase } from '../application/chatUseCase.js';
import { toPublicError } from '../http/errors.js';

export function createChatStreamRoutes({ db, adapter, callAIStream, validateOutput,
  operationStore, usageStore, env = process.env, product = createAiProduct({ env }) } = {}) {
  const router = express.Router();
  // 6. Stream Port (Completely Request-Scoped with terminal error support)
  const deliveryPort = {
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

  const executeChat = createChatUseCase({ db, adapter, callAIStream, validateOutput,
    operationStore, usageStore, env, product, deliveryPort });

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
      try { result = await executeChat({
        request: req.body,
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
