export class AgentRuntimeError extends Error {
  constructor(failureClass, code, message, {
    retryable = false,
    stopReason = "failed",
    status = 500,
  } = {}) {
    super(message);
    this.name = "AgentRuntimeError";
    this.failureClass = failureClass;
    this.code = code;
    this.retryable = retryable;
    this.stopReason = stopReason;
    this.status = status;
  }
}

export function classifyRuntimeError(error, abortReason, phase) {
  const reason = typeof abortReason === "function" ? abortReason() : abortReason;
  if (reason === "user_stop") {
    return new AgentRuntimeError("user_stop", "user_stop", "Generation was stopped by the user", {
      stopReason: "user_stop",
      status: 200,
    });
  }
  if (reason === "client_disconnect") {
    return new AgentRuntimeError("client_disconnect", "client_disconnect", "Client connection closed", {
      retryable: true,
      status: 499,
    });
  }
  if (error instanceof AgentRuntimeError) return error;

  const code = error?.code || "runtime_error";
  const retryable = Boolean(error?.retryable);
  const failureClass = phase === "settlement"
    ? "persistence_failure"
    : retryable
      ? "provider_unavailable"
      : "provider_protocol_error";

  return new AgentRuntimeError(
    failureClass,
    code,
    error?.message || "An error occurred during agent execution",
    { retryable, status: error?.status || 500 },
  );
}

/**
 * Creates an extensible streaming Agent Runtime.
 * Decouples runtime execution flow from downstream domain entities, database schemas, and product billing policies.
 */
