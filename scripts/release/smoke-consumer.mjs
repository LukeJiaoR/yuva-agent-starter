import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyBundle, run, json } from './artifacts.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), index = args.indexOf('--bundle');
if (index < 0 || !args[index + 1]) throw new Error('Usage: npm run smoke:consumer -- --bundle <release-directory>');
if (!process.env.TEST_DATABASE_URL) throw new Error('Explicit non-production TEST_DATABASE_URL is required');
const bundle = path.resolve(args[index + 1]), manifest = await verifyBundle(bundle);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuva-consumer-'));
const target = path.join(temporary, 'support-agent');
try {
  console.log(run(process.execPath, ['scripts/create-web-app.mjs', 'support-agent', '--domain', 'Customer Support', '--bundle', bundle, '--target', target, '--install'], root));
  const pin = await json(path.join(target, '.core-release.json'));
  if (pin.sourceCommit !== manifest.sourceCommit || pin.version !== manifest.version) throw new Error('Generated consumer release mismatch');
  try { await fs.access(path.join(target, 'packages')); throw new Error('Generated consumer contains core source'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(run('npm', ['run', 'check'], target));
  console.log(JSON.stringify({ version: manifest.version, sourceCommit: manifest.sourceCommit, manifestIntegrity: pin.manifestIntegrity, generatedConsumer: 'Customer Support', checks: 'passed' }));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
