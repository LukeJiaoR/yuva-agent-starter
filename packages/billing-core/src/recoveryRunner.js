import { invariant } from './operationContract.js';

/** Query/recover existing work only: this interface intentionally has no generate function. */
export function createRecoveryRunner({ recoveryStore, settlementStore, usageStore, resolvePolicy,
  inspectExecution = async () => ({ status: 'unknown' }), persistResult, heartbeatMs = 5000 }) {
  invariant(Number.isInteger(heartbeatMs) && heartbeatMs > 0);
  const identity = (operation) => ({ operationId: operation.id, accountId: operation.accountId, expectedEpoch: operation.executionEpoch });
  const terminal = (status) => ['settled', 'no_charge', 'released'].includes(status);
  const expired = (operation) => operation.recoveryExpired === true;
  async function decide(operation, usage) {
    if (expired(operation) && operation.recoveryPolicy?.onExpiry === 'waive') {
      return operation.fulfillment?.status === 'ready'
        ? { action: 'settle', credits: 0, reason: 'consumer_protection_waiver' }
        : { action: 'release', reason: 'consumer_protection_waiver' };
    }
    if (operation.fulfillment?.status === 'ready') {
      const policy = resolvePolicy(operation.quote.policyId, operation.quote.policyVersion);
      if (!policy) return { action: 'defer', reason: 'policy_version_unavailable' };
      return policy.decide(structuredClone(operation.quote), usage, operation.fulfillment);
    }
    if (!usage.calls.length) return { action: 'release', reason: 'no_external_call_started' };
    if (usage.calls.every((call) => ['failed', 'cancelled'].includes(call.outcome) && call.externalStatus === 'completed')) {
      return { action: 'release', reason: 'confirmed_execution_failed' };
    }
    return { action: 'defer', reason: 'execution_or_delivery_unknown' };
  }
  return {
    async run({ dryRun = true, operationId = null, limit = 20, review = false } = {}) {
      const candidates = await recoveryStore.list({ operationId, limit, review });
      const outcomes = [];
      for (const candidate of candidates) {
        const usage = await usageStore.summary(identity(candidate));
        if (dryRun) {
          const snapshot = await settlementStore.read(identity(candidate));
          const decision = await decide(candidate, usage);
          outcomes.push({ operationId: candidate.id, action: ['settled','released'].includes(snapshot.ledgerStatus) ? 'repair_ledger_state' : decision.action,
            reason: decision.reason, dryRun: true });
          continue;
        }
        const claimed = await recoveryStore.claim({ operationId: candidate.id, review });
        if (!claimed) continue;
        const owned = { operationId: claimed.id, owner: claimed.leaseOwner, expectedEpoch: claimed.executionEpoch };
        let heartbeat = Promise.resolve(), leaseError = null;
        const timer = setInterval(() => {
          heartbeat = heartbeat.then(() => recoveryStore.heartbeat(owned)).catch((error) => { leaseError = error; });
        }, heartbeatMs);
        timer.unref?.();
        let outcome;
        try {
          let state = await settlementStore.reconcileLedger(identity(claimed));
          if (!terminal(state.status)) {
            state = await settlementStore.read(identity(claimed));
            let currentUsage = await usageStore.summary(identity(claimed));
            if (!expired(state.operation) && currentUsage.calls.length && (state.fulfillment?.status !== 'ready'
              || claimed.quote.policyId === 'token' && currentUsage.calls.some((call) =>
                call.metrics.inputTokens?.value == null || call.metrics.outputTokens?.value == null))) {
              const external = await inspectExecution({ operation: state.operation, calls: currentUsage.calls });
              invariant(['unknown','running','failed','completed'].includes(external?.status), 'invalid_execution_observation');
              await heartbeat;
              if (leaseError) throw leaseError;
              await recoveryStore.heartbeat(owned);
              for (const observation of external.observations || []) {
                invariant(currentUsage.calls.some((call) => call.callId === observation.callId), 'recovery_call_forbidden', 403);
                await usageStore.observe({ callId: observation.callId, accountId: claimed.accountId, observation: observation.observation });
              }
              if (external.fulfillment) await settlementStore.stage({ ...identity(claimed), fulfillment: external.fulfillment });
              currentUsage = await usageStore.summary(identity(claimed));
              state = await settlementStore.read(identity(claimed));
            }
            const decision = await decide(state.operation, currentUsage);
            const fulfillment = state.fulfillment || { status: decision.action === 'release' && decision.reason !== 'consumer_protection_waiver' ? 'failed' : 'pending',
              accountId: claimed.accountId, ruleVersion: claimed.quote.fulfillmentVersion, artifacts: [] };
            state = await settlementStore.apply({ ...identity(claimed), decision, fulfillment, persistResult });
          }
          outcome = { operationId: claimed.id, action: terminal(state.status) ? state.status : 'deferred',
            reason: state.decision?.reason || state.operation.reconciliationReason || null };
        } catch (error) {
          outcome = { operationId: claimed.id, action: 'deferred', reason: /^[a-z_]{1,80}$/u.test(error.code || '') ? error.code : 'recovery_failed' };
        } finally { clearInterval(timer); await heartbeat; }
        try { await recoveryStore.finish({ ...owned, action: outcome.action, reason: outcome.reason }); }
        catch { outcome = { operationId: claimed.id, action: 'deferred', reason: 'execution_lease_lost' }; }
        outcomes.push(outcome);
      }
      return { dryRun, outcomes, metrics: await recoveryStore.metrics() };
    },
  };
}
