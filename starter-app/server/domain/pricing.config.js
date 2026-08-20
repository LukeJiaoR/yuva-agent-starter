/**
 * PricingCatalog
 * Defines the credit costs for vertical features and operations.
 */
export const PricingCatalog = {
  currency: 'credits',
  features: {
    quick_analysis: {
      key: 'quick_analysis',
      name: 'Quick Analysis',
      credits: 1,
      description: 'Single-turn deterministic analysis and summary',
    },
    deep_reasoning: {
      key: 'deep_reasoning',
      name: 'Deep Reasoning Stream',
      credits: 2,
      description: 'Multi-turn conversational agent with domain knowledge retrieval',
    },
  },
  starter_grant: {
    default_credits: 10,
    expires_in_days: 30,
  },
};
