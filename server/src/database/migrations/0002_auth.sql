-- 0002_auth
--
-- Stage 2: user accounts, server-side sessions and authentication events.
-- No financial tables. Passwords and session tokens are never stored: only an Argon2id hash
-- (users.password_hash) and a SHA-256 digest of each session token (sessions.token_hash).

CREATE TABLE users (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 citext      NOT NULL,
  name                  text        NOT NULL,
  role                  text        NOT NULL,
  password_hash         text        NOT NULL,
  must_change_password  boolean     NOT NULL DEFAULT false,
  is_active             boolean     NOT NULL DEFAULT true,
  -- Lockout state lives in the database so it survives restarts and works across instances.
  failed_login_count    integer     NOT NULL DEFAULT 0,
  lockout_count         integer     NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_unique        UNIQUE (email),
  CONSTRAINT users_email_format        CHECK (email = btrim(email) AND email ~ '^[^@\s]+@[^@\s]+$' AND length(email) <= 254),
  CONSTRAINT users_name_length         CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT users_role_valid          CHECK (role IN ('owner', 'manager')),
  CONSTRAINT users_password_hash_argon CHECK (password_hash LIKE '$argon2id$%'),
  CONSTRAINT users_failed_count_valid  CHECK (failed_login_count >= 0),
  CONSTRAINT users_lockout_count_valid CHECK (lockout_count >= 0),
  -- The owner account can never be deactivated, so there is always an active owner.
  CONSTRAINT users_owner_active        CHECK (role <> 'owner' OR is_active)
);

-- At most one owner, enforced by the database (blocks accidental second owners, including races).
CREATE UNIQUE INDEX users_single_owner ON users ((true)) WHERE role = 'owner';

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE sessions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash           bytea       NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoked_reason       text,
  ip                   inet,
  user_agent           text,

  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_valid      CHECK (absolute_expires_at > created_at),
  CONSTRAINT sessions_user_agent_length CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  CONSTRAINT sessions_revocation_valid  CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_reason IN (
      'logout', 'password_changed', 'password_reset', 'user_deactivated', 'revoked_by_owner'))
  )
);

CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;


CREATE TABLE auth_events (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  event_type       text        NOT NULL,
  -- The account the event concerns (NULL for failed logins with an unknown e-mail).
  user_id          uuid        REFERENCES users (id) ON DELETE SET NULL,
  -- Who performed it, when different from user_id (e.g. the owner resetting a password).
  actor_user_id    uuid        REFERENCES users (id) ON DELETE SET NULL,
  email_attempted  citext,
  ip               inet,
  user_agent       text,
  details          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT auth_events_type_valid CHECK (event_type IN (
    'owner_bootstrapped', 'login_success', 'login_failure', 'login_rate_limited', 'account_locked',
    'logout', 'password_changed', 'password_reset', 'user_created', 'user_updated',
    'user_activated', 'user_deactivated', 'sessions_revoked')),
  CONSTRAINT auth_events_user_agent_length CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);

CREATE INDEX auth_events_user_idx ON auth_events (user_id, created_at DESC);
-- Supports the per-IP login rate limit (recent failures from one address).
CREATE INDEX auth_events_ip_failures_idx ON auth_events (ip, created_at DESC)
  WHERE event_type = 'login_failure';
