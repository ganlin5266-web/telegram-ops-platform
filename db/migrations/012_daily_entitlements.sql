-- P5-B: qualification only. No point, reward, opportunity or P3/P4 business writes.
CREATE TABLE entitlement_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, platform_id uuid NOT NULL,
 entitlement_type text NOT NULL DEFAULT 'member_daily_status' CHECK(entitlement_type='member_daily_status'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), created_by uuid NOT NULL REFERENCES admins(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id), FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),
 UNIQUE(brand_id,bot_id,platform_id,entitlement_type), UNIQUE(brand_id,bot_id,platform_id,id)
);
CREATE TRIGGER entitlement_rule_immutable BEFORE UPDATE OR DELETE ON entitlement_rules FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE entitlement_rule_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, platform_id uuid NOT NULL, rule_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','retired')),
 metric text NOT NULL CHECK(metric='deposit_amount'), operator text NOT NULL CHECK(operator='>='), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 source_timezone text NOT NULL, entitlement_timezone text NOT NULL, cutoff_time time NOT NULL,
 effective_from date NOT NULL, effective_until date NOT NULL CHECK(effective_until>=effective_from AND effective_until-effective_from<=365),
 mapping_batch_id uuid NOT NULL REFERENCES platform_import_batches(id), mapping_approval jsonb NOT NULL CHECK(jsonb_typeof(mapping_approval)='object'),
 created_by uuid NOT NULL REFERENCES admins(id), created_at timestamptz NOT NULL DEFAULT now(), published_by uuid REFERENCES admins(id), published_at timestamptz, retired_at timestamptz,
 CHECK((status='draft')=(published_at IS NULL)), CHECK((published_at IS NULL)=(published_by IS NULL)), CHECK((status='retired')=(retired_at IS NOT NULL)),
 FOREIGN KEY(brand_id,bot_id,platform_id,rule_id) REFERENCES entitlement_rules(brand_id,bot_id,platform_id,id),
 UNIQUE(rule_id,version), UNIQUE(brand_id,bot_id,platform_id,id)
);
CREATE TABLE entitlement_rule_tiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_id uuid NOT NULL REFERENCES entitlement_rule_versions(id), tier_key text NOT NULL CHECK(tier_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 position integer NOT NULL CHECK(position BETWEEN 1 AND 20), display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80), threshold numeric(28,6) NOT NULL CHECK(threshold>=0),
 UNIQUE(version_id,tier_key), UNIQUE(version_id,position), UNIQUE(version_id,threshold)
);
CREATE FUNCTION protect_entitlement_tier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'entitlement_tier_immutable'; END IF;
 PERFORM 1 FROM entitlement_rule_versions WHERE id=NEW.version_id AND status='draft' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'entitlement_version_not_draft'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entitlement_tier_protect BEFORE INSERT OR UPDATE OR DELETE ON entitlement_rule_tiers FOR EACH ROW EXECUTE FUNCTION protect_entitlement_tier();
