import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import ipaddr from 'ipaddr.js';
import { LIMITS, failure, prepare, identity } from './contract.js';

export const REMOTE_LIMITS = Object.freeze({ urlLength: 4096, deadlineMs: 10000, dnsAnswers: 64 });
const globalV6 = ipaddr.parseCIDR('2000::/3');
// Conservative additions to pinned ipaddr.js classifications. Reject special-purpose
// ranges even when particular suballocations are globally reachable.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const extraV4 = ['198.18.0.0/15', '192.175.48.0/24'].map(ipaddr.parseCIDR);
const extraV6 = ['2001::/23', '3fff::/20', '2620:4f:8000::/48'].map(ipaddr.parseCIDR);
function publicAddress(address, family) {
  if (isIP(address) !== family || ![4, 6].includes(family)) return false;
  let parsed;
  try { parsed = ipaddr.parse(address); } catch { return false; }
  if (parsed.range() !== 'unicast') return false;
  if (family === 6 && !parsed.match(globalV6)) return false;
  return !(family === 4 ? extraV4 : extraV6).some((range) => parsed.match(range));
}
function hostname(value) {
  return typeof value === 'string' && value.length <= 253 && value.includes('.')
    && !isIP(value) && value === value.toLowerCase()
    && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}
function sourceUrl(source, trusted) {
  if (typeof source !== 'string' || source.length > REMOTE_LIMITS.urlLength
    || /[\s\\\x00-\x1f\x7f]/u.test(source)
    || source.slice(source.indexOf('//') + 2).split(/[/?#]/u)[0].includes('@')) throw failure('artifact_remote_url_rejected');
  let url;
  try { url = new URL(source); } catch { throw failure('artifact_remote_url_rejected'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !hostname(url.hostname) || !trusted.has(url.hostname)) throw failure('artifact_remote_url_rejected');
  return url;
}

function snapshotMetadata(input) {
  const { accountId, operationId, slot = 'output', provenance, expectedSpecs } = input;
  identity(accountId, operationId, slot);
  if (!provenance || Object.keys(provenance).sort().join(',') !== 'modelId,providerId'
    || Object.values(provenance).some((value) => typeof value !== 'string' || !value.trim()
      || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))) throw failure('artifact_invalid_provenance');
  if (expectedSpecs !== undefined && (!expectedSpecs || typeof expectedSpecs !== 'object'
    || Array.isArray(expectedSpecs) || Object.entries(expectedSpecs).some(([key, value]) => {
      if (key === 'mediaType') return value !== 'image/png';
      const bounds = { width: LIMITS.dimension, height: LIMITS.dimension, sizeBytes: LIMITS.bytes };
      if (!Object.hasOwn(bounds, key)) return true;
      const max = bounds[key];
      return !max || !Number.isInteger(value) || value < 1 || value > max;
    }))) throw failure('artifact_spec_mismatch');
  return { accountId, operationId, slot, provenance: { ...provenance },
    ...(expectedSpecs === undefined ? {} : { expectedSpecs: { ...expectedSpecs } }) };
}

/** Trusted application composition only. Dependencies are injectable for offline tests;
 * they must never be selected or supplied by HTTP callers. No global fetch/proxy agent. */
export function createRemoteArtifactIngestor({ store, enabled = false, trustedHostnames = [],
  lookup = dnsLookup, request = httpsRequest, deadlineMs = REMOTE_LIMITS.deadlineMs } = {}) {
  if (!Array.isArray(trustedHostnames) || trustedHostnames.some((host) => !hostname(host))
    || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > REMOTE_LIMITS.deadlineMs) {
    throw failure('artifact_remote_configuration_invalid');
  }
  const trusted = new Set(trustedHostnames);
  if (enabled && (!store || typeof store.save !== 'function' || !trusted.size)) throw failure('artifact_remote_configuration_invalid');
  return {
    async ingest(input) {
      if (!enabled) throw failure('artifact_remote_disabled', 404);
      if (!input || Object.keys(input).some((key) => !['sourceUrl', 'accountId', 'operationId', 'slot', 'provenance', 'expectedSpecs'].includes(key))) {
        throw failure('artifact_invalid_input');
      }
      const url = sourceUrl(input.sourceUrl, trusted);
      const metadata = snapshotMetadata(input);
      let req, response, expired = false, timer;
      const deadline = performance.now() + deadlineMs;
      const timedOut = () => expired || performance.now() >= deadline;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(failure('artifact_remote_timeout'));
          response?.destroy(); req?.destroy();
        }, deadlineMs);
      });
      const transfer = async () => {
        const answers = await lookup(url.hostname, { all: true, verbatim: true });
        if (timedOut()) throw failure('artifact_remote_timeout');
        if (!Array.isArray(answers) || !answers.length || answers.length > REMOTE_LIMITS.dnsAnswers
          || answers.some((answer) => !publicAddress(answer.address, answer.family))) throw failure('artifact_remote_address_rejected');
        const pinned = { address: answers[0].address, family: answers[0].family };
        return await new Promise((resolve, reject) => {
          if (timedOut()) return reject(failure('artifact_remote_timeout'));
          // Fresh direct socket to the validated IP. Host/SNI retain the original
          // trusted hostname and Node's default certificate hostname verification.
          req = request({ protocol: 'https:', hostname: pinned.address, family: pinned.family,
            port: 443, method: 'GET', path: url.pathname + url.search, servername: url.hostname,
            rejectUnauthorized: true, agent: false, maxHeaderSize: 8192,
            headers: { Host: url.hostname, Accept: 'image/png', 'Accept-Encoding': 'identity' },
          }, (res) => {
            response = res;
            const fail = (code = 'artifact_remote_response_rejected') => {
              reject(failure(code)); res.destroy(); req?.destroy();
            };
            res.on('error', () => fail('artifact_remote_transfer_failed'));
            res.on('aborted', () => fail('artifact_remote_transfer_failed'));
            if (timedOut()) return fail('artifact_remote_timeout');
            const length = res.headers['content-length'];
            if (res.statusCode !== 200 || res.headers['content-type'] !== 'image/png'
              || res.headers['content-encoding'] !== undefined
              || (length !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(length)
                || !Number.isSafeInteger(Number(length)) || Number(length) > LIMITS.bytes))) return fail();
            const body = Buffer.alloc(LIMITS.bytes); let size = 0;
            res.on('data', (chunk) => {
              if (timedOut()) return fail('artifact_remote_timeout');
              if (!Buffer.isBuffer(chunk)) return fail();
              size += chunk.length;
              if (size > LIMITS.bytes) return fail();
              chunk.copy(body, size - chunk.length);
            });
            res.on('end', () => {
              if (timedOut()) return fail('artifact_remote_timeout');
              if (!res.complete || (length !== undefined && size !== Number(length))) return fail();
              resolve(body.subarray(0, size));
            });
            res.on('close', () => { if (!res.complete) fail('artifact_remote_transfer_failed'); });
          });
          req.on('error', () => reject(failure('artifact_remote_transfer_failed')));
          if (timedOut()) { req.destroy(); return reject(failure('artifact_remote_timeout')); }
          req.end();
        });
      };
      let bytes;
      try {
        bytes = await Promise.race([transfer(), timeout]);
        if (timedOut()) throw failure('artifact_remote_timeout');
      }
      catch (error) {
        response?.destroy(); req?.destroy();
        // Native DNS/TLS/transport errors may contain signed source URLs. Do not
        // expose causes, raw errors or provider response bodies to callers/logs.
        const safeCodes = ['artifact_remote_timeout', 'artifact_remote_address_rejected',
          'artifact_remote_response_rejected', 'artifact_remote_transfer_failed'];
        throw failure(safeCodes.includes(error?.code) ? error.code : 'artifact_remote_transfer_failed');
      } finally { clearTimeout(timer); }
      const savedInput = { ...metadata, bytes };
      prepare(savedInput); // Same strict PNG/spec validation, even with a custom store.
      return await store.save(savedInput); // Availability only after successful immutable commit.
    },
  };
}

export function configuredRemoteArtifactIngestor(env, store) {
  const mode = env.ARTIFACT_REMOTE_INGESTION || 'disabled';
  if (!['disabled', 'https'].includes(mode)) throw failure('artifact_remote_configuration_invalid');
  return createRemoteArtifactIngestor({ store, enabled: mode === 'https',
    trustedHostnames: env.ARTIFACT_REMOTE_TRUSTED_HOSTNAMES
      ? env.ARTIFACT_REMOTE_TRUSTED_HOSTNAMES.split(',').map((host) => host.trim()) : [] });
}
