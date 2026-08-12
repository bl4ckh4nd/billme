-- Once an asset owns an activation or movement, direct SQL/import paths must
-- preserve the accounting identity. Lifecycle status changes remain possible
-- only for the accounting flows that have already persisted their movement or
-- completed their depreciation schedule.
CREATE OR REPLACE FUNCTION billme_protect_asset_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  financially_owned BOOLEAN;
  disposal_transition BOOLEAN;
  depreciation_transition BOOLEAN;
BEGIN
  financially_owned := OLD.activation_journal_entry_id IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM asset_movements
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id
    )
    OR EXISTS (
      SELECT 1
      FROM asset_depreciation_schedule
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id AND status = 'posted'
    );

  IF NOT financially_owned THEN
    RETURN NEW;
  END IF;

  IF NEW.asset_number IS DISTINCT FROM OLD.asset_number
    OR NEW.asset_class IS DISTINCT FROM OLD.asset_class
    OR NEW.activation_date IS DISTINCT FROM OLD.activation_date
    OR NEW.acquisition_cost IS DISTINCT FROM OLD.acquisition_cost
    OR NEW.useful_life_years IS DISTINCT FROM OLD.useful_life_years
    OR NEW.depreciation_method IS DISTINCT FROM OLD.depreciation_method
    OR NEW.asset_account_number IS DISTINCT FROM OLD.asset_account_number
    OR NEW.acquisition_offset_account_number IS DISTINCT FROM OLD.acquisition_offset_account_number
    OR NEW.source_incoming_invoice_id IS DISTINCT FROM OLD.source_incoming_invoice_id
    OR NEW.activation_journal_entry_id IS DISTINCT FROM OLD.activation_journal_entry_id
    OR NEW.accounting_repair_required IS DISTINCT FROM OLD.accounting_repair_required
    OR NEW.accounting_repair_reason IS DISTINCT FROM OLD.accounting_repair_reason THEN
    RAISE EXCEPTION 'accounting-affecting asset fields are immutable';
  END IF;

  disposal_transition := OLD.status IN ('aktiv', 'voll_abgeschrieben')
    AND NEW.status IN ('verkauft', 'stillgelegt')
    AND EXISTS (
      SELECT 1
      FROM asset_movements
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id AND type = 'disposal'
    );
  depreciation_transition := OLD.status = 'aktiv'
    AND NEW.status = 'voll_abgeschrieben'
    AND EXISTS (
      SELECT 1
      FROM asset_depreciation_schedule
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id AND status = 'posted'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM asset_depreciation_schedule
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id AND status <> 'posted'
    );

  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT disposal_transition
    AND NOT depreciation_transition THEN
    RAISE EXCEPTION 'asset status is immutable after accounting ownership';
  END IF;

  IF NOT disposal_transition
    AND (NEW.disposal_date IS DISTINCT FROM OLD.disposal_date
      OR NEW.disposal_proceeds IS DISTINCT FROM OLD.disposal_proceeds) THEN
    RAISE EXCEPTION 'asset disposal fields are immutable outside the disposal flow';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_accounting_ownership_guard ON assets;
CREATE TRIGGER assets_accounting_ownership_guard
  BEFORE UPDATE ON assets
  FOR EACH ROW
  EXECUTE FUNCTION billme_protect_asset_accounting();
