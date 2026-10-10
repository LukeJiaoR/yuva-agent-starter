import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_NAMES } from './release/artifacts.mjs';

const nodeEngine = '>=24 <25';
const read = (file) => fs.readFile(path.resolve(file), 'utf8');
const json = async (file) => JSON.parse(await read(file));
const roots = ['', 'examples/customer-support/'];

describe('Node 24-only runtime policy', () => {
  it('declares the same engine in application, core source, and lockfile metadata', async () => {
    for (const root of roots) {
      const lock = await json(`${root}package-lock.json`);
      const packageDirs = ['', 'starter-app', 'starter-web'];
      if (!root) packageDirs.push(...CORE_NAMES.map((name) => `packages/${name}`));
      for (const directory of packageDirs) {
        const manifest = await json(path.join(root, directory, 'package.json'));
        expect(manifest.engines.node, `${root}${directory}/package.json`).toBe(nodeEngine);
        expect(lock.packages[directory].engines.node, `${root}lock:${directory}`).toBe(nodeEngine);
      }
      expect((await json(`${root}package.json`)).packageManager).toBe('npm@10.9.8');
      expect((await read(`${root}.nvmrc`)).trim()).toBe('24');
      expect(await read(`${root}.npmrc`)).toMatch(/^engine-strict=true$/mu);
    }
  });

  it('keeps local containers and current operations metadata on Node 24', async () => {
    for (const root of roots) {
      for (const application of ['starter-app', 'starter-web']) {
        expect(await read(`${root}${application}/Dockerfile`)).toMatch(/^FROM node:24-alpine(?: AS build)?$/mu);
      }
    }
    const stack = await json('ops/stack.json');
    expect(stack.runtime.node).toEqual([24]);
    expect(stack.runtime.recommendedNode).toBe(24);
  });

  it('runs the existing CI and release gates only on Node 24', async () => {
    const ci = await read('.github/workflows/ci.yml');
    expect(ci).toMatch(/^\s+node-version: \[24\]$/mu);
    expect(ci).toContain('npm run test:acceptance');
    expect(ci).toContain('npm --prefix examples/customer-support run check');
    expect(ci).toContain('docker build -f starter-app/Dockerfile');
    expect(ci).toContain('docker build -f starter-web/Dockerfile');
    expect(await read('.github/workflows/release-core.yml')).toMatch(/^\s+node-version: 24$/mu);
  });
});
