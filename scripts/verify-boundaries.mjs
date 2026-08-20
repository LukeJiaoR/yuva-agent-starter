import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const EXTRACTED_PACKAGES = ['auth-core', 'admin-core', 'billing-core', 'ai-engine', 'context-engine'];
const FORBIDDEN_DOMAIN_KEYWORDS = ['iztro', 'palace', 'ziweichart', 'readingresolver'];

let violations = [];

function checkFile(filePath, content, isPackage) {
  const relPath = path.relative(ROOT_DIR, filePath);

  if (isPackage) {
    // 1. Check for reverse imports to starter-app or ziwei-app
    if (content.includes('starter-app') || content.includes('ziwei-app')) {
      violations.push(`[REVERSE DEPENDENCY] ${relPath} imports or references application layer`);
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

function scanDir(dirPath, isPackage) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, isPackage);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.jsx') || entry.name.endsWith('.ts'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      checkFile(fullPath, content, isPackage);
    }
  }
}

console.log('[Boundary Check] Checking core package boundaries...');
for (const pkg of EXTRACTED_PACKAGES) {
  const pkgDir = path.join(ROOT_DIR, 'packages', pkg);
  scanDir(pkgDir, true);
}

if (violations.length > 0) {
  console.error('\n❌ Package boundary violations found:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
} else {
  console.log('✅ Package boundary verification PASSED: Zero reverse dependencies, zero domain leakage, strict encapsulation.');
  process.exit(0);
}
