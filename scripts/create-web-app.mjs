#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
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
  --help                       Show this help

Example:
  npm run create -- legal-lens --domain "Legal research" --install`);
}

function parseArgs(argv) {
  const options = { install: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--install') options.install = true;
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
  return !segments.some((segment) => ['.git', 'node_modules', 'dist', 'coverage', '.env'].includes(segment))
    && !relative.endsWith('.log')
    && relative !== '.DS_Store';
}

async function writeGeneratedConfig(target, options) {
  const appSlug = slug(options.name);
  const domainKey = slug(options.domainKey || options.name);
  const domainName = options.domain || displayName(domainKey);
  const description = options.description || `A grounded AI assistant for ${domainName.toLowerCase()}.`;

  const rootPackagePath = path.join(target, 'package.json');
  const rootPackage = JSON.parse(await fs.readFile(rootPackagePath, 'utf8'));
  rootPackage.name = appSlug;
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
  }, null, 2)}\n`);
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

  await ensureEmptyTarget(target);
  await fs.cp(sourceRoot, target, { recursive: true, filter: copyFilter });
  await writeGeneratedConfig(target, options);

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
