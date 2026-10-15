import { PNG } from 'pngjs';
import { IMAGE_MODEL, IMAGE_PROFILE, IMAGE_PROVIDER, IMAGE_SPECS } from '../../server/domain/imageGenerationContract.js';
export const imageProfile = () => ({ version: IMAGE_PROFILE, provider: IMAGE_PROVIDER, model: IMAGE_MODEL, specs: { ...IMAGE_SPECS },
  fixedCredits: 2, maxCalls: 1, maxRetries: 0, maxImages: 1, deadlineMs: 30000,
  recoveryPolicy: { version: '1', maxAgeMs: 60000, onExpiry: 'waive' },
  supplierAuthorization: { kind: 'synthetic-only', currency: 'USD', amount: '0', scale: 0 } });
export const imageInput = () => ({ model: IMAGE_MODEL, prompt: 'Synthetic pixel', n: 1, specs: { ...IMAGE_SPECS } });
export function imageResponse(extra = {}) {
  const png = new PNG({ width: 1, height: 1 });
  png.data.set([50, 100, 150, 255]);
  return { status: 200, requestId: 'fixture-1', body: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG.sync.write(png).toString('base64') }], ...extra })) };
}
