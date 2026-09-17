import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { installBundle, run, REPOSITORY, verifyBundle } from './artifacts.mjs';
const args = process.argv.slice(2), value = (key) => args[args.indexOf(key) + 1];
if (!args.includes('--target') || (!args.includes('--bundle') && !args.includes('--tag'))) throw new Error('Usage: node scripts/release/upgrade.mjs --target <project> --bundle <directory> | --tag core-vX.Y.Z [--packages .,starter-app] [--apply]');
const root = path.resolve(value('--target'));
let temporary;
try {
  let bundle;
  if (args.includes('--tag')) {
    const tag = value('--tag');
    if (!/^core-v\d+\.\d+\.\d+$/u.test(tag)) throw new Error('Invalid release tag');
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuva-core-download-')); bundle = temporary;
    run('gh', ['release', 'download', tag, '--repo', REPOSITORY, '--dir', bundle], root);
    const manifest = await verifyBundle(bundle);
    const commit = run('gh', ['api', `repos/${REPOSITORY}/commits/${tag}`, '--jq', '.sha'], root);
    if (manifest.tag !== tag || manifest.sourceCommit !== commit) throw new Error('Release tag/source mismatch');
  } else bundle = path.resolve(value('--bundle'));
  const packageDirs = args.includes('--packages') ? value('--packages').split(',') : ['.', 'starter-app'];
  console.log(JSON.stringify(await installBundle({ root, bundle, packageDirs, apply: args.includes('--apply') }), null, 2));
  if (args.includes('--apply')) console.log('Update and review the consumer lockfile with npm install --package-lock-only --ignore-scripts, then npm ci and run the consumer checks. No application/schema migration was run.');
} finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
