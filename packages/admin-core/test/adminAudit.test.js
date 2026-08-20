import { describe, it, expect, vi } from 'vitest';
import {
  ERROR_CODES,
  beginAdminAction,
  finishAdminAction,
} from '../index.js';

describe('@yuva/admin-core', () => {
  it('validates beginAdminAction input constraints', async () => {
    const mockDb = { query: vi.fn() };
    await expect(beginAdminAction({ db: null })).rejects.toThrow();

    // Invalid actor role
    await expect(
      beginAdminAction({
        db: mockDb,
        actor: { id: '1', email: 'test@example.com', role: 'invalid_role' },
        action: 'adjust_credits',
        targetType: 'user',
        targetId: '123',
        reason: 'testing',
        idempotencyKey: 'key-1',
        payload: { delta: 10 },
        environment: 'test',
      })
    ).rejects.toThrow();
  });

  it('inserts pending admin action log and returns requestId', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql, params) => ({
        rows: [{ request_id: params[7] }],
      })),
    };


    const res = await beginAdminAction({
      db: mockDb,
      actor: { id: 'admin-1', email: 'admin@example.com', role: 'support' },

      action: 'grant_credits',
      targetType: 'user',
      targetId: 'u-123',
      reason: 'manual compensation',
      idempotencyKey: 'idemp-123',
      payload: { amount: 50 },
      environment: 'test',
    });

    expect(res.replayed).toBe(false);
    expect(typeof res.requestId).toBe('string');
    expect(res.requestId.length).toBe(36);
  });


  it('finishes admin action successfully', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          request_id: '11111111-2222-4333-8444-555555555555',
          status: 'succeeded',
          result_summary: { outcome: 'granted', creditAmount: 50 },
          error_code: null,
        }],
      }),
    };

    const res = await finishAdminAction({
      db: mockDb,
      requestId: '11111111-2222-4333-8444-555555555555',
      status: 'succeeded',
      resultSummary: { outcome: 'granted', creditAmount: 50 },
    });

    expect(res.status).toBe('succeeded');
    expect(res.resultSummary.outcome).toBe('granted');
  });
});
