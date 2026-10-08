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
    expect(manifest.compatibility.starterMigrations).toEqual([1, 2, 3, 4, 5, 6]);
    expect(manifest.compatibility.automaticMigrations).toBe(false);
    expect((await verifyBundle(bundle, { allowDevelopment: true })).version).toBe('1.4.0');
    expect(manifest.packages.every((p) => p.integrity.startsWith('sha512-'))).toBe(true);
  });
  it('defaults to a read-only plan and never edits product source', async () => {
    const original = await fs.readFile(path.join(consumer, 'package.json'), 'utf8');
    const plan = await installBundle({ root: consumer, bundle, packageDirs: ['.'], allowDevelopment: true });
    expect(plan.apply).toBe(false); expect(plan.changes).toHaveLength(1);
    expect(await fs.readFile(path.join(consumer, 'package.json'), 'utf8')).toBe(original);
    await installBundle({ root: consumer, bundle, packageDirs: ['.'], apply: true, allowDevelopment: true });
    expect((await json(path.join(consumer, 'package.json'))).dependencies['@yuva/billing-core']).toContain('vendor/yuva-core/1.4.0/');
    expect(await fs.readFile(path.join(consumer, 'product.js'), 'utf8')).toBe('product-owned logic');
  });
  it('installs all packages outside the workspace and enforces public exports', async () => {
    const isolated = path.join(temp, 'isolated'); await fs.mkdir(isolated);
    await writeJson(path.join(isolated, 'package.json'), { private: true, type: 'module', dependencies: Object.fromEntries(manifest.packages.map((p) => [p.name, p.version])) });
    await installBundle({ root: isolated, bundle, packageDirs: ['.'], apply: true, allowDevelopment: true });
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], isolated);
    const source = manifest.packages.map((p) => `await import('${p.name}');`).join('\n') + `
      try { await import('@yuva/ai-engine/src/agentRuntime.js'); process.exit(1); }
      catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
    `;
    run(process.execPath, ['--input-type=module', '-e', source], isolated);
    const lock = await json(path.join(isolated, 'package-lock.json'));
    for (const component of manifest.packages) expect(lock.packages[`node_modules/${component.name}`].integrity).toBe(component.integrity);
  }, 120000);
  it('refuses artifact tampering and replacement of an already pinned version', async () => {
    const corrupt = path.join(temp, 'corrupt'); await fs.cp(bundle, corrupt, { recursive: true });
    await fs.appendFile(path.join(corrupt, manifest.packages[0].file), 'corrupt');
    await expect(installBundle({ root: consumer, bundle: corrupt, packageDirs: ['.'], apply: true, allowDevelopment: true })).rejects.toThrow('Integrity');
    const changed = path.join(temp, 'changed'); await fs.cp(bundle, changed, { recursive: true });
    await writeJson(path.join(changed, 'manifest.json'), { ...manifest, sourceCommit: '1'.repeat(40) });
    await fs.writeFile(path.join(changed, 'manifest.sha256'), digest(await fs.readFile(path.join(changed, 'manifest.json')), 'sha256') + '\n');
    await expect(installBundle({ root: consumer, bundle: changed, packageDirs: ['.'], apply: true, allowDevelopment: true })).rejects.toThrow('refusing overwrite');
  });
});
