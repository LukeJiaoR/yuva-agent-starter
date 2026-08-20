import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_ALLOWED_ROLES = Object.freeze(new Set(['support', 'product', 'finance', 'super_admin']));
export const DEFAULT_ENVIRONMENTS = Object.freeze(new Set(['test', 'production']));
const COMPLETED_STATUSES = new Set(['succeeded', 'failed', 'needs_reconciliation']);
const ALL_STATUSES = new Set(['pending', ...COMPLETED_STATUSES]);
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const SENSITIVE_STEMS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'session',
  'prompt',
  'content',
  'credentials',
  'rawpayload',
  'rawbody',
  'providerresponse',
];
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MACHINE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,79}$/u;
const SUMMARY_MACHINE_CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,79}$/u;
const SUMMARY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$/u;
const RESULT_SUMMARY_MAX_BYTES = 8192;
const RESULT_SUMMARY_ARRAY_MAX_ITEMS = 100;
const BEGIN_CANONICAL_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 5_000,
  maxStringBytes: 16_384,
  maxBytes: 65_536,
});
const RESULT_SUMMARY_CANONICAL_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 512,
  maxStringBytes: 128,
  maxBytes: RESULT_SUMMARY_MAX_BYTES,
});

const SUMMARY_MACHINE_CODE_FIELDS = new Set([
  'kind', 'status', 'outcome', 'action', 'targetType', 'referenceType', 'creditType', 'featureKey', 'productKey',
]);
const SUMMARY_IDENTIFIER_FIELDS = new Set([
  'targetId', 'requestId', 'referenceId', 'sourceId', 'orderReference', 'transactionId', 'originalTransactionId', 'reversalTransactionId',
  'grantId', 'usageRequestId', 'orderId', 'paymentId', 'subscriptionId', 'webhookEventId',
]);
const SUMMARY_NONNEGATIVE_INTEGER_FIELDS = new Set([
  'creditAmount', 'restoredCreditAmount', 'expiredCreditAmount', 'creditCount', 'count', 'affectedCount', 'itemCount', 'allocationCount', 'retryCount',
]);
const SUMMARY_SIGNED_INTEGER_FIELDS = new Set([
  'creditDelta', 'balanceBefore', 'balanceAfter', 'balanceDelta',
]);
const SUMMARY_BOOLEAN_FIELDS = new Set([
  'created', 'updated', 'replayed', 'attempted', 'uncertain', 'reconciled', 'needsReconciliation',
]);
const SUMMARY_MACHINE_CODE_ARRAY_FIELDS = new Set(['codes', 'warningCodes']);
const SUMMARY_IDENTIFIER_ARRAY_FIELDS = new Set([
  'transactionIds', 'grantIds', 'usageRequestIds', 'orderIds', 'paymentIds', 'subscriptionIds', 'webhookEventIds',
]);

export const ERROR_CODES = Object.freeze({
  invalid: 'admin_action_invalid',
  unavailable: 'admin_action_unavailable',
  idempotencyConflict: 'admin_action_idempotency_conflict',
  inProgress: 'admin_action_in_progress',
  finishConflict: 'admin_action_finish_conflict',
  notFound: 'admin_action_not_found',
});

