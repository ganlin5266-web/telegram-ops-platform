-- All tenant-owned relations carry brand_id + bot_id; composite FKs enforce scope.
CREATE TABLE brands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE,
 default_language text NOT NULL, countries text[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_bots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL REFERENCES brands(id),
 name text NOT NULL, username text NOT NULL UNIQUE, token_secret_ref text NOT NULL UNIQUE,
 webhook_secret_ref text NOT NULL UNIQUE, default_language text NOT NULL,
 supported_languages text[] NOT NULL CHECK(cardinality(supported_languages)>0),
 status text NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,id), CHECK(default_language=ANY(supported_languages))
);
CREATE TABLE telegram_chats (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 telegram_chat_id bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('channel','group','supergroup')),
 title text, target_language text NOT NULL, status text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(brand_id,bot_id,id), UNIQUE(bot_id,telegram_chat_id),
 FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TABLE telegram_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 telegram_user_id bigint NOT NULL CHECK(telegram_user_id>0), username text, first_name text, last_name text,
 telegram_language_code text, preferred_language text, referral_code text NOT NULL DEFAULT replace(gen_random_uuid()::text,'-',''),
 first_started_at timestamptz, last_interaction_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,bot_id,id), UNIQUE(bot_id,telegram_user_id), UNIQUE(bot_id,referral_code),
 FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TABLE telegram_updates (
 brand_id uuid NOT NULL, bot_id uuid NOT NULL, update_id bigint NOT NULL CHECK(update_id>=0),
 kind text NOT NULL, status text NOT NULL CHECK(status IN ('processed','ignored')),
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(bot_id,update_id), FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TABLE message_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 template_key text NOT NULL, language text NOT NULL, body text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bot_id,template_key,language), FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TABLE bot_menu_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 item_key text NOT NULL, language text NOT NULL, label text NOT NULL,
 button_type text NOT NULL CHECK(button_type IN ('callback','url')), callback_data text, url text,
 sort_order integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true,
 UNIQUE(bot_id,item_key,language), FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id),
 CHECK((button_type='callback' AND callback_data IS NOT NULL AND octet_length(callback_data) BETWEEN 1 AND 64 AND url IS NULL)
 OR (button_type='url' AND url ~ '^https://' AND callback_data IS NULL))
);
CREATE TABLE point_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL,
 balance bigint NOT NULL DEFAULT 0 CHECK(balance>=0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,bot_id,id), UNIQUE(bot_id,user_id),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id)
);
CREATE TABLE point_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL,
 account_id uuid NOT NULL, delta bigint NOT NULL CHECK(delta<>0),
 direction text GENERATED ALWAYS AS (CASE WHEN delta>0 THEN 'credit' ELSE 'debit' END) STORED,
 balance_before bigint NOT NULL, balance_after bigint NOT NULL CHECK(balance_after>=0),
 source text NOT NULL, business_type text NOT NULL, business_id text NOT NULL, idempotency_key text NOT NULL,
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bot_id,idempotency_key), UNIQUE(bot_id,business_type,business_id),
 CHECK(balance_after=balance_before+delta),
 FOREIGN KEY(brand_id,bot_id,account_id) REFERENCES point_accounts(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id)
);
-- The ledger is the only write path to balances. Works for API and future workers alike.
CREATE FUNCTION ledger_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a point_accounts%ROWTYPE;
BEGIN
 SELECT * INTO a FROM point_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF a.id IS NULL OR a.user_id<>NEW.user_id OR a.bot_id<>NEW.bot_id OR a.brand_id<>NEW.brand_id THEN
  RAISE EXCEPTION 'account_scope_mismatch'; END IF;
 NEW.balance_before:=a.balance; NEW.balance_after:=a.balance+NEW.delta;
 IF NEW.balance_after<0 THEN RAISE EXCEPTION 'insufficient_points'; END IF;
 UPDATE point_accounts SET balance=NEW.balance_after,updated_at=now() WHERE id=a.id;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_apply BEFORE INSERT ON point_ledger FOR EACH ROW EXECUTE FUNCTION ledger_apply();
