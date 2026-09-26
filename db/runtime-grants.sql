-- Execute as migration owner after separately provisioning telegram_app LOGIN credentials.
-- Never run the API as database owner / superuser. No grants to browser-facing roles.
GRANT USAGE ON SCHEMA public TO telegram_app;
GRANT SELECT ON brands,telegram_bots,telegram_users,telegram_updates,point_accounts,point_ledger,
 message_templates,admins,roles,permissions,admin_roles,role_permissions,audit_logs,
 referrals,redemption_rules,redemptions,redemption_codes TO telegram_app;
GRANT INSERT ON telegram_users,telegram_updates,point_accounts,point_ledger,referrals,audit_logs,redemptions TO telegram_app;
GRANT UPDATE(username,first_name,last_name,telegram_language_code,first_started_at,last_interaction_at,updated_at) ON telegram_users TO telegram_app;
-- Required for SELECT FOR UPDATE. Identity updates still cannot cross FK boundaries.
GRANT UPDATE(id) ON telegram_bots TO telegram_app;
GRANT UPDATE ON redemptions,redemption_codes TO telegram_app;
GRANT UPDATE(id) ON point_accounts TO telegram_app;
GRANT UPDATE(id) ON redemption_rules TO telegram_app;
-- No DELETE, TRUNCATE, schema DDL, role management or direct balance writes granted.
-- Browser authentication runtime access. Bootstrap uses the migration owner.
GRANT SELECT ON admin_credentials,admin_sessions,admin_login_limits TO telegram_app;
GRANT INSERT,UPDATE ON admin_sessions,admin_login_limits TO telegram_app;
GRANT UPDATE(id) ON admins TO telegram_app;
-- Mini App identity is separate from admin sessions. No runtime cleanup/DDL rights.
GRANT SELECT,INSERT ON mini_auth_exchanges,mini_sessions TO telegram_app;
GRANT UPDATE(revoked_at,revoke_reason) ON mini_sessions TO telegram_app;
GRANT SELECT,INSERT,UPDATE ON mini_auth_limits TO telegram_app;
