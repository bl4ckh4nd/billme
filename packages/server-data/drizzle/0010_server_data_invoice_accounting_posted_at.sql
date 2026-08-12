-- Preserve the outgoing invoice posting timestamp on installations that already
-- applied 0006/0007 before this field was added to the SQLite accounting model.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_posted_at TEXT;
