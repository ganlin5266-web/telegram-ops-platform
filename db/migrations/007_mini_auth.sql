-- Separate user authentication. No administrator, ledger, webhook or seed data changes.
CREATE TABLE mini_auth_exchanges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 auth_date timestamptz NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz NOT NULL,
 FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id),
 UNIQUE(bot_id,payload_digest), UNIQUE(brand_id,bot_id,id),
 CHECK(valid_until>auth_date)
);
CREATE INDEX mini_exchange_expiry ON mini_auth_exchanges(valid_until);
CREATE TABLE mini_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL,
 app_key text NOT NULL,
 exchange_id uuid NOT NULL UNIQUE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoke_reason text,
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,exchange_id) REFERENCES mini_auth_exchanges(brand_id,bot_id,id),
 CHECK(expires_at>created_at),
 CHECK((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX mini_sessions_user ON mini_sessions(brand_id,bot_id,user_id,expires_at) WHERE revoked_at IS NULL;
-- Same PostgreSQL atomic counter approach as admin_login_limits; separate namespace,
-- privileges and counters so Mini traffic cannot consume administrator login capacity.
CREATE TABLE mini_auth_limits (
 bucket_hash text PRIMARY KEY CHECK(bucket_hash ~ '^[a-f0-9]{64}$'),
 window_started_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL CHECK(attempts>0)
);
