-- Skonto terms of an invoice (percent and days from the invoice date), e.g. {"percent":2,"days":10}.
-- Part of the issued document like the due date; NULL means no Skonto.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS skonto_json TEXT;
