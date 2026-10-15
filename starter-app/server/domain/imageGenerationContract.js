import { canonicalJson, createFixedOperationPricingPolicy, invariant, validateQuote } from '@yuva/billing-core';

export const IMAGE_PROFILE = 'local-images-rgba8-v1';
export const IMAGE_PROVIDER = 'synthetic-images';
export const IMAGE_MODEL = 'synthetic-rgba8-1';
export const IMAGE_SPECS = Object.freeze({ width: 1, height: 1, mediaType: 'image/png' });
export const IMAGE_BOUNDS = Object.freeze({ promptBytes: 4096, requestBytes: 8192, responseBytes: 32768 });
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
function requireValue(condition) { invariant(condition, 'image_configuration_invalid', 422); }

/** Explicit, trusted product configuration. No environment defaults or catalog registration. */
export function validateImageProfile(profile) {
  requireValue(profile?.version === IMAGE_PROFILE && profile.provider === IMAGE_PROVIDER && profile.model === IMAGE_MODEL);
  requireValue(profile.specs && same(profile.specs, IMAGE_SPECS));
  requireValue(Number.isSafeInteger(profile.fixedCredits) && profile.fixedCredits >= 0 && profile.fixedCredits <= 2147483647);
  requireValue(profile.maxCalls === 1 && profile.maxRetries === 0 && profile.maxImages === 1);
  requireValue(Number.isSafeInteger(profile.deadlineMs) && profile.deadlineMs > 0 && profile.deadlineMs <= 60000);
  requireValue(profile.recoveryPolicy?.version === '1' && profile.recoveryPolicy.onExpiry === 'waive'
    && Number.isSafeInteger(profile.recoveryPolicy.maxAgeMs) && profile.recoveryPolicy.maxAgeMs >= profile.deadlineMs
    && profile.recoveryPolicy.maxAgeMs <= 31536000000);
  // An explicit synthetic-only authorization, NOT a money cap enforced at a real supplier.
  requireValue(profile.supplierAuthorization?.kind === 'synthetic-only'
    && profile.supplierAuthorization.currency === 'USD' && profile.supplierAuthorization.amount === '0'
    && profile.supplierAuthorization.scale === 0);
  return { version: IMAGE_PROFILE, provider: IMAGE_PROVIDER, model: IMAGE_MODEL, specs: { ...IMAGE_SPECS },
    fixedCredits: profile.fixedCredits, maxCalls: 1, maxRetries: 0, maxImages: 1, deadlineMs: profile.deadlineMs,
    recoveryPolicy: { version: '1', maxAgeMs: profile.recoveryPolicy.maxAgeMs, onExpiry: 'waive' },
    supplierAuthorization: { kind: 'synthetic-only', currency: 'USD', amount: '0', scale: 0 } };
}

export function prepareImageGeneration({ profile: supplied, accountId, clientRequestId, input, now = Date.now }) {
  const profile = validateImageProfile(supplied);
  invariant(input && Object.keys(input).sort().join(',') === 'model,n,prompt,specs', 'image_input_invalid', 422);
  invariant(input.model === profile.model && input.n === 1 && same(input.specs, profile.specs), 'image_input_invalid', 422);
  invariant(typeof input.prompt === 'string' && input.prompt.trim().length > 0
    && Buffer.byteLength(input.prompt, 'utf8') <= IMAGE_BOUNDS.promptBytes, 'image_prompt_invalid', 422);
  invariant(typeof accountId === 'string' && accountId.trim() && accountId.length <= 160
    && typeof clientRequestId === 'string' && clientRequestId.trim() && clientRequestId.length <= 120, 'image_identity_invalid', 422);
  const request = { model: profile.model, prompt: input.prompt, n: 1, size: '1x1', response_format: 'b64_json' };
  invariant(Buffer.byteLength(JSON.stringify(request)) <= IMAGE_BOUNDS.requestBytes, 'image_request_too_large', 422);
  const operation = { accountId, clientRequestId, featureKey: 'synthetic_image_generation', taskType: 'image', mode: 'sync',
    inputVersion: IMAGE_PROFILE, input: { model: input.model, prompt: input.prompt, n: 1, specs: structuredClone(input.specs) } };
  const limits = { models: [profile.model], paths: [{ provider: profile.provider, model: profile.model }], maxCalls: 1,
    maxRetries: 0, maxImages: 1, specs: profile.specs, deadlineMs: profile.deadlineMs };
  const quote = createFixedOperationPricingPolicy({ credits: profile.fixedCredits, fulfillmentVersion: IMAGE_PROFILE, now }).quote(operation, limits);
  quote.terms.recoveryPolicy = profile.recoveryPolicy;
  quote.terms.imageProfile = IMAGE_PROFILE;
  quote.terms.supplierAuthorization = profile.supplierAuthorization;
  validateQuote(quote);
  return deepFreeze({ operation, quote, request });
}

export function missingImageObservation(failureCode = 'image_submission_unknown') {
  return { outcome: 'unknown', externalStatus: 'unknown', metrics: { images: { value: null, unit: 'image', source: 'missing' } },
    cost: null, model: IMAGE_MODEL, modelIdentitySource: 'requested_fallback', failureCode };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
