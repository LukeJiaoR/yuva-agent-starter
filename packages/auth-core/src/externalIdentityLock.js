export function externalIdentityLockKey(provider, externalId) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedExternalId = String(externalId || '').trim();
  if (!normalizedProvider || !normalizedExternalId) return null;
  return `external-identity:${normalizedProvider}:${normalizedExternalId}`;
}

export async function acquireExternalIdentityLock({ client, provider, externalId }) {
  const lockKey = externalIdentityLockKey(provider, externalId);
  if (!lockKey) return false;
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    [lockKey],
  );
  return true;
}
