-- Batch 2A: verified referral rewards only. This migration does not touch
-- redemption inventory or any existing Points/Growth balance semantics.
ALTER TABLE referrals
  ADD CONSTRAINT referrals_scope_id UNIQUE (brand_id, bot_id, id);

CREATE TABLE referral_reward_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  platform_id uuid NOT NULL,
  campaign_key text NOT NULL CHECK (length(campaign_key) BETWEEN 1 AND 120),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','disabled')),
  effective_from date NOT NULL,
  effective_until date,
  inviter_points bigint NOT NULL DEFAULT 50 CHECK (inviter_points = 50),
  invitee_points bigint NOT NULL DEFAULT 20 CHECK (invitee_points = 20),
  invitee_enabled boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES admins(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES admins(id),
  published_at timestamptz,
  disabled_by uuid REFERENCES admins(id),
  disabled_at timestamptz,
  FOREIGN KEY (brand_id, platform_id) REFERENCES platforms(brand_id, id),
  UNIQUE (brand_id, id),
  UNIQUE (brand_id, platform_id, id),
  UNIQUE (brand_id, platform_id, version),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CHECK ((status = 'draft') = (published_at IS NULL AND published_by IS NULL)),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL AND disabled_by IS NOT NULL))
);

CREATE FUNCTION protect_referral_reward_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'referral_rule_immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'referral_rule_requires_draft'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    IF (to_jsonb(OLD)-ARRAY['status','published_at','published_by']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','published_at','published_by']) THEN
      RAISE EXCEPTION 'referral_rule_immutable';
    END IF;
    IF EXISTS (
      SELECT 1 FROM referral_reward_rule_versions r
       WHERE r.brand_id=NEW.brand_id AND r.platform_id=NEW.platform_id
         AND r.status='published' AND r.id<>NEW.id
         AND r.effective_from <= COALESCE(NEW.effective_until,'9999-12-31'::date)
         AND COALESCE(r.effective_until,'9999-12-31'::date) >= NEW.effective_from
    ) THEN RAISE EXCEPTION 'referral_rule_overlap'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'disabled' THEN
    IF (to_jsonb(OLD)-ARRAY['status','disabled_at','disabled_by']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','disabled_at','disabled_by']) THEN
      RAISE EXCEPTION 'referral_rule_immutable';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'referral_rule_transition_forbidden';
END $$;
CREATE TRIGGER referral_reward_rule_protect
  BEFORE INSERT OR UPDATE OR DELETE ON referral_reward_rule_versions
  FOR EACH ROW EXECUTE FUNCTION protect_referral_reward_rule();

CREATE TABLE referral_qualification_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  platform_id uuid NOT NULL,
  bot_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  invitee_user_id uuid NOT NULL,
  platform_identity_id uuid NOT NULL,
  verified_uid_fingerprint text NOT NULL CHECK (verified_uid_fingerprint ~ '^[a-f0-9]{64}$'),
  rule_version_id uuid,
  campaign_version text NOT NULL,
  business_date date NOT NULL,
  qualified_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('verified','cap_exceeded','conflict','revoked','invalid','manual_review')),
  evidence_fingerprint text NOT NULL CHECK (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (brand_id, platform_id) REFERENCES platforms(brand_id, id),
  FOREIGN KEY (brand_id, bot_id, referral_id) REFERENCES referrals(brand_id, bot_id, id),
  FOREIGN KEY (brand_id, bot_id, invitee_user_id, platform_id, platform_identity_id) REFERENCES platform_identities(brand_id, bot_id, user_id, platform_id, id),
  FOREIGN KEY (brand_id, rule_version_id) REFERENCES referral_reward_rule_versions(brand_id, id),
  UNIQUE (brand_id, platform_id, referral_id, evidence_fingerprint),
  UNIQUE (brand_id, platform_id, referral_id, id)
);
CREATE UNIQUE INDEX referral_qualified_uid_once
  ON referral_qualification_evidence (brand_id, platform_id, verified_uid_fingerprint)
  WHERE status IN ('verified','cap_exceeded');
