/** Version 1 contracts. Policies calculate; stores and ledger adapters enforce ownership. */
export const OPERATION_CONTRACT_VERSION = 1;
export const MAX_CREDITS = 2_147_483_647;
export const EXECUTION_STATES = Object.freeze(['pending', 'running', 'submission_unknown', 'succeeded', 'failed', 'cancelled']);
export const FINANCIAL_STATES = Object.freeze(['unreserved', 'reserved', 'settled', 'no_charge', 'released', 'reconciliation_required']);

export class OperationError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.status = status;
  }
}
export function invariant(condition, code = 'invalid_contract', status = 400) {
  if (!condition) throw new OperationError(code, code, status);
}
export function creditInteger(value) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= MAX_CREDITS, 'invalid_credits');
  return value;
}
function string(value, max = 160) {
  invariant(typeof value === 'string' && value.trim().length > 0 && value.length <= max);
}
function object(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value));
}
export function validateOperation(operation) {
  object(operation);
  for (const field of ['id', 'accountId', 'featureKey', 'clientRequestId', 'inputVersion']) string(operation[field], field === 'clientRequestId' ? 120 : ['featureKey', 'inputVersion'].includes(field) ? 80 : 160);
  invariant(['text', 'image', 'video'].includes(operation.taskType));
  invariant(['sync', 'stream', 'async'].includes(operation.mode));
  object(operation.input);
  return operation;
}
export function assertCapability(operation, capabilities = [{ taskType: 'text', mode: 'stream' }]) {
  invariant(capabilities.some((c) => c.taskType === operation.taskType && c.mode === operation.mode), 'unsupported_operation', 422);
}
export function validateLimits(limits) {
  object(limits);
  invariant(Array.isArray(limits.models) && limits.models.length > 0);
  limits.models.forEach((model) => string(model));
  for (const field of ['maxCalls', 'deadlineMs']) invariant(Number.isSafeInteger(limits[field]) && limits[field] > 0 && limits[field] <= MAX_CREDITS);
  invariant(Number.isSafeInteger(limits.maxRetries) && limits.maxRetries >= 0 && limits.maxRetries < limits.maxCalls);
  for (const field of ['maxInputTokens', 'maxOutputTokens', 'maxImages', 'maxDurationMs']) {
    if (limits[field] !== undefined) invariant(Number.isSafeInteger(limits[field]) && limits[field] > 0 && limits[field] <= MAX_CREDITS);
  }
  for (const field of ['maxTotalInputTokens', 'maxTotalOutputTokens']) {
    if (limits[field] !== undefined) invariant(Number.isSafeInteger(limits[field]) && limits[field] > 0 && limits[field] <= MAX_CREDITS);
  }
  if (limits.paths !== undefined) {
    invariant(Array.isArray(limits.paths) && limits.paths.length > 0);
    for (const path of limits.paths) { string(path.provider); string(path.model); invariant(limits.models.includes(path.model)); }
  }
  if (limits.specs !== undefined) object(limits.specs);
  return limits;
}
export function validateQuote(quote) {
  object(quote);
  invariant(quote.contractVersion === OPERATION_CONTRACT_VERSION);
  for (const field of ['policyId', 'policyVersion', 'fulfillmentVersion']) string(quote[field]);
  invariant(quote.unit === 'credit');
  creditInteger(quote.reserveCredits);
  creditInteger(quote.authorizedCredits);
  invariant(quote.reserveCredits <= quote.authorizedCredits, 'authorization_exceeded');
  invariant(['defer', 'estimate'].includes(quote.missingUsage));
  invariant(quote.billingScope === 'successful_calls');
  object(quote.terms);
  validateLimits(quote.limits);
  const created = Date.parse(quote.createdAt), expires = Date.parse(quote.expiresAt);
  invariant(Number.isFinite(created) && Number.isFinite(expires) && expires > created);
  return quote;
}
/** @returns {{ action: 'settle'|'release'|'defer', credits?: number, reason: string }} */
export function validateDecision(decision, quote) {
  validateQuote(quote);
  object(decision);
  string(decision.reason);
  invariant(['settle', 'release', 'defer'].includes(decision.action));
  if (decision.action === 'settle') {
    creditInteger(decision.credits);
    invariant(decision.credits <= quote.reserveCredits && decision.credits <= quote.authorizedCredits, 'authorization_exceeded');
  } else invariant(decision.credits === undefined || decision.credits === 0);
  return decision;
}
export function validateUsageRecord(record) {
  object(record);
  for (const field of ['operationId', 'callId', 'model', 'provider']) string(record[field]);
  invariant(Number.isSafeInteger(record.attempt) && record.attempt > 0);
  invariant(['started', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(record.outcome));
  object(record.metrics);
  const units = { inputTokens: 'token', outputTokens: 'token', totalTokens: 'token', cachedInputTokens: 'token', cacheWriteTokens: 'token', reasoningTokens: 'token', toolTokens: 'token', images: 'image', durationMs: 'millisecond' };
  for (const [name, metric] of Object.entries(record.metrics)) {
    invariant(units[name] && metric && metric.unit === units[name], 'invalid_usage_unit');
    invariant(metric.value === null || (Number.isSafeInteger(metric.value) && metric.value >= 0), 'invalid_usage_value');
    invariant(['provider', 'estimate', 'synthetic', 'missing'].includes(metric.source));
    invariant(metric.value !== null || metric.source === 'missing');
    invariant(metric.source !== 'missing' || metric.value === null);
  }
  return record;
}
export function validateFulfillment(result, accountId) {
  object(result);
  invariant(['ready', 'partial', 'failed', 'pending'].includes(result.status));
  string(result.ruleVersion);
  invariant(result.accountId === accountId, 'result_forbidden', 403);
  invariant(Array.isArray(result.artifacts));
  if (result.status === 'ready') {
    string(result.resultId);
    invariant(result.artifacts.length > 0, 'result_unavailable');
  }
  for (const artifact of result.artifacts) {
    string(artifact.id);
    invariant(artifact.accountId === accountId, 'result_forbidden', 403);
    invariant(['text', 'json', 'image', 'video'].includes(artifact.type));
    invariant(['available', 'pending', 'failed'].includes(artifact.state));
    if (result.status === 'ready') invariant(artifact.state === 'available', 'result_unavailable');
    if (artifact.state === 'available') {
      if (artifact.type === 'text') string(artifact.text, 2 * 1024 * 1024);
      if (artifact.type === 'json') object(artifact.value);
      if (['image', 'video'].includes(artifact.type)) {
        string(artifact.storageKey, 1024);
        invariant(!/^[a-z]+:\/\//iu.test(artifact.storageKey) && !artifact.storageKey.includes('?'), 'unstable_artifact_reference');
        object(artifact.specs);
      }
    }
  }
  return result;
}
