CREATE TABLE platforms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL REFERENCES brands(id),
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{1,47}$'), display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 market text NOT NULL CHECK(market ~ '^[A-Z]{2}$'), timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 verification_method text NOT NULL CHECK(verification_method IN ('manual_admin','platform_api','platform_import','automation')),
 uid_format text NOT NULL DEFAULT 'alphanumeric' CHECK(uid_format IN ('digits','alphanumeric')),
 uid_case text NOT NULL DEFAULT 'upper' CHECK(uid_case IN ('upper','sensitive')),
 uid_min_length integer NOT NULL DEFAULT 3 CHECK(uid_min_length BETWEEN 1 AND 64),
 uid_max_length integer NOT NULL DEFAULT 64 CHECK(uid_max_length BETWEEN uid_min_length AND 64),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,id),UNIQUE(brand_id,code)
);
-- A Bot-scoped user row still represents a Telegram identity. Carry its immutable
-- Telegram ID through a composite FK so uniqueness also works across Bots.
ALTER TABLE telegram_users ADD CONSTRAINT telegram_users_platform_identity_key UNIQUE(brand_id,bot_id,id,telegram_user_id);
CREATE TABLE platform_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,bot_id uuid NOT NULL,user_id uuid NOT NULL,telegram_user_id bigint NOT NULL,
 platform_id uuid NOT NULL,platform_uid text NOT NULL CHECK(platform_uid ~ '^[A-Za-z0-9_-]{1,64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','conflict','rejected','revoked')),
 verification_method text NOT NULL CHECK(verification_method IN ('manual_admin','platform_api','platform_import','automation')),
 submission_key uuid NOT NULL,previous_identity_id uuid,
 submitted_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz,verified_by uuid REFERENCES admins(id),rejected_at timestamptz,rejected_by uuid REFERENCES admins(id),
 revoked_at timestamptz,revoked_by uuid REFERENCES admins(id),reason_code text,evidence_reference text,
 CHECK(reason_code IS NULL OR reason_code IN ('uid_in_use','evidence_missing','ownership_not_proven','incorrect_uid','user_request','security_review')),
 CHECK(evidence_reference IS NULL OR evidence_reference ~ '^CASE-[A-Z0-9-]{1,64}$'),
 CHECK((status IN ('verified','revoked'))=(verified_at IS NOT NULL AND verified_by IS NOT NULL)),
 CHECK((verified_at IS NULL)=(verified_by IS NULL)), CHECK((rejected_at IS NULL)=(rejected_by IS NULL)), CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
 CHECK(status IN ('verified','revoked') OR evidence_reference IS NULL),
 CHECK((status='rejected')=(rejected_at IS NOT NULL AND rejected_by IS NOT NULL)),
 CHECK((status='revoked')=(revoked_at IS NOT NULL AND revoked_by IS NOT NULL)),
 CHECK(status NOT IN ('verified','revoked') OR evidence_reference IS NOT NULL),
 CHECK(status NOT IN ('rejected','revoked','conflict') OR reason_code IS NOT NULL),
 CHECK(verified_at IS NULL OR verified_at>=submitted_at),CHECK(rejected_at IS NULL OR rejected_at>=submitted_at),
 CHECK(revoked_at IS NULL OR revoked_at>=verified_at),
 UNIQUE(brand_id,bot_id,user_id,platform_id,id),UNIQUE(bot_id,user_id,submission_key),
 FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),
 FOREIGN KEY(brand_id,bot_id,user_id,telegram_user_id) REFERENCES telegram_users(brand_id,bot_id,id,telegram_user_id),
 FOREIGN KEY(brand_id,bot_id,user_id,platform_id,previous_identity_id) REFERENCES platform_identities(brand_id,bot_id,user_id,platform_id,id)
);
CREATE UNIQUE INDEX platform_identity_live_uid ON platform_identities(brand_id,platform_id,platform_uid) WHERE status IN ('pending','verified');
CREATE UNIQUE INDEX platform_identity_live_user ON platform_identities(brand_id,platform_id,telegram_user_id) WHERE status IN ('pending','verified');
CREATE INDEX platform_identity_admin_queue ON platform_identities(brand_id,bot_id,status,submitted_at DESC,id DESC);
CREATE INDEX platform_identity_user_history ON platform_identities(brand_id,bot_id,user_id,submitted_at DESC,id DESC);
CREATE FUNCTION protect_platform_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p platforms%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO p FROM platforms WHERE brand_id=NEW.brand_id AND id=NEW.platform_id;
  IF NEW.status NOT IN ('pending','conflict') OR NEW.platform_uid<>btrim(NEW.platform_uid)
   OR (p.uid_case='upper' AND NEW.platform_uid<>upper(NEW.platform_uid))
   OR length(NEW.platform_uid)<p.uid_min_length OR length(NEW.platform_uid)>p.uid_max_length
   OR (p.uid_format='digits' AND NEW.platform_uid!~'^[0-9]+$')
   OR NEW.verification_method<>p.verification_method
  THEN RAISE EXCEPTION 'identity_input_invalid'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'identity_history_immutable'; END IF;
 IF (NEW.id,NEW.brand_id,NEW.bot_id,NEW.user_id,NEW.telegram_user_id,NEW.platform_id,NEW.platform_uid,NEW.submission_key,NEW.previous_identity_id,NEW.submitted_at,NEW.created_at,NEW.verification_method)
 IS DISTINCT FROM (OLD.id,OLD.brand_id,OLD.bot_id,OLD.user_id,OLD.telegram_user_id,OLD.platform_id,OLD.platform_uid,OLD.submission_key,OLD.previous_identity_id,OLD.submitted_at,OLD.created_at,OLD.verification_method)
 THEN RAISE EXCEPTION 'identity_identity_immutable'; END IF;
 IF NOT ((OLD.status='pending' AND NEW.status IN ('verified','rejected')) OR (OLD.status='verified' AND NEW.status='revoked'))
 THEN RAISE EXCEPTION 'identity_transition_forbidden'; END IF;
 IF OLD.status='verified' AND (NEW.verified_at,NEW.verified_by,NEW.evidence_reference) IS DISTINCT FROM (OLD.verified_at,OLD.verified_by,OLD.evidence_reference)
 THEN RAISE EXCEPTION 'identity_verification_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_platform_identity BEFORE INSERT OR UPDATE OR DELETE ON platform_identities FOR EACH ROW EXECUTE FUNCTION protect_platform_identity();
INSERT INTO permissions(name) VALUES ('platforms.read'),('platforms.manage'),('platform_identities.read'),('platform_identities.verify');
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='Super Admin' AND p.name IN ('platforms.read','platforms.manage','platform_identities.read','platform_identities.verify');
