-- Only query indexes and a read permission; no existing business rules changed.
INSERT INTO permissions(name) VALUES('audit.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name IN ('Super Admin','Admin') AND p.name='audit.read'
ON CONFLICT DO NOTHING;
CREATE INDEX users_started_page ON telegram_users(brand_id,bot_id,first_started_at,id);
CREATE INDEX users_interaction_page ON telegram_users(brand_id,bot_id,last_interaction_at,id);
CREATE INDEX users_status_page ON telegram_users(brand_id,bot_id,status,id);
CREATE INDEX users_telegram_language ON telegram_users(brand_id,bot_id,lower(telegram_language_code),id);
CREATE INDEX users_preferred_language ON telegram_users(brand_id,bot_id,lower(preferred_language),id);
CREATE INDEX users_username_prefix ON telegram_users(brand_id,bot_id,lower(username) text_pattern_ops);
CREATE INDEX users_first_name_prefix ON telegram_users(brand_id,bot_id,lower(first_name) text_pattern_ops);
CREATE INDEX users_last_name_prefix ON telegram_users(brand_id,bot_id,lower(last_name) text_pattern_ops);
CREATE INDEX ledger_user_page ON point_ledger(brand_id,bot_id,user_id,created_at,id);
CREATE INDEX referrals_scope_page ON referrals(brand_id,bot_id,bound_at,id);
CREATE INDEX referrals_inviter_page ON referrals(brand_id,bot_id,inviter_id,bound_at,id);
CREATE INDEX referrals_status_page ON referrals(brand_id,bot_id,status,bound_at,id);
CREATE INDEX audit_scope_page ON audit_logs(brand_id,bot_id,created_at,id);
CREATE INDEX audit_admin_page ON audit_logs(brand_id,bot_id,admin_id,created_at,id);
CREATE INDEX audit_action_page ON audit_logs(brand_id,bot_id,action,created_at,id);
CREATE INDEX users_started_desc_page ON telegram_users(brand_id,bot_id,first_started_at DESC NULLS LAST,id DESC);
CREATE INDEX audit_object_page ON audit_logs(brand_id,bot_id,object_type,object_id,created_at,id);
