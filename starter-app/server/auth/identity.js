import { grantCredits } from '@yuva/billing-core';
export const SELF_HOSTED_AUTHORITY = 'starter:self-hosted';

export async function findSelfHostedUser(subject, db) {
  const { rows } = await db.query(`SELECT u.id, u.email, u.display_name, u.memory_enabled
    FROM identity_bindings b JOIN users u ON u.id=b.user_id
    WHERE b.authority=$1 AND b.subject=$2`, [SELF_HOSTED_AUTHORITY, subject]);
  return rows[0] || null;
}

/** No email-based claims of existing profiles, balances, roles, or entitlements. */
export async function provisionSelfHostedUser({ db, subject, signupCredits }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${SELF_HOSTED_AUTHORITY}:${subject}`]);
    const { rows: [identity] } = await client.query('SELECT id, email, name, email_verified, disabled FROM auth_users WHERE id=$1 FOR UPDATE', [subject]);
    if (!identity || !identity.email_verified || identity.disabled) throw Object.assign(new Error('Not authenticated'), { status: 401, code: 'authentication_required' });
    let user = await findSelfHostedUser(subject, client);
    if (!user) {
      // Lock a canonical email too so concurrent first-provision attempts cannot
      // award two grants or race an identity into another provider's profile.
      const email = identity.email.trim().toLowerCase();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`starter:profile-email:${email}`]);
      const existing = await client.query('SELECT id FROM users WHERE lower(email)=$1', [email]);
      if (existing.rowCount) throw Object.assign(new Error('An existing profile needs an explicit recovery or identity-linking process. Contact the app operator; this sign-in cannot claim it.'), { status: 409, code: 'identity_conflict' });
      // Reserve the legacy external-identity columns too: the older Clerk
      // provisioning helper must never regard this profile as email-claimable.
      // Our lookup still exclusively uses identity_bindings.
      const created = await client.query(`INSERT INTO users(email,display_name,auth_provider,external_auth_provider,external_auth_id,last_login_at)
        VALUES($1,$2,'self-hosted',$3,$4,NOW()) RETURNING id,email,display_name,memory_enabled`, [email, identity.name, SELF_HOSTED_AUTHORITY, subject]);
      user = created.rows[0];
      await client.query('INSERT INTO identity_bindings(authority,subject,user_id) VALUES($1,$2,$3)', [SELF_HOSTED_AUTHORITY, subject, user.id]);
      await client.query('INSERT INTO credit_accounts(user_id) VALUES($1)', [user.id]);
      if (signupCredits > 0) await grantCredits({ db: client, userId: user.id, creditType: 'purchased', sourceType: 'signup_grant',
        credits: signupCredits, idempotencyKey: `starter:signup:${user.id}`, metadata: { authority: SELF_HOSTED_AUTHORITY } });
    }
    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // A legacy writer may not take our email lock. A uniqueness race still never
    // adopts its row; the browser can safely retry or ask the operator for help.
    if (error.code === '23505') throw Object.assign(new Error('An existing profile requires explicit identity linking.'), { status: 409, code: 'identity_conflict' });
    throw error;
  } finally { client.release(); }
}
