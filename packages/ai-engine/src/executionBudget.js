function requireBudget(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code, status: 409 });
}
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** Conservative local envelope for plain text only; never provider-measured usage. */
export function textInputEnvelope({ systemPrompt = '', messages = [] }) {
  requireBudget(typeof systemPrompt === 'string' && Array.isArray(messages), 'unsupported_budget_input');
  let bound = Buffer.byteLength(systemPrompt, 'utf8') + 256;
  for (const message of messages) {
    requireBudget(['system', 'user', 'assistant'].includes(message?.role) && typeof message.content === 'string', 'unsupported_budget_input');
    bound += Buffer.byteLength(message.content, 'utf8') + 256;
  }
  return bound;
}

export function executionRequest({ taskType, limits, provider, model, input = {}, capabilities }) {
  requireBudget(limits?.models?.includes(model), 'execution_model_forbidden');
  requireBudget(limits.paths?.some((path) => path.provider === provider && path.model === model), 'execution_path_forbidden');
  requireBudget(capabilities?.taskType === taskType && capabilities.outputLimit === true && capabilities.abort === true,
    'execution_capability_unsupported');
  if (taskType === 'text') {
    // Frozen quotes require enforceable numeric output holds. Reject before
    // invoking a metered provider or creating any durable usage entry.
    requireBudget(input.options?.outputTokenPolicy === undefined, 'execution_output_policy_unsupported');
    requireBudget(positive(limits.maxInputTokens) && positive(limits.maxOutputTokens), 'execution_limits_invalid');
    const inputTokens = textInputEnvelope(input);
    requireBudget(inputTokens <= limits.maxInputTokens, 'execution_input_exceeded');
    const outputTokens = input.options?.maxOutputTokens ?? limits.maxOutputTokens;
    requireBudget(positive(outputTokens) && outputTokens <= limits.maxOutputTokens, 'execution_output_exceeded');
    return { inputTokens, outputTokens, inputSource: 'estimate', inputMethod: 'utf8_envelope_v1' };
  }
  const field = taskType === 'image' ? 'images' : taskType === 'video' ? 'durationMs' : null;
  const limit = taskType === 'image' ? limits.maxImages : limits.maxDurationMs;
  requireBudget(field && positive(limit) && positive(input[field]) && input[field] <= limit, 'execution_media_exceeded');
  requireBudget(JSON.stringify(input.specs) === JSON.stringify(limits.specs), 'execution_specs_forbidden');
    return { [field]: input[field], specs: input.specs };
}

/** Minimal sequential coordinator. Durable start enforces the shared budget across instances. */
export function createBudgetedProvider({ operation, provider, model, capabilities, invoke, now = Date.now }) {
  requireBudget(operation?.id && operation.quote && operation.createdAt, 'execution_authorization_missing');
  const quote = structuredClone(operation.quote);
  const deadline = new Date(operation.createdAt).getTime() + quote.limits.deadlineMs;
  requireBudget(Number.isFinite(deadline), 'execution_limits_invalid');
  let active = false;
  return async (input = {}) => {
    requireBudget(!active, 'execution_call_active');
    requireBudget(now() < deadline && !input.signal?.aborted, 'execution_deadline_exceeded');
    const resources = executionRequest({ taskType: operation.taskType, limits: quote.limits, provider,
      model: input.model ?? model, input, capabilities });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Execution deadline', 'TimeoutError')), deadline - now());
    timer.unref?.();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    active = true;
    try {
      // Await provider termination even after abort: a local deadline is not proof of external cancellation.
      return await invoke({ ...input, model: input.model ?? model, signal,
        options: { ...input.options, maxOutputTokens: resources.outputTokens, maxOutputTokensCap: resources.outputTokens },
        executionBudget: { resources, kind: input.retryOf ? 'retry' : 'primary', retryOf: input.retryOf ?? null } });
    } finally { clearTimeout(timer); active = false; }
  };
}
