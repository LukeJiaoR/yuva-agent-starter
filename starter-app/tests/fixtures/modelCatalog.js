export function catalogFixture(provider = 'mock') {
  return { version: 1, connections: [{ id: 'primary', provider, status: 'enabled',
    credentialRef: provider === 'mock' ? null : `env:${provider.toUpperCase()}_API_KEY` }],
  models: [{ id: 'approved', connectionId: 'primary', model: provider === 'mock' ? 'starter-local' : 'fixture-model',
    provenance: { source: 'manual', recordedAt: '2026-10-15T00:00:00.000Z' }, status: 'enabled',
    capabilities: [{ taskType: 'text', mode: 'stream', status: 'verified' }] }],
  bindings: [{ featureKey: 'deep_reasoning', version: 'v1', modelId: 'approved', taskType: 'text', mode: 'stream',
    parameters: { maxOutputTokens: 512 }, budget: { maxInputTokens: 24000, deadlineMs: 60000, maxCredits: 100 } }] };
}
