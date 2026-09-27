-- Expand only. No opening lots, balances, historical ledger or runtime flags are changed.
CREATE TABLE point_expiry_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), source text NOT NULL CHECK(length(source) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id),
 UNIQUE(brand_id,bot_id,source), UNIQUE(brand_id,bot_id,id)
);
CREATE TABLE point_expiry_policy_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,bot_id uuid NOT NULL,policy_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),mode text NOT NULL CHECK(mode IN ('permanent','rolling_days','fixed_deadline')),
 rolling_days integer CHECK(rolling_days BETWEEN 1 AND 36500),deadline timestamptz,timezone text NOT NULL,
 refund_min_compensation_days integer CHECK(refund_min_compensation_days BETWEEN 1 AND 36500),
 effective_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 created_by uuid NOT NULL REFERENCES admins(id),created_at timestamptz NOT NULL DEFAULT now(),published_by uuid REFERENCES admins(id),published_at timestamptz,
 CHECK((mode='permanent' AND rolling_days IS NULL AND deadline IS NULL) OR (mode='rolling_days' AND rolling_days IS NOT NULL AND deadline IS NULL) OR (mode='fixed_deadline' AND rolling_days IS NULL AND deadline IS NOT NULL AND deadline>effective_at)),
 CHECK((status='published')=(published_at IS NOT NULL AND published_by IS NOT NULL)),
 FOREIGN KEY(brand_id,bot_id,policy_id) REFERENCES point_expiry_policies(brand_id,bot_id,id),
 UNIQUE(policy_id,version),UNIQUE(brand_id,bot_id,policy_id,id)
);
CREATE UNIQUE INDEX point_policy_effective_unique ON point_expiry_policy_versions(policy_id,effective_at) WHERE status='published';
CREATE FUNCTION protect_point_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'point_policy_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'point_policy_draft_required'; END IF;
 ELSE
  IF OLD.status<>'draft' OR NEW.status<>'published' OR (to_jsonb(NEW)-ARRAY['status','published_at','published_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','published_at','published_by']) THEN RAISE EXCEPTION 'point_policy_immutable'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN RAISE EXCEPTION 'invalid_timezone'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER point_policy_version_protect BEFORE INSERT OR UPDATE OR DELETE ON point_expiry_policy_versions FOR EACH ROW EXECUTE FUNCTION protect_point_policy_version();
