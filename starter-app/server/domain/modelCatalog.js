import { invariant, creditInteger, validateLimits } from '@yuva/billing-core';

// Application-owned configuration, not a remote discovery or credential service.
const references = { mock: null, openai: 'env:OPENAI_API_KEY', anthropic: 'env:ANTHROPIC_API_KEY' };
const fail = (condition) => invariant(condition, 'invalid_model_catalog');
function fields(value, names) {
  fail(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
  fail(Reflect.ownKeys(value).length === names.length && names.every((name) => Object.hasOwn(value, name)));
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) fail('value' in descriptor);
}
function id(value) { fail(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/u.test(value)); }
function unique(items, key) {
  fail(Array.isArray(items));
  fail(new Set(items.map((item) => item?.[key])).size === items.length);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function positive(value) { fail(Number.isSafeInteger(value) && value > 0 && value <= 2147483647); }
function executable(catalog, binding) {
  const model = catalog.models.find((item) => item.id === binding.modelId);
  fail(Boolean(model));
  const connection = catalog.connections.find((item) => item.id === model.connectionId);
  fail(Boolean(connection));
  invariant(connection.status === 'enabled' && model.status === 'enabled', 'model_unavailable');
  invariant(binding.taskType === 'text' && binding.mode === 'stream', 'unsupported_model_capability');
  invariant(model.capabilities.some((capability) => capability.taskType === binding.taskType
    && capability.mode === binding.mode && capability.status === 'verified'), 'model_capability_unverified');
  return { model, connection };
}

/** Validate all records, including unused records. Return an immutable private copy.
 * Importing an unverified model is allowed; binding one for execution is not.
 * Errors never include values from configuration (which might contain secrets).
 */
export function validateModelCatalog(input) {
  fields(input, ['version', 'connections', 'models', 'bindings']);
  fail(input.version === 1);
  unique(input.connections, 'id'); unique(input.models, 'id'); unique(input.bindings, 'featureKey');
  fail(new Set(input.connections.map((item) => item?.provider)).size === input.connections.length);
  for (const connection of input.connections) {
    fields(connection, ['id', 'provider', 'credentialRef', 'status']); id(connection.id);
    fail(typeof connection.provider === 'string' && Object.hasOwn(references, connection.provider));
    fail(connection.credentialRef === references[connection.provider]);
    fail(['enabled', 'disabled'].includes(connection.status));
  }
  for (const model of input.models) {
    fields(model, ['id', 'connectionId', 'model', 'provenance', 'status', 'capabilities']);
    id(model.id); id(model.connectionId);
    fail(typeof model.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/u.test(model.model));
    const connection = input.connections.find((item) => item.id === model.connectionId);
    fail(Boolean(connection)); fail(connection.provider !== 'mock' || model.model === 'starter-local');
    fail(['enabled', 'disabled'].includes(model.status));
    fields(model.provenance, ['source', 'recordedAt']);
    fail(['manual', 'discovered'].includes(model.provenance.source));
    fail(typeof model.provenance.recordedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(model.provenance.recordedAt)
      && Number.isFinite(Date.parse(model.provenance.recordedAt))
      && new Date(model.provenance.recordedAt).toISOString() === model.provenance.recordedAt);
    fail(Array.isArray(model.capabilities));
    const seen = new Set();
    for (const capability of model.capabilities) {
      fields(capability, ['taskType', 'mode', 'status']);
      fail(['text', 'image', 'video', 'tool'].includes(capability.taskType));
      fail(['sync', 'stream', 'async'].includes(capability.mode));
      fail(['verified', 'unverified', 'disabled'].includes(capability.status));
      const key = `${capability.taskType}:${capability.mode}`; fail(!seen.has(key)); seen.add(key);
    }
  }
  for (const binding of input.bindings) {
    fields(binding, ['featureKey', 'version', 'modelId', 'taskType', 'mode', 'parameters', 'budget']);
    fail(typeof binding.featureKey === 'string' && /^[a-z][a-z0-9_]{1,79}$/u.test(binding.featureKey));
    id(binding.version); id(binding.modelId);
    fields(binding.parameters, ['maxOutputTokens']); positive(binding.parameters.maxOutputTokens);
    fields(binding.budget, ['maxInputTokens', 'deadlineMs', 'maxCredits']);
    positive(binding.budget.maxInputTokens); positive(binding.budget.deadlineMs); creditInteger(binding.budget.maxCredits);
    executable(input, binding);
  }
  return freeze(structuredClone(input));
}

/** Pure resolver. Only text/stream has an executor; labels never imply approval. */
export function resolveFeatureBinding(input, featureKey) {
  const catalog = validateModelCatalog(input);
  const binding = catalog.bindings.find((item) => item.featureKey === featureKey);
  invariant(Boolean(binding), 'model_binding_missing');
  const { model, connection } = executable(catalog, binding);
  const executionLimits = validateLimits({ models: [model.model], paths: [{ provider: connection.provider, model: model.model }],
    maxCalls: 1, maxRetries: 0, maxInputTokens: binding.budget.maxInputTokens,
    maxOutputTokens: binding.parameters.maxOutputTokens, deadlineMs: binding.budget.deadlineMs });
  return freeze({ provider: connection.provider, model: model.model, executionLimits,
    snapshot: { catalogVersion: catalog.version, ...binding, connectionId: connection.id, provider: connection.provider, model: model.model } });
}
