import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packCore, verifyBundle, installBundle, json, writeJson, digest, run } from './artifacts.mjs';

describe('private release integrity and safe consumer upgrades', () => {
  let temp, bundle, manifest, consumer;
  beforeAll(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'core-release-test-'));
    bundle = path.join(temp, 'bundle'); consumer = path.join(temp, 'consumer');
    manifest = await packCore(process.cwd(), bundle, { allowDirty: true });
    await fs.mkdir(consumer);
    await writeJson(path.join(consumer, 'package.json'), { private: true, type: 'module', dependencies: { '@yuva/billing-core': '1.0.0' } });
    await fs.writeFile(path.join(consumer, 'product.js'), 'product-owned logic');
  }, 30000);
  afterAll(async () => fs.rm(temp, { recursive: true, force: true }));
  it('packs only declared public runtime files with per-component hashes', async () => {
    expect(manifest.packages).toHaveLength(5);
    expect(manifest.compatibility.node).toEqual([24]);
    expect(manifest.compatibility.starterMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(manifest.compatibility.automaticMigrations).toBe(false);
    expect((await verifyBundle(bundle, { allowDevelopment: true })).version).toBe('3.0.0');
    expect(manifest.packages.every((p) => p.integrity.startsWith('sha512-'))).toBe(true);
  });
  it('defaults to a read-only plan and never edits product source', async () => {
    const original = await fs.readFile(path.join(consumer, 'package.json'), 'utf8');
    const plan = await installBundle({ root: consumer, bundle, packageDirs: ['.'], allowDevelopment: true });
    expect(plan.apply).toBe(false); expect(plan.changes).toHaveLength(1);
    expect(await fs.readFile(path.join(consumer, 'package.json'), 'utf8')).toBe(original);
    await installBundle({ root: consumer, bundle, packageDirs: ['.'], apply: true, allowDevelopment: true });
    expect((await json(path.join(consumer, 'package.json'))).dependencies['@yuva/billing-core']).toContain('vendor/yuva-core/3.0.0/');
    expect(await fs.readFile(path.join(consumer, 'product.js'), 'utf8')).toBe('product-owned logic');
  });
  it('installs all packages outside the workspace and enforces public exports', async () => {
    const isolated = path.join(temp, 'isolated'); await fs.mkdir(isolated);
    const appManifest = await json(path.join(process.cwd(), 'starter-app/package.json'));
    const applicationDependencies = Object.fromEntries(Object.entries(appManifest.dependencies)
      .filter(([name]) => !name.startsWith('@yuva/') && name !== '@clerk/backend'));
    await writeJson(path.join(isolated, 'package.json'), { private: true, type: 'module',
      dependencies: { ...applicationDependencies, ...Object.fromEntries(manifest.packages.map((p) => [p.name, p.version])) } });
    await installBundle({ root: isolated, bundle, packageDirs: ['.'], apply: true, allowDevelopment: true });
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], isolated);
    const source = manifest.packages.map((p) => `await import('${p.name}');`).join('\n') + `
      try { await import('@yuva/ai-engine/src/agentRuntime.js'); process.exit(1); }
      catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
    `;
    run(process.execPath, ['--input-type=module', '-e', source], isolated);
    const lock = await json(path.join(isolated, 'package-lock.json'));
    // Optional peers are actually absent, not merely avoided by the source import.
    expect(Object.keys(lock.packages).some((name) => name.endsWith('node_modules/@clerk/backend'))).toBe(false);
    await expect(fs.access(path.join(isolated, 'node_modules/@clerk/backend'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.cp(path.join(process.cwd(), 'starter-app/server'), path.join(isolated, 'server'), { recursive: true });
    const composition = `
      import assert from 'node:assert/strict';
      import { createServer } from './server/index.js';
      import { createRequireAuth, verifyClerkRequest } from '@yuva/auth-core';
      console.error = () => {};
      const db = { query() { throw new Error('Unexpected SQL in identity fixture'); } };
      const auth = {
        verifyRequest: async () => ({ kind: 'authenticated', userId: 'verified-subject' }),
        findUser: async subject => { assert.equal(subject, 'verified-subject'); return { id: 'local-user' }; },
      };
      const config = { env: { NODE_ENV: 'test', AI_PROVIDER: 'mock', ALLOW_DEV_GUEST: 'true' } };
      const app = createServer({ db, config, auth });
      app.get('/identity-fixture', (req, res) => res.json({ id: req.user.id, clerk: req.clerkAuth }));
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/identity-fixture');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { id: 'local-user', clerk: null });
      } finally {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
      const env = { NODE_ENV: 'production', CLERK_JWT_KEY: 'fixture-key',
        CLERK_AUTHORIZED_PARTIES: 'https://auth.example.test' };
      const req = { headers: { authorization: 'Bearer fixture-token' } };
      assert.deepEqual(await verifyClerkRequest(req, { env }), { kind: 'unavailable', token: null });
      let status, body, passed = false;
      const res = { status(value) { status = value; return this; }, json(value) { body = value; } };
      await createRequireAuth({ env, findUser: auth.findUser })(req, res, () => { passed = true; });
      assert.equal(status, 503);
      assert.equal(body.code, 'authentication_unavailable');
      assert.equal(passed, false);
      const unavailable = createServer({ db, config: { env: { ...config.env, ...env, NODE_ENV: 'test' } } });
      const unavailableServer = unavailable.listen(0, '127.0.0.1');
      await new Promise(resolve => unavailableServer.once('listening', resolve));
      try {
        const response = await fetch('http://127.0.0.1:' + unavailableServer.address().port + '/api/pricing',
          { headers: req.headers });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, 'authentication_unavailable');
      } finally {
        await new Promise(resolve => { unavailableServer.close(resolve); unavailableServer.closeAllConnections(); });
      }
    `;
    await fs.writeFile(path.join(isolated, 'auth-composition.mjs'), composition);
    run(process.execPath, ['auth-composition.mjs'], isolated);
    if (process.env.TEST_DATABASE_URL) {
      await fs.mkdir(path.join(isolated, 'scripts'));
      for (const entry of ['migrations.mjs', 'schema.sql', 'migrations']) await fs.cp(path.join(process.cwd(), 'scripts', entry), path.join(isolated, 'scripts', entry), { recursive: true });
      await fs.copyFile(path.join(process.cwd(), 'scripts/release/fixtures/self-hosted-consumer.mjs'), path.join(isolated, 'self-hosted-consumer.mjs'));
      run(process.execPath, ['self-hosted-consumer.mjs'], isolated);
      // Repeat the same cookie/session/database contract with Clerk installed;
      // explicit self-hosted selection must not silently change providers.
      run('npm', ['install', '@clerk/backend@' + appManifest.dependencies['@clerk/backend'], '--ignore-scripts', '--no-audit', '--no-fund'], isolated);
      run(process.execPath, ['self-hosted-consumer.mjs'], isolated);
    }

    for (const component of manifest.packages) {
      expect(lock.packages[`node_modules/${component.name}`].integrity).toBe(component.integrity);
      expect(lock.packages[`node_modules/${component.name}`].engines.node).toBe('>=24.22.1 <25');
    }
  }, 120000);
  it('refuses artifact tampering and replacement of an already pinned version', async () => {
    const corrupt = path.join(temp, 'corrupt'); await fs.cp(bundle, corrupt, { recursive: true });
    await fs.appendFile(path.join(corrupt, manifest.packages[0].file), 'corrupt');
    await expect(installBundle({ root: consumer, bundle: corrupt, packageDirs: ['.'], apply: true, allowDevelopment: true })).rejects.toThrow('Integrity');
    const changed = path.join(temp, 'changed'); await fs.cp(bundle, changed, { recursive: true });
    await writeJson(path.join(changed, 'manifest.json'), { ...manifest, sourceCommit: '1'.repeat(40),
      starterUsageAdapter: { ...manifest.starterUsageAdapter, sourceCommit: '1'.repeat(40) } });
    await fs.writeFile(path.join(changed, 'manifest.sha256'), digest(await fs.readFile(path.join(changed, 'manifest.json')), 'sha256') + '\n');
    await expect(installBundle({ root: consumer, bundle: changed, packageDirs: ['.'], apply: true, allowDevelopment: true })).rejects.toThrow('refusing overwrite');
  });
  it('tracks one product-owned usage adapter through a real generator and read-only three-way plans', async () => {
    const generated = path.join(temp, 'generated-adapter-consumer');
    run(process.execPath, ['scripts/create-web-app.mjs', 'adapter-consumer', '--target', generated,
      '--bundle', bundle, '--development'], process.cwd());
    const adapterPath = manifest.starterUsageAdapter.path;
    const file = path.join(generated, adapterPath);
    const original = await fs.readFile(file, 'utf8');
    const plan = candidate => installBundle({ root: generated, bundle: candidate || bundle, allowDevelopment: true });
    const pinFile = path.join(generated, '.core-release.json');
    const initialPin = await json(pinFile);
    expect(initialPin.starterUsageAdapter).toEqual(manifest.starterUsageAdapter);
    expect((await plan()).starterUsageAdapter.status).toBe('unchanged');
    const snapshot = async () => Promise.all([adapterPath, 'package.json', 'starter-app/package.json',
      'package-lock.json', '.core-release.json', initialPin.manifest].map(name => fs.readFile(path.join(generated, name), 'utf8')));
    const customize = original + '\n// Synthetic product-owned customization.\n';
    await fs.writeFile(file, customize);
    const before = await snapshot();
    const local = await plan();
    expect(local.starterUsageAdapter.status).toBe('local_changed');
    expect(local.starterUsageAdapter.currentIntegrity).toBe(digest(customize, 'sha256'));
    expect(JSON.stringify(local)).not.toContain('Synthetic product-owned');
    expect(JSON.stringify(local)).not.toContain(generated);
    expect(await snapshot()).toEqual(before);
    await installBundle({ root: generated, bundle, apply: true, allowDevelopment: true });
    expect(await fs.readFile(file, 'utf8')).toBe(customize);
    expect((await json(pinFile)).starterUsageAdapter).toEqual(initialPin.starterUsageAdapter);

    // Simulated upstream provenance only: no consumer source is ever added to a bundle.
    const next = path.join(temp, 'next-adapter-metadata');
    await fs.cp(bundle, next, { recursive: true });
    const upstream = { ...manifest, sourceCommit: '1'.repeat(40), starterUsageAdapter: {
      ...manifest.starterUsageAdapter, sourceCommit: '1'.repeat(40),
      integrity: digest(original + '\n// Synthetic upstream revision.\n', 'sha256'),
    } };
    const saveManifest = async (directory, value) => {
      await writeJson(path.join(directory, 'manifest.json'), value);
      await fs.writeFile(path.join(directory, 'manifest.sha256'), digest(await fs.readFile(path.join(directory, 'manifest.json')), 'sha256') + '\n');
    };
    await saveManifest(next, upstream);
    expect((await plan(next)).starterUsageAdapter).toMatchObject({ status: 'diverged', base: manifest.starterUsageAdapter,
      currentIntegrity: digest(customize, 'sha256'), upstream: upstream.starterUsageAdapter });
    expect(await snapshot()).toEqual(before);
    await fs.writeFile(file, original);
    const beforeUpstreamPlan = await snapshot();
    expect((await plan(next)).starterUsageAdapter.status).toBe('upstream_changed');
    expect(await snapshot()).toEqual(beforeUpstreamPlan);

    // An older app base plus exact known new bytes is distinguishable from a custom merge.
    await writeJson(pinFile, { ...initialPin, starterUsageAdapter: upstream.starterUsageAdapter });
    expect((await plan()).starterUsageAdapter.status).toBe('upstream_applied');
    await installBundle({ root: generated, bundle, apply: true, allowDevelopment: true });
    expect((await json(pinFile)).starterUsageAdapter).toEqual(manifest.starterUsageAdapter);
    expect(await fs.readFile(file, 'utf8')).toBe(original);

    // Legacy pins and bundles remain installable, but unknown source is never invented.
    const { starterUsageAdapter, ...legacyPin } = initialPin;
    await writeJson(pinFile, legacyPin);
    expect((await plan()).starterUsageAdapter).toMatchObject({ status: 'base_unknown', base: null });
    const legacy = { ...manifest }; delete legacy.starterUsageAdapter;
    await saveManifest(next, legacy);
    expect((await verifyBundle(next, { allowDevelopment: true })).starterUsageAdapter).toBeUndefined();
    expect((await plan(next)).starterUsageAdapter.status).toBe('upstream_unknown');
    const legacyConsumer = path.join(temp, 'legacy-adapter-consumer'); await fs.mkdir(legacyConsumer);
    await writeJson(path.join(legacyConsumer, 'package.json'), { private: true, dependencies: {} });
    await installBundle({ root: legacyConsumer, bundle: next, packageDirs: ['.'], apply: true, allowDevelopment: true });
    expect((await json(path.join(legacyConsumer, '.core-release.json'))).starterUsageAdapter).toBeUndefined();
    await fs.rm(file);
    expect((await plan()).starterUsageAdapter.status).toBe('current_unavailable');
    await fs.symlink(path.join(temp, 'missing-private-file'), file);
    expect((await plan()).starterUsageAdapter.status).toBe('current_unavailable');
    await fs.rm(file);
    await fs.writeFile(file, original);
    const storeDir = path.dirname(file), movedDir = path.join(temp, 'outside-product-stores');
    await fs.rename(storeDir, movedDir);
    await fs.symlink(movedDir, storeDir, 'dir');
    try { expect((await plan()).starterUsageAdapter.status).toBe('current_unavailable'); }
    finally { await fs.rm(storeDir); await fs.rename(movedDir, storeDir); }
    await saveManifest(next, { ...manifest, starterUsageAdapter: { ...starterUsageAdapter, path: '../private-file' } });
    await expect(verifyBundle(next, { allowDevelopment: true })).rejects.toThrow('Invalid adapter provenance');
  }, 120000);

  it('does not bind an uncommitted adapter to a source commit in a development bundle', async () => {
    const source = path.join(temp, 'dirty-adapter-source'), output = path.join(temp, 'dirty-adapter-bundle');
    run('git', ['clone', '--quiet', '--local', '--shared', process.cwd(), source], process.cwd());
    await fs.appendFile(path.join(source, 'starter-app/server/stores/usageStore.js'), '\n// Synthetic uncommitted adapter edit.\n');
    const dirty = await packCore(source, output, { allowDirty: true });
    expect(dirty.development).toBe(true);
    expect(dirty.starterUsageAdapter).toBeUndefined();
    expect((await verifyBundle(output, { allowDevelopment: true })).starterUsageAdapter).toBeUndefined();
    const target = path.join(temp, 'dirty-adapter-plan'); await fs.mkdir(target);
    await writeJson(path.join(target, 'package.json'), { private: true, dependencies: {} });
    const result = await installBundle({ root: target, bundle: output, packageDirs: ['.'], apply: true, allowDevelopment: true });
    expect(result.starterUsageAdapter.status).toBe('upstream_unknown');
    expect((await json(path.join(target, '.core-release.json'))).starterUsageAdapter).toBeUndefined();

    // Turn this synthetic source into a genuinely committed, differently versioned
    // local bundle, then apply it to a customized consumer without touching app code.
    const versionParts = manifest.version.split('.').map(Number); versionParts[2] += 1;
    const nextVersion = versionParts.join('.');
    for (const component of manifest.packages) {
      const file = path.join(source, 'packages', component.name.slice('@yuva/'.length), 'package.json');
      const pkg = await json(file); pkg.version = nextVersion; await writeJson(file, pkg);
    }
    run('git', ['add', 'packages', 'starter-app/server/stores/usageStore.js'], source);
    run('git', ['-c', 'user.name=AdapterFixture', '-c', 'user.email=fixture@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic local adapter upgrade fixture'], source);
    const upgradedBundle = path.join(temp, 'committed-adapter-bundle');
    const upgraded = await packCore(source, upgradedBundle);
    expect(upgraded.development).toBe(false); expect(upgraded.starterUsageAdapter).toBeDefined();
    const product = path.join(temp, 'customized-upgrade-consumer');
    const productFile = path.join(product, manifest.starterUsageAdapter.path);
    await fs.mkdir(path.dirname(productFile), { recursive: true });
    await fs.copyFile(path.join(process.cwd(), manifest.starterUsageAdapter.path), productFile);
    await writeJson(path.join(product, 'package.json'), { private: true, dependencies: { '@yuva/billing-core': manifest.version } });
    await installBundle({ root: product, bundle, packageDirs: ['.'], apply: true, allowDevelopment: true });
    await fs.appendFile(productFile, '\n// Synthetic private product customization.\n');
    const customized = await fs.readFile(productFile, 'utf8');
    const resultUpgrade = await installBundle({ root: product, bundle: upgradedBundle, packageDirs: ['.'], apply: true });
    expect(resultUpgrade.starterUsageAdapter.status).toBe('diverged');
    const upgradedPin = await json(path.join(product, '.core-release.json'));
    expect(upgradedPin.version).toBe(nextVersion); expect(upgradedPin.sourceCommit).toBe(upgraded.sourceCommit);
    expect(upgradedPin.starterUsageAdapter).toEqual(manifest.starterUsageAdapter);
    expect(await fs.readFile(productFile, 'utf8')).toBe(customized);
  }, 60000);

});
