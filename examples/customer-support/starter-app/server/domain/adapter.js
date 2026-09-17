import crypto from 'node:crypto';

/**
 * IDomainKnowledgeAdapter
 * Defines the contract for vertical domain factual calculations,
 * deterministic snapshot creation, and context enrichment.
 */
export class DomainKnowledgeAdapter {
  constructor(domainKey = 'vertical-agent-saas') {
    this.domainKey = domainKey;
  }

  /**
   * Computes deterministic facts from raw user input.
   * Example: In astrology, compute astrolabe charts; in legal, parse statute clauses; in finance, parse balance sheets.
   */
  async computeFacts(input = {}) {
    return {
      domain_key: this.domainKey,
      subject: input.subject || 'Default Subject',
      parameters: input.parameters || {},
      computed_at: new Date().toISOString(),
    };
  }

  /**
   * Generates a deterministic SHA256 fingerprint for caching, knowledge versioning, and idempotency.
   */
  computeFingerprint(facts) {
    const payload = JSON.stringify({
      domain_key: this.domainKey,
      subject: facts.subject,
      parameters: facts.parameters,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Creates an immutable snapshot of domain facts with versioning metadata.
   */
  createSnapshot(facts) {
    return {
      version: 1,
      fingerprint: this.computeFingerprint(facts),
      domain_key: this.domainKey,
      facts,
      computed_at: new Date().toISOString(),
    };
  }

  /**
   * Formats domain facts into prioritized context blocks for the LLM.
   */
  buildContext(facts, history = [], query = '') {
    return {
      domain_key: this.domainKey,
      facts_block: JSON.stringify(facts, null, 2),
      history_count: history.length,
      user_query: query,
    };
  }
}
