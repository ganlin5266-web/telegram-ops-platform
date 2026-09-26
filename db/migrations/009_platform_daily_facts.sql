-- Platform facts are independent of Telegram ownership. Identity snapshots never transfer on rebind.
CREATE TABLE platform_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,platform_id uuid NOT NULL,platform_uid text NOT NULL CHECK(platform_uid ~ '^[A-Za-z0-9_-]{1,64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),UNIQUE(brand_id,platform_id,platform_uid),UNIQUE(brand_id,platform_id,id)
);
CREATE TRIGGER platform_account_immutable BEFORE UPDATE OR DELETE ON platform_accounts FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE platform_import_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,platform_id uuid NOT NULL,business_date date NOT NULL,
 timezone text NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),source_type text NOT NULL CHECK(source_type IN ('csv','xlsx','api','webhook','automation')),
 original_filename text NOT NULL CHECK(length(original_filename) BETWEEN 1 AND 160),file_digest text NOT NULL CHECK(file_digest ~ '^[a-f0-9]{64}$'),metadata_digest text NOT NULL CHECK(metadata_digest ~ '^[a-f0-9]{64}$'),scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
 coverage jsonb NOT NULL CHECK(jsonb_typeof(coverage)='object'),mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 completeness text NOT NULL CHECK(completeness IN ('complete','incomplete','unknown','conflicting')),
 replacement boolean NOT NULL DEFAULT false,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 160),
 row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 1000),accepted_rows integer NOT NULL CHECK(accepted_rows>=0),rejected_rows integer NOT NULL CHECK(rejected_rows>=0),warning_rows integer NOT NULL CHECK(warning_rows>=0),
 status text NOT NULL CHECK(status IN ('ready','active','rejected','review_required','superseded')),issues jsonb NOT NULL CHECK(jsonb_typeof(issues)='array'),
 created_by uuid NOT NULL REFERENCES admins(id),created_at timestamptz NOT NULL DEFAULT now(),activated_by uuid REFERENCES admins(id),activated_at timestamptz,
 CHECK(accepted_rows+rejected_rows=row_count),CHECK(warning_rows<=row_count),CHECK((activated_at IS NULL)=(activated_by IS NULL)),CHECK((status IN ('active','superseded'))=(activated_at IS NOT NULL)),
 FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),UNIQUE(brand_id,platform_id,business_date,file_digest),UNIQUE(brand_id,platform_id,business_date,id)
);
CREATE TABLE platform_import_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,platform_id uuid NOT NULL,business_date date NOT NULL,batch_id uuid NOT NULL,row_number integer NOT NULL CHECK(row_number>=2),
 raw_values jsonb NOT NULL CHECK(jsonb_typeof(raw_values)='object'),row_digest text NOT NULL CHECK(row_digest ~ '^[a-f0-9]{64}$'),normalized jsonb NOT NULL CHECK(jsonb_typeof(normalized)='object'),issues jsonb NOT NULL CHECK(jsonb_typeof(issues)='array'),expected_revision_id uuid,
 FOREIGN KEY(brand_id,platform_id,business_date,batch_id) REFERENCES platform_import_batches(brand_id,platform_id,business_date,id),UNIQUE(batch_id,row_number),UNIQUE(brand_id,platform_id,business_date,batch_id,id)
);
CREATE TRIGGER platform_evidence_immutable BEFORE UPDATE OR DELETE ON platform_import_evidence FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE platform_user_daily_facts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,platform_id uuid NOT NULL,account_id uuid NOT NULL,business_date date NOT NULL,current_revision_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(brand_id,platform_id,account_id) REFERENCES platform_accounts(brand_id,platform_id,id),UNIQUE(brand_id,platform_id,account_id,business_date),UNIQUE(brand_id,platform_id,business_date,id)
);
CREATE TABLE platform_user_daily_fact_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand_id uuid NOT NULL,platform_id uuid NOT NULL,business_date date NOT NULL,fact_id uuid NOT NULL,batch_id uuid NOT NULL,evidence_id uuid NOT NULL,
 identity_id uuid REFERENCES platform_identities(id),data_version integer NOT NULL CHECK(data_version>0),supersedes uuid,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 160),imported_at timestamptz NOT NULL DEFAULT now(),
 normalized jsonb NOT NULL CHECK(jsonb_typeof(normalized)='object'),value_digest text NOT NULL CHECK(value_digest ~ '^[a-f0-9]{64}$'),
 deposit numeric(28,6),deposit_count bigint CHECK(deposit_count>=0),gift numeric(28,6),withdrawal numeric(28,6),source_net numeric(28,6),bet numeric(28,6),payout numeric(28,6),game_profit numeric(28,6),first_deposit numeric(28,6),
 FOREIGN KEY(brand_id,platform_id,business_date,fact_id) REFERENCES platform_user_daily_facts(brand_id,platform_id,business_date,id),
 FOREIGN KEY(brand_id,platform_id,business_date,batch_id,evidence_id) REFERENCES platform_import_evidence(brand_id,platform_id,business_date,batch_id,id),
 UNIQUE(fact_id,data_version),UNIQUE(fact_id,batch_id),UNIQUE(brand_id,platform_id,business_date,fact_id,id),
 FOREIGN KEY(brand_id,platform_id,business_date,fact_id,supersedes) REFERENCES platform_user_daily_fact_revisions(brand_id,platform_id,business_date,fact_id,id)
);
ALTER TABLE platform_user_daily_facts ADD CONSTRAINT fact_current_revision_fk FOREIGN KEY(brand_id,platform_id,business_date,id,current_revision_id) REFERENCES platform_user_daily_fact_revisions(brand_id,platform_id,business_date,fact_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platform_import_evidence ADD CONSTRAINT evidence_expected_revision_fk FOREIGN KEY(expected_revision_id) REFERENCES platform_user_daily_fact_revisions(id);
CREATE FUNCTION protect_daily_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f platform_user_daily_facts%ROWTYPE; a platform_accounts%ROWTYPE; b platform_import_batches%ROWTYPE; e platform_import_evidence%ROWTYPE; ident platform_identities%ROWTYPE; prev platform_user_daily_fact_revisions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT f FROM platform_user_daily_facts WHERE id=NEW.fact_id;
 SELECT * INTO STRICT a FROM platform_accounts WHERE id=f.account_id;
 SELECT * INTO STRICT b FROM platform_import_batches WHERE id=NEW.batch_id;
 SELECT * INTO STRICT e FROM platform_import_evidence WHERE id=NEW.evidence_id;
 IF b.status NOT IN ('ready','review_required') OR NEW.normalized IS DISTINCT FROM e.normalized OR e.normalized->>'uid' IS DISTINCT FROM a.platform_uid OR NEW.supersedes IS DISTINCT FROM f.current_revision_id THEN RAISE EXCEPTION 'fact_revision_invalid'; END IF;
 IF NEW.supersedes IS NULL THEN IF NEW.data_version<>1 THEN RAISE EXCEPTION 'fact_version_invalid'; END IF;
 ELSE SELECT * INTO STRICT prev FROM platform_user_daily_fact_revisions WHERE id=NEW.supersedes; IF NEW.data_version<>prev.data_version+1 OR prev.fact_id<>NEW.fact_id THEN RAISE EXCEPTION 'fact_version_invalid'; END IF; END IF;
 IF NEW.identity_id IS NOT NULL THEN
 SELECT * INTO STRICT ident FROM platform_identities WHERE id=NEW.identity_id;
 IF ident.brand_id<>NEW.brand_id OR ident.platform_id<>NEW.platform_id OR ident.platform_uid<>a.platform_uid OR ident.status<>'verified' THEN RAISE EXCEPTION 'fact_identity_scope_invalid'; END IF;
 END IF;
 IF NEW.deposit IS DISTINCT FROM (NEW.normalized->>'deposit')::numeric OR NEW.withdrawal IS DISTINCT FROM (NEW.normalized->>'withdrawal')::numeric OR NEW.gift IS DISTINCT FROM (NEW.normalized->>'gift')::numeric OR NEW.source_net IS DISTINCT FROM (NEW.normalized->>'source_net')::numeric OR NEW.bet IS DISTINCT FROM (NEW.normalized->>'bet')::numeric OR NEW.payout IS DISTINCT FROM (NEW.normalized->>'payout')::numeric OR NEW.game_profit IS DISTINCT FROM (NEW.normalized->>'game_profit')::numeric OR NEW.first_deposit IS DISTINCT FROM (NEW.normalized->>'first_deposit')::numeric OR NEW.deposit_count IS DISTINCT FROM (NEW.normalized->>'deposit_count')::bigint THEN RAISE EXCEPTION 'fact_values_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER daily_revision_validate BEFORE INSERT ON platform_user_daily_fact_revisions FOR EACH ROW EXECUTE FUNCTION protect_daily_revision();
CREATE TRIGGER daily_revision_immutable BEFORE UPDATE OR DELETE ON platform_user_daily_fact_revisions FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION protect_daily_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r platform_user_daily_fact_revisions%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'fact_immutable'; END IF;
 IF (NEW.id,NEW.brand_id,NEW.platform_id,NEW.account_id,NEW.business_date,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.brand_id,OLD.platform_id,OLD.account_id,OLD.business_date,OLD.created_at) OR NEW.current_revision_id IS NULL THEN RAISE EXCEPTION 'fact_immutable'; END IF;
 SELECT * INTO STRICT r FROM platform_user_daily_fact_revisions WHERE id=NEW.current_revision_id;
 IF r.fact_id<>OLD.id OR r.supersedes IS DISTINCT FROM OLD.current_revision_id THEN RAISE EXCEPTION 'fact_current_invalid'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER daily_fact_protect BEFORE UPDATE OR DELETE ON platform_user_daily_facts FOR EACH ROW EXECUTE FUNCTION protect_daily_fact();
CREATE FUNCTION protect_import_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'batch_history_immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','activated_by','activated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','activated_by','activated_at']) OR NOT ((OLD.status IN ('ready','review_required') AND NEW.status='active') OR (OLD.status='active' AND NEW.status='superseded' AND NEW.activated_by=OLD.activated_by AND NEW.activated_at=OLD.activated_at)) THEN RAISE EXCEPTION 'batch_history_immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER import_batch_protect BEFORE UPDATE OR DELETE ON platform_import_batches FOR EACH ROW EXECUTE FUNCTION protect_import_batch();
CREATE INDEX import_batch_search ON platform_import_batches(brand_id,platform_id,business_date DESC,created_at DESC);
CREATE INDEX daily_fact_search ON platform_user_daily_facts(brand_id,platform_id,business_date DESC,id);
CREATE INDEX daily_revision_identity ON platform_user_daily_fact_revisions(identity_id,business_date DESC) WHERE identity_id IS NOT NULL;
CREATE INDEX daily_revision_batch ON platform_user_daily_fact_revisions(batch_id);
INSERT INTO permissions(name) VALUES('platform_data.read'),('platform_data.import'),('platform_data.activate');
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='Super Admin' AND p.name IN ('platform_data.read','platform_data.import','platform_data.activate');