CREATE TRIGGER point_policy_immutable BEFORE UPDATE OR DELETE ON point_expiry_policies FOR EACH ROW EXECUTE FUNCTION immutable_row();
-- Owner-only cutover marker. Once inserted, database guards reject legacy-only writes.
CREATE TABLE point_lot_cutovers (
 bot_id uuid PRIMARY KEY,brand_id uuid NOT NULL,cutover_at timestamptz NOT NULL DEFAULT now(),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TRIGGER point_cutover_immutable BEFORE UPDATE OR DELETE ON point_lot_cutovers FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE point_lot_openings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL UNIQUE REFERENCES point_accounts(id),
 balance_snapshot bigint NOT NULL CHECK(balance_snapshot>=0),ledger_count bigint NOT NULL CHECK(ledger_count>=0),
 ledger_watermark uuid REFERENCES point_ledger(id),ledger_fingerprint text NOT NULL CHECK(ledger_fingerprint ~ '^[a-f0-9]{64}$'),
 cutover_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account_id,id)
);
CREATE TRIGGER point_opening_immutable BEFORE UPDATE OR DELETE ON point_lot_openings FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE point_lots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,bot_id uuid NOT NULL,user_id uuid NOT NULL,account_id uuid NOT NULL,
 source text NOT NULL,source_reference text NOT NULL,granted_amount bigint NOT NULL CHECK(granted_amount>0),
 remaining_amount bigint NOT NULL CHECK(remaining_amount>=0 AND remaining_amount<=granted_amount),
 granted_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz,
 policy_id uuid,policy_version_id uuid,policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
 positive_ledger_id uuid REFERENCES point_ledger(id),opening_id uuid,
 refund_allocation_id uuid,lot_type text NOT NULL CHECK(lot_type IN ('normal_grant','refund_compensation','legacy_opening')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((policy_id IS NULL)=(policy_version_id IS NULL)),
 CHECK((lot_type='legacy_opening' AND opening_id IS NOT NULL AND positive_ledger_id IS NULL AND expires_at IS NULL AND policy_id IS NULL AND refund_allocation_id IS NULL)
 OR (lot_type='normal_grant' AND positive_ledger_id IS NOT NULL AND opening_id IS NULL AND policy_id IS NOT NULL AND refund_allocation_id IS NULL)
 OR (lot_type='refund_compensation' AND positive_ledger_id IS NOT NULL AND opening_id IS NULL)),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,account_id) REFERENCES point_accounts(brand_id,bot_id,id),
 FOREIGN KEY(account_id,opening_id) REFERENCES point_lot_openings(account_id,id),
 FOREIGN KEY(brand_id,bot_id,policy_id,policy_version_id) REFERENCES point_expiry_policy_versions(brand_id,bot_id,policy_id,id),
 UNIQUE(opening_id),UNIQUE(positive_ledger_id,refund_allocation_id),UNIQUE(brand_id,bot_id,account_id,id)
);
CREATE UNIQUE INDEX normal_point_lot_ledger ON point_lots(positive_ledger_id) WHERE lot_type='normal_grant';
CREATE TABLE point_lot_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,bot_id uuid NOT NULL,account_id uuid NOT NULL,
 negative_ledger_id uuid NOT NULL REFERENCES point_ledger(id),lot_id uuid NOT NULL,amount bigint NOT NULL CHECK(amount>0),
 kind text NOT NULL CHECK(kind IN ('consume','expire')),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,bot_id,account_id,lot_id) REFERENCES point_lots(brand_id,bot_id,account_id,id),
 UNIQUE(negative_ledger_id,lot_id)
);
ALTER TABLE point_lots ADD FOREIGN KEY(refund_allocation_id) REFERENCES point_lot_allocations(id);
CREATE UNIQUE INDEX point_refund_once ON point_lots(refund_allocation_id) WHERE refund_allocation_id IS NOT NULL;
CREATE INDEX point_lot_fefo ON point_lots(account_id,expires_at,granted_at,id) WHERE remaining_amount>0;
CREATE INDEX point_lot_due ON point_lots(expires_at,bot_id,account_id) WHERE remaining_amount>0 AND expires_at IS NOT NULL;
CREATE INDEX point_allocation_lot ON point_lot_allocations(lot_id,created_at,id);
CREATE FUNCTION protect_point_lot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a point_accounts%ROWTYPE; l point_ledger%ROWTYPE; original point_lot_allocations%ROWTYPE; policy point_expiry_policy_versions%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'point_lot_immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  IF pg_trigger_depth()<2 OR (to_jsonb(NEW)-'remaining_amount') IS DISTINCT FROM (to_jsonb(OLD)-'remaining_amount') OR NEW.remaining_amount>OLD.remaining_amount THEN RAISE EXCEPTION 'use_lot_allocation'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT a FROM point_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF a.user_id<>NEW.user_id OR a.bot_id<>NEW.bot_id OR a.brand_id<>NEW.brand_id OR NEW.remaining_amount<>NEW.granted_amount THEN RAISE EXCEPTION 'point_lot_scope_invalid'; END IF;
 IF NEW.positive_ledger_id IS NOT NULL THEN
  SELECT * INTO STRICT l FROM point_ledger WHERE id=NEW.positive_ledger_id;
  IF l.account_id<>NEW.account_id OR l.delta<=0 THEN RAISE EXCEPTION 'point_lot_ledger_invalid'; END IF;
 END IF;
 IF NEW.lot_type='normal_grant' THEN
  SELECT * INTO STRICT policy FROM point_expiry_policy_versions WHERE id=NEW.policy_version_id;
  IF policy.status<>'published' OR policy.effective_at>NEW.granted_at OR
   (policy.mode='permanent' AND NEW.expires_at IS NOT NULL) OR
   (policy.mode='rolling_days' AND NEW.expires_at IS DISTINCT FROM NEW.granted_at+policy.rolling_days*interval '24 hours') OR
   (policy.mode='fixed_deadline' AND NEW.expires_at IS DISTINCT FROM policy.deadline) OR
   (NEW.expires_at IS NOT NULL AND NEW.expires_at<=NEW.granted_at)
  THEN RAISE EXCEPTION 'point_policy_lot_invalid'; END IF;
 END IF;
 IF NEW.refund_allocation_id IS NOT NULL THEN
  SELECT * INTO STRICT original FROM point_lot_allocations WHERE id=NEW.refund_allocation_id;
  IF original.account_id<>NEW.account_id OR original.kind<>'consume' OR NEW.granted_amount<>original.amount OR NEW.lot_type<>'refund_compensation' THEN RAISE EXCEPTION 'point_refund_invalid'; END IF;
 END IF;
 IF NEW.opening_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM point_lot_openings o WHERE o.id=NEW.opening_id AND o.account_id=NEW.account_id AND o.balance_snapshot=NEW.granted_amount) THEN RAISE EXCEPTION 'point_opening_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER point_lot_protect BEFORE INSERT OR UPDATE OR DELETE ON point_lots FOR EACH ROW EXECUTE FUNCTION protect_point_lot();