CREATE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable_record'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON point_ledger FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION protect_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.balance<>0 THEN RAISE EXCEPTION 'initial_balance_must_be_zero'; END IF;
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'account_delete_forbidden';
 ELSIF pg_trigger_depth()<2 AND (NEW.balance IS DISTINCT FROM OLD.balance OR NEW.user_id<>OLD.user_id OR NEW.bot_id<>OLD.bot_id OR NEW.brand_id<>OLD.brand_id) THEN
  RAISE EXCEPTION 'use_point_ledger';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_account BEFORE INSERT OR UPDATE OR DELETE ON point_accounts FOR EACH ROW EXECUTE FUNCTION protect_account();
CREATE TABLE referrals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 inviter_id uuid NOT NULL, invitee_id uuid NOT NULL, start_parameter text NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'bound' CHECK(status IN ('bound','qualified','invalid')),
 reward_status text NOT NULL DEFAULT 'pending' CHECK(reward_status IN ('pending','rewarded','ineligible')),
 UNIQUE(bot_id,invitee_id), CHECK(inviter_id<>invitee_id),
 FOREIGN KEY(brand_id,bot_id,inviter_id) REFERENCES telegram_users(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,invitee_id) REFERENCES telegram_users(brand_id,bot_id,id)
);
CREATE FUNCTION protect_referral() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.inviter_id<>OLD.inviter_id OR NEW.invitee_id<>OLD.invitee_id OR NEW.bot_id<>OLD.bot_id OR NEW.brand_id<>OLD.brand_id THEN RAISE EXCEPTION 'referral_binding_immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER protect_referral BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION protect_referral();
CREATE TRIGGER referral_no_delete BEFORE DELETE ON referrals FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE activities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 name text NOT NULL, activity_type text NOT NULL, starts_at timestamptz, ends_at timestamptz,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','ended')),
 rule_config jsonb NOT NULL DEFAULT '{}', audience_config jsonb NOT NULL DEFAULT '{}', target_languages text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,bot_id,id), CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at),
 FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TABLE activity_rewards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, activity_id uuid NOT NULL,
 user_id uuid NOT NULL, event_key text NOT NULL, points bigint CHECK(points>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','granted','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bot_id,activity_id,user_id,event_key),
 FOREIGN KEY(brand_id,bot_id,activity_id) REFERENCES activities(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id)
);
CREATE TABLE redemption_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 name text NOT NULL, mode text NOT NULL CHECK(mode IN ('fixed','all_points')), points_cost bigint CHECK(points_cost>0),
 exchange_rate numeric(20,8) NOT NULL CHECK(exchange_rate>0), daily_count_limit integer CHECK(daily_count_limit>0),
 daily_points_limit bigint CHECK(daily_points_limit>0), requires_deposit boolean NOT NULL DEFAULT false,
 review_mode text NOT NULL DEFAULT 'manual' CHECK(review_mode IN ('manual','automatic')),
 enabled boolean NOT NULL DEFAULT false, conditions jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(brand_id,bot_id,id),
 CHECK(mode<>'fixed' OR points_cost IS NOT NULL), FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TABLE redemptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, user_id uuid NOT NULL,
 rule_id uuid NOT NULL, points_cost bigint NOT NULL CHECK(points_cost>0), idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','success','failed','cancelled')),
 rule_snapshot jsonb NOT NULL, failure_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,bot_id,id), UNIQUE(bot_id,idempotency_key),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,rule_id) REFERENCES redemption_rules(brand_id,bot_id,id)
);
CREATE TABLE redemption_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, rule_id uuid NOT NULL,
 code_secret_ref text NOT NULL UNIQUE, code_fingerprint text NOT NULL, redemption_id uuid UNIQUE,
 status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','assigned','used','disabled')),
 expires_at timestamptz, assigned_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bot_id,code_fingerprint),
 CHECK((status IN ('assigned','used') AND redemption_id IS NOT NULL AND assigned_at IS NOT NULL) OR (status IN ('available','disabled') AND redemption_id IS NULL)),
 FOREIGN KEY(brand_id,bot_id,rule_id) REFERENCES redemption_rules(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,redemption_id) REFERENCES redemptions(brand_id,bot_id,id)
);
CREATE TABLE admins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_subject text NOT NULL UNIQUE, display_name text NOT NULL,
 ui_language text NOT NULL DEFAULT 'zh-CN', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
