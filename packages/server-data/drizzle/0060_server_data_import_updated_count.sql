-- A CSV re-import books pending bank lines instead of adding rows; the batch keeps that count next to "imported".
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS updated_count INTEGER NOT NULL DEFAULT 0;
