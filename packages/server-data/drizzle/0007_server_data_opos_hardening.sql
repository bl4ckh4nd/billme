-- Existing installations already applied 0006 before these OPOS hardening
-- columns and line immutability rules were introduced. Keep this migration
-- additive and idempotent: never rewrite the applied 0006 migration.
ALTER TABLE incoming_invoices ADD COLUMN IF NOT EXISTS accounting_posted_at TEXT;
ALTER TABLE accounting_backfill_runs ADD COLUMN IF NOT EXISTS config_json TEXT;

-- Posted documents retain immutable accounting content, but their OPOS status
-- is a projection maintained by payment allocation.  Only that projection
-- (and updated_at) may change while the accounting snapshot remains posted.
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
     AND (to_jsonb(OLD) - 'status' - 'updated_at') = (to_jsonb(NEW) - 'status' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.accounting_status IN ('posted','reversed')
     AND NEW.accounting_status = 'reversed'
     AND (to_jsonb(OLD) - 'accounting_status' - 'status' - 'updated_at') = (to_jsonb(NEW) - 'accounting_status' - 'status' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.accounting_status IN ('posted','reversed') THEN
    RAISE EXCEPTION 'posted accounting documents are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS invoices_posted_immutable ON invoices;
CREATE TRIGGER invoices_posted_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION billme_protect_posted_document();
DROP TRIGGER IF EXISTS incoming_invoices_posted_immutable ON incoming_invoices;
CREATE TRIGGER incoming_invoices_posted_immutable BEFORE UPDATE OR DELETE ON incoming_invoices FOR EACH ROW EXECUTE FUNCTION billme_protect_posted_document();

CREATE OR REPLACE FUNCTION billme_protect_posted_incoming_invoice_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND EXISTS (
    SELECT 1 FROM incoming_invoices
    WHERE id = OLD.incoming_invoice_id
      AND tenant_id = OLD.tenant_id
      AND accounting_status IN ('posted','reversed')
  ) THEN
    RAISE EXCEPTION 'posted incoming invoice lines are immutable';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND EXISTS (
    SELECT 1 FROM incoming_invoices
    WHERE id = NEW.incoming_invoice_id
      AND tenant_id = NEW.tenant_id
      AND accounting_status IN ('posted','reversed')
  ) THEN
    RAISE EXCEPTION 'posted incoming invoice lines are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS incoming_invoice_lines_posted_immutable ON incoming_invoice_lines;
CREATE TRIGGER incoming_invoice_lines_posted_immutable BEFORE INSERT OR UPDATE OR DELETE ON incoming_invoice_lines FOR EACH ROW EXECUTE FUNCTION billme_protect_posted_incoming_invoice_lines();
