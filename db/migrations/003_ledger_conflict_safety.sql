-- BEFORE INSERT must not update accounts: ON CONFLICT DO NOTHING may discard
-- the ledger row after BEFORE triggers have run. Apply balance only AFTER INSERT.
CREATE OR REPLACE FUNCTION ledger_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a point_accounts%ROWTYPE;
BEGIN
 SELECT * INTO a FROM point_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF a.id IS NULL OR a.user_id<>NEW.user_id OR a.bot_id<>NEW.bot_id OR a.brand_id<>NEW.brand_id THEN
  RAISE EXCEPTION 'account_scope_mismatch'; END IF;
 NEW.balance_before:=a.balance; NEW.balance_after:=a.balance+NEW.delta;
 IF NEW.balance_after<0 THEN RAISE EXCEPTION 'insufficient_points'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION ledger_commit_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
 UPDATE point_accounts SET balance=NEW.balance_after,updated_at=now() WHERE id=NEW.account_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_commit_balance() FROM PUBLIC;
CREATE TRIGGER ledger_commit_balance AFTER INSERT ON point_ledger FOR EACH ROW EXECUTE FUNCTION ledger_commit_balance();
ALTER TABLE redemptions ADD UNIQUE(brand_id,bot_id,rule_id,id);
ALTER TABLE redemption_codes ADD FOREIGN KEY(brand_id,bot_id,rule_id,redemption_id) REFERENCES redemptions(brand_id,bot_id,rule_id,id);
