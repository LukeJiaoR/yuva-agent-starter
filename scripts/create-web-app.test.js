import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('create-web-app generator', () => {
  let temporaryRoot;
  let target;
  let result;

  beforeAll(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yuva-create-test-'));
    target = path.join(temporaryRoot, 'legal-lens');
    result = spawnSync(process.execPath, [
      'scripts/create-web-app.mjs',
      'legal-lens',
      '--development',
      '--domain', 'Legal Research',
      '--domain-key', 'legal-research',
      '--description', 'Review controlled legal facts before asking the model.',
      '--target', target,
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
  }, 120_000);

  afterAll(async () => {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates a complete, renamed project outside the starter repository', async () => {
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(target, 'package-lock.json'), 'utf8'));
    const metadata = JSON.parse(await fs.readFile(path.join(target, '.starter.json'), 'utf8'));
    expect(manifest.name).toBe('legal-lens');
    expect(manifest.workspaces).toEqual(['starter-app', 'starter-web']);
    expect(metadata.source.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(metadata.core.packages).toHaveLength(5);
    await expect(fs.access(path.join(target, 'packages'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(lock.name).toBe('legal-lens');
    expect(metadata).toMatchObject({
      appName: 'Legal Research',
      packageName: 'legal-lens',
      domainKey: 'legal-research',
    });
    await expect(fs.access(path.join(target, 'starter-app', 'server', 'index.js'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(target, 'starter-web', 'src', 'main.jsx'))).resolves.toBeUndefined();
  });

  it('writes ready-to-edit API and web environment files without copying local secrets', async () => {
    const apiEnv = await fs.readFile(path.join(target, 'starter-app', '.env'), 'utf8');
    const webEnv = await fs.readFile(path.join(target, 'starter-web', '.env'), 'utf8');
    const productionWebEnv = await fs.readFile(path.join(target, 'starter-web', '.env.production'), 'utf8');
    expect(apiEnv).toContain('DOMAIN_KEY=legal-research');
    expect(apiEnv.match(/^DOMAIN_KEY=/gmu)).toHaveLength(1);
    expect(webEnv).toContain('VITE_APP_NAME=Legal Research');
    expect(webEnv).toContain('Review controlled legal facts before asking the model.');
    expect(productionWebEnv).toBe(webEnv);
    await expect(fs.access(path.join(target, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(target, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
