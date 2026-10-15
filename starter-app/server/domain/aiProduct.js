import { createFixedOperationPricingPolicy, createTokenPricingPolicy, createOperationBillingPort,
  creditInteger, invariant, validateLimits } from '@yuva/billing-core';
import { resolveFeatureBinding } from './modelCatalog.js';
import { PricingCatalog } from './pricing.config.js';
import { withChatProjection, persistChatProjection, persistDefaultTextResult } from './chatResultPersistence.js';

export function publicQuote(quote) {
  return { version: 1, strategy: quote.policyId, policyVersion: quote.policyVersion, unit: quote.unit,
    reserveCredits: quote.reserveCredits, authorizedCredits: quote.authorizedCredits,
    ...(quote.policyId === 'fixed' ? { credits: quote.terms.credits } : { inputRate: quote.terms.rates.input, outputRate: quote.terms.rates.output }),
    expiresAt: quote.expiresAt, missingUsage: quote.missingUsage };
}

/** Product-owned input/prompt/schema contract, independent of prices and package versions. */
export function resolveProductInputVersion(inputVersion = '1') {
  invariant(typeof inputVersion === 'string' && inputVersion.trim().length > 0 && inputVersion.length <= 80,
    'invalid_input_version');
  return inputVersion;
}

/** Trusted product composition, never constructed from HTTP request bodies. */
export function createAiProduct({ env = process.env, configuration, modelCatalog, inputVersion, policy, evaluateFulfillment, persistResult } = {}) {
  const version = resolveProductInputVersion(inputVersion);
  const config = structuredClone(configuration ?? { strategy: env.PRICING_STRATEGY ?? 'fixed',
    featureKey: PricingCatalog.features.deep_reasoning.key, credits: PricingCatalog.features.deep_reasoning.credits,
    inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 } });
  invariant(['fixed', 'token'].includes(config.strategy), 'invalid_pricing_configuration');
  invariant(typeof config.featureKey === 'string' && /^[a-z][a-z0-9_]{1,79}$/u.test(config.featureKey), 'invalid_feature_configuration');
  const binding = modelCatalog === undefined ? null : resolveFeatureBinding(modelCatalog, config.featureKey);
  invariant(!binding || config.limits === undefined, 'catalog_limits_conflict');
  const provider = binding?.provider ?? (env.AI_PROVIDER || 'openai');
  invariant(['mock', 'openai', 'anthropic'].includes(provider), 'unsupported_provider');
  invariant(!(provider === 'mock' && env.NODE_ENV === 'production'), 'mock_provider_forbidden');
  const model = binding?.model ?? (provider === 'mock' ? 'starter-local' : provider === 'anthropic'
    ? env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022' : env.OPENAI_MODEL || 'gpt-4o');
  const executionLimits = binding?.executionLimits ?? validateLimits({ models: [model], paths: [{ provider, model }], maxCalls: 1, maxRetries: 0,
    maxInputTokens: 24000, maxOutputTokens: 1024, deadlineMs: 60000, ...config.limits });
  const basePricing = policy ?? (config.strategy === 'fixed'
    ? createFixedOperationPricingPolicy({ credits: creditInteger(config.credits) })
    : createTokenPricingPolicy({ inputRate: config.inputRate, outputRate: config.outputRate, allowEstimates: config.allowEstimates ?? false }));
  invariant(basePricing.id === config.strategy && typeof basePricing.quote === 'function' && typeof basePricing.decide === 'function', 'invalid_pricing_configuration');
  const pricing = binding ? { id: basePricing.id, version: basePricing.version,
    decide(...args) { return basePricing.decide(...args); },
    quote(...args) {
    const quote = basePricing.quote(...args);
    invariant(quote.authorizedCredits <= binding.snapshot.budget.maxCredits, 'model_binding_budget_exceeded');
    return { ...quote, modelBinding: structuredClone(binding.snapshot) };
  } } : basePricing;
  const capabilities = { taskType: 'text', outputLimit: true, abort: true };
  const preview = pricing.quote({ taskType: 'text', mode: 'stream', featureKey: config.featureKey }, executionLimits);
  return {
    inputVersion: version,
    provider, model, executionLimits, capabilities, featureKey: config.featureKey, policy: pricing,
    publicPricing: { version: 1, strategy: pricing.id, policyVersion: pricing.version, unit: 'credit',
      reserveCredits: preview.reserveCredits, authorizedCredits: preview.authorizedCredits,
      missingUsage: preview.missingUsage,
      ...(config.strategy === 'fixed' ? { credits: preview.terms.credits } : { inputRate: preview.terms.rates.input, outputRate: preview.terms.rates.output }),
      capabilities: [{ taskType: 'text', mode: 'stream' }] },
    createBilling({ db, operationStore, usageStore }) {
      return createOperationBillingPort({ db, operationStore: { ...operationStore,
        async reserve(facts) {
          const result = await operationStore.reserve(facts);
          return { ...result, requiredCredits: facts.quote.reserveCredits };
        } }, policy: pricing, executionLimits,
        readUsage: (identity) => usageStore.summary(identity), metadata: ({ request }) => ({ conversation_id: request.conversationId }),
        evaluateFulfillment: async (context) => {
          const { operation, output } = context;
          const fulfillment = evaluateFulfillment ? await evaluateFulfillment(context)
            : { status: 'ready', accountId: operation.accountId, ruleVersion: '1', resultId: operation.id,
              artifacts: [{ id: operation.id, accountId: operation.accountId, type: 'text', state: 'available', text: output }] };
          return withChatProjection(fulfillment, context, { customWriter: Boolean(persistResult) });
        },
        persistResult: async (facts) => {
          if (facts.fulfillment?.starterChatProjection) await persistChatProjection(facts);
          return persistResult ? persistResult(facts) : persistDefaultTextResult(facts);
        },
      });
    },
  };
}