CREATE FUNCTION protect_entitlement_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer; tz text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'entitlement_version_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'entitlement_requires_draft'; END IF;
  IF NOT EXISTS(SELECT 1 FROM platform_import_batches WHERE id=NEW.mapping_batch_id AND brand_id=NEW.brand_id AND platform_id=NEW.platform_id) THEN RAISE EXCEPTION 'entitlement_mapping_scope'; END IF;
  FOREACH tz IN ARRAY ARRAY[NEW.source_timezone,NEW.entitlement_timezone] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) THEN RAISE EXCEPTION 'entitlement_timezone_invalid'; END IF;
  END LOOP;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','published_at','published_by','retired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','published_at','published_by','retired_at']) THEN RAISE EXCEPTION 'entitlement_version_immutable'; END IF;
 IF OLD.status='draft' AND NEW.status='published' THEN
  -- One transaction lock per rule serializes publication even through independent runtime connections.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.rule_id::text,52));
  IF EXISTS(SELECT 1 FROM entitlement_rule_versions v WHERE v.rule_id=NEW.rule_id AND v.id<>NEW.id AND v.status='published' AND daterange(v.effective_from,v.effective_until,'[]') && daterange(NEW.effective_from,NEW.effective_until,'[]')) THEN RAISE EXCEPTION 'entitlement_rule_overlap'; END IF;
  SELECT count(*) INTO n FROM entitlement_rule_tiers WHERE version_id=NEW.id;
  IF n<1 OR EXISTS(SELECT 1 FROM (SELECT position,threshold,lag(threshold) OVER(ORDER BY position) AS prev,row_number() OVER(ORDER BY position) AS expected FROM entitlement_rule_tiers WHERE version_id=NEW.id) t WHERE position<>expected OR threshold<=prev) THEN RAISE EXCEPTION 'entitlement_tiers_invalid'; END IF;
 ELSIF OLD.status='published' AND NEW.status='retired' THEN
  IF NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN RAISE EXCEPTION 'entitlement_version_immutable'; END IF;
 ELSE RAISE EXCEPTION 'entitlement_version_transition_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entitlement_version_protect BEFORE INSERT OR UPDATE OR DELETE ON entitlement_rule_versions FOR EACH ROW EXECUTE FUNCTION protect_entitlement_version();
