import fs from 'node:fs/promises';
import { authMode, readSelfHostedConfig } from '../../starter-app/server/auth/config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function verifyStack(file = new URL('../../ops/stack.json', import.meta.url)) {
  const stack = JSON.parse(await fs.readFile(file, 'utf8'));
  if (stack.formatVersion !== 1 || !stack.owner || !stack.templateVersion || !stack.reviewedAt) throw new Error('Invalid operations registry');
  const ids = new Set();
  for (const service of stack.services) {
    for (const field of ['id', 'status', 'owner', 'version', 'failure', 'review', 'verification']) if (!service[field]) throw new Error(`Missing service field: ${field}`);
    if (ids.has(service.id)) throw new Error('Duplicate service'); ids.add(service.id);
    for (const reference of [...service.config, ...service.secrets]) if (!/^[A-Z][A-Z0-9_]+$/u.test(reference)) throw new Error('Registry must contain configuration names, never credentials');
  }
  for (const component of stack.components) if (!component.extension || !component.owner || !component.implementation) throw new Error('Component extension boundary missing');
  return stack;
}
export function productionProblems(env) {
  const errors = [];
  const required = (name) => {
    const value = env[name];
    if (!value || /[<>]/u.test(value) || /^(?:sk-\.\.\.|development|local_docker)/u.test(value)) errors.push(`${name}: missing or placeholder`);
    return value;
  };
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV: must be production');
  if (env.ALLOW_DEV_GUEST !== 'false') errors.push('ALLOW_DEV_GUEST: must be false');
  if (!['openai', 'anthropic'].includes(env.AI_PROVIDER)) errors.push('AI_PROVIDER: choose openai or anthropic');
  const database = required('DATABASE_URL');
  if (database) { try { if (!['postgres:', 'postgresql:'].includes(new URL(database).protocol)) throw new Error(); } catch { errors.push('DATABASE_URL: invalid PostgreSQL URL'); } }
  let mode;
  try { mode = authMode(env); } catch (error) { errors.push(error.message); }
  for (const key of mode === 'self-hosted' ? ['CORS_ORIGIN'] : ['CORS_ORIGIN', 'CLERK_AUTHORIZED_PARTIES']) {
    const value = required(key);
    if (value) for (const origin of value.split(',')) {
      try { const url = new URL(origin.trim()); if (url.protocol !== 'https:' || url.username || url.password || url.origin !== origin.trim()) throw new Error(); }
      catch { errors.push(`${key}: requires exact HTTPS origins`); }
    }
  }
  if (mode === 'self-hosted') {
    try {
      const auth = readSelfHostedConfig(env);
      if (auth.mailMode === 'custom') errors.push('AUTH_MAIL_MODE: custom requires an application-injected adapter; standalone start requires smtp');
    } catch (error) { errors.push(error.message); }
  } else {
    if (!env.CLERK_JWT_KEY && !env.CLERK_SECRET_KEY) errors.push('Clerk: configure verification key or secret');
    else required(env.CLERK_JWT_KEY ? 'CLERK_JWT_KEY' : 'CLERK_SECRET_KEY');
    const authSecret = required('AUTH_TOKEN_SECRET');
    if (authSecret && authSecret.length < 32) errors.push('AUTH_TOKEN_SECRET: requires at least 32 characters');
  }
  if (env.AI_PROVIDER === 'anthropic') { required('ANTHROPIC_API_KEY'); required('ANTHROPIC_MODEL'); }
  else {
    required('OPENAI_MODEL');
    const base = required('OPENAI_BASE_URL');
    if (base) { try { const url = new URL(base); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error(); } catch { errors.push('OPENAI_BASE_URL: invalid provider URL'); } }
    required('OPENAI_API_KEY');
  }
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stack = await verifyStack();
  if (process.argv.includes('--production')) {
    const errors = productionProblems(process.env);
    console.log(JSON.stringify({ valid: errors.length === 0, errors }));
    if (errors.length) process.exitCode = 1;
  } else console.log(JSON.stringify({ templateVersion: stack.templateVersion, services: stack.services.length, owner: stack.owner }));
}
