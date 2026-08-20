/**
 * PricingCatalog
 * Defines the credit costs for vertical features and operations.
 */
export const PricingCatalog = {
  currency: 'credits',
  features: {
    quick_analysis: {
      key: 'quick_analysis',
      name: 'Deterministic Domain Analysis Preview',
      credits: 0,
      is_free: true,
      description: 'Free deterministic domain fact extraction & SHA-256 snapshot preview',
    },
    deep_reasoning: {
      key: 'deep_reasoning',
      name: 'Deep Reasoning Stream',
      credits: 2,
      description: 'Multi-turn conversational streaming agent with grounded domain knowledge',
    },
  },
  starter_grant: {
    default_credits: 10,
    expires_in_days: 30,
  },
};