CREATE TABLE daily_entitlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL, platform_id uuid NOT NULL,
 entitlement_type text NOT NULL DEFAULT 'member_daily_status' CHECK(entitlement_type='member_daily_status'), entitlement_date date NOT NULL, current_revision_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id), FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),
 UNIQUE(brand_id,bot_id,user_id,platform_id,entitlement_type,entitlement_date), UNIQUE(brand_id,bot_id,user_id,platform_id,entitlement_date,id)
);
CREATE TABLE daily_entitlement_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), daily_entitlement_id uuid NOT NULL, brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL, platform_id uuid NOT NULL,
 source_business_date date NOT NULL, entitlement_date date NOT NULL CHECK(entitlement_date=source_business_date+1),
 revision_number integer NOT NULL CHECK(revision_number>0), supersedes_revision_id uuid,
 daily_fact_id uuid, daily_fact_revision_id uuid, platform_identity_id uuid REFERENCES platform_identities(id), rule_version_id uuid,
 identity_snapshot jsonb NOT NULL CHECK(jsonb_typeof(identity_snapshot)='object'), input_fingerprint text NOT NULL CHECK(input_fingerprint ~ '^[a-f0-9]{64}$'),
 metric text NOT NULL CHECK(metric='deposit_amount'), source_metric_semantics jsonb NOT NULL CHECK(jsonb_typeof(source_metric_semantics)='object'), source_value numeric(28,6), matched_tier text,
 status text NOT NULL CHECK(status IN ('pending','eligible','ineligible','review_required')), reason_code text NOT NULL CHECK(reason_code ~ '^[a-z_]{1,64}$'),
 result_snapshot jsonb NOT NULL CHECK(jsonb_typeof(result_snapshot)='object'), calculated_at timestamptz NOT NULL DEFAULT now(), trigger_reason text NOT NULL CHECK(trigger_reason ~ '^[a-z_]{1,64}$'), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='eligible')=(matched_tier IS NOT NULL)), CHECK((daily_fact_id IS NULL)=(daily_fact_revision_id IS NULL)),
 CHECK(status NOT IN ('eligible','ineligible') OR (platform_identity_id IS NOT NULL AND daily_fact_revision_id IS NOT NULL AND rule_version_id IS NOT NULL AND source_value IS NOT NULL AND identity_snapshot->>'status'='verified')),
 FOREIGN KEY(brand_id,bot_id,user_id,platform_id,entitlement_date,daily_entitlement_id) REFERENCES daily_entitlements(brand_id,bot_id,user_id,platform_id,entitlement_date,id),
 FOREIGN KEY(brand_id,platform_id,source_business_date,daily_fact_id,daily_fact_revision_id) REFERENCES platform_user_daily_fact_revisions(brand_id,platform_id,business_date,fact_id,id),
 FOREIGN KEY(brand_id,bot_id,platform_id,rule_version_id) REFERENCES entitlement_rule_versions(brand_id,bot_id,platform_id,id),
 UNIQUE(daily_entitlement_id,revision_number), UNIQUE(daily_entitlement_id,input_fingerprint), UNIQUE(daily_entitlement_id,id),
 FOREIGN KEY(daily_entitlement_id,supersedes_revision_id) REFERENCES daily_entitlement_revisions(daily_entitlement_id,id)
);
ALTER TABLE daily_entitlements ADD CONSTRAINT entitlement_current_belongs FOREIGN KEY(id,current_revision_id) REFERENCES daily_entitlement_revisions(daily_entitlement_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION validate_entitlement_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d daily_entitlements%ROWTYPE; p platform_identities%ROWTYPE; previous_number integer; fact_value numeric; fact_currency text; quality text; expected_tier text; rv entitlement_rule_versions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT d FROM daily_entitlements WHERE id=NEW.daily_entitlement_id FOR UPDATE;
 IF NEW.supersedes_revision_id IS DISTINCT FROM d.current_revision_id THEN RAISE EXCEPTION 'entitlement_stale_revision'; END IF;
 SELECT revision_number INTO previous_number FROM daily_entitlement_revisions WHERE id=d.current_revision_id;
 IF NEW.revision_number<>coalesce(previous_number,0)+1 THEN RAISE EXCEPTION 'entitlement_revision_sequence'; END IF;
 IF NEW.daily_fact_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_user_daily_facts WHERE id=NEW.daily_fact_id AND current_revision_id=NEW.daily_fact_revision_id) THEN RAISE EXCEPTION 'entitlement_stale_fact'; END IF;
 IF NEW.rule_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entitlement_rule_versions WHERE id=NEW.rule_version_id AND status IN ('published','retired') AND NEW.entitlement_date BETWEEN effective_from AND effective_until) THEN RAISE EXCEPTION 'entitlement_rule_not_applicable'; END IF;
 IF NEW.platform_identity_id IS NOT NULL THEN
  SELECT * INTO STRICT p FROM platform_identities WHERE id=NEW.platform_identity_id;
  IF (p.brand_id,p.bot_id,p.user_id,p.platform_id) IS DISTINCT FROM (NEW.brand_id,NEW.bot_id,NEW.user_id,NEW.platform_id) THEN RAISE EXCEPTION 'entitlement_identity_scope'; END IF;
  IF NEW.identity_snapshot->>'status' IS DISTINCT FROM p.status OR (NEW.status IN ('eligible','ineligible') AND p.status<>'verified') THEN RAISE EXCEPTION 'entitlement_identity_snapshot_invalid'; END IF;
  IF NEW.daily_fact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_user_daily_facts f JOIN platform_accounts a ON a.id=f.account_id WHERE f.id=NEW.daily_fact_id AND a.platform_uid=p.platform_uid AND a.platform_id=p.platform_id AND a.brand_id=p.brand_id) THEN RAISE EXCEPTION 'entitlement_fact_owner'; END IF;
 END IF;
 IF NEW.daily_fact_revision_id IS NOT NULL THEN
  SELECT f.deposit,b.currency,b.completeness INTO fact_value,fact_currency,quality FROM platform_user_daily_fact_revisions f JOIN platform_import_batches b ON b.id=f.batch_id WHERE f.id=NEW.daily_fact_revision_id;
  IF NEW.source_value IS DISTINCT FROM fact_value THEN RAISE EXCEPTION 'entitlement_metric_snapshot_invalid'; END IF;
 END IF;
 IF NEW.status IN ('eligible','ineligible') THEN
  SELECT * INTO STRICT rv FROM entitlement_rule_versions WHERE id=NEW.rule_version_id;
  IF quality IS DISTINCT FROM 'complete' OR fact_currency IS DISTINCT FROM rv.currency OR NEW.source_value<0 THEN RAISE EXCEPTION 'entitlement_fact_not_qualified'; END IF;
  SELECT tier_key INTO expected_tier FROM entitlement_rule_tiers WHERE version_id=rv.id AND threshold<=NEW.source_value ORDER BY threshold DESC LIMIT 1;
  IF NEW.matched_tier IS DISTINCT FROM expected_tier THEN RAISE EXCEPTION 'entitlement_tier_invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entitlement_revision_validate BEFORE INSERT ON daily_entitlement_revisions FOR EACH ROW EXECUTE FUNCTION validate_entitlement_revision();
