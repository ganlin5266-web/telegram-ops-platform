-- Batch A only. Schema installation does not initialize members or enable Growth.
CREATE TABLE member_rule_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL REFERENCES brands(id),
 kind text NOT NULL CHECK(kind IN ('level','growth','platform')), platform_id uuid,
 version integer NOT NULL CHECK(version>0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 effective_from date NOT NULL,effective_until date NOT NULL CHECK(effective_until>=effective_from),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'), mapping_approval jsonb,
 created_by uuid NOT NULL REFERENCES admins(id),created_at timestamptz NOT NULL DEFAULT now(),published_by uuid REFERENCES admins(id),published_at timestamptz,
 CHECK((kind='platform')=(platform_id IS NOT NULL)),CHECK((kind='platform')=(mapping_approval IS NOT NULL)),
 CHECK((status='draft')=(published_at IS NULL)),CHECK((published_at IS NULL)=(published_by IS NULL)),
 FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),UNIQUE(brand_id,id),
 UNIQUE NULLS NOT DISTINCT(brand_id,kind,platform_id,version)
);
CREATE FUNCTION protect_member_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'member_rule_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'member_rule_requires_draft'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'draft' OR NEW.status<>'published' OR (to_jsonb(OLD)-ARRAY['status','published_at','published_by']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','published_at','published_by']) THEN RAISE EXCEPTION 'member_rule_immutable'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.brand_id::text,0));
 IF EXISTS(SELECT 1 FROM member_rule_versions WHERE brand_id=NEW.brand_id AND kind=NEW.kind AND platform_id IS NOT DISTINCT FROM NEW.platform_id AND status='published' AND effective_from<=NEW.effective_until AND effective_until>=NEW.effective_from AND id<>NEW.id) THEN RAISE EXCEPTION 'member_rule_overlap'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_rule_protect BEFORE INSERT OR UPDATE OR DELETE ON member_rule_versions FOR EACH ROW EXECUTE FUNCTION protect_member_rule();
