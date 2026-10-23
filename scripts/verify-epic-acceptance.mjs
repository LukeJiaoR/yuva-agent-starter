import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.env.TEST_DATABASE_URL) throw new Error('Epic acceptance requires explicit TEST_DATABASE_URL');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'starter-acceptance-'));
const reportPath = path.join(directory, 'vitest.json');
const required = ['epicAcceptance', 'operationStore', 'usageStore', 'fixedPricing', 'executionBudget',
  'reliableSettlement', 'tokenPricing', 'recoveryLease', 'recoveryRunner', 'chatStream',
  'httpContract', 'imageProduct', 'imageProductHttp', 'imageGenerations', 'imageSubmissionContract',
  'creditRefunds', 'creditAdjustments', 'chatPublicErrors', 'chatMessageOrder', 'workspaceRequests', 'workspaceApi', 'privacyExpiry', 'artifactStorage', 'artifactRemoteIngestion', 'artifactStaging', 'productComposition', 'product-examples', 'selfHostedAuth'];
try {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['test', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`],
    { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Acceptance test command failed: ${result.status ?? result.signal}`);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  if (!report.success || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTotalTests < 1)
    throw new Error('Acceptance requires successful tests with no skips');
  for (const name of required) {
    const suite = report.testResults.find((item) => item.name.endsWith(`/${name}.test.js`));
    if (!suite?.assertionResults.length || suite.assertionResults.some((test) => test.status !== 'passed'))
      throw new Error(`Required acceptance suite missing, failed or skipped: ${name}`);
  }
  console.log(`Epic acceptance verified: ${required.length} required suites; ${report.numPassedTests} passed, zero skipped.`);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
