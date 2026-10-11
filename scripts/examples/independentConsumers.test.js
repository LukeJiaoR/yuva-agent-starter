import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packCore, json } from '../release/artifacts.mjs';
import { createExample, profiles } from '../../examples/create-consumer.mjs';

const root = process.cwd();
describe('independently installed example consumers (real PostgreSQL)', () => {
  let temporary, bundle, manifest;
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('Independent consumer acceptance requires explicit TEST_DATABASE_URL');
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'starter-independent-consumers-'));
    bundle = path.join(temporary, 'bundle');
    manifest = await packCore(root, bundle, { allowDirty: true });
    if (process.env.CI) expect(manifest.development).toBe(false);
  }, 30000);
  afterAll(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });
  it.each(profiles)('%s installs immutable local tarballs and passes its own HTTP/PG acceptance', async profile => {
    const target = path.join(temporary, profile);
    await createExample({ profile, target, bundle, development: manifest.development, install: true });
    const env = { ...process.env, NODE_ENV: 'test', ALLOW_DEVELOPMENT_BUNDLE: String(manifest.development) };
    for (const key of Object.keys(env)) {
      if (/^(CLERK_|OPENAI_|ANTHROPIC_)/u.test(key) || key === 'DATABASE_URL' || key === 'NODE_PATH') delete env[key];
    }
    const run = args => execFileSync('npm', args, { cwd: target, env, encoding: 'utf8', timeout: 120000 });
    const output = run(['test']);
    expect(output).toMatch(/# tests 5\b/u); expect(output).toMatch(/# pass 5\b/u);
    expect(output).toMatch(/# fail 0\b/u); expect(output).toMatch(/# skipped 0\b/u);
    // A dirty development checkout is useful locally, but is not a verified release.
    // Exact-head CI checks clean, source-pinned bundles through the normal verifier.
    if (!manifest.development) expect(run(['run', 'core:verify'])).toContain(manifest.sourceCommit);
    const pin = await json(path.join(target, '.core-release.json'));
    expect(pin.sourceCommit).toBe(manifest.sourceCommit);
    expect((await json(path.join(target, 'package.json'))).workspaces).toEqual(['starter-app', 'starter-web']);
    console.log(`${profile}: independently installed current-source artifacts; 5 HTTP/PostgreSQL checks passed, zero skipped; source ${manifest.sourceCommit}`);
  }, 180000);
});
