import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle, run, REPOSITORY } from './artifacts.mjs';
const directory = path.resolve(process.argv[2] || '.release');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = await verifyBundle(directory);
if (run('git', ['rev-parse', 'HEAD'], root) !== manifest.sourceCommit) throw new Error('Release source is not checked-out HEAD');
run('git', ['fetch', 'origin', 'main'], root);
run('git', ['merge-base', '--is-ancestor', manifest.sourceCommit, 'origin/main'], root);
const tags = JSON.parse(run('gh', ['release', 'list', '--repo', REPOSITORY, '--limit', '100', '--json', 'tagName'], root));
if (tags.some((r) => r.tagName === manifest.tag)) throw new Error('Release version already exists; never overwrite release assets');
const assets = ['manifest.json', 'manifest.sha256', ...manifest.packages.map((p) => p.file)].map((file) => path.join(directory, file));
console.log(run('gh', ['release', 'create', manifest.tag, ...assets, '--repo', REPOSITORY, '--target', manifest.sourceCommit,
  '--title', `YUVA Core ${manifest.version}`, '--notes-file', path.join(root, 'docs/releases', `${manifest.version}.md`)], root));
