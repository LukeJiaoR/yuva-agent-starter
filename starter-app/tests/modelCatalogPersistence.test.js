import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOperationStore, grantCredits } from '@yuva/billing-core';
import { createAiProduct } from '../server/domain/aiProduct.js';
import { catalogFixture } from './fixtures/modelCatalog.js';
import { isolatedDatabase, operationFixture } from './helpers/database.js';

let db, close;
beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
afterAll(async () => close?.());
it('persists old binding and quote unchanged while a new request uses the new version', async () => {
  const accountId = randomUUID();
  await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
  await grantCredits({ db, userId: accountId, credits: 100, creditType: 'purchased', idempotencyKey: randomUUID() });
  const store = createOperationStore({ db });
  const catalog = catalogFixture('openai');
  const before = createAiProduct({ modelCatalog: catalog });
  const operation = { ...operationFixture(accountId), featureKey: before.featureKey };
  const quote = before.policy.quote(operation, before.executionLimits);
  const first = await store.reserve({ operation, quote });
  catalog.models[0].model = 'new-approved-model'; catalog.bindings[0].version = 'v2';
  catalog.bindings[0].parameters.maxOutputTokens = 256;
  const after = createAiProduct({ modelCatalog: catalog,
    configuration: { strategy: 'fixed', featureKey: before.featureKey, credits: 9 } });
  const newQuote = after.policy.quote(operation, after.executionLimits);
  const replay = await store.reserve({ operation, quote: newQuote });
  expect(replay.kind).toBe('existing'); expect(replay.operation.id).toBe(first.operation.id);
  expect(replay.operation.quote).toEqual(first.operation.quote);
  expect(replay.operation.quote.modelBinding).toMatchObject({ version: 'v1', model: 'fixture-model' });
  expect(replay.operation.quote.reserveCredits).toBe(2);
  const second = await store.reserve({ operation: { ...operation, clientRequestId: randomUUID() }, quote: newQuote });
  expect(second.operation.quote.modelBinding).toMatchObject({ version: 'v2', model: 'new-approved-model' });
  expect(second.operation.quote.reserveCredits).toBe(9);
  expect(second.operation.quote.limits.maxOutputTokens).toBe(256);
});
