import path from 'node:path';
import fs from 'node:fs/promises';
import { json, verifyBundle, digest } from './artifacts.mjs';
const root = path.resolve(process.argv[2] || '.');
const pin = await json(path.join(root, '.core-release.json'));
const directory = path.resolve(root, path.dirname(pin.manifest));
if (!directory.startsWith(root + path.sep)) throw new Error('Manifest escapes consumer');
const manifest = await verifyBundle(directory);
if (digest(await fs.readFile(path.join(root, pin.manifest)), 'sha256') !== pin.manifestIntegrity || pin.sourceCommit !== manifest.sourceCommit || pin.version !== manifest.version) throw new Error('Pinned release identity mismatch');
for (const packageDir of pin.packageDirs) {
  const dir = path.resolve(root, packageDir);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error('Package directory escapes consumer');
  const pkg = await json(path.join(dir, 'package.json'));
  let lock;
  try { lock = await json(path.join(dir, 'package-lock.json')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    lock = await json(path.join(root, 'package-lock.json'));
  }
  for (const component of manifest.packages) {
    const declared = pkg.dependencies?.[component.name] || pkg.devDependencies?.[component.name] || pkg.optionalDependencies?.[component.name];
    if (!declared) continue;
    const expected = 'file:' + path.relative(dir, path.join(directory, component.file)).split(path.sep).join('/');
    if (declared !== expected) throw new Error(`Unpinned core dependency: ${component.name}`);
    const installed = lock.packages?.[`node_modules/${component.name}`];
    if (installed?.version !== component.version || installed?.integrity !== component.integrity || installed?.link) throw new Error(`Lockfile core integrity mismatch: ${component.name}`);
  }
}
console.log(`Verified ${manifest.tag} at ${manifest.sourceCommit}`);