function auditError(code, status) {
  const error = new Error(code);
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function invalid(field) {
  return auditError(ERROR_CODES.invalid, 400);
}

function unavailable() {
  return auditError(ERROR_CODES.unavailable, 503);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return SENSITIVE_STEMS.some((stem) => normalized.includes(stem));
}

function canonicalJson(value, { rejectSensitive = false, limits = BEGIN_CANONICAL_LIMITS } = {}) {
  const state = { active: new WeakSet(), bytes: 0, nodes: 0 };

  function consumeBytes(text) {
    state.bytes += Buffer.byteLength(text, 'utf8');
    if (state.bytes > limits.maxBytes) throw invalid();
    return text;
  }

  function canonicalString(text) {
    if (Buffer.byteLength(text, 'utf8') > limits.maxStringBytes) throw invalid();
    return consumeBytes(JSON.stringify(text));
  }

  function walk(current, depth) {
    if (depth > limits.maxDepth) throw invalid();
    state.nodes += 1;
    if (state.nodes > limits.maxNodes) throw invalid();

    if (current === null) return consumeBytes('null');
    if (typeof current === 'string') return canonicalString(current);
    if (typeof current === 'boolean') return consumeBytes(JSON.stringify(current));
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw invalid();
      return consumeBytes(JSON.stringify(current));
    }
    if (typeof current !== 'object' || state.active.has(current)) throw invalid();

    state.active.add(current);
    try {
      if (Array.isArray(current)) {
        const ownNames = Object.getOwnPropertyNames(current);
        if (Object.getPrototypeOf(current) !== Array.prototype || Object.getOwnPropertySymbols(current).length > 0
          || ownNames.some((name) => {
            if (name === 'length') return false;
            if (!/^(?:0|[1-9][0-9]*)$/u.test(name)) return true;
            const index = Number(name);
            return !Number.isSafeInteger(index) || index < 0 || index >= current.length || String(index) !== name;
          }) || current.length > limits.maxNodes - state.nodes) {
          throw invalid();
        }
        consumeBytes('[');
        const items = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) throw invalid();
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
          if (index > 0) consumeBytes(',');
          items.push(walk(descriptor.value, depth + 1));
        }
        consumeBytes(']');
        return `[${items.join(',')}]`;
      }

      if (!isPlainObject(current) || Object.getOwnPropertySymbols(current).length > 0) throw invalid();
      const ownNames = Object.getOwnPropertyNames(current);
      const keys = Object.keys(current);
      if (ownNames.length !== keys.length || keys.length > limits.maxNodes - state.nodes) throw invalid();
      consumeBytes('{');
      const entries = [];
      for (const [index, key] of keys.sort().entries()) {
        if (PROTOTYPE_KEYS.has(key.toLowerCase()) || (rejectSensitive && sensitiveKey(key))) throw invalid();
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
        if (index > 0) consumeBytes(',');
        const canonicalKey = canonicalString(key);
        consumeBytes(':');
        entries.push(`${canonicalKey}:${walk(descriptor.value, depth + 1)}`);
      }
      consumeBytes('}');
      return `{${entries.join(',')}}`;
    } finally {
      state.active.delete(current);
    }
  }

  return walk(value, 0);
}

function requiredText(value, field, maximum) {
  if (typeof value !== 'string') throw invalid(field);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes('\u0000')) throw invalid(field);
  return normalized;
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || value.includes(',') || value.includes('\r') || value.includes('\n')) throw invalid('email');
  const normalized = value.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  const localPart = at > 0 ? normalized.slice(0, at) : '';
  const domain = at > 0 ? normalized.slice(at + 1) : '';
  if (normalized.length > 320 || localPart.length > 64 || domain.length > 255
    || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalized)) {
    throw invalid('email');
  }
  return normalized;
}

function normalizeActor(actor, allowedRoles = DEFAULT_ALLOWED_ROLES) {
  if (!isPlainObject(actor)) throw invalid('actor');
  const id = requiredText(actor.id, 'actor.id', 255);
  const email = normalizeEmail(actor.email);
  if (!allowedRoles.has(actor.role)) throw invalid('actor.role');
  const creditGrantLimit = actor.creditGrantLimit === null || actor.creditGrantLimit === undefined
    ? null
    : actor.creditGrantLimit;
  if (creditGrantLimit !== null && (!Number.isSafeInteger(creditGrantLimit) || creditGrantLimit < 0)) {
    throw invalid('actor.creditGrantLimit');
  }
  return { id, email, role: actor.role, creditGrantLimit };
}

function validateDb(db) {
  if (!db || typeof db.query !== 'function') throw unavailable();
}

function validateBeginInput(input, { allowedRoles = DEFAULT_ALLOWED_ROLES, allowedEnvironments = DEFAULT_ENVIRONMENTS } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const actor = normalizeActor(input.actor, allowedRoles);
  const action = requiredText(input.action, 'action', 80);
  if (!/^[a-zA-Z][a-zA-Z0-9_.:-]*$/u.test(action)) throw invalid('action');
  const targetType = requiredText(input.targetType, 'targetType', 80);
  const targetId = requiredText(input.targetId, 'targetId', 255);
  const reason = requiredText(input.reason, 'reason', 500);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 255);
  if (input.payload === undefined) throw invalid('payload');
  const payloadCanonical = canonicalJson(input.payload, { limits: BEGIN_CANONICAL_LIMITS });
  if (!allowedEnvironments.has(input.environment)) throw invalid('environment');
  return {
    actor,
    action,
    targetType,
    targetId,
    reason,
    idempotencyKey,
    payload: JSON.parse(payloadCanonical),
    environment: input.environment,
  };
}