CREATE UNIQUE INDEX referral_qualified_referral_once
  ON referral_qualification_evidence (brand_id, platform_id, referral_id)
  WHERE status IN ('verified','cap_exceeded');
CREATE TRIGGER referral_evidence_immutable
  BEFORE UPDATE OR DELETE ON referral_qualification_evidence
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE referral_reward_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  platform_id uuid NOT NULL,
  bot_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  verified_uid_fingerprint text NOT NULL CHECK (verified_uid_fingerprint ~ '^[a-f0-9]{64}$'),
  reward_role text NOT NULL CHECK (reward_role IN ('inviter','invitee')),
  recipient_user_id uuid NOT NULL,
  points bigint NOT NULL CHECK ((reward_role='inviter' AND points=50) OR (reward_role='invitee' AND points=20)),
  status text NOT NULL CHECK (status IN ('granted','blocked','manual_review')),
  idempotency_key text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (brand_id, platform_id) REFERENCES platforms(brand_id, id),
  FOREIGN KEY (brand_id, bot_id, referral_id) REFERENCES referrals(brand_id, bot_id, id),
  FOREIGN KEY (brand_id, platform_id, referral_id, evidence_id) REFERENCES referral_qualification_evidence(brand_id, platform_id, referral_id, id),
  FOREIGN KEY (brand_id, rule_version_id) REFERENCES referral_reward_rule_versions(brand_id, id),
  FOREIGN KEY (brand_id, bot_id, recipient_user_id) REFERENCES telegram_users(brand_id, bot_id, id),
  UNIQUE (bot_id, idempotency_key)
);
CREATE UNIQUE INDEX referral_reward_granted_uid_once
  ON referral_reward_events (brand_id, platform_id, verified_uid_fingerprint, reward_role)
  WHERE status='granted';
CREATE UNIQUE INDEX referral_reward_granted_referral_once
  ON referral_reward_events (brand_id, platform_id, referral_id, reward_role)
  WHERE status='granted';
CREATE TRIGGER referral_reward_event_immutable
  BEFORE UPDATE OR DELETE ON referral_reward_events
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE referral_reward_daily_counters (
  brand_id uuid NOT NULL,
  platform_id uuid NOT NULL,
  inviter_member_id uuid NOT NULL,
  business_date date NOT NULL,
  qualified_count integer NOT NULL DEFAULT 0 CHECK (qualified_count >= 0),
  rewarded_count integer NOT NULL DEFAULT 0 CHECK (rewarded_count BETWEEN 0 AND 5),
  cap integer NOT NULL DEFAULT 5 CHECK (cap=5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, platform_id, inviter_member_id, business_date),
  FOREIGN KEY (brand_id, platform_id) REFERENCES platforms(brand_id, id),
  FOREIGN KEY (brand_id, inviter_member_id) REFERENCES members(brand_id, id),
  CHECK (rewarded_count <= qualified_count)
);
CREATE TRIGGER referral_counter_immutable
  BEFORE DELETE ON referral_reward_daily_counters
  FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE INDEX referral_evidence_queue ON referral_qualification_evidence(brand_id, platform_id, status, created_at);
CREATE INDEX referral_reward_recipient ON referral_reward_events(brand_id, bot_id, recipient_user_id, created_at);

INSERT INTO permissions(name) VALUES
  ('referrals.read'),('referrals.evaluate'),('referrals.reward.review'),
  ('referrals.rules.manage'),('referrals.rules.publish')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.name='Super Admin' AND p.name IN ('referrals.read','referrals.evaluate','referrals.reward.review','referrals.rules.manage','referrals.rules.publish')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.name='Admin' AND p.name IN ('referrals.read','referrals.reward.review')
ON CONFLICT DO NOTHING;
