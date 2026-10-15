import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { canonicalJson, createOperationStore, createOperationSettlementStore, createOperationRecoveryStore,
  createRecoveryRunner, createFixedOperationPricingPolicy, withCreditTransaction, lockCreditAccount, invariant } from '@yuva/billing-core';
import { createUsageStore } from '../stores/usageStore.js';
import { createImageGenerationsAdapter } from '../providers/imageGenerations.js';
import { prepareImageGeneration, validateImageProfile, missingImageObservation, IMAGE_PROFILE, IMAGE_PROVIDER,
  IMAGE_MODEL, IMAGE_SPECS } from '../domain/imageGenerationContract.js';
import { identity } from '../artifacts/contract.js';

/** Deliberately uninteresting, generated locally; no credentials, fetch, SDK or provider lookup. */
export async function syntheticPixelTransport() {
  const png = new PNG({ width: 1, height: 1 });
  png.data.set([255, 0, 255, 255]);
  return { status: 200, requestId: 'mock-pixel', body: Buffer.from(JSON.stringify({ model: IMAGE_MODEL,
    usage: { images: 1 }, data: [{ b64_json: PNG.sync.write(png).toString('base64') }] })) };
}
const terminalDelivery = (operation) => ['settled', 'no_charge'].includes(operation.financialStatus)
  && operation.fulfillment?.status === 'ready';
const opIdentity = (operation) => ({ operationId: operation.id, accountId: operation.accountId, expectedEpoch: operation.executionEpoch });
const isImage = (operation) => operation?.featureKey === 'synthetic_image_generation' && operation.taskType === 'image'
  && operation.mode === 'sync' && operation.inputVersion === IMAGE_PROFILE && operation.quote.terms.imageProfile === IMAGE_PROFILE;
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const fulfillmentFor = (operation, artifact) => ({ status: 'ready', accountId: operation.accountId,
  ruleVersion: operation.quote.fulfillmentVersion, resultId: artifact.id, artifacts: [artifact] });

function validArtifact(operation, artifact) {
  return artifact?.accountId === operation.accountId && artifact.operationId === operation.id && artifact.slot === 'output'
    && artifact.id === identity(operation.accountId, operation.id, 'output') && artifact.type === 'image'
    && artifact.provenance?.providerId === IMAGE_PROVIDER && artifact.provenance?.modelId === IMAGE_MODEL
    && Object.entries(IMAGE_SPECS).every(([key, value]) => artifact.specs?.[key] === value);
}

