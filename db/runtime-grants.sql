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
-- P3: no UID/scope/history overwrites, deletes or existing business privilege expansion.
GRANT SELECT,INSERT ON platforms,platform_identities TO telegram_app;
GRANT UPDATE(status,updated_at) ON platforms TO telegram_app;
GRANT UPDATE(status,verified_at,verified_by,rejected_at,rejected_by,revoked_at,revoked_by,reason_code,evidence_reference) ON platform_identities TO telegram_app;

-- P4: immutable source/revisions; only explicit activation and current pointers are mutable.
GRANT SELECT,INSERT ON platform_accounts,platform_import_batches,platform_import_evidence,platform_user_daily_facts,platform_user_daily_fact_revisions TO telegram_app;
GRANT UPDATE(status,activated_by,activated_at) ON platform_import_batches TO telegram_app;
GRANT UPDATE(current_revision_id) ON platform_user_daily_facts TO telegram_app;

-- P5-A: cutover/openings remain owner-only. Balances are allocation-trigger projections.
GRANT SELECT ON point_lot_cutovers,point_lot_openings TO telegram_app;
GRANT SELECT,INSERT ON point_expiry_policies,point_expiry_policy_versions,point_lots,point_lot_allocations TO telegram_app;
GRANT UPDATE(status,published_at,published_by) ON point_expiry_policy_versions TO telegram_app;
GRANT UPDATE(id) ON point_lots TO telegram_app;

-- P5-B: immutable qualification history; no new rights on P1-P5-A business tables.
GRANT SELECT,INSERT ON entitlement_rules,entitlement_rule_versions,entitlement_rule_tiers,daily_entitlements,daily_entitlement_revisions,entitlement_evaluation_tasks,entitlement_sla_findings TO telegram_app;
GRANT UPDATE(status,published_at,published_by,retired_at) ON entitlement_rule_versions TO telegram_app;
GRANT UPDATE(current_revision_id) ON daily_entitlements TO telegram_app;
GRANT UPDATE(status,attempts,next_attempt_at,lease_until,lease_token,last_error_code,outcome,completed_at) ON entitlement_evaluation_tasks TO telegram_app;
GRANT UPDATE(resolved_at) ON entitlement_sla_findings TO telegram_app;
