import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const EXTRACTED_PACKAGES = ['auth-core', 'admin-core', 'billing-core', 'ai-engine', 'context-engine'];
const FORBIDDEN_DOMAIN_KEYWORDS = ['iztro', 'ziweichart', 'readingresolver'];
const APP_DIRECTORIES = new Set(['starter-app', 'starter-web']);
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

let violations = [];

function checkFile(filePath, content, packageDir) {
  const relPath = path.relative(ROOT_DIR, filePath);

  if (packageDir) {
    // 1. Check for reverse imports to starter-app or ziwei-app
    if (content.includes('starter-app') || content.includes('ziwei-app')) {
      violations.push(`[REVERSE DEPENDENCY] ${relPath} imports or references application layer`);
    }

    for (const match of content.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] || match[2];
      if (!specifier?.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(filePath), specifier);
      if (resolved !== packageDir && !resolved.startsWith(`${packageDir}${path.sep}`)) {
        violations.push(`[PACKAGE ESCAPE] ${relPath} imports ${specifier} outside its package`);
      }
    }

    // 2. Check for domain leakage in extracted packages
    const lower = content.toLowerCase();
    for (const kw of FORBIDDEN_DOMAIN_KEYWORDS) {
      if (lower.includes(kw)) {
        violations.push(`[DOMAIN LEAKAGE] ${relPath} contains domain keyword '${kw}'`);
      }
    }
  }
}

function scanDir(dirPath, packageDir) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, packageDir);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.jsx') || entry.name.endsWith('.ts'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      checkFile(fullPath, content, packageDir);
    }
  }
}

console.log('[Boundary Check] Checking core package boundaries...');
for (const pkg of EXTRACTED_PACKAGES) {
  const pkgDir = path.join(ROOT_DIR, 'packages', pkg);
  const manifestPath = path.join(pkgDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })) {
    if (APP_DIRECTORIES.has(dependency)) {
      violations.push(`[MANIFEST REVERSE DEPENDENCY] packages/${pkg}/package.json depends on ${dependency}`);
    }
  }
  scanDir(pkgDir, pkgDir);
}

if (violations.length > 0) {
  console.error('\n❌ Package boundary violations found:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
} else {
  console.log('✅ Package boundary verification PASSED: no application imports, package escapes, or known source-domain leakage.');
  process.exit(0);
}