export function createMockImageUseCase({ db, profile: suppliedProfile, artifactStore, artifactPipeline,
  usageStore = createUsageStore({ db }), settlementStore = createMockImageSettlementStore({ db }),
  transport = syntheticPixelTransport, now = Date.now } = {}) {
  const profile = validateImageProfile(suppliedProfile);
  invariant(artifactStore?.get && artifactPipeline?.save && artifactPipeline?.inspect && artifactPipeline?.recover && artifactPipeline?.ready,
    'image_configuration_invalid', 422);
  const operations = createOperationStore({ db, capabilities: [{ taskType: 'image', mode: 'sync' }] });
  // decide() reads the frozen operation quote; current configuration never reprices old work.
  const policy = createFixedOperationPricingPolicy({ credits: profile.fixedCredits, fulfillmentVersion: IMAGE_PROFILE });
  async function read({ accountId, operationId }) {
    invariant(uuid(operationId), 'operation_not_found', 404);
    const state = await settlementStore.read({ accountId, operationId });
    invariant(isImage(state.operation), 'operation_not_found', 404);
    return state.operation;
  }
  function view(operation) {
    const artifact = terminalDelivery(operation) && operation.fulfillment.artifacts?.length === 1
      ? operation.fulfillment.artifacts[0] : null;
    return { mock: true, operationId: operation.id, executionStatus: operation.executionStatus,
      financialStatus: operation.financialStatus, fulfillmentStatus: operation.fulfillmentStatus,
      pricing: { mode: 'fixed', credits: operation.quote.terms.credits,
        chargedCredits: operation.financialStatus === 'settled' ? operation.decision?.credits ?? 0 : 0 },
      artifact: artifact && validArtifact(operation, artifact) ? { id: artifact.id, mediaType: 'image/png', width: 1, height: 1,
        downloadUrl: `/api/artifacts/${artifact.id}` } : null };
  }
  const runner = createRecoveryRunner({ recoveryStore: createOperationRecoveryStore({ db }), settlementStore, usageStore,
    resolvePolicy: (id, version) => id === policy.id && version === policy.version ? policy : null,
    inspectExecution: async ({ operation, calls }) => {
      if (!isImage(operation) || calls.length !== 1 || calls[0].provider !== IMAGE_PROVIDER || calls[0].model !== IMAGE_MODEL
        || calls[0].outcome !== 'succeeded' || calls[0].externalStatus !== 'completed') return { status: 'unknown' };
      try {
        const scope = { accountId: operation.accountId, operationId: operation.id, slot: 'output' };
        const staged = await artifactPipeline.inspect(scope);
        if (!validArtifact(operation, staged)) return { status: 'unknown' };
        const artifact = await artifactPipeline.recover(scope);
        if (!validArtifact(operation, artifact)) return { status: 'unknown' };
        return { status: 'completed', fulfillment: fulfillmentFor(operation, artifact) };
      } catch { return { status: 'unknown' }; }
    } });
  return {
    async submit({ accountId, requestId, prompt, ...extra }) {
      invariant(!Object.keys(extra).length, 'image_input_invalid', 422);
      const prepared = prepareImageGeneration({ profile, accountId, clientRequestId: requestId,
        input: { prompt, model: IMAGE_MODEL, n: 1, specs: IMAGE_SPECS } });
      const existing = await operations.find({ accountId, clientRequestId: requestId, operation: prepared.operation });
      if (existing) return view(existing);
      await artifactPipeline.ready(); // Reject unsafe/missing directories before reserve or transport.
      const reserved = await operations.reserve(prepared);
      if (reserved.kind !== 'reserved') {
        invariant(reserved.operation, 'idempotency_conflict', 409);
        return view(reserved.operation);
      }
      const operation = reserved.operation, scope = opIdentity(operation), callId = randomUUID();
      let handedOff = false;
      try {
        // start resolves only after COMMIT. An ambiguous acknowledgement never invokes transport.
        await usageStore.start({ ...scope, callId, attempt: 1, provider: IMAGE_PROVIDER, model: IMAGE_MODEL,
          requestedMetrics: { images: { value: 1, unit: 'image', source: 'estimate' } },
          executionBudget: { kind: 'primary', resources: { images: 1, specs: operation.quote.limits.specs } } });
        const remainingMs = new Date(operation.createdAt).getTime() + operation.quote.limits.deadlineMs - now();
        invariant(remainingMs > 0, 'image_deadline_exceeded', 409);
        handedOff = true;
        const result = await createImageGenerationsAdapter({ transport })({ request: prepared.request, signal: AbortSignal.timeout(remainingMs) });
        await usageStore.observe({ callId, accountId, observation: result.observation });
        const artifact = await artifactPipeline.save({ accountId, operationId: operation.id, bytes: result.bytes,
          provenance: { providerId: IMAGE_PROVIDER, modelId: IMAGE_MODEL }, expectedSpecs: IMAGE_SPECS });
        invariant(validArtifact(operation, artifact), 'image_artifact_invalid');
        const fulfillment = fulfillmentFor(operation, artifact);
        // Stage and settlement are epoch-fenced. Bytes alone never grant delivery.
        await settlementStore.stage({ ...scope, fulfillment });
        await settlementStore.apply({ ...scope, fulfillment,
          decision: policy.decide(operation.quote, await usageStore.summary(scope), fulfillment) });
      } catch (error) {
        // Late external facts are permitted, but never downgrade a known success after storage/ACK failures.
        if (handedOff && error.observation) {
          try { await usageStore.observe({ callId, accountId, observation: error.observation ?? missingImageObservation() }); } catch { /* recovery reads committed facts */ }
        }
        try { await settlementStore.markReconciliation({ ...scope, reason: 'image_reconciliation_required' }); } catch { /* fenced or terminal; read canonical state */ }
      }
      return view(await read(scope));
    },
    async query(scope) { return view(await read(scope)); },
    async recover(scope) {
      const operation = await read(scope); // Account and image-kind check before generic recovery can run.
      await runner.run({ dryRun: false, operationId: operation.id, limit: 1 });
      return view(await read(scope));
    },
    authorizeArtifact: createImageArtifactAuthorizer({ db, strict: true }),
  };
}

