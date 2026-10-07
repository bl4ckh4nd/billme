-- Projections a posted invoice may still take; its journal stays untouched:
-- - a revision replaces an unpaid invoice: the Stornorechnung posts the inverse
--   journal and settles the open item, then the original shows as cancelled;
-- - a dunning run records the reached level.
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
     AND NEW.status IN ('open','paid','overdue','unresolved','cancelled')
     AND (to_jsonb(OLD) - 'status' - 'updated_at' - CASE WHEN TG_TABLE_NAME = 'invoices' THEN ARRAY['payments_json','dunning_level'] ELSE ARRAY['__none__'] END)
       = (to_jsonb(NEW) - 'status' - 'updated_at' - CASE WHEN TG_TABLE_NAME = 'invoices' THEN ARRAY['payments_json','dunning_level'] ELSE ARRAY['__none__'] END) THEN
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
