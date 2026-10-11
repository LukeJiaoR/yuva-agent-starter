import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_NAMES, packCore, verifyBundle, installBundle, json, writeJson, digest, run } from './artifacts.mjs';

describe('bundle build intent without publication claims', () => {
  let temporary, source, developmentBundle, candidateBundle, development, candidate;
  beforeAll(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-intent-'));
    source = path.join(temporary, 'source');
    await fs.mkdir(path.join(source, 'scripts/migrations'), { recursive: true });
    await writeJson(path.join(source, 'package-lock.json'), { packages: {} });
    for (const name of CORE_NAMES) {
      const directory = path.join(source, 'packages', name);
      await fs.mkdir(directory, { recursive: true });
      await writeJson(path.join(directory, 'package.json'), {
        name: '@yuva/' + name, version: '1.0.0', type: 'module', files: ['index.js'],
      });
      await fs.writeFile(path.join(directory, 'index.js'), 'export const fixture = true;\n');
    }
    run('git', ['init', '--quiet'], source);
    run('git', ['add', '.'], source);
    run('git', ['-c', 'user.name=BundleFixture', '-c', 'user.email=fixture@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic bundle fixture'], source);
    developmentBundle = path.join(temporary, 'development');
    candidateBundle = path.join(temporary, 'candidate');
    development = await packCore(source, developmentBundle, { development: true });
    // Permission to read dirty source is not an instruction to mark clean source dirty.
    candidate = await packCore(source, candidateBundle, { allowDirty: true });
  }, 30000);
  afterAll(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

  it('honors explicit development intent on a clean committed source', async () => {
    expect(run('git', ['status', '--porcelain'], source)).toBe('');
    expect(development).toMatchObject({ development: true, buildIntent: 'development' });
    expect(candidate).toMatchObject({ development: false, buildIntent: 'release-candidate' });
    expect(development.sourceCommit).toBe(candidate.sourceCommit);
    expect(development.packages).toEqual(candidate.packages);
    await expect(verifyBundle(developmentBundle)).rejects.toThrow('Unsupported/unreleased');
    expect((await verifyBundle(developmentBundle, { allowDevelopment: true })).buildIntent).toBe('development');
    expect((await verifyBundle(candidateBundle)).buildIntent).toBe('release-candidate');
  });

  it('keeps permission to pack dirty source separate and never labels it a release candidate', async () => {
    const file = path.join(source, 'packages/auth-core/index.js');
    await fs.appendFile(file, '// Synthetic uncommitted edit.\n');
    try {
      await expect(packCore(source, path.join(temporary, 'rejected'), { development: true }))
        .rejects.toThrow('clean committed tree');
      const manifest = await packCore(source, path.join(temporary, 'dirty'), { allowDirty: true });
      expect(manifest).toMatchObject({ development: true, buildIntent: 'development' });
    } finally { await fs.writeFile(file, 'export const fixture = true;\n'); }
  }, 30000);

  async function copyManifest(name, original, update) {
    const directory = path.join(temporary, name);
    await fs.cp(original, directory, { recursive: true });
    const manifest = await json(path.join(directory, 'manifest.json'));
    await writeJson(path.join(directory, 'manifest.json'), update(manifest));
    await fs.writeFile(path.join(directory, 'manifest.sha256'),
      digest(await fs.readFile(path.join(directory, 'manifest.json')), 'sha256') + '\n');
    return directory;
  }

  it('rejects inconsistent/unknown intent while retaining legacy bundles unchanged', async () => {
    for (const [name, value] of [['contradiction', 'release-candidate'], ['unknown', 'published']]) {
      const directory = await copyManifest(name, developmentBundle, manifest => ({ ...manifest, buildIntent: value }));
      await expect(verifyBundle(directory, { allowDevelopment: true })).rejects.toThrow('Invalid bundle build intent');
    }
    const legacy = await copyManifest('legacy', candidateBundle, ({ buildIntent, ...manifest }) => manifest);
    expect((await verifyBundle(legacy)).buildIntent).toBeUndefined();
    expect((await verifyBundle(legacy)).development).toBe(false);
  });

  it('requires explicit development verification, checks the pin, and describes candidates honestly', async () => {
    const verifier = path.resolve('scripts/release/verify-consumer.mjs');
    async function consumer(name, bundle) {
      const root = path.join(temporary, name);
      await fs.mkdir(root);
      await writeJson(path.join(root, 'package.json'), { private: true });
      await writeJson(path.join(root, 'package-lock.json'), { packages: {} });
      await installBundle({ root, bundle, packageDirs: ['.'], apply: true, allowDevelopment: true });
      return root;
    }
    const dev = await consumer('development-consumer', developmentBundle);
    const invoke = (root, args = []) => spawnSync(process.execPath, [verifier, root, ...args], { encoding: 'utf8' });
    expect(invoke(dev).status).not.toBe(0);
    const allowed = invoke(dev, ['--development']);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain('build intent: development');
    expect(allowed.stdout).toContain('Publication is not verified');
    expect(allowed.stdout).toContain('not deployment approval');
    const release = await consumer('candidate-consumer', candidateBundle);
    const checked = invoke(release);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain('build intent: release-candidate');
    expect(checked.stdout).toContain('Publication is not verified');
    const pinFile = path.join(dev, '.core-release.json');
    const pin = await json(pinFile);
    await writeJson(pinFile, { ...pin, sourceCommit: '0'.repeat(40) });
    expect(invoke(dev, ['--development']).stderr).toContain('Pinned release identity mismatch');
  });

  it('does not replace an installed version merely to relabel its build intent', async () => {
    const root = path.join(temporary, 'immutable-consumer');
    await fs.mkdir(root);
    await writeJson(path.join(root, 'package.json'), { private: true });
    await installBundle({ root, bundle: candidateBundle, packageDirs: ['.'], apply: true });
    const original = await fs.readFile(path.join(root, '.core-release.json'), 'utf8');
    await expect(installBundle({ root, bundle: developmentBundle, packageDirs: ['.'], apply: true, allowDevelopment: true }))
      .rejects.toThrow('refusing overwrite');
    expect(await fs.readFile(path.join(root, '.core-release.json'), 'utf8')).toBe(original);
  });
});