function requestHash(contract) {
  return createHash('sha256')
    .update(canonicalJson(contract, { limits: BEGIN_CANONICAL_LIMITS }), 'utf8')
    .digest('hex');
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !CANONICAL_UUID_PATTERN.test(value)) throw invalid('requestId');
  return value.toLowerCase();
}

function normalizeErrorCode(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !MACHINE_ERROR_CODE_PATTERN.test(value)) throw invalid('errorCode');
  return value;
}

function validSummaryArray(value, itemPattern) {
  return Array.isArray(value)
    && value.length <= RESULT_SUMMARY_ARRAY_MAX_ITEMS
    && value.every((item) => typeof item === 'string' && itemPattern.test(item));
}

function validateSummaryField(key, value) {
  if (SUMMARY_MACHINE_CODE_FIELDS.has(key)) {
    if (typeof value !== 'string' || !SUMMARY_MACHINE_CODE_PATTERN.test(value)) throw invalid('resultSummary');
    return;
  }
  if (SUMMARY_IDENTIFIER_FIELDS.has(key)) {
    if (typeof value !== 'string' || !SUMMARY_IDENTIFIER_PATTERN.test(value)) throw invalid('resultSummary');
    return;
  }
  if (SUMMARY_NONNEGATIVE_INTEGER_FIELDS.has(key)) {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid('resultSummary');
    return;
  }
  if (SUMMARY_SIGNED_INTEGER_FIELDS.has(key)) {
    if (!Number.isSafeInteger(value)) throw invalid('resultSummary');
    return;
  }
  if (SUMMARY_BOOLEAN_FIELDS.has(key)) {
    if (typeof value !== 'boolean') throw invalid('resultSummary');
    return;
  }
  if (SUMMARY_MACHINE_CODE_ARRAY_FIELDS.has(key)) {
    if (!validSummaryArray(value, SUMMARY_MACHINE_CODE_PATTERN)) throw invalid('resultSummary');
    return;
  }
  if (SUMMARY_IDENTIFIER_ARRAY_FIELDS.has(key)) {
    if (!validSummaryArray(value, SUMMARY_IDENTIFIER_PATTERN)) throw invalid('resultSummary');
    return;
  }
  throw invalid('resultSummary');
}

function safeResultSummary(value) {
  if (!isPlainObject(value)) throw invalid('resultSummary');
  const canonical = canonicalJson(value, {
    rejectSensitive: true,
    limits: RESULT_SUMMARY_CANONICAL_LIMITS,
  });
  const normalized = JSON.parse(canonical);
  for (const [key, fieldValue] of Object.entries(normalized)) validateSummaryField(key, fieldValue);
  return { canonical, value: normalized };
}

async function loadByKey(db, actorEmail, action, idempotencyKey) {
  let result;
  try {
    result = await db.query(
      `SELECT request_id, status, request_hash, result_summary, error_code
       FROM admin_audit_logs
       WHERE actor_email = $1 AND action = $2 AND idempotency_key = $3
       LIMIT 1`,
      [actorEmail, action, idempotencyKey],
    );
  } catch {
    throw unavailable();
  }
  if (!Array.isArray(result?.rows) || result.rows.length !== 1) throw unavailable();
  return result.rows[0];
}

function storedRequestId(row) {
  return typeof row?.request_id === 'string' && CANONICAL_UUID_PATTERN.test(row.request_id)
    ? row.request_id.toLowerCase()
    : null;
}

function storedHash(row) {
  return typeof row?.request_hash === 'string' && /^[a-f0-9]{64}$/u.test(row.request_hash)
    ? row.request_hash
    : null;
}

function storedSummary(row) {
  let value = row?.result_summary;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw unavailable();
    }
  }
  try {
    return safeResultSummary(value);
  } catch (error) {
    if (error?.code === ERROR_CODES.invalid) throw unavailable();
    throw error;
  }
}

function storedErrorCode(row) {
  if (row?.error_code === null || row?.error_code === undefined) return null;
  if (typeof row.error_code !== 'string' || !MACHINE_ERROR_CODE_PATTERN.test(row.error_code)) throw unavailable();
  return row.error_code;
}

