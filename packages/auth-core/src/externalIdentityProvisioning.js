import { acquireExternalIdentityLock } from './externalIdentityLock.js';

export async function provisionExternalIdentity({
  applyReferral,
  checkIsDeleted,
  db,
  displayName,
  email,
  externalId,
  onProvisioned,
  provider,
  referralCode,
}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedExternalId = String(externalId || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const safeName = String(displayName || '').trim();
  if (!normalizedProvider || !normalizedExternalId || !normalizedEmail) return null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await acquireExternalIdentityLock({
      client,
      provider: normalizedProvider,
      externalId: normalizedExternalId,
    });

    if (checkIsDeleted && (await checkIsDeleted({ db: client, provider: normalizedProvider, externalId: normalizedExternalId }))) {
      const error = new Error('This account has been deleted');
      error.code = 'account_deleted';
      error.status = 409;
      throw error;
    }

    const { rows: [existingExternal] } = await client.query(
      `UPDATE users
       SET last_login_at = NOW(), updated_at = NOW()
       WHERE external_auth_provider = $1 AND external_auth_id = $2
       RETURNING id, email, display_name, external_auth_provider,
                 external_auth_id, memory_enabled`,
      [normalizedProvider, normalizedExternalId],
    );
    if (existingExternal) {
      await onProvisioned?.({ client, isNewUser: false, user: existingExternal });
      await client.query('COMMIT');
      return existingExternal;
    }

    const { rows: [existingEmail] } = await client.query(
      `UPDATE users
       SET external_auth_provider = COALESCE(external_auth_provider, $1),
           external_auth_id = COALESCE(external_auth_id, $2),
           auth_provider = $1,
           display_name = COALESCE(display_name, $3),
           last_login_at = NOW(),
           updated_at = NOW()
       WHERE email = $4
         AND (
           external_auth_provider IS NULL
           OR (external_auth_provider = $1 AND external_auth_id = $2)
         )
       RETURNING id, email, display_name, external_auth_provider,
                 external_auth_id, memory_enabled`,
      [normalizedProvider, normalizedExternalId, safeName, normalizedEmail],
    );
    if (existingEmail) {
      await onProvisioned?.({ client, isNewUser: false, user: existingEmail });
      await client.query('COMMIT');
      return existingEmail;
    }

    const { rows: [created] } = await client.query(
      `INSERT INTO users (email, display_name, auth_provider, external_auth_provider, external_auth_id, last_login_at)
       VALUES ($1, $2, $3, $3, $4, NOW())
       RETURNING id, email, display_name, external_auth_provider,
                 external_auth_id, memory_enabled`,
      [normalizedEmail, safeName, normalizedProvider, normalizedExternalId],
    );
    await applyReferral?.({ client, referralCode, userId: created.id });
    await onProvisioned?.({ client, isNewUser: true, user: created });
    await client.query('COMMIT');
    return created;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
