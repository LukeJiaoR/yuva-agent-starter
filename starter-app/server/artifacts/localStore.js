import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, prepare, encode, decode, validId, failure } from './contract.js';

const MAX_RECORD_BYTES = Math.ceil(LIMITS.bytes / 3) * 4 + 8192;
// Operator-owned, pre-created private directory. No path from a request is used.
export function createImmutableLocalStore({ directory, prepare, encode, decode }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === '/') throw new Error('ARTIFACT_DIRECTORY must be a normalized absolute private directory');
  async function checkDirectory() {
    let current = path.parse(directory).root;
    for (const segment of directory.slice(current.length).split(path.sep)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('artifact_storage_unsafe', 503);
      if (current === directory && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw failure('artifact_storage_unsafe', 503);
    }
  }
  async function read(id) {
    await checkDirectory();
    const handle = await fs.open(path.join(directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || stat.size < 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw failure('artifact_unavailable', 404);
      // A fixed bound avoids allocations controlled by a corrupted/growing file.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== stat.size) throw failure('artifact_unavailable', 404);
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }
  async function syncDirectory() {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  return {
    async save(input) {
      const record = prepare(input), serialized = encode(record);
      await checkDirectory();
      const temporary = path.join(directory, `.pending-${randomUUID()}`), target = path.join(directory, `${record.artifact.id}.json`);
      let handle;
      try {
        handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(serialized);
        await handle.sync();
        await handle.close(); handle = null;
        // Atomic create-if-absent; no overwrite window across processes.
        try { await fs.link(temporary, target); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const prior = await read(record.artifact.id);
          decode(prior, record.artifact.accountId, record.artifact.id);
          if (!prior.equals(serialized)) throw failure('artifact_conflict', 409);
        }
        await fs.unlink(temporary);
        await syncDirectory();
        // Verify the committed record, including its content hash, before delivery.
        return (await this.get({ accountId: record.artifact.accountId, id: record.artifact.id })).artifact;
      } finally {
        await handle?.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    },
    async get({ accountId, id }) {
      if (!validId(id)) throw failure('artifact_unavailable', 404);
      try { return decode(await read(id), accountId, id); }
      catch { throw failure('artifact_unavailable', 404); }
    },
  };
}

export function createLocalArtifactStore({ directory } = {}) {
  return createImmutableLocalStore({ directory, prepare, encode, decode });
}

export function configuredArtifactStore(env) {
  if (!env.ARTIFACT_STORAGE || env.ARTIFACT_STORAGE === 'disabled') return null;
  if (env.ARTIFACT_STORAGE !== 'local') throw new Error('Unsupported ARTIFACT_STORAGE');
  return createLocalArtifactStore({ directory: env.ARTIFACT_DIRECTORY });
}
