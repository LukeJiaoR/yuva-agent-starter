import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packCore } from './artifacts.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('Usage: npm run release:pack -- --output <empty-directory>');
const manifest = await packCore(root, path.resolve(args[outputIndex + 1]), { allowDirty: args.includes('--allow-dirty') });
console.log(JSON.stringify({ version: manifest.version, sourceCommit: manifest.sourceCommit, development: manifest.development }));
