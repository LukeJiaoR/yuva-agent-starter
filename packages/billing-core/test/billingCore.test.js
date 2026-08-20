import { describe, it, expect, vi } from 'vitest';
import {
  normalizeCreditBalance,
  creditGrantIsExpired,
  planRecurringEntitlements,
  planAnnualMembershipEntitlements,
  createCreditFeatureRegistry,
  withCreditTransaction,
} from '../index.js';



describe('@yuva/billing-core', () => {
  describe('normalizeCreditBalance', () => {
    it('correctly normalizes dual-track credit balances and handles negative/null inputs', () => {
      const balance = normalizeCreditBalance({
        membership_credits: 100,
        purchased_credits: 50,
        membership_reserved_credits: 10,
        purchased_reserved_credits: 5,
        available_credits: 135,
        reserved_credits: 15,
        credit_debt: 0,
      });

      expect(balance.membership).toBe(100);
      expect(balance.purchased).toBe(50);
      expect(balance.membership_reserved).toBe(10);
      expect(balance.purchased_reserved).toBe(5);
      expect(balance.available).toBe(135);
      expect(balance.reserved).toBe(15);
      expect(balance.debt).toBe(0);
    });

    it('falls back to 0 for missing or invalid values', () => {
      const balance = normalizeCreditBalance(null);
      expect(balance.membership).toBe(0);
      expect(balance.purchased).toBe(0);
      expect(balance.available).toBe(0);
    });
  });

  describe('creditGrantIsExpired', () => {
    it('detects expired membership grants', () => {
      const expiredGrant = {
        credit_type: 'membership',
        expires_at: new Date(Date.now() - 10000).toISOString(),
      };
      expect(creditGrantIsExpired(expiredGrant)).toBe(true);

      const validGrant = {
        credit_type: 'membership',
        expires_at: new Date(Date.now() + 100000).toISOString(),
      };
      expect(creditGrantIsExpired(validGrant)).toBe(false);

      // Purchased credits never expire
      const purchasedGrant = {
        credit_type: 'purchased',
        expires_at: new Date(Date.now() - 10000).toISOString(),
      };
      expect(creditGrantIsExpired(purchasedGrant)).toBe(false);
    });
  });

  describe('planAnnualMembershipEntitlements', () => {
    it('calculates monthly entitlement periods for annual subscriptions accurately', () => {
      const currentPeriodStart = new Date('2026-01-01T00:00:00Z');
      const currentPeriodEnd = new Date('2027-01-01T00:00:00Z');
      const now = new Date('2026-03-15T00:00:00Z');

      const plan = planAnnualMembershipEntitlements({
        currentPeriodStart,
        currentPeriodEnd,
        nextEntitlementPeriod: 0,
        now,
      });

      expect(plan.periods.length).toBe(3); // Jan, Feb, Mar periods
      expect(plan.periods[0].index).toBe(0);
      expect(plan.periods[0].expired).toBe(true); // Jan period is expired by March
      expect(plan.nextEntitlementPeriod).toBe(3);
    });
  });

  describe('createCreditFeatureRegistry', () => {
    it('registers and retrieves custom feature policies', () => {
      const registry = createCreditFeatureRegistry({
        summary_analysis: { creditCost: 10, enabled: true },
        deep_chat: { creditCost: 2, enabled: true },
      });

      expect(registry.hasFeature('summary_analysis')).toBe(true);
      expect(registry.getFeaturePolicy('summary_analysis').creditCost).toBe(10);
      expect(registry.getFeaturePolicy('non_existent')).toBeNull();
      expect(registry.listFeatures().length).toBe(2);
    });
  });

  describe('withCreditTransaction', () => {
    it('executes callback inside transaction boundary', async () => {
      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      const mockDb = {
        connect: vi.fn().mockResolvedValue(mockClient),
      };

      const result = await withCreditTransaction(mockDb, async (client) => {
        await client.query('SELECT 1');
        return 'success';
      });

      expect(result).toBe('success');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
