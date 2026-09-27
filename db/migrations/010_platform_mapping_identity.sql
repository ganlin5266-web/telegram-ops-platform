-- Preserve legacy import identity and immutable evidence. Mapping upgrades create new batches/revisions.
ALTER TABLE platform_import_batches ADD COLUMN mapping_digest text NOT NULL DEFAULT repeat('0',64) CHECK(mapping_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE platform_import_batches DROP CONSTRAINT platform_import_batches_brand_id_platform_id_business_date__key;
ALTER TABLE platform_import_batches ADD CONSTRAINT import_file_mapping_unique UNIQUE(brand_id,platform_id,business_date,file_digest,mapping_digest);
