-- Batch 2B inventory and fixed-tier configuration only.
-- Installation is inert: it creates no rule, imports no code, creates no
-- redemption, and never writes Points, Lots, Growth, or historical business data.
ALTER TABLE redemption_rules
  ADD COLUMN platform_id uuid,
  ADD COLUMN tier_key text,
  ADD COLUMN version integer,
  ADD COLUMN status text,
  ADD COLUMN face_value numeric(20,8),
  ADD COLUMN face_currency text,
  ADD COLUMN effective_from date,
  ADD COLUMN effective_until date,
  ADD COLUMN created_by uuid REFERENCES admins(id),
  ADD COLUMN published_by uuid REFERENCES admins(id),
  ADD COLUMN published_at timestamptz,
  ADD COLUMN disabled_by uuid REFERENCES admins(id),
  ADD COLUMN disabled_at timestamptz,
  ADD FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id);

ALTER TABLE redemption_rules ADD CONSTRAINT redemption_rule_v2_shape CHECK (
  platform_id IS NULL OR (
    mode='fixed'
    AND points_cost BETWEEN 1 AND 300
    AND requires_deposit=false
    AND conditions='{}'::jsonb
    AND tier_key IS NOT NULL AND length(tier_key) BETWEEN 1 AND 64
    AND version>0
    AND status IN ('draft','published','disabled')
    AND enabled=(status='published')
    AND face_value>0
    AND face_currency ~ '^[A-Z]{3}$'
    AND effective_from IS NOT NULL
    AND (effective_until IS NULL OR effective_until>=effective_from)
    AND created_by IS NOT NULL
    AND (
      (status='draft' AND published_at IS NULL AND published_by IS NULL AND disabled_at IS NULL AND disabled_by IS NULL)
      OR
      (status='published' AND published_at IS NOT NULL AND published_by IS NOT NULL AND disabled_at IS NULL AND disabled_by IS NULL)
      OR
      (status='disabled' AND published_at IS NOT NULL AND published_by IS NOT NULL AND disabled_at IS NOT NULL AND disabled_by IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX redemption_rule_v2_version
  ON redemption_rules(brand_id,platform_id,tier_key,version)
  WHERE platform_id IS NOT NULL;
CREATE UNIQUE INDEX redemption_rule_v2_published
  ON redemption_rules(brand_id,bot_id,platform_id,tier_key)
  WHERE status='published';
ALTER TABLE redemption_rules ADD CONSTRAINT redemption_rule_v2_scope_key
  UNIQUE(brand_id,bot_id,platform_id,id);

CREATE FUNCTION protect_redemption_rule_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.platform_id IS NULL THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'redemption_rule_immutable';
  END IF;
  IF OLD.status='draft' AND NEW.status='published'
     AND (to_jsonb(OLD)-ARRAY['status','enabled','published_by','published_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(NEW)-ARRAY['status','enabled','published_by','published_at']) THEN
    RETURN NEW;
  END IF;
  IF OLD.status='published' AND NEW.status='disabled'
     AND (to_jsonb(OLD)-ARRAY['status','enabled','disabled_by','disabled_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(NEW)-ARRAY['status','enabled','disabled_by','disabled_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'redemption_rule_immutable';
END $$;
CREATE TRIGGER redemption_rule_v2_protect
  BEFORE UPDATE OR DELETE ON redemption_rules
  FOR EACH ROW EXECUTE FUNCTION protect_redemption_rule_v2();

CREATE TABLE redemption_code_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  bot_id uuid NOT NULL,
  platform_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('imported','rejected')),
  total_count integer NOT NULL CHECK(total_count>0),
  imported_count integer NOT NULL CHECK(imported_count>=0),
  duplicate_count integer NOT NULL CHECK(duplicate_count>=0),
  source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES admins(id),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id),
  FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),
  FOREIGN KEY(brand_id,bot_id,platform_id,rule_id)
    REFERENCES redemption_rules(brand_id,bot_id,platform_id,id),
  UNIQUE(brand_id,bot_id,platform_id,source_fingerprint),
  UNIQUE(brand_id,bot_id,platform_id,rule_id,id),
  UNIQUE(brand_id,bot_id,id),
  CHECK(
    (status='imported' AND imported_count=total_count AND duplicate_count=0)
    OR
    (status='rejected' AND imported_count=0 AND duplicate_count>0 AND duplicate_count<=total_count)
  )
);
CREATE TRIGGER redemption_code_batch_immutable
  BEFORE UPDATE OR DELETE ON redemption_code_batches
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

ALTER TABLE redemption_codes
  ADD COLUMN platform_id uuid,
  ADD COLUMN batch_id uuid,
  ADD COLUMN code_ciphertext bytea,
  ADD COLUMN code_iv bytea,
  ADD COLUMN code_auth_tag bytea,
  ADD COLUMN code_key_version text,
  ADD FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),
  ADD FOREIGN KEY(brand_id,bot_id,platform_id,rule_id,batch_id)
    REFERENCES redemption_code_batches(brand_id,bot_id,platform_id,rule_id,id);

ALTER TABLE redemption_codes ADD CONSTRAINT redemption_code_v2_secret CHECK (
  batch_id IS NULL OR (
    platform_id IS NOT NULL
    AND code_ciphertext IS NOT NULL
    AND code_iv IS NOT NULL
    AND code_auth_tag IS NOT NULL
    AND code_key_version IS NOT NULL
  )
);
CREATE UNIQUE INDEX redemption_code_platform_unique
  ON redemption_codes(brand_id,platform_id,code_fingerprint)
  WHERE platform_id IS NOT NULL;

INSERT INTO permissions(name) VALUES
  ('redemptions.read'),
  ('redemptions.rules.manage'),
  ('redemptions.inventory.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.name='Super Admin'
  AND p.name IN ('redemptions.read','redemptions.rules.manage','redemptions.inventory.manage')
ON CONFLICT DO NOTHING;

INSERT INTO roles(name) VALUES ('Redemption Inventory Operator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.name='Redemption Inventory Operator'
  AND p.name IN ('redemptions.read','redemptions.inventory.manage')
ON CONFLICT DO NOTHING;
