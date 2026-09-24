-- NULL means unconfigured: never infer business timezone from host/browser.
ALTER TABLE brands ADD COLUMN timezone text;
ALTER TABLE telegram_bots ADD COLUMN timezone text;
CREATE FUNCTION validate_business_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone AND (name='UTC' OR name LIKE '%/%') AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%') THEN
  RAISE EXCEPTION 'invalid_business_timezone';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brand_timezone BEFORE INSERT OR UPDATE OF timezone ON brands FOR EACH ROW EXECUTE FUNCTION validate_business_timezone();
CREATE TRIGGER bot_timezone BEFORE INSERT OR UPDATE OF timezone ON telegram_bots FOR EACH ROW EXECUTE FUNCTION validate_business_timezone();
INSERT INTO permissions(name) VALUES('dashboard.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.name IN ('Super Admin','Admin','Operator','Viewer') AND p.name='dashboard.read'
ON CONFLICT DO NOTHING;
CREATE INDEX dashboard_ledger_period ON point_ledger(brand_id,bot_id,created_at);
CREATE INDEX dashboard_redemptions_period ON redemptions(brand_id,bot_id,created_at);
