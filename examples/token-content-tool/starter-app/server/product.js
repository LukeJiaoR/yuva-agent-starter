import { createServer } from './index.js';
import { DomainKnowledgeAdapter } from './domain/adapter.js';
import { INPUT_VERSION, DOMAIN_KEY, PRICING, materialFacts, validateCard } from './domain/contract.js';

// Overrides are trusted deployment configuration, never values copied from a request.
export function createExampleServer({ db, auth, callAIStream, env = process.env,
  pricing = PRICING, inputVersion = INPUT_VERSION } = {}) {
  if (typeof auth?.verifyRequest !== 'function' || typeof auth?.findUser !== 'function') {
    throw new Error('The host must supply trusted verifyRequest and explicit local-user mapping');
  }
  const adapter = new DomainKnowledgeAdapter(DOMAIN_KEY);
  adapter.computeFacts = async input => ({ domain_key: DOMAIN_KEY, subject: 'Given material', parameters: materialFacts(input) });
  return createServer({ db, auth, adapter, callAIStream, validateOutput: validateCard,
    config: { inputVersion, pricing, env: { ...env, ALLOW_DEV_GUEST: 'false' } } });
}