CREATE TRIGGER entitlement_revision_immutable BEFORE UPDATE OR DELETE ON daily_entitlement_revisions FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION protect_entitlement_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'entitlement_history_immutable'; END IF;
 IF (to_jsonb(NEW)-'current_revision_id') IS DISTINCT FROM (to_jsonb(OLD)-'current_revision_id') OR NEW.current_revision_id IS NULL THEN RAISE EXCEPTION 'entitlement_subject_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM daily_entitlement_revisions WHERE id=NEW.current_revision_id AND daily_entitlement_id=OLD.id AND supersedes_revision_id IS NOT DISTINCT FROM OLD.current_revision_id) THEN RAISE EXCEPTION 'entitlement_current_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entitlement_current_protect BEFORE UPDATE OR DELETE ON daily_entitlements FOR EACH ROW EXECUTE FUNCTION protect_entitlement_current();
CREATE TABLE entitlement_evaluation_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL, platform_id uuid NOT NULL, entitlement_date date NOT NULL,
 trigger_reason text NOT NULL CHECK(trigger_reason ~ '^[a-z_]{1,64}$'), business_key text NOT NULL UNIQUE CHECK(length(business_key) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10), next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
 last_error_code text CHECK(last_error_code ~ '^[a-z_]{1,64}$'), outcome text CHECK(outcome IN ('changed','unchanged','stale','transient_error','permanent_configuration_error')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK((status='running')=(lease_until IS NOT NULL AND lease_token IS NOT NULL)),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id), FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id)
);
CREATE TABLE entitlement_sla_findings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL, platform_id uuid NOT NULL, entitlement_date date NOT NULL,
 daily_entitlement_id uuid NOT NULL, finding text NOT NULL CHECK(finding='data_sla_missed'), first_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 FOREIGN KEY(brand_id,bot_id,user_id,platform_id,entitlement_date,daily_entitlement_id) REFERENCES daily_entitlements(brand_id,bot_id,user_id,platform_id,entitlement_date,id),
 UNIQUE(daily_entitlement_id,finding)
);
CREATE INDEX entitlement_current_search ON daily_entitlements(brand_id,bot_id,platform_id,entitlement_date DESC,id);
CREATE INDEX entitlement_user_date ON daily_entitlements(brand_id,bot_id,user_id,entitlement_date DESC);
CREATE INDEX entitlement_revision_fact ON daily_entitlement_revisions(daily_fact_revision_id);
CREATE INDEX entitlement_revision_rule ON daily_entitlement_revisions(rule_version_id);
CREATE INDEX entitlement_revision_status ON daily_entitlement_revisions(status,daily_entitlement_id);
CREATE INDEX entitlement_task_due ON entitlement_evaluation_tasks(status,next_attempt_at,lease_until);
CREATE INDEX entitlement_task_scope ON entitlement_evaluation_tasks(brand_id,bot_id,platform_id,entitlement_date);
CREATE INDEX entitlement_sla_scope ON entitlement_sla_findings(brand_id,bot_id,platform_id,entitlement_date,resolved_at);
INSERT INTO permissions(name) VALUES('entitlements.read'),('entitlements.explain_sensitive'),('entitlements.rules.manage'),('entitlements.recalculate');
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='Super Admin' AND p.name IN ('entitlements.read','entitlements.explain_sensitive','entitlements.rules.manage','entitlements.recalculate');
-- A committed subject must have a current revision; no dangling empty subjects.
CREATE FUNCTION check_entitlement_current_exists() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM daily_entitlements WHERE id=NEW.id AND current_revision_id IS NULL) THEN RAISE EXCEPTION 'entitlement_current_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entitlement_current_required AFTER INSERT ON daily_entitlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entitlement_current_exists();
