import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CORE_NAMES = ['admin-core', 'ai-engine', 'auth-core', 'billing-core', 'context-engine'];
export const REPOSITORY = 'LukeJiaoR/yuva-agent-starter';
const USAGE_ADAPTER_PATH = 'starter-app/server/stores/usageStore.js';
export const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
export const writeJson = async (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
export const digest = (bytes, algorithm = 'sha512') => algorithm + '-' + createHash(algorithm).update(bytes).digest('base64');
export function run(file, args, cwd) { return execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function validUsageAdapter(value) {
  return value?.formatVersion === 1 && value.path === USAGE_ADAPTER_PATH
    && typeof value.sourceCommit === 'string' && /^[a-f0-9]{40}$/u.test(value.sourceCommit)
    && typeof value.integrity === 'string' && /^sha256-[A-Za-z0-9+/]{43}=$/u.test(value.integrity);
}
function usageAdapterRecord(value) {
  return validUsageAdapter(value) ? { formatVersion: 1, path: USAGE_ADAPTER_PATH,
    sourceCommit: value.sourceCommit, integrity: value.integrity } : null;
}
async function localAdapterIntegrity(root) {
  try {
    let file = root;
    const segments = USAGE_ADAPTER_PATH.split('/');
    for (const [index, segment] of segments.entries()) {
      file = path.join(file, segment);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) return null;
      if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) return null;
    }
    return digest(await fs.readFile(file), 'sha256');
  } catch (error) {
    if (['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}
async function usageAdapterPlan(root, manifest) {
  let previous;
  try { previous = await json(path.join(root, '.core-release.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const base = usageAdapterRecord(previous?.starterUsageAdapter);
  const upstream = usageAdapterRecord(manifest.starterUsageAdapter);
  const current = await localAdapterIntegrity(root);
  const status = !upstream ? 'upstream_unknown' : !current ? 'current_unavailable' : !base ? 'base_unknown'
    : current === upstream.integrity ? (current === base.integrity ? 'unchanged' : 'upstream_applied')
      : current === base.integrity ? 'upstream_changed' : upstream.integrity === base.integrity ? 'local_changed' : 'diverged';
  const recommendations = {
    upstream_unknown: 'This bundle has no adapter provenance. Do not infer compatibility or overwrite product code.',
    current_unavailable: 'The product adapter is absent or not a readable regular file. Review application requirements manually.',
    base_unknown: 'No recorded application base. Review the product adapter against the upstream source before adopting provenance.',
    unchanged: 'No source difference for this adapter. Product integration and migration checks still apply.',
    upstream_applied: 'The product file matches upstream. An explicit --apply can record that reviewed source as its base.',
    upstream_changed: 'Review upstream changes from base.sourceCommit to upstream.sourceCommit and merge into the product separately.',
    local_changed: 'Preserve product-owned edits. Upstream adapter bytes have not changed from the recorded base.',
    diverged: 'Both product and upstream differ from the base. Perform a manual three-way review; never overwrite product code.',
  };
  return {
    report: { path: USAGE_ADAPTER_PATH, status, base, currentIntegrity: current, upstream,
      recommendation: recommendations[status] },
    // Package installation never rewrites the app. Only exact known upstream bytes
    // permit adopting a new source base; all customizations keep their prior base.
    nextBase: upstream && current === upstream.integrity ? upstream : base,
  };
}

export async function packCore(root, output, { allowDirty = false, development = false } = {}) {
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=normal'], root);
  if (dirty && !allowDirty) throw new Error('Release requires a clean committed tree');
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root);
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error('Artifact output must be empty');
  const packages = [];
  for (const name of CORE_NAMES) {
    const directory = path.join(root, 'packages', name);
    const manifest = await json(path.join(directory, 'package.json'));
    if (manifest.name !== `@yuva/${name}` || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) throw new Error('Invalid release package identity');
    const packed = JSON.parse(run('npm', ['pack', directory, '--pack-destination', output, '--ignore-scripts', '--json'], root))[0];
    if (packed.files.some(({ path: entry }) => !/^(?:index\.js|package\.json|LICENSE|src\/[a-zA-Z0-9._/-]+\.js)$/u.test(entry))) throw new Error(`Unexpected packed file in ${name}`);
    packages.push({ name: manifest.name, version: manifest.version, file: packed.filename,
      integrity: digest(await fs.readFile(path.join(output, packed.filename))), dependencies: manifest.dependencies || {} });
  }
  const versions = [...new Set(packages.map((p) => p.version))];
  if (versions.length !== 1) throw new Error('Core components use one coordinated release version');
  const version = versions[0];
  const lock = await json(path.join(root, 'package-lock.json'));
  const testedDependencies = Object.fromEntries([...new Set(packages.flatMap((p) => Object.keys(p.dependencies)))].map((name) => [name, lock.packages[`node_modules/${name}`]?.version]));
  const starterMigrations = [1, ...(await fs.readdir(path.join(root, 'scripts/migrations')))
    .filter((name) => /^\d{3}-.*\.sql$/u.test(name)).sort().map((name) => Number(name.slice(0, 3)))];
  if (starterMigrations.some((version, index) => version !== index + 1)) throw new Error('Release migrations must be consecutive');
  const currentAdapterIntegrity = await localAdapterIntegrity(root);
  let committedAdapterIntegrity = null;
  try { committedAdapterIntegrity = digest(execFileSync('git', ['show', `${sourceCommit}:${USAGE_ADAPTER_PATH}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }), 'sha256'); } catch { /* Unknown source stays unknown. */ }
  const starterUsageAdapter = currentAdapterIntegrity && currentAdapterIntegrity === committedAdapterIntegrity
    ? { formatVersion: 1, path: USAGE_ADAPTER_PATH, sourceCommit, integrity: currentAdapterIntegrity } : null;
  // Build intent is independent of tree cleanliness. Neither value proves that a
  // bundle has been published, reviewed or approved for deployment.
  const isDevelopment = development || Boolean(dirty);
  const manifest = { formatVersion: 1, repository: REPOSITORY, version, tag: `core-v${version}`, sourceCommit,
    development: isDevelopment, buildIntent: isDevelopment ? 'development' : 'release-candidate',
    compatibility: { node: [24], postgres: [16], ledger: 'existing-credit-ledger-v1', starterMigrations, automaticMigrations: false },
    testedDependencies, packages, ...(starterUsageAdapter ? { starterUsageAdapter } : {}) };
  await writeJson(path.join(output, 'manifest.json'), manifest);
  await fs.writeFile(path.join(output, 'manifest.sha256'), digest(await fs.readFile(path.join(output, 'manifest.json')), 'sha256') + '\n');
  return manifest;
}
export async function verifyBundle(directory, { allowDevelopment = false } = {}) {
  const manifest = await json(path.join(directory, 'manifest.json'));
  if (manifest.formatVersion !== 1 || manifest.repository !== REPOSITORY || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
    || manifest.tag !== `core-v${manifest.version}` || !/^[a-f0-9]{40}$/u.test(manifest.sourceCommit)
    || (manifest.development && !allowDevelopment)) throw new Error('Unsupported/unreleased core manifest');
  if (manifest.buildIntent !== undefined && (typeof manifest.development !== 'boolean'
    || manifest.buildIntent !== (manifest.development ? 'development' : 'release-candidate'))) {
    throw new Error('Invalid bundle build intent');
  }
  if (manifest.starterUsageAdapter !== undefined && (!validUsageAdapter(manifest.starterUsageAdapter)
    || manifest.starterUsageAdapter.sourceCommit !== manifest.sourceCommit)) throw new Error('Invalid adapter provenance');
  const bytes = await fs.readFile(path.join(directory, 'manifest.json'));
  if ((await fs.readFile(path.join(directory, 'manifest.sha256'), 'utf8')).trim() !== digest(bytes, 'sha256')) throw new Error('Manifest checksum mismatch');
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== CORE_NAMES.length) throw new Error('Incomplete core bundle');
  const names = new Set();
  for (const pkg of manifest.packages) {
    const name = pkg.name?.replace('@yuva/', '');
    if (!CORE_NAMES.includes(name) || names.has(name) || pkg.version !== manifest.version || pkg.file !== `yuva-${name}-${manifest.version}.tgz`) throw new Error('Invalid core package entry');
    names.add(name);
    if (digest(await fs.readFile(path.join(directory, pkg.file))) !== pkg.integrity) throw new Error(`Integrity mismatch: ${pkg.name}`);
  }
  return manifest;
}
/** All mutations are in public dependency metadata/vendor, never application source. */
export async function installBundle({ root, bundle, packageDirs = ['.', 'starter-app'], apply = false, allowDevelopment = false }) {
  const manifest = await verifyBundle(bundle, { allowDevelopment });
  const adapter = await usageAdapterPlan(root, manifest);
  const vendor = path.join(root, 'vendor', 'yuva-core', manifest.version);
  const changes = [];
  for (const packageDir of packageDirs) {
    const directory = path.resolve(root, packageDir);
    if (directory !== root && !directory.startsWith(root + path.sep)) throw new Error('Package directory escapes consumer');
    const file = path.join(directory, 'package.json'), data = await json(file);
    for (const [section, dependencies] of Object.entries(data)) {
      if (!['dependencies', 'devDependencies', 'optionalDependencies'].includes(section)) continue;
      for (const pkg of manifest.packages) {
        if (!dependencies[pkg.name]) continue;
        const specifier = 'file:' + path.relative(directory, path.join(vendor, pkg.file)).split(path.sep).join('/');
        changes.push({ package: packageDir, section, name: pkg.name, from: dependencies[pkg.name], to: specifier });
        dependencies[pkg.name] = specifier;
      }
    }
    changes.push({ file, data });
  }
  if (apply) {
    // Never replace an existing version with different or incomplete bytes.
    let exists = true;
    try { await fs.access(vendor); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (exists) {
      const previous = await verifyBundle(vendor, { allowDevelopment });
      if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error('Existing release version differs; refusing overwrite');
    } else {
      await fs.mkdir(path.dirname(vendor), { recursive: true });
      const stage = await fs.mkdtemp(path.join(path.dirname(vendor), '.stage-'));
      try {
        for (const file of ['manifest.json', 'manifest.sha256', ...manifest.packages.map((p) => p.file)]) await fs.copyFile(path.join(bundle, file), path.join(stage, file));
        await verifyBundle(stage, { allowDevelopment });
        await fs.rename(stage, vendor);
      } finally { await fs.rm(stage, { recursive: true, force: true }); }
    }
    for (const entry of changes.filter((c) => c.file)) await writeJson(entry.file, entry.data);
    await writeJson(path.join(root, '.core-release.json'), { manifest: path.relative(root, path.join(vendor, 'manifest.json')).split(path.sep).join('/'),
      manifestIntegrity: digest(await fs.readFile(path.join(vendor, 'manifest.json')), 'sha256'), packageDirs, repository: REPOSITORY, version: manifest.version, sourceCommit: manifest.sourceCommit,
      ...(adapter.nextBase ? { starterUsageAdapter: adapter.nextBase } : {}) });
  }
  return { version: manifest.version, sourceCommit: manifest.sourceCommit, apply, changes: changes.filter((c) => !c.file),
    starterUsageAdapter: adapter.report };
}