export function configuredMockImageUseCase({ env, db, artifactStore, artifactPipeline, profile }) {
  const mode = env.MOCK_IMAGE_GENERATION || 'disabled';
  if (mode === 'disabled') return null;
  invariant(mode === 'local-development' && ['development', 'test'].includes(env.NODE_ENV)
    && env.ARTIFACT_STORAGE === 'local' && env.ARTIFACT_STAGING === 'local', 'image_configuration_invalid', 422);
  let configuredProfile = profile;
  if (!configuredProfile) {
    try { configuredProfile = JSON.parse(env.MOCK_IMAGE_PROFILE); } catch { invariant(false, 'image_configuration_invalid', 422); }
  }
  return createMockImageUseCase({ db, profile: configuredProfile, artifactStore, artifactPipeline });
}

/** Keep protection when generation is later disabled: durable mock artifacts never become standalone files. */
export function createImageArtifactAuthorizer({ db, strict = false }) {
  const store = createOperationSettlementStore({ db });
  return async ({ accountId, artifact, remoteAddress }) => {
    const required = strict || artifact.provenance?.providerId === IMAGE_PROVIDER;
    if (remoteAddress !== undefined && required) invariant(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress), 'artifact_unavailable', 404);
    if (!uuid(artifact.operationId)) { invariant(!required, 'artifact_unavailable', 404); return; }
    let operation;
    try { operation = (await store.read({ accountId, operationId: artifact.operationId })).operation; }
    catch (error) { if (!required && error.code === 'operation_not_found') return; throw error; }
    if (!isImage(operation)) { invariant(!required, 'artifact_unavailable', 404); return; }
    invariant(terminalDelivery(operation) && validArtifact(operation, artifact)
      && operation.fulfillment.artifacts?.length === 1
      && canonicalJson(operation.fulfillment.artifacts[0]) === canonicalJson(artifact), 'artifact_unavailable', 404);
  };
}

/** Product-level expiry fence, serialized with the existing ledger/operation locks. */
export function createMockImageSettlementStore({ db }) {
  const base = createOperationSettlementStore({ db });
  const guarded = (method) => async (facts) => withCreditTransaction(db, async (client) => {
    await lockCreditAccount(client, facts.accountId);
    await client.query('SELECT id FROM ai_operations WHERE id=$1 AND account_id=$2 FOR UPDATE', [facts.operationId, facts.accountId]);
    const locked = createOperationSettlementStore({ db: client });
    const state = await locked.read(facts);
    if (!['settled', 'no_charge', 'released'].includes(state.status) && state.operation.recoveryExpired) {
      // Only the recovery runner's epoch-owned waiver may finalize expired work.
      invariant(method === 'apply' && facts.expectedEpoch > 0 && facts.expectedEpoch === state.operation.executionEpoch
        && state.operation.leaseOwner && facts.decision?.reason === 'consumer_protection_waiver'
        && (state.fulfillment?.status === 'ready' ? facts.decision.action === 'settle' && facts.decision.credits === 0
          : facts.decision.action === 'release'), 'image_recovery_expired', 409);
    }
    return locked[method](facts);
  }, { trackCommitOutcome: true });
  return { ...base, stage: guarded('stage'), apply: guarded('apply') };
}
