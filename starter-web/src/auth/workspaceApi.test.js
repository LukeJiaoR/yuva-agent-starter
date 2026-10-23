import { afterEach, expect, it, vi } from 'vitest';
import { streamChat } from '../api.js';
afterEach(() => vi.unstubAllGlobals());
it.each([
  [{ code: 'request_released', error: 'Fixed public message', financial_status: 'released' }, 'request_released', 'released'],
  [{ error: 'request_released' }, 'request_released', undefined],
  [{ code: 'execution_unknown', error: 'Please retry' }, 'execution_unknown', undefined],
])('preserves stable HTTP error identity and only supplied financial status', async (body, code, financialStatus) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409,
    headers: { get: () => 'application/json' }, json: async () => body }));
  await expect(streamChat({ requestId: 'synthetic' })).rejects.toMatchObject({ status: 409, code, financialStatus });
});
