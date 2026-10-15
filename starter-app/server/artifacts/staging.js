import fs from 'node:fs/promises';
import path from 'node:path';
import { prepare, encode, identity, failure } from './contract.js';
import { createImmutableLocalStore } from './localStore.js';

function prepareStage(input) {
  const record = prepare(input);
  record.artifact.state = 'staged';
  record.artifact.storageKey = `staging-v1/${record.artifact.id}`;
  return record;
}
function decodeStage(serialized, accountId, id) {
  try {
    const raw = JSON.parse(serialized.toString('utf8'));
    const record = prepareStage({ ...raw.artifact, base64: raw.base64, expectedSpecs: raw.artifact.specs });
    if (record.artifact.accountId !== accountId || record.artifact.id !== id
      || JSON.stringify(record.artifact) !== JSON.stringify(raw.artifact)) throw new Error();
    return record;
  } catch { throw failure('artifact_unavailable', 404); }
}
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
async function ancestors(directory) {
  const result = [];
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('artifact_storage_unsafe', 503);
    if (current === directory && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw failure('artifact_storage_unsafe', 503);
    result.push(`${stat.dev}:${stat.ino}`);
    if (current === path.dirname(current)) return result;
  }
}

/** Trusted application-only port, never exposed as a route or a delivery store.
 * The final directory must describe the actual local store, not caller input. */
export function createStagedArtifactPipeline({ store, directory, artifactDirectory } = {}) {
  if (!store || typeof store.save !== 'function' || typeof artifactDirectory !== 'string'
    || !path.isAbsolute(artifactDirectory) || path.resolve(artifactDirectory) !== artifactDirectory
    || artifactDirectory === '/') throw failure('artifact_staging_configuration_invalid');
  const staged = createImmutableLocalStore({ directory, prepare: prepareStage, encode, decode: decodeStage });
  if (overlaps(directory, artifactDirectory)) throw failure('artifact_staging_configuration_invalid');
  async function separated() {
    // Also reject aliases/nesting through bind mounts (same device + inode),
    // not just lexical overlaps. Recheck on every operation, fail closed.
    const [stagePath, finalPath, stageNodes, finalNodes] = await Promise.all([
      fs.realpath(directory), fs.realpath(artifactDirectory), ancestors(directory), ancestors(artifactDirectory),
    ]);
    if (overlaps(stagePath, finalPath) || stageNodes.includes(finalNodes[0]) || finalNodes.includes(stageNodes[0])) {
      throw failure('artifact_storage_unsafe', 503);
    }
  }
  async function stageRecord(record) {
    await separated();
    await staged.save({ ...record.artifact, bytes: record.bytes, expectedSpecs: record.artifact.specs });
    return { recoveryId: record.artifact.id, state: 'staged' };
  }
  async function publish(record) {
    const expected = prepare({ ...record.artifact, bytes: record.bytes, expectedSpecs: record.artifact.specs });
    const result = await store.save({ ...expected.artifact, bytes: expected.bytes, expectedSpecs: expected.artifact.specs });
    // A custom composition may not claim delivery for a different source.
    if (JSON.stringify(result) !== JSON.stringify(expected.artifact)) throw failure('artifact_publish_mismatch', 503);
    return result;
  }
  return {
    async stage(input) { return stageRecord(prepare(input)); },
    async save(input) {
      const record = prepare(input); // Copy/validate before the first await.
      await stageRecord(record);
      return publish(record);
    },
    async recover(input) {
      if (!input || Object.keys(input).some((key) => !['accountId', 'operationId', 'slot'].includes(key))) throw failure('artifact_invalid_input');
      const { accountId, operationId, slot = 'output' } = input;
      const id = identity(accountId, operationId, slot);
      await separated();
      return publish(await staged.get({ accountId, id }));
    },
  };
}

export function configuredStagedArtifactPipeline(env, store) {
  const mode = env.ARTIFACT_STAGING || 'disabled';
  if (mode === 'disabled') return null;
  if (mode !== 'local' || env.ARTIFACT_STORAGE !== 'local') throw failure('artifact_staging_configuration_invalid');
  return createStagedArtifactPipeline({ store, directory: env.ARTIFACT_STAGING_DIRECTORY, artifactDirectory: env.ARTIFACT_DIRECTORY });
}