CREATE FUNCTION apply_point_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l point_ledger%ROWTYPE; lot point_lots%ROWTYPE;
BEGIN
 SELECT * INTO STRICT l FROM point_ledger WHERE id=NEW.negative_ledger_id;
 SELECT * INTO STRICT lot FROM point_lots WHERE id=NEW.lot_id FOR UPDATE;
 IF l.account_id<>NEW.account_id OR l.delta>=0 OR lot.remaining_amount<NEW.amount THEN RAISE EXCEPTION 'point_allocation_invalid'; END IF;
 IF NEW.kind='consume' AND lot.expires_at IS NOT NULL AND lot.expires_at<=statement_timestamp() THEN RAISE EXCEPTION 'point_lot_expired'; END IF;
 IF NEW.kind='expire' AND (lot.expires_at IS NULL OR lot.expires_at>statement_timestamp() OR l.business_type<>'point_expired' OR l.business_id<>lot.id::text OR NEW.amount<>lot.remaining_amount) THEN RAISE EXCEPTION 'point_expiry_invalid'; END IF;
 UPDATE point_lots SET remaining_amount=remaining_amount-NEW.amount WHERE id=lot.id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION apply_point_allocation() FROM PUBLIC;
CREATE TRIGGER point_allocation_apply AFTER INSERT ON point_lot_allocations FOR EACH ROW EXECUTE FUNCTION apply_point_allocation();
CREATE TRIGGER point_allocation_immutable BEFORE UPDATE OR DELETE ON point_lot_allocations FOR EACH ROW EXECUTE FUNCTION immutable_row();
-- Deferred accounting guard protects against application bugs and direct runtime ledger inserts.
CREATE FUNCTION check_point_lot_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lid uuid; l point_ledger%ROWTYPE; total numeric;
BEGIN
 IF TG_TABLE_NAME='point_ledger' THEN lid:=NEW.id;
 ELSIF TG_TABLE_NAME='point_lots' THEN lid:=NEW.positive_ledger_id;
 ELSE lid:=NEW.negative_ledger_id; END IF;
 IF lid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT l FROM point_ledger WHERE id=lid;
 IF NOT EXISTS(SELECT 1 FROM point_lot_cutovers WHERE bot_id=l.bot_id) THEN RETURN NULL; END IF;
 IF l.delta>0 THEN SELECT COALESCE(sum(granted_amount),0) INTO total FROM point_lots WHERE positive_ledger_id=lid;
 ELSE SELECT -COALESCE(sum(amount),0) INTO total FROM point_lot_allocations WHERE negative_ledger_id=lid; END IF;
 IF total<>l.delta THEN RAISE EXCEPTION 'point_lot_ledger_mismatch'; END IF;
 IF (SELECT balance FROM point_accounts WHERE id=l.account_id)<>(SELECT COALESCE(sum(remaining_amount),0) FROM point_lots WHERE account_id=l.account_id) THEN RAISE EXCEPTION 'point_lot_balance_mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER point_ledger_lot_guard AFTER INSERT ON point_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_point_lot_ledger();
CREATE CONSTRAINT TRIGGER point_lot_ledger_guard AFTER INSERT ON point_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_point_lot_ledger();
CREATE CONSTRAINT TRIGGER point_allocation_ledger_guard AFTER INSERT ON point_lot_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_point_lot_ledger();
INSERT INTO permissions(name) VALUES('points.expiry.read'),('points.expiry.manage');
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='Super Admin' AND p.name IN ('points.expiry.read','points.expiry.manage');
