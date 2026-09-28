# Migration 013 approval and runbook

STOP: schema code developed only. No Staging migration/cutover/flag enable authorized by this commit.

Before approval: exact feature commit/CI, migration hash and six minimal grant statements; compare001–012 hashes; independently authenticate runtime via safe hidden credential channel; record role attributes and existing permissions. Owner and runtime remain separate connections, never grant role membership.

On separately approved execution: lock migration/advisory guard; snapshot core/P3/P4/P5A/P5B tables with actual catalog PK order; apply013 and register checksum in one transaction; apply only new-domain minimal grants. Validate catalog as key-indexed sets (not locale-sensitive row order). Verify all10 new tables, FKs/checks/indexes/triggers, published immutability. Compare all old fingerprints before commit. Commit outcome unknown => stop, no automatic retry.

After commit: new tables empty; roles unchanged; no direct balance/ledger/audit-history update, no DELETE/TRUNCATE/DDL; runtime independent login+read-only metadata checks. Destructive denied-operation probes only in disposable local PG, never execute successful business probes in Staging without approval. Feature remains false; no member initialization or rule publish.

Cutover separate: dry-run eligible active Telegram identities by Brand; count members, links, accounts; lock/init uniquely, LV1/Growth0/no ledger; compare old fingerprints. Production and historical backfill excluded.

Enable separate after rules/configuration and basic UI checks. On reconcile failures: stop new Growth via flag, retain all history, inspect source/revision/ledger safe IDs; no manual balance edits. Correct authoritative input through its domain then replay affected task. Negative-balance correction requires manual review, not clamping. Never delete history or run down migration. Deployment rollback must remain compatible with additive schema. Forward fix only.