CREATE TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
CREATE TABLE role_permissions (role_id uuid REFERENCES roles(id),permission_id uuid REFERENCES permissions(id), PRIMARY KEY(role_id,permission_id));
CREATE TABLE admin_roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid NOT NULL REFERENCES admins(id), role_id uuid NOT NULL REFERENCES roles(id),
 brand_id uuid REFERENCES brands(id), bot_id uuid,
 CHECK(bot_id IS NULL OR brand_id IS NOT NULL), FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id),
 UNIQUE NULLS NOT DISTINCT(admin_id,role_id,brand_id,bot_id)
);
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid REFERENCES admins(id), brand_id uuid REFERENCES brands(id), bot_id uuid,
 action text NOT NULL, object_type text NOT NULL, object_id text NOT NULL,
 before_data jsonb, after_data jsonb, request_id text, ip inet, note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(brand_id,bot_id) REFERENCES telegram_bots(brand_id,id)
);
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TABLE scheduled_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL,
 chat_id uuid, user_id uuid, target_language text NOT NULL,
 admin_request text, final_content text NOT NULL, image_url text, buttons jsonb NOT NULL DEFAULT '[]',
 scheduled_at timestamptz NOT NULL, sent_at timestamptz,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','processing','sent','failed','cancelled','uncertain')),
 created_by uuid NOT NULL REFERENCES admins(id), confirmed_by uuid REFERENCES admins(id), confirmed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand_id,bot_id,id), CHECK(num_nonnulls(chat_id,user_id)=1),
 CHECK(status NOT IN ('approved','processing','sent') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
 FOREIGN KEY(brand_id,bot_id,chat_id) REFERENCES telegram_chats(brand_id,bot_id,id),
 FOREIGN KEY(brand_id,bot_id,user_id) REFERENCES telegram_users(brand_id,bot_id,id)
);
CREATE TABLE message_delivery_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL, bot_id uuid NOT NULL, scheduled_message_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt>0), status text NOT NULL CHECK(status IN ('sent','failed','uncertain')),
 telegram_message_id bigint, telegram_result jsonb, failure_reason text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(scheduled_message_id,attempt), FOREIGN KEY(brand_id,bot_id,scheduled_message_id) REFERENCES scheduled_messages(brand_id,bot_id,id)
);
CREATE INDEX ledger_user_history ON point_ledger(bot_id,user_id,created_at DESC);
CREATE INDEX users_recent ON telegram_users(bot_id,last_interaction_at DESC);
CREATE INDEX codes_available ON redemption_codes(bot_id,rule_id,created_at) WHERE status='available';
CREATE INDEX scheduled_due ON scheduled_messages(scheduled_at) WHERE status='approved';
CREATE INDEX audit_scope ON audit_logs(brand_id,bot_id,created_at DESC);
INSERT INTO roles(name) VALUES ('Super Admin'),('Admin'),('Operator'),('Viewer');
INSERT INTO permissions(name) VALUES ('users.read'),('points.adjust'),('redemptions.review'),('activities.manage'),('messages.publish'),('bots.manage'),('system.manage');
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name IN ('Super Admin','Admin') OR (r.name='Operator' AND p.name IN ('users.read','activities.manage','messages.publish')) OR (r.name='Viewer' AND p.name='users.read');
