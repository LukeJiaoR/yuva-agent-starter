import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, json, writeJson } from '../scripts/release/artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const profiles = ['knowledge-assistant', 'token-content-tool'];

/** Generate an ordinary product-owned app, then apply one reviewed example overlay. */
export async function createExample({ profile, target, bundle, development = false, install = false }) {
  if (!profiles.includes(profile)) throw new Error('Choose knowledge-assistant or token-content-tool');
  if (!target || !bundle) throw new Error('An explicit target and local bundle are required');
  target = path.resolve(target);
  run(process.execPath, ['scripts/create-web-app.mjs', profile, '--target', target,
    '--bundle', path.resolve(bundle), ...(development ? ['--development'] : [])], root);
  // The generator has checked that target is outside the source and initially empty.
  // Replace copied starter tests with the product's own independent acceptance suite.
  await fs.rm(path.join(target, 'starter-app/tests'), { recursive: true });
  await fs.cp(path.join(root, 'examples', profile), target, { recursive: true });
  await fs.cp(path.join(root, 'examples/consumer-fixtures'), path.join(target, 'acceptance'), { recursive: true });
  const appFile = path.join(target, 'starter-app/package.json');
  const app = await json(appFile);
  delete app.dependencies['@clerk/backend'];
  delete app.devDependencies.vitest;
  delete app.scripts.start;
  delete app.scripts.dev;
  app.scripts.test = 'node --test --test-reporter=tap ../acceptance/*.test.mjs';
  await writeJson(appFile, app);
  const packageFile = path.join(target, 'package.json');
  const pkg = await json(packageFile);
  // Both examples require server-owned authentication. The default CLI starts the
  // unauthenticated starter, so expose only the explicitly wired example factory.
  delete pkg.scripts.start;
  delete pkg.scripts.dev;
  delete pkg.scripts['dev:api'];
  delete pkg.scripts['example:fixed'];
  delete pkg.scripts['example:token'];
  delete pkg.scripts['test:acceptance'];
  delete pkg.devDependencies.vitest;
  delete pkg.devDependencies.concurrently;
  await fs.rm(path.join(target, 'vitest.config.js'));
  pkg.scripts.test = 'node --test --test-reporter=tap acceptance/*.test.mjs';
  pkg.scripts.check = 'npm run core:verify && npm test && npm run build';
  await writeJson(packageFile, pkg);
  await writeJson(path.join(target, '.example.json'), { profile, mode: 'current-source-local-artifacts' });
  // A copied lock can retain Clerk as a satisfied optional peer after its direct
  // dependency is removed. Resolve this new consumer's final graph from scratch.
  await fs.rm(path.join(target, 'package-lock.json'));
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], target);
  if (install) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], target);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [profile, target, bundle] = process.argv.slice(2);
  await createExample({ profile, target, bundle, install: true });
  console.log(`Created ${profile}. Run npm test with an explicit local TEST_DATABASE_URL in the generated directory.`);
}