CREATE TABLE members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL REFERENCES brands(id),telegram_user_id bigint NOT NULL CHECK(telegram_user_id>0),
 level integer NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 5),level_rule_id uuid NOT NULL,
 initialized_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,telegram_user_id),UNIQUE(brand_id,id),UNIQUE(brand_id,id,telegram_user_id),
 FOREIGN KEY(brand_id,level_rule_id) REFERENCES member_rule_versions(brand_id,id)
);
CREATE TABLE member_user_links (
 brand_id uuid NOT NULL,bot_id uuid NOT NULL,user_id uuid NOT NULL,member_id uuid NOT NULL,telegram_user_id bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(brand_id,bot_id,user_id),
 FOREIGN KEY(brand_id,bot_id,user_id,telegram_user_id) REFERENCES telegram_users(brand_id,bot_id,id,telegram_user_id),
 FOREIGN KEY(brand_id,member_id,telegram_user_id) REFERENCES members(brand_id,id,telegram_user_id)
);
CREATE TRIGGER member_link_immutable BEFORE UPDATE OR DELETE ON member_user_links FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE growth_accounts (
 member_id uuid PRIMARY KEY,brand_id uuid NOT NULL,balance bigint NOT NULL DEFAULT 0 CHECK(balance>=0),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,member_id) REFERENCES members(brand_id,id),UNIQUE(brand_id,member_id)
);
CREATE TABLE growth_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,member_id uuid NOT NULL,
 source_type text NOT NULL CHECK(source_type IN ('platform_daily','qualified_referral','member_task','daily_checkin')),
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 160),business_date date NOT NULL,occurred_at timestamptz NOT NULL,
 policy_id uuid NOT NULL,current_evaluation_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,member_id) REFERENCES members(brand_id,id),FOREIGN KEY(brand_id,policy_id) REFERENCES member_rule_versions(brand_id,id),
 UNIQUE(brand_id,member_id,source_type,source_key),UNIQUE(brand_id,member_id,id)
);
CREATE TABLE growth_evaluation_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,member_id uuid NOT NULL,source_id uuid NOT NULL,
 rule_version_id uuid NOT NULL,input_fingerprint text NOT NULL CHECK(input_fingerprint ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('eligible','not_applicable','pending','review_required')),reason_code text NOT NULL,
 requested_growth integer NOT NULL CHECK(requested_growth BETWEEN 0 AND 350),evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,member_id,source_id) REFERENCES growth_sources(brand_id,member_id,id),
 FOREIGN KEY(brand_id,rule_version_id) REFERENCES member_rule_versions(brand_id,id),
 UNIQUE(source_id,input_fingerprint),UNIQUE(brand_id,member_id,source_id,id),UNIQUE(brand_id,member_id,id),
 CHECK(status='eligible' OR requested_growth=0)
);
ALTER TABLE growth_sources ADD FOREIGN KEY(brand_id,member_id,id,current_evaluation_id) REFERENCES growth_evaluation_revisions(brand_id,member_id,source_id,id);
CREATE TRIGGER growth_evaluation_immutable BEFORE UPDATE OR DELETE ON growth_evaluation_revisions FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE growth_daily_reconciliations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,member_id uuid NOT NULL,business_date date NOT NULL,policy_id uuid NOT NULL,
 input_fingerprint text NOT NULL CHECK(input_fingerprint ~ '^[a-f0-9]{64}$'),allocation jsonb NOT NULL CHECK(jsonb_typeof(allocation)='array'),
 total integer NOT NULL CHECK(total BETWEEN 0 AND 350),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,member_id) REFERENCES members(brand_id,id),FOREIGN KEY(brand_id,policy_id) REFERENCES member_rule_versions(brand_id,id),
 UNIQUE(member_id,business_date,input_fingerprint),UNIQUE(brand_id,member_id,id)
);
CREATE TRIGGER growth_reconciliation_immutable BEFORE UPDATE OR DELETE ON growth_daily_reconciliations FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE growth_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,member_id uuid NOT NULL,source_id uuid,reconciliation_id uuid,
 delta bigint NOT NULL CHECK(delta<>0),business_date date NOT NULL,kind text NOT NULL CHECK(kind IN ('grant','correction','admin_adjustment')),
 reason_code text NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 100),idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 admin_id uuid REFERENCES admins(id),request_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,member_id) REFERENCES growth_accounts(brand_id,member_id),
 FOREIGN KEY(brand_id,member_id,source_id) REFERENCES growth_sources(brand_id,member_id,id),
 FOREIGN KEY(brand_id,member_id,reconciliation_id) REFERENCES growth_daily_reconciliations(brand_id,member_id,id),
 UNIQUE(member_id,idempotency_key),CHECK(kind<>'grant' OR delta>0),
 CHECK((kind='admin_adjustment' AND admin_id IS NOT NULL AND source_id IS NULL AND reconciliation_id IS NULL) OR (kind<>'admin_adjustment' AND source_id IS NOT NULL AND reconciliation_id IS NOT NULL))
);
CREATE TRIGGER growth_ledger_immutable BEFORE UPDATE OR DELETE ON growth_ledger FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION growth_apply_ledger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.growth_accounts SET balance=balance+NEW.delta,updated_at=now() WHERE member_id=NEW.member_id AND brand_id=NEW.brand_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'growth_account_missing'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION growth_apply_ledger() FROM PUBLIC;
CREATE TRIGGER growth_ledger_balance AFTER INSERT ON growth_ledger FOR EACH ROW EXECUTE FUNCTION growth_apply_ledger();
CREATE TABLE member_level_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,member_id uuid NOT NULL,previous_level integer,new_level integer NOT NULL,ordinal integer NOT NULL DEFAULT 1 CHECK(ordinal>0),
 growth_balance bigint NOT NULL CHECK(growth_balance>=0),rule_version_id uuid NOT NULL,reason_code text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,member_id) REFERENCES members(brand_id,id),FOREIGN KEY(brand_id,rule_version_id) REFERENCES member_rule_versions(brand_id,id),
 UNIQUE(member_id,ordinal),CHECK(new_level BETWEEN 1 AND 5),CHECK(previous_level IS NULL OR new_level>=previous_level),UNIQUE(brand_id,member_id,id)
);
CREATE TRIGGER member_history_immutable BEFORE UPDATE OR DELETE ON member_level_history FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE growth_evaluation_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,bot_id uuid NOT NULL,user_id uuid NOT NULL,platform_id uuid NOT NULL,
 source_business_date date NOT NULL,event_key text NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,lease_token uuid,
 last_error_code text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id),FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),
 UNIQUE(brand_id,bot_id,user_id,platform_id,source_business_date,event_key)
);
CREATE INDEX growth_task_ready ON growth_evaluation_tasks(status,next_attempt_at);
CREATE INDEX growth_sources_day ON growth_sources(member_id,business_date);
CREATE INDEX growth_ledger_history ON growth_ledger(member_id,created_at,id);
CREATE INDEX growth_ledger_analytics ON growth_ledger(brand_id,business_date,member_id);
CREATE INDEX member_history_period ON member_level_history(brand_id,created_at,member_id);
CREATE INDEX member_links_member ON member_user_links(brand_id,member_id,bot_id);
CREATE FUNCTION protect_member_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'member_history_preserved'; END IF;
 IF TG_TABLE_NAME='members' THEN
  IF NEW.level<OLD.level OR (to_jsonb(NEW)-ARRAY['level','level_rule_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['level','level_rule_id']) THEN RAISE EXCEPTION 'member_scope_immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM member_rule_versions WHERE id=NEW.level_rule_id AND brand_id=NEW.brand_id AND kind='level' AND status='published') THEN RAISE EXCEPTION 'member_level_rule_invalid'; END IF;
  IF NEW.level>OLD.level AND NOT EXISTS(SELECT 1 FROM member_rule_versions r JOIN growth_accounts a ON a.brand_id=r.brand_id AND a.member_id=NEW.id WHERE r.id=NEW.level_rule_id AND a.balance>=(r.config->'levels'->(NEW.level-1)->>'threshold')::bigint) THEN RAISE EXCEPTION 'member_level_not_earned'; END IF;

 ELSIF TG_TABLE_NAME='growth_sources' THEN
  IF (to_jsonb(NEW)-'current_evaluation_id') IS DISTINCT FROM (to_jsonb(OLD)-'current_evaluation_id') THEN RAISE EXCEPTION 'growth_source_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_state_protect BEFORE UPDATE OR DELETE ON members FOR EACH ROW EXECUTE FUNCTION protect_member_state();
CREATE TRIGGER growth_source_protect BEFORE UPDATE OR DELETE ON growth_sources FOR EACH ROW EXECUTE FUNCTION protect_member_state();
INSERT INTO permissions(name) VALUES('members.read'),('growth.read'),('growth.adjust'),('growth.rules.manage'),('growth.rules.publish'),('member.levels.manage'),('member.levels.publish'),('growth.tasks.manage');
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='Super Admin' AND p.name IN ('members.read','growth.read','growth.adjust','growth.rules.manage','growth.rules.publish','member.levels.manage','member.levels.publish','growth.tasks.manage');
CREATE FUNCTION guard_growth_account_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.balance<>0 THEN RAISE EXCEPTION 'growth_account_requires_zero'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER growth_account_zero BEFORE INSERT ON growth_accounts FOR EACH ROW EXECUTE FUNCTION guard_growth_account_insert();
CREATE FUNCTION guard_member_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.level<>1 OR NOT EXISTS(SELECT 1 FROM member_rule_versions WHERE id=NEW.level_rule_id AND brand_id=NEW.brand_id AND kind='level' AND status='published') THEN RAISE EXCEPTION 'member_initial_level_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_initial_level BEFORE INSERT ON members FOR EACH ROW EXECUTE FUNCTION guard_member_insert();

CREATE FUNCTION guard_growth_account_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.member_id<>OLD.member_id OR NEW.brand_id<>OLD.brand_id OR (pg_trigger_depth()<2 AND NEW.balance<>OLD.balance) THEN RAISE EXCEPTION 'growth_account_derived_only'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER growth_account_guard BEFORE UPDATE ON growth_accounts FOR EACH ROW EXECUTE FUNCTION guard_growth_account_update();

CREATE FUNCTION order_member_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM members WHERE brand_id=NEW.brand_id AND id=NEW.member_id FOR UPDATE;
 SELECT coalesce(max(ordinal),0)+1 INTO NEW.ordinal FROM member_level_history WHERE member_id=NEW.member_id;
 RETURN NEW;
END $$;
CREATE TRIGGER member_history_order BEFORE INSERT ON member_level_history FOR EACH ROW EXECUTE FUNCTION order_member_history();