function resolveReplay(row, hash) {
  const requestId = storedRequestId(row);
  const storedRequestHash = storedHash(row);
  if (!requestId || !storedRequestHash || !ALL_STATUSES.has(row?.status)) throw unavailable();
  if (storedRequestHash !== hash) {
    throw auditError(ERROR_CODES.idempotencyConflict, 409);
  }
  if (row.status === 'pending') throw auditError(ERROR_CODES.inProgress, 409);
  const resultSummary = storedSummary(row).value;
  return {
    replayed: true,
    requestId,
    resultSummary,
    status: row.status,
    errorCode: storedErrorCode(row),
  };
}

export async function beginAdminAction(input = {}, options = {}) {
  validateDb(input.db);
  const contract = validateBeginInput(input, options);
  const requestId = randomUUID();

  const hash = requestHash(contract);
  const { actor, action, targetType, targetId, reason, idempotencyKey, environment } = contract;

  let insertResult;
  try {
    insertResult = await input.db.query(
      `INSERT INTO admin_audit_logs
         (actor_id, actor_email, actor_role, action, target_type, target_id,
          environment, request_id, idempotency_key, request_hash, reason,
          before_snapshot, after_snapshot, status, result_summary, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          '{}'::jsonb, '{}'::jsonb, 'pending', '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (actor_email, action, idempotency_key) DO NOTHING
       RETURNING request_id`,
      [actor.id, actor.email, actor.role, action, targetType, targetId, environment,
        requestId, idempotencyKey, hash, reason],
    );
  } catch {
    throw unavailable();
  }

  if (!Array.isArray(insertResult?.rows) || insertResult.rows.length > 1) throw unavailable();
  if (insertResult.rows.length === 1) {
    if (storedRequestId(insertResult.rows[0]) !== requestId) throw unavailable();
    return { replayed: false, requestId };
  }

  const existing = await loadByKey(input.db, actor.email, action, idempotencyKey);
  return resolveReplay(existing, hash);
}

async function loadByRequestId(db, requestId) {
  let result;
  try {
    result = await db.query(
      `SELECT request_id, status, result_summary, error_code
       FROM admin_audit_logs
       WHERE request_id = $1
       LIMIT 1`,
      [requestId],
    );
  } catch {
    throw unavailable();
  }
  if (!Array.isArray(result?.rows)) throw unavailable();
  return result.rows[0] || null;
}

function finishReplay(row, requestId, status, resultSummary, errorCode) {
  const storedId = storedRequestId(row);
  if (!storedId) throw unavailable();
  if (storedId !== requestId) throw auditError(ERROR_CODES.inProgress, 409);
  if (!COMPLETED_STATUSES.has(row?.status)) throw auditError(ERROR_CODES.inProgress, 409);
  const normalizedStoredSummary = storedSummary(row);
  const stored = normalizedStoredSummary.value;
  const storedCode = storedErrorCode(row);
  if (row.status !== status || storedCode !== errorCode || normalizedStoredSummary.canonical !== resultSummary.canonical) {
    throw auditError(ERROR_CODES.finishConflict, 409);
  }
  return {
    replayed: true,
    requestId,
    status: row.status,
    resultSummary: stored,
    errorCode: storedCode,
  };
}

export async function finishAdminAction({ db, requestId, status, resultSummary, errorCode = null } = {}) {
  validateDb(db);
  const normalizedRequestId = validateRequestId(requestId);
  if (!COMPLETED_STATUSES.has(status)) throw invalid('status');
  const normalizedSummary = safeResultSummary(resultSummary);
  const normalizedErrorCode = normalizeErrorCode(errorCode);

  let result;
  try {
    result = await db.query(
      `UPDATE admin_audit_logs
       SET status = $2, result_summary = $3::jsonb, error_code = $4,
           finished_at = NOW()
       WHERE request_id = $1 AND status = 'pending'
       RETURNING request_id, status, result_summary, error_code`,
      [normalizedRequestId, status, normalizedSummary.canonical, normalizedErrorCode],
    );
  } catch {
    throw unavailable();
  }

  if (!Array.isArray(result?.rows)) throw unavailable();
  if (result.rows.length === 1) {
    return {
      replayed: false,
      requestId: normalizedRequestId,
      status,
      resultSummary: normalizedSummary.value,
      errorCode: normalizedErrorCode,
    };
  }
  if (result.rows.length > 1) throw unavailable();

  const existing = await loadByRequestId(db, normalizedRequestId);
  if (!existing) throw auditError(ERROR_CODES.notFound, 404);
  return finishReplay(existing, normalizedRequestId, status, normalizedSummary, normalizedErrorCode);
}
