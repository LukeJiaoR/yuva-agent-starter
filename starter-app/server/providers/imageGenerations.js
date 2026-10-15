import { invariant } from '@yuva/billing-core';
import { inspectPng, inputBytes } from '../artifacts/contract.js';
import { IMAGE_BOUNDS, IMAGE_MODEL, IMAGE_PROFILE, IMAGE_SPECS, missingImageObservation } from '../domain/imageGenerationContract.js';

/** Local compatibility profile, not a promise of compatibility with any public vendor.
 * transport({method,path,body,signal,maxResponseBytes}) -> {status,body:Buffer,requestId?}.
 * The transport must bound bytes during read, disable retries, and perform no redirects.
 * There is deliberately no default transport, fetch, base URL, credential or SDK lookup.
 */
export function createImageGenerationsAdapter({ transport }) {
  invariant(typeof transport === 'function', 'image_transport_required', 422);
  return async ({ request, signal }) => {
    // Snapshot getters once and discard prototypes/non-enumerable serialization hooks.
    request = request && { ...request };
    invariant(request && Object.keys(request).sort().join(',') === 'model,n,prompt,response_format,size'
      && request.model === IMAGE_MODEL && request.n === 1 && request.size === '1x1' && request.response_format === 'b64_json'
      && typeof request.prompt === 'string' && request.prompt.trim() && Buffer.byteLength(request.prompt) <= IMAGE_BOUNDS.promptBytes,
    'image_request_invalid', 422);
    const body = JSON.stringify({ model: IMAGE_MODEL, prompt: request.prompt, n: 1, size: '1x1', response_format: 'b64_json' });
    invariant(Buffer.byteLength(body) <= IMAGE_BOUNDS.requestBytes, 'image_request_too_large', 422);
    signal?.throwIfAborted(); // No submission yet. Durable caller must still conservatively reconcile its start.
    try {
      const response = await transport({ method: 'POST', path: '/images/generations', body, signal,
        maxResponseBytes: IMAGE_BOUNDS.responseBytes, profileVersion: IMAGE_PROFILE });
      invariant(response?.status === 200 && Buffer.isBuffer(response.body)
        && response.body.length <= IMAGE_BOUNDS.responseBytes, 'image_response_invalid');
      const payload = JSON.parse(response.body.toString('utf8'));
      invariant(payload && Array.isArray(payload.data) && payload.data.length === 1, 'image_response_invalid');
      const item = payload.data[0];
      invariant(item && !Object.hasOwn(item, 'url'), 'image_url_response_unsupported');
      invariant(Object.keys(item).join(',') === 'b64_json' && typeof item.b64_json === 'string', 'image_response_invalid');
      const bytes = inputBytes({ base64: item.b64_json }), specs = inspectPng(bytes);
      invariant(specs.width === IMAGE_SPECS.width && specs.height === IMAGE_SPECS.height, 'image_spec_mismatch');
      invariant(response.requestId === undefined || typeof response.requestId === 'string'
        && /^[A-Za-z0-9._:-]{1,128}$/u.test(response.requestId), 'image_request_id_invalid');
      invariant(payload.model === undefined || payload.model === IMAGE_MODEL, 'image_model_mismatch');
      invariant(payload.usage === undefined || payload.usage && Object.keys(payload.usage).join(',') === 'images'
        && payload.usage.images === 1, 'image_usage_invalid');
      return { bytes, specs, observation: { outcome: 'succeeded', externalStatus: 'completed',
        metrics: { images: { value: payload.usage ? 1 : null, unit: 'image', source: payload.usage ? 'provider' : 'missing' } },
        cost: null, providerRequestId: response.requestId ?? null, model: IMAGE_MODEL, modelIdentitySource: payload.model === undefined ? 'requested_fallback' : 'provider_response' } };
    } catch (cause) {
      // Once handed off, even abort/timeout/refusal/malformed success is not proof of non-submission.
      const code = cause?.code === 'image_url_response_unsupported' ? cause.code : 'image_submission_unknown';
      throw Object.assign(new Error(code), { code, observation: missingImageObservation(code) });
    }
  };
}
