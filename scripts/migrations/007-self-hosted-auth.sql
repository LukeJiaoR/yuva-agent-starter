-- Application-owned Better Auth 1.7.7 schema. Do not run an upstream latest CLI
-- against production. Auth identities and business users remain separate.
CREATE TABLE auth_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE, image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled BOOLEAN NOT NULL DEFAULT FALSE, credential_version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX auth_users_email_canonical ON auth_users(lower(email));
CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), expires_at TIMESTAMPTZ NOT NULL, token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credential_version INTEGER NOT NULL DEFAULT 0, ip_address TEXT, user_agent TEXT, user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE TABLE auth_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ, scope TEXT, password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_id, account_id)
);
CREATE INDEX auth_accounts_user_id_idx ON auth_accounts(user_id);
CREATE TABLE auth_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), identifier TEXT NOT NULL, value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);
CREATE TABLE auth_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request BIGINT NOT NULL
);
CREATE TABLE identity_bindings (
  authority TEXT NOT NULL, subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(authority,subject),
  UNIQUE(user_id,authority)
);
-- Revocation is atomic with the credential write, including failures after a
-- successful password change inside an upstream request. No cookie cache exists.
CREATE FUNCTION starter_revoke_changed_password() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.password IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.password IS DISTINCT FROM OLD.password) THEN
    UPDATE auth_users SET credential_version=credential_version+1 WHERE id=NEW.user_id;
    DELETE FROM auth_sessions WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER auth_password_revoke AFTER INSERT OR UPDATE OF password ON auth_accounts
  FOR EACH ROW EXECUTE FUNCTION starter_revoke_changed_password();
CREATE FUNCTION starter_revoke_disabled_identity() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.disabled AND NOT OLD.disabled THEN DELETE FROM auth_sessions WHERE user_id=NEW.id; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER auth_disabled_revoke AFTER UPDATE OF disabled ON auth_users
  FOR EACH ROW EXECUTE FUNCTION starter_revoke_disabled_identity();

-- Fence in-flight old-password logins as well as already-issued sessions. A
-- password mutation and session insertion serialize on the same auth user row.
CREATE FUNCTION starter_check_session_credential() RETURNS TRIGGER AS $$
DECLARE identity auth_users%ROWTYPE;
BEGIN
  SELECT * INTO identity FROM auth_users WHERE id=NEW.user_id FOR UPDATE;
  IF NOT FOUND OR identity.disabled OR NOT identity.email_verified
    OR NEW.credential_version <> identity.credential_version THEN
    RAISE EXCEPTION 'Session credential is no longer current' USING ERRCODE='28000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER auth_session_credential BEFORE INSERT ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION starter_check_session_credential();
