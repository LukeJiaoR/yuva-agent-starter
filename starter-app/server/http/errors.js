const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,79}$/u;

const PUBLIC_MESSAGES = Object.freeze({
  unsupported_operation: 'This task type and execution mode are not enabled.',
  invalid_json: 'The request body must be valid JSON.',
  invalid_request: 'The request is invalid. Review the submitted fields and try again.',
  unauthorized: 'Authentication is required.',
  insufficient_credits: 'There are not enough credits for this request.',
  unsafe_output: 'The generated response did not pass validation.',
  provider_unavailable: 'The AI provider is temporarily unavailable. Please try again.',
  provider_overloaded: 'The AI provider is busy. Please try again.',
  internal_server_error: 'The server could not complete the request.',
  runtime_error: 'The request could not be completed.',
});

function safeCode(error) {
  const code = String(error?.code || '').trim();
  if (!SAFE_CODE_PATTERN.test(code)) return '';
  if (/^(?:provider_|runtime_|unsupported_operation|unsafe_output|invalid_request|unauthorized|insufficient_credits)/u.test(code)) {
    return code;
  }
  return '';
}

export function toPublicError(error) {
  if (error?.type === 'entity.parse.failed') {
    return { status: 400, code: 'invalid_json', message: PUBLIC_MESSAGES.invalid_json };
  }

  const explicitStatus = Number(error?.status || error?.statusCode);
  const code = safeCode(error);
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 500) {
    const publicCode = code || 'invalid_request';
    return {
      status: explicitStatus,
      code: publicCode,
      message: error?.publicMessage || PUBLIC_MESSAGES[publicCode] || PUBLIC_MESSAGES.invalid_request,
    };
  }

  if (error?.code === 'checkout_outcome_unknown') {
    return { status: 503, code: 'checkout_outcome_unknown', message: 'The synthetic order outcome is unknown. Keep the same request ID and retry or read the order.' };
  }

  if (code.startsWith('provider_')) {
    return { status: 503, code, message: PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.provider_unavailable };
  }
  if (code === 'unsafe_output') {
    return { status: 422, code, message: PUBLIC_MESSAGES.unsafe_output };
  }

  return {
    status: 500,
    code: 'internal_server_error',
    message: PUBLIC_MESSAGES.internal_server_error,
  };
}

export function sendPublicError(res, error) {
  const publicError = toPublicError(error);
  return res.status(publicError.status).json({
    error: publicError.code,
    message: publicError.message,
  });
}
