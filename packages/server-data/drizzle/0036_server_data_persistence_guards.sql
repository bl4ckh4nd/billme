ALTER TABLE recurring_profiles ADD COLUMN IF NOT EXISTS anchor_day INTEGER CHECK (anchor_day BETWEEN 1 AND 31);
UPDATE recurring_profiles SET anchor_day = EXTRACT(DAY FROM next_run::date)::integer WHERE anchor_day IS NULL;
CREATE TABLE IF NOT EXISTS login_attempts (
  product TEXT NOT NULL,
  email TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  window_started_at BIGINT NOT NULL,
  PRIMARY KEY (product, email)
);
ALTER TABLE transactions DROP CONSTRAINT transactions_account_id_fkey;
ALTER TABLE transactions ADD CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE bank_transactions DROP CONSTRAINT bank_transactions_account_id_fkey;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE import_batches DROP CONSTRAINT import_batches_account_id_fkey;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION billme_protect_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.accounting_status IN ('posted','reversed') THEN
      RAISE EXCEPTION 'posted accounting documents are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.accounting_status = 'posted'
     AND NEW.accounting_status = 'posted'
     AND NEW.status IN ('open','paid','overdue','unresolved')
     AND (to_jsonb(OLD) - 'status' - 'updated_at' - CASE WHEN TG_TABLE_NAME = 'invoices' THEN 'payments_json' ELSE '__none__' END)
       = (to_jsonb(NEW) - 'status' - 'updated_at' - CASE WHEN TG_TABLE_NAME = 'invoices' THEN 'payments_json' ELSE '__none__' END) THEN
    RETURN NEW;
  END IF;
  IF OLD.accounting_status = 'posted'
     AND NEW.accounting_status = 'reversed'
     AND NEW.status = 'cancelled'
     AND (to_jsonb(OLD) - 'accounting_status' - 'status' - 'updated_at') = (to_jsonb(NEW) - 'accounting_status' - 'status' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.accounting_status IN ('posted','reversed') THEN
    RAISE EXCEPTION 'posted accounting documents are immutable';
  END IF;
  RETURN NEW;
END $$;