export function createAgentRuntime(runtimeDefaults = {}) {
  return async function executeAgent(callOptions = {}) {
    const options = { ...runtimeDefaults, ...callOptions };
    const {
    request,
    user,
    db,
    env = process.env,
    logger = console,
    signal,
    abortReason = () => null,
    onActive = () => {},
    onContextDiagnostics = () => {},
    classifyError = null,
    // Injected Ports
    billingPort = {},
    requestPort = {},
    domainPort = {},
    contextPort = {},
    promptPort = {},
    streamPort = {},
    validationPort = {},
    memoryPort = {},
    telemetryPort = {},
    errorPort = runtimeDefaults.errorPort || {},
  } = options;
    let phase = "preflight";
    let reservation = null;
    let emitter = null;
    let settled = false;
    let canonicalRequest = request;
    let providerResult = null;

    try {
      // 1. Idempotency & existing request check
      if (typeof billingPort.getRequest === "function") {
        const existing = await billingPort.getRequest({ request, user, db });
        if (existing?.rejected) {
          return {
            handled: true,
            streamed: false,
            statusCode: existing.status || existing.statusCode || 409,
            status: existing.status || existing.statusCode || 409,
            error: existing.error,
            code: existing.code,
            body: existing.body,
          };
        }
        if (existing?.isExisting || existing?.replayed) {
          if (typeof streamPort.replayExisting === "function") {
            const replayedResult = await streamPort.replayExisting({
              request,
              canonicalRequest: canonicalRequest || request,
              existing: existing.request || existing,
              balance: existing.balance,
              user,
              db,
              env,
            });
            if (replayedResult) return replayedResult;
          }
          if (existing?.status === "active" || existing?.statusCode === 202) {
            return {
              handled: true,
              streamed: false,
              statusCode: 202,
              status: 202,
              body: existing.body || existing.request || existing,
              request: existing.request || existing,
            };
          }
          return {
            handled: true,
            streamed: false,
            statusCode: existing.status || existing.statusCode || 200,
            status: existing.status || existing.statusCode || 200,
            body: existing.body || existing.request || existing,
            request: existing.request || existing,
            replayed: true,
          };
        }
      }

      // 2. Request preparation & domain preflight
      const prepareFn = domainPort.prepare || requestPort.prepare;
      if (typeof prepareFn === "function") {
        phase = "preflight";
        const prepared = await prepareFn({ request, user, db, env, logger });
        if (prepared?.rejected) {
          return {
            handled: true,
            streamed: false,
            statusCode: prepared.status || 400,
            status: prepared.status || 400,
            error: prepared.error,
            code: prepared.code,
            body: prepared.body || {
              error: prepared.error,
              code: prepared.code,
              request_id: request?.clientRequestId || request?.request_id || request?.id,
            },
          };
        }
        if (prepared?.request) {
          canonicalRequest = prepared.request;
        }
      }


      // 3. Reservation / quota lock
      if (typeof billingPort.reserve === "function") {
        phase = "reservation";
        reservation = await billingPort.reserve({ request: canonicalRequest, user, db, env });
        if (reservation?.rejected) {
          return {
            handled: true,
            streamed: false,
            statusCode: reservation.status || 402,
            status: reservation.status || 402,
            error: reservation.error,
            code: reservation.code,
            balance: reservation.balance,
            body: reservation.body || {
              error: reservation.error,
              code: reservation.code,
              request_id: canonicalRequest?.clientRequestId || canonicalRequest?.id,
              ...(reservation.balance ? { ask_credit_balance: reservation.balance } : {}),
            },
          };
        }
        if (reservation?.isExisting || reservation?.kind === "existing") {
          if (typeof streamPort.replayExisting === "function") {
            const replayedResult = await streamPort.replayExisting({
              request,
              canonicalRequest,
              existing: reservation.request || reservation,
              balance: reservation.balance,
              createdConversation: canonicalRequest?.createdConversation,
              conversationId: canonicalRequest?.conversationId,
              user,
              db,
              env,
            });
            if (replayedResult) return replayedResult;
          }
          if (reservation?.status === "active" || reservation?.statusCode === 202) {
            return {
              handled: true,
              streamed: false,
              statusCode: 202,
              status: 202,
              body: reservation.body || reservation.request || reservation,
              request: reservation.request || reservation,
            };
          }
          return {
            handled: true,
            streamed: false,
            statusCode: 200,
            status: 200,
            request: reservation.request,
            balance: reservation.balance,
            body: reservation.body || reservation.request,
            replayed: true,
          };
        }
      }



      // 4. Emitter initialization & lifecycle start
      if (typeof streamPort.createEmitter === "function") {
        emitter = streamPort.createEmitter({
          requestId: canonicalRequest?.clientRequestId || canonicalRequest?.request_id || canonicalRequest?.id || request?.clientRequestId || request?.request_id || request?.id,
          pipelineRunId: canonicalRequest?.pipelineRunId,
        });
        if (typeof streamPort.emitStart === "function") {
          streamPort.emitStart(emitter, { request: canonicalRequest, reservation, env });
        }
      }


      if (typeof onActive === "function") {
        onActive({ request: canonicalRequest, reservation });
      }

      // 5. Context resolution & dynamic budgeting
      phase = "context";
      let context = null;
      let budget = null;
      if (typeof contextPort.resolveContext === "function") {
        context = await contextPort.resolveContext({ request: canonicalRequest, user, db, env, logger });
      }
      if (typeof contextPort.allocateBudget === "function") {
        budget = await contextPort.allocateBudget({ context, request: canonicalRequest, env });
        if (budget?.diagnostics && typeof onContextDiagnostics === "function") {
          onContextDiagnostics(budget.diagnostics);
        }
        if (budget?.context) {
          context = budget.context;
        }
      }

      // 6. Prompt composition (explicitly receives budget alongside context and reservation)
      phase = "prompt";
      let promptPayload = null;
      if (typeof promptPort.composePrompt === "function") {
        promptPayload = await promptPort.composePrompt({ request: canonicalRequest, reservation, context, budget, user, env });
      }

      // 6. Provider Streaming & Validation-Before-Delivery
      phase = "generation";
      let accumulatedRawText = "";
      let finalDeliveredText = "";

      // Initialize validation delivery buffer if port provided
      const delivery = typeof validationPort.createDelivery === "function"
        ? await validationPort.createDelivery({
            request: canonicalRequest,
            reservation,
            context,
            onCommit: (committedDelta) => {
              finalDeliveredText += committedDelta;
              if (emitter && typeof streamPort.emitTextDelta === "function") {
                streamPort.emitTextDelta(emitter, committedDelta);
              }
            },
          })
        : null;

      const streamProvider = streamPort.streamProviderText || runtimeDefaults.streamProviderText;

      if (typeof streamProvider === "function") {
        providerResult = await streamProvider({
          ...promptPayload,
          request: canonicalRequest,
          reservation,
          signal,
          onText: async (delta) => {
            accumulatedRawText += delta;
            if (delivery && typeof delivery.push === "function") {
              await delivery.push(delta);
            } else if (!delivery && emitter && typeof streamPort.emitTextDelta === "function") {
              // Direct emission only when no semantic validation buffer is configured
              finalDeliveredText += delta;
              streamPort.emitTextDelta(emitter, delta);
            }
          },
        });
      }

      let deliveryResult = null;
      if (delivery && typeof delivery.flush === "function") {
        deliveryResult = await delivery.flush({ providerResult });
      }

      const outputText = delivery
        ? (deliveryResult?.visibleText ?? finalDeliveredText)
        : accumulatedRawText;

      // 7. Settlement (two-phase commit)
      phase = "settlement";
      let settlement = null;
      if (typeof billingPort.settle === "function") {
        settlement = await billingPort.settle({
          request: canonicalRequest,
          user,
          db,
          reservation,
          providerResult,
          output: outputText,
          rawOutput: accumulatedRawText,
          deliveryResult,
          signal,
          shouldAbort: () => Boolean(signal?.aborted),
        });
        settled = true;
      }

      // 8. Post-settlement memory & telemetry hooks (must never trigger release on error)
      if (typeof memoryPort.persistCandidate === "function") {
        try {
          await memoryPort.persistCandidate({
            request: canonicalRequest,
            user,
            db,
            context,
            output: outputText,
            deliveryResult,
            reservation,
            settlement,
            signal,
          });
        } catch (error) {
          logger.warn?.("[agent-runtime] post-settlement memory hook warning", { error: error?.message });
        }
      }


      if (typeof telemetryPort.record === "function") {
        try {
          await telemetryPort.record({
            request: canonicalRequest,
            user,
            providerResult,
            settlement,
            context,
          });
        } catch (error) {
          logger.warn?.("[agent-runtime] telemetry hook warning", { error: error?.message });
        }
      }

      // 9. Done event
      if (emitter && typeof streamPort.emitDone === "function") {
        try {
          streamPort.emitDone(emitter, {
            request: canonicalRequest,
            reservation,
            settlement,
            deliveryStatus: "delivered",
            stopReason: "complete",
          });
        } catch (error) {
          logger.warn?.("[agent-runtime] emitDone error", { error: error?.message });
        }
      }


      return {
        handled: true,
        streamed: Boolean(emitter),
        terminalStatus: settlement?.status || "settled",
        requestId: canonicalRequest?.clientRequestId || canonicalRequest?.id,
        conversationId: canonicalRequest?.conversationId,
        replayed: Boolean(settlement?.replay || settlement?.replayed),
        output: outputText,
        settlement,
        providerResult,
      };
    } catch (error) {
      const runError = typeof errorPort.classify === "function"


        ? errorPort.classify(error, abortReason, phase)
        : typeof classifyError === "function"
          ? classifyError(error, abortReason, phase)
          : classifyRuntimeError(error, abortReason, phase);

      logger.error?.(`[agent-runtime] execution failed in phase [${phase}]`, {
        code: runError.code,
        message: runError.message,
      });

      // Release reserved credits ONLY IF not already settled
      if (reservation && !settled && typeof billingPort.release === "function") {
        try {
          await billingPort.release({
            request: canonicalRequest,
            user,
            db,
            reservation,
            providerResult,
            error: runError,
          });
        } catch (releaseErr) {
          logger.error?.("[agent-runtime] release failed", { error: releaseErr?.message });
          if (typeof billingPort.markReconciliation === "function") {
            await billingPort.markReconciliation({ request: canonicalRequest, user, db, reservation }).catch(() => {});
          }
        }
      }


      if (emitter && typeof streamPort.emitError === "function") {
        streamPort.emitError(emitter, runError);
      }

      return {
        handled: true,
        streamed: Boolean(emitter),
        terminalStatus: "released",
        requestId: canonicalRequest?.clientRequestId || canonicalRequest?.id,
        conversationId: canonicalRequest?.conversationId,
        statusCode: runError.statusCode || runError.status || 500,
        status: runError.statusCode || runError.status || 500,
        error: runError.message || runError,
        code: runError.code,
        body: !emitter ? {
          error: runError.message,
          code: runError.code,
          request_id: canonicalRequest?.clientRequestId || canonicalRequest?.id,
          conversation_id: canonicalRequest?.conversationId,
          ...(reservation?.balance ? { ask_credit_balance: reservation.balance } : {}),
        } : undefined,
        phase,
        replayed: false,
      };
    }

  };
}

