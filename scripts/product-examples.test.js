import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import pg from 'pg';
import { prepareTestDatabase } from '../starter-app/tests/helpers/database.js';

it('importing the app factory does not start a server in development', async () => {
  const env = { ...process.env, NODE_ENV: 'development' };
  delete env.TEST_MODE;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'await import("./starter-app/server/index.js"); console.log("factory imported");'], { env });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    expect(output).toContain('factory imported');
    expect(output).not.toContain('Server running');
  } finally { clearTimeout(timer); }
}, 10000);

it.each(['fixed', 'token'])('%s runnable example settles, replays and cleans its schema', async (strategy) => {
  const databaseUrl = process.env.TEST_DATABASE_URL || 'postgresql://ziwei:changeme_in_production@localhost:45432/ziwei';
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await prepareTestDatabase(admin);
  const child = spawn(process.execPath, ['scripts/run-product-example.mjs', strategy], {
    env: { ...process.env, NODE_ENV: 'development', TEST_DATABASE_URL: databaseUrl, EXAMPLE_PORT: String(port) },
  });
  const exited = once(child, 'exit');
  let output = '', errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Example startup timeout: ${output} ${errors}`)), 10000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('Temporary schema:')) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Example exited ${code}: ${errors}`)); });
    });
    const schema = output.match(/Temporary schema: (example_\w+)/u)[1];
    const base = `http://127.0.0.1:${port}`;
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    expect(pricing.strategy).toBe(strategy);
    const request = () => fetch(`${base}/api/chat/stream`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Explain this example', requestId: 'example-check' }) });
    const first = await (await request()).text();
    expect(first).toContain('"financial_status":"settled"');
    expect(first).toContain(`"credits_used":${strategy === 'fixed' ? 2 : 4}`);
    expect(await (await request()).text()).toContain('"replayed":true');
    expect((await admin.query(`SELECT count(*)::int AS count FROM ${schema}.ai_operations`)).rows[0].count).toBe(1);
    child.kill('SIGTERM');
    expect((await exited)[0]).toBe(0);
    expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    await admin.end();
  }
}, 20000);
