import { describe, it, expect } from 'vitest';
import * as billing from './billing-core/index.js';
import * as auth from './auth-core/index.js';
import * as ai from './ai-engine/index.js';
import * as context from './context-engine/index.js';
import * as admin from './admin-core/index.js';

describe('Monorepo Core Packages Exports', () => {
  it('exports billing-core functions', () => {
    expect(typeof billing.normalizeCreditBalance).toBe('function');
    expect(typeof billing.creditGrantIsExpired).toBe('function');
    expect(typeof billing.withCreditTransaction).toBe('function');
    expect(typeof billing.reserveFeatureCredits).toBe('function');
    expect(typeof billing.settleFeatureCredits).toBe('function');
    expect(typeof billing.releaseFeatureCredits).toBe('function');
    expect(typeof billing.planRecurringEntitlements).toBe('function');
    expect(typeof billing.planAnnualMembershipEntitlements).toBe('function');
    expect(typeof billing.createCreditFeatureRegistry).toBe('function');
  });



  it('exports physical auth-core generic functions', () => {
    // Middleware & Clerk authentication factories
    expect(typeof auth.createRequireAuth).toBe('function');
    expect(typeof auth.createOptionalAuth).toBe('function');
    expect(typeof auth.createDbRateLimiter).toBe('function');
    expect(typeof auth.requireClerkAuth).toBe('function');
    expect(typeof auth.verifyClerkRequest).toBe('function');
    expect(typeof auth.findMappedClerkUser).toBe('function');
    expect(typeof auth.getClerkAuthorizedParties).toBe('function');

    // Token security & production fail-fast
    expect(typeof auth.hashAuthToken).toBe('function');
    expect(typeof auth.createAuthToken).toBe('function');
    expect(typeof auth.verifyAuthToken).toBe('function');
    expect(typeof auth.ensureAuthTokenSecret).toBe('function');
    expect(typeof auth.getAuthTokenSecret).toBe('function');

    // Response hardening & privacy
    expect(typeof auth.stripSessionToken).toBe('function');
    expect(typeof auth.hardenJsonResponse).toBe('function');
    expect(typeof auth.shouldRedactKey).toBe('function');
    expect(typeof auth.redactSensitiveObject).toBe('function');
    expect(typeof auth.redactWebhookEvent).toBe('function');

    // Claim tokens & anonymous cookies
    expect(typeof auth.createClaimToken).toBe('function');
    expect(typeof auth.verifyClaimToken).toBe('function');
    expect(typeof auth.hashSecret).toBe('function');
    expect(typeof auth.anonymousCookieOptions).toBe('function');
    expect(typeof auth.anonymousCookieClearOptions).toBe('function');

    // External identity provisioning & locks
    expect(typeof auth.externalIdentityLockKey).toBe('function');
    expect(typeof auth.acquireExternalIdentityLock).toBe('function');
    expect(typeof auth.provisionExternalIdentity).toBe('function');
  });

  it('exports ai-engine functions', () => {
    expect(typeof ai.createProviderModel).toBe('function');
    expect(typeof ai.streamProviderText).toBe('function');
    expect(typeof ai.generateProviderText).toBe('function');
    expect(typeof ai.createStreamEmitter).toBe('function');
    expect(typeof ai.writeSseEvent).toBe('function');
    expect(typeof ai.setSseHeaders).toBe('function');
    expect(typeof ai.countUnicodeTokens).toBe('function');
    expect(typeof ai.normalizeText).toBe('function');
    expect(typeof ai.normalizeSdkProviderResult).toBe('function');
    expect(typeof ai.createSyntheticProviderResult).toBe('function');
    expect(typeof ai.resolveOpenAIChatModel).toBe('function');
    expect(typeof ai.resolveReasoningEffort).toBe('function');
    expect(typeof ai.createAgentRuntime).toBe('function');
    expect(ai.AgentRuntimeError).toBeDefined();
  });




  it('exports context-engine functions', () => {
    expect(typeof context.allocateContextBudget).toBe('function');
    expect(typeof context.planContextBudget).toBe('function');
    expect(typeof context.resolveContextBudget).toBe('function');
    expect(context.DEFAULT_CONTEXT_BUDGET_TOKENS).toBeDefined();
    expect(context.DEFAULT_CONTEXT_MIN_BUDGET_TOKENS).toBeDefined();
    expect(context.DEFAULT_CONTEXT_MAX_BUDGET_TOKENS).toBeDefined();
    expect(context.DEFAULT_CONTEXT_PRIORITIES).toBeDefined();
  });



  it('exports physical admin-core generic functions', () => {
    expect(typeof admin.beginAdminAction).toBe('function');
    expect(typeof admin.finishAdminAction).toBe('function');
    expect(admin.ERROR_CODES).toBeDefined();
    expect(admin.DEFAULT_ALLOWED_ROLES).toBeDefined();
    expect(admin.DEFAULT_ENVIRONMENTS).toBeDefined();
  });
});
