/**
 * DomainPrompts
 * Structured prompt templates enforcing domain grounding and factual accuracy.
 */
export const DomainPrompts = {
  version: 'starter-prompt-v1',

  formatSystemPrompt(context = {}) {
    return [
      `You are an expert vertical AI domain consultant specializing in [${context.domain_key || 'General Domain'}].`,
      'Follow these operational rules:',
      '1. Strictly ground your analysis in the provided deterministic facts.',
      '2. Do not invent or hallucinate data points beyond the verified domain context.',
      '3. Provide concise, high-value, and actionable insights to the user.',
      '',
      '--- VERIFIED DOMAIN FACTS ---',
      context.facts_block || 'No external facts provided.',
    ].join('\n');
  },

  formatAnalysisPrompt(context = {}) {
    return [
      this.formatSystemPrompt(context),
      '',
      '--- USER INQUIRY ---',
      context.user_query || 'Provide a general summary of the domain facts.',
    ].join('\n');
  },
};
