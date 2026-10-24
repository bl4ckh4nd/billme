-- GoBD (Aufbewahrung im Empfangsformat): a bank import keeps the CSV file as received next to its hash.
-- Batches imported before keep only the hash. Once stored, file and hash never change; the batch row
-- itself still records its counts and a rollback.
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS file_content BYTEA;

CREATE OR REPLACE FUNCTION billme_protect_import_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.file_content IS NOT NULL
     AND (NEW.file_content IS DISTINCT FROM OLD.file_content OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256 OR NEW.file_name IS DISTINCT FROM OLD.file_name) THEN
    RAISE EXCEPTION 'imported bank files are immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS import_batches_file_immutable ON import_batches;
CREATE TRIGGER import_batches_file_immutable BEFORE UPDATE ON import_batches FOR EACH ROW EXECUTE FUNCTION billme_protect_import_file();
