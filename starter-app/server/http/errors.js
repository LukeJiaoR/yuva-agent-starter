// Public messages and machine codes are application-owned. Never forward an
// exception's message/publicMessage, arbitrary code, stack, or provider body.
const PUBLIC_MESSAGES = Object.freeze({
  unsupported_operation: 'This task type and execution mode are not enabled.',
  context_budget_exceeded: 'The facts and question are too large. Shorten the parameters or question and try again.',
  invalid_json: 'The request body must be valid JSON.',
  invalid_request: 'The request is invalid. Review the submitted fields and try again.',
  unauthorized: 'Authentication is required.',
  insufficient_credits: 'There are not enough credits for this request.',
  unsafe_output: 'The generated response did not pass validation.',
  provider_unavailable: 'The AI provider is temporarily unavailable. Please try again.',
  provider_http_error: 'The AI provider could not complete this request. Please try again.',
  provider_connection_error: 'The AI provider is temporarily unavailable. Please try again.',
  provider_overloaded: 'The AI provider is busy. Please try again.',
  provider_refusal: 'The AI provider could not complete this request.',
  provider_aborted: 'The AI provider request was interrupted.',
  incomplete_provider_stream: 'The AI provider response was interrupted. Keep the same request ID.',
  provider_protocol_error: 'The AI provider returned an invalid response.',
  internal_server_error: 'The server could not complete the request.',
  runtime_error: 'The request could not be completed.',
  idempotency_conflict: 'This request ID has already been used for different input.',
  request_released: 'This request was released. Start a new request to try again.',
  request_refunded: 'This request was refunded. Start a new request to try again.',
  request_reconciliation_required: 'The request outcome is being checked. Keep the same request ID.',
  conversation_history_unavailable: 'Conversation history is temporarily unavailable. Please try again.',
  conversation_history_order_unavailable: 'This older conversation has messages whose order cannot be verified. Start a new conversation to continue; the original messages have been preserved.',
  chat_conversation_forbidden: 'Conversation is not available for this account.',
  chat_result_persistence_failed: 'Chat result persistence is temporarily unavailable.',
  usage_persistence_failed: 'Request usage could not be saved. Keep the same request ID.',
  commit_outcome_unknown: 'The request outcome is being checked. Keep the same request ID.',
  checkout_outcome_unknown: 'The synthetic order outcome is unknown. Keep the same request ID and retry or read the order.',
  user_stop: 'Generation was stopped by the user.',
  client_disconnect: 'The client connection closed.',
});
const INVALID_REQUEST_CODES = new Set([
  'invalid_request:order_not_found', 'invalid_request:idempotency_conflict',
  'invalid_request:unknown_product', 'invalid_request:order_not_pending',
  'operation_not_found', 'operation_forbidden', 'quote_expired', 'policy_version_unavailable',
  'execution_fenced', 'execution_lease_lost', 'execution_authorization_missing',
  'execution_deadline_exceeded', 'execution_calls_exceeded', 'execution_outcome_unknown',
  'execution_retry_required', 'execution_retry_invalid', 'execution_retries_exceeded',
  'execution_input_exceeded', 'execution_output_exceeded', 'execution_media_exceeded',
  'execution_model_forbidden', 'execution_call_active', 'execution_capability_unsupported',
  'execution_output_policy_unsupported', 'execution_limits_invalid', 'execution_or_delivery_unknown',
  'execution_resources_exceeded', 'execution_path_forbidden', 'execution_specs_forbidden',
  'fulfillment_version_mismatch', 'result_identity_conflict', 'result_unavailable',
]);
const FINANCIAL_STATUSES = new Set(['unreserved', 'reserved', 'settled', 'no_charge', 'released',
  'refunded', 'reconciliation_required']);

export function toPublicError(error) {
  if (error?.type === 'entity.parse.failed') {
    return { status: 400, code: 'invalid_json', message: PUBLIC_MESSAGES.invalid_json };
  }
  const explicitStatus = Number(error?.statusCode || error?.status);
  const knownCode = Object.hasOwn(PUBLIC_MESSAGES, error?.code) || INVALID_REQUEST_CODES.has(error?.code);
  const status = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
    ? explicitStatus
    : error?.code === 'user_stop' ? 200
      : error?.code === 'unsafe_output' ? 422
        : ['provider_unavailable', 'provider_overloaded', 'provider_http_error', 'provider_connection_error', 'incomplete_provider_stream', 'checkout_outcome_unknown'].includes(error?.code) ? 503 : 500;
  const code = knownCode ? error.code : status < 500 ? 'invalid_request' : 'internal_server_error';
  return { status, code, message: PUBLIC_MESSAGES[code]
    || (status < 500 ? PUBLIC_MESSAGES.invalid_request : PUBLIC_MESSAGES.internal_server_error) };
}

/** Shared safe error data for both handled runtime results and thrown errors. */
export function publicChatError(error) {
  const source = error?.body && typeof error.body === 'object' ? { ...error.body, ...error } : error;
  const publicError = toPublicError(source);
  const financialStatus = source?.terminalStatus ?? source?.financialStatus ?? source?.financial_status
    ?? ({ request_released: 'released', request_refunded: 'refunded',
      request_reconciliation_required: 'reconciliation_required' })[publicError.code];
  const body = { error: publicError.code, code: publicError.code, message: publicError.message,
    retryable: source?.retryable === true,
    ...(FINANCIAL_STATUSES.has(financialStatus) ? { financial_status: financialStatus } : {}) };
  // These numeric credit facts are the only extra rejection payload permitted.
  for (const key of ['required_credits', 'available_credits']) {
    if (Number.isSafeInteger(source?.[key]) && source[key] >= 0) body[key] = source[key];
  }
  return { status: publicError.status, body };
}

export function sendPublicError(res, error) {
  const publicError = toPublicError(error);
  return res.status(publicError.status).json({ error: publicError.code, message: publicError.message });
}
