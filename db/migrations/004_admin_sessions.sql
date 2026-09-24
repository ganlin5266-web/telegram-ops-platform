-- Browser authentication is separate from operational users and Bot credentials.
CREATE TABLE admin_credentials (
 admin_id uuid PRIMARY KEY REFERENCES admins(id),
 login text NOT NULL UNIQUE CHECK(login=lower(login) AND length(login) BETWEEN 3 AND 120),
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid NOT NULL REFERENCES admins(id),
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoke_reason text,
 CHECK(expires_at>created_at)
);
CREATE INDEX admin_sessions_active ON admin_sessions(admin_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE admin_login_limits (
 bucket_hash text PRIMARY KEY, window_started_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL CHECK(attempts>0)
);
