#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { packCore, verifyBundle, installBundle, run } from './release/artifacts.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`Create a new vertical AI web app from this starter.

Usage:
  npm run create -- <app-name> [options]

Options:
  --domain <display name>       Human-readable domain name
  --domain-key <key>           Machine key, defaults to the app name
  --description <text>         Short product description
  --target <directory>         Output path, defaults to a sibling directory
  --install                    Run npm ci in the generated project
  --bundle <directory>         Use a verified release bundle
  --development                Allow dirty source or an explicit development bundle
  --help                       Show this help

Example:
  npm run create -- legal-lens --domain "Legal research" --install`);
}

function parseArgs(argv) {
  const options = { install: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--install') options.install = true;
    else if (arg === '--development') options.development = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[key] = value;
      index += 1;
    } else if (!options.name) {
      options.name = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }
  return options;
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
}

function displayName(value) {
  return String(value || '')
    .trim()
    .split(/[-_\s]+/gu)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

async function ensureEmptyTarget(target) {
  try {
    const entries = await fs.readdir(target);
    if (entries.length) throw new Error(`Target directory is not empty: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(target, { recursive: true });
  }
}

function copyFilter(source) {
  const relative = path.relative(sourceRoot, source);
  if (!relative) return true;
  const segments = relative.split(path.sep);
  if (segments.some((name) => ['.git', 'node_modules', 'dist', 'coverage', 'vendor', 'packages', 'examples', '.release', '.ai-gh-account'].includes(name))) return false;
  if (segments.some((name) => name.startsWith('.env') && name !== '.env.example')) return false;
  if (relative.endsWith('.log') || relative.endsWith('.tgz') || relative.endsWith('.DS_Store')) return false;
  if (relative.startsWith('scripts/release/fixtures/')) return false;
  if (relative.startsWith('scripts/') && (relative.endsWith('.test.js') || relative.endsWith('create-web-app.mjs') || relative.endsWith('release/pack.mjs') || relative.endsWith('release/smoke-consumer.mjs'))) return false;
  if (relative.startsWith('.github/') && relative !== '.github/workflows' && relative !== '.github/workflows/ci.yml') return false;
  return true;
}

async function writeGeneratedConfig(target, options, bundle, release) {
  const appSlug = slug(options.name);
  const domainKey = slug(options.domainKey || options.name);
  const domainName = options.domain || displayName(domainKey);
  const description = options.description || `A grounded AI assistant for ${domainName.toLowerCase()}.`;

  const rootPackagePath = path.join(target, 'package.json');
  const rootPackage = JSON.parse(await fs.readFile(rootPackagePath, 'utf8'));
  rootPackage.name = appSlug;
  rootPackage.workspaces = ['starter-app', 'starter-web'];
  for (const name of ['create', 'release:pack', 'test:packages', 'smoke:consumer']) delete rootPackage.scripts[name];
  const verification = 'node scripts/release/verify-consumer.mjs';
  rootPackage.scripts['verify:boundaries'] = verification + (release.development ? ' --development' : '');
  rootPackage.scripts.test = 'npm run verify:boundaries && vitest run';
  await fs.writeFile(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

  const lockPath = path.join(target, 'package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.name = appSlug;
  if (lock.packages?.['']) lock.packages[''].name = appSlug;
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const apiExample = await fs.readFile(path.join(target, 'starter-app', '.env.example'), 'utf8');
  const apiEnv = `${apiExample.trim()}\n`.replace(/^DOMAIN_KEY=.*$/mu, `DOMAIN_KEY=${domainKey}`);
  await fs.writeFile(path.join(target, 'starter-app', '.env'), apiEnv);

  const webExample = await fs.readFile(path.join(target, 'starter-web', '.env.example'), 'utf8');
  const webEnv = webExample
    .replace(/^VITE_APP_NAME=.*$/mu, `VITE_APP_NAME=${domainName}`)
    .replace(/^VITE_APP_DESCRIPTION=.*$/mu, `VITE_APP_DESCRIPTION=${description}`);
  await fs.writeFile(path.join(target, 'starter-web', '.env'), webEnv);
  await fs.writeFile(path.join(target, 'starter-web', '.env.production'), webEnv);

  await fs.writeFile(path.join(target, '.starter.json'), `${JSON.stringify({
    appName: domainName,
    packageName: appSlug,
    domainKey,
    generatedAt: new Date().toISOString(),
    source: { repository: release.repository, commit: run('git', ['rev-parse', 'HEAD'], sourceRoot), starterVersion: rootPackage.version },
    core: { version: release.version, tag: release.tag, sourceCommit: release.sourceCommit, packages: release.packages.map(({ name, version, integrity }) => ({ name, version, integrity })) },
    development: release.development,
    ...(release.buildIntent ? { buildIntent: release.buildIntent } : {}),
  }, null, 2)}\n`);
  await installBundle({ root: target, bundle, apply: true, allowDevelopment: !options.bundle || options.development });
  await fs.writeFile(path.join(target, 'scripts/verify-boundaries.mjs'),
    (release.development ? "process.argv.push('--development');\n" : '') + "await import('./release/verify-consumer.mjs');\n");
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], target);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.name) {
    usage();
    throw new Error('An app name is required');
  }
  const appSlug = slug(options.name);
  if (!appSlug) throw new Error('App name must contain letters or numbers');

  const target = options.target
    ? path.resolve(process.cwd(), options.target)
    : path.resolve(sourceRoot, '..', appSlug);
  if (target === sourceRoot || target.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error('Target must be outside the starter repository');
  }

  let temporary;
  try {
    const bundle = options.bundle ? path.resolve(options.bundle)
      : (temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuva-generator-core-')));
    if (!options.bundle) await packCore(sourceRoot, bundle, { allowDirty: options.development, development: true });
    const release = await verifyBundle(bundle, { allowDevelopment: !options.bundle || options.development });
    await ensureEmptyTarget(target);
    await fs.cp(sourceRoot, target, { recursive: true, filter: copyFilter });
    await writeGeneratedConfig(target, options, bundle, release);
    if (release.development) console.log('Local development bundle: npm test/check verify integrity with --development. This is not a published release or deployment approval.');
    else console.log('Bundle integrity checked. Publication and deployment approval are not established by generation.');
  } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }

  if (options.install) {
    const result = spawnSync('npm', ['ci'], { cwd: target, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('npm ci failed in the generated project');
  }

  console.log(`\nCreated ${displayName(options.name)} at ${target}`);
  const installStep = options.install ? '' : '\n  npm ci';
  console.log(`\nNext steps:\n  cd ${target}${installStep}\n  npm run db:up\n  npm run setup\n  npm run dev`);
}

main().catch((error) => {
  console.error(`Create failed: ${error.message}`);
  process.exitCode = 1;
});
