// Opt-in transport configuration. Keep legacy numeric parsing in its existing
// resolvers; a provider-default request must never silently discard a cap.
export class OutputTokenPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OutputTokenPolicyError';
    this.code = code;
  }
}

export function usesProviderDefaultOutputTokens(options = {}) {
  if (options.outputTokenPolicy === undefined) return false;
  if (options.outputTokenPolicy !== 'provider_default') {
    throw new OutputTokenPolicyError('output_token_policy_invalid');
  }
  if (options.maxOutputTokens !== undefined || options.maxOutputTokensCap !== undefined) {
    throw new OutputTokenPolicyError('output_token_policy_conflict');
  }
  return true;
}
