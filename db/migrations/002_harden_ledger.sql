-- This function runs with migration owner's privileges to update the balance;
-- application role receives INSERT on ledger, never UPDATE(balance) on accounts.
ALTER FUNCTION ledger_apply() SECURITY DEFINER;
ALTER FUNCTION ledger_apply() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION ledger_apply() FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
