import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';

export const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, pixels: 4 * 1024 * 1024, dimension: 4096 });
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function failure(code, status = 422) { return Object.assign(new Error(code), { code, status }); }
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) throw failure('artifact_invalid_input');
  return value;
}
export function identity(accountId, operationId, slot) {
  return `art_${hash(JSON.stringify([text(accountId), text(operationId), text(slot)]))}`;
}
export function validId(id) { return typeof id === 'string' && /^art_[a-f0-9]{64}$/u.test(id); }
export function inputBytes(input) {
  if (input.url !== undefined || input.sourceUrl !== undefined) throw failure('artifact_remote_source_unsupported');
  if ((input.bytes !== undefined) === (input.base64 !== undefined)) throw failure('artifact_invalid_input');
  if (input.bytes !== undefined) {
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length > LIMITS.bytes) throw failure('artifact_invalid_input');
    return Buffer.from(input.bytes);
  }
  if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(LIMITS.bytes / 3) * 4) throw failure('artifact_invalid_input');
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.toString('base64') !== input.base64) throw failure('artifact_invalid_input');
  return bytes;
}

// Deliberately narrow PNG profile: RGBA8, non-interlaced, no ancillary chunks.
// pngjs verifies CRCs and decodes every pixel. A separate bounded full inflate
// rejects truncated zlib checksums, extra compressed streams and decompression bombs.
export function inspectPng(bytes) {
  try {
    if (bytes.length < 57 || bytes.length > LIMITS.bytes || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error();
    let offset = 8, width, height, ended = false;
    const compressed = [];
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw new Error();
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) throw new Error();
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (offset === 8) {
        if (type !== 'IHDR' || length !== 13) throw new Error();
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        if (!width || !height || width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.pixels
          || !data.subarray(8).equals(Buffer.from([8, 6, 0, 0, 0]))) throw new Error();
      } else if (type === 'IDAT' && !ended) compressed.push(data);
      else if (type === 'IEND' && length === 0 && compressed.length && offset + 12 === bytes.length) ended = true;
      else throw new Error();
      offset += length + 12;
    }
    if (!ended) throw new Error();
    const stream = Buffer.concat(compressed), expected = (width * 4 + 1) * height;
    const inflated = inflateSync(stream, { maxOutputLength: expected, info: true });
    if (inflated.buffer.length !== expected || inflated.engine.bytesWritten !== stream.length) throw new Error();
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) throw new Error();
    return { mediaType: 'image/png', width, height, sizeBytes: bytes.length };
  } catch { throw failure('artifact_invalid_image'); }
}

export function prepare(input) {
  const { accountId, operationId, slot = 'output', provenance, expectedSpecs } = input;
  const id = identity(accountId, operationId, slot), bytes = inputBytes(input), specs = inspectPng(bytes);
  if (!provenance || Object.keys(provenance).sort().join(',') !== 'modelId,providerId') throw failure('artifact_invalid_provenance');
  const source = { providerId: text(provenance.providerId), modelId: text(provenance.modelId) };
  if (expectedSpecs !== undefined) {
    if (!expectedSpecs || typeof expectedSpecs !== 'object' || Array.isArray(expectedSpecs)
      || Object.keys(expectedSpecs).some((key) => !Object.hasOwn(specs, key))
      || Object.entries(expectedSpecs).some(([key, value]) => specs[key] !== value)) throw failure('artifact_spec_mismatch');
  }
  const digest = hash(bytes);
  return { artifact: { id, accountId, operationId, slot, type: 'image', state: 'available',
    storageKey: `local-v1/${id}`, version: 1, sha256: digest, specs, provenance: source }, bytes };
}
export function encode(record) { return Buffer.from(JSON.stringify({ artifact: record.artifact, base64: record.bytes.toString('base64') })); }
export function decode(serialized, accountId, id) {
  try {
    const raw = JSON.parse(serialized.toString('utf8'));
    const record = prepare({ ...raw.artifact, base64: raw.base64, expectedSpecs: raw.artifact.specs });
    if (record.artifact.accountId !== accountId || record.artifact.id !== id || JSON.stringify(record.artifact) !== JSON.stringify(raw.artifact)) throw new Error();
    return record;
  } catch { throw failure('artifact_unavailable', 404); }
}

/** Deterministic in-memory port implementation for tests; never selected by env. */
export function createFakeArtifactStore() {
  const records = new Map();
  return {
    async save(input) {
      const record = prepare(input), encoded = encode(record), prior = records.get(record.artifact.id);
      if (prior && !prior.equals(encoded)) throw failure('artifact_conflict', 409);
      records.set(record.artifact.id, encoded);
      return structuredClone(record.artifact);
    },
    async get({ accountId, id }) {
      if (!validId(id) || !records.has(id)) throw failure('artifact_unavailable', 404);
      return decode(records.get(id), accountId, id);
    },
  };
}
