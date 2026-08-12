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
  financial_fields_changed BOOLEAN;
  lifecycle_fields_changed BOOLEAN;
  repair_transition BOOLEAN;
  disposal_transition BOOLEAN;
  depreciation_transition BOOLEAN;
BEGIN
  financially_owned := OLD.activation_journal_entry_id IS NOT NULL
    OR OLD.accounting_repair_required
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

  financial_fields_changed := NEW.asset_number IS DISTINCT FROM OLD.asset_number
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
    OR NEW.accounting_repair_reason IS DISTINCT FROM OLD.accounting_repair_reason;
  lifecycle_fields_changed := NEW.status IS DISTINCT FROM OLD.status
    OR NEW.disposal_date IS DISTINCT FROM OLD.disposal_date
    OR NEW.disposal_proceeds IS DISTINCT FROM OLD.disposal_proceeds;

  -- A legacy activation can be repaired only by attaching the matching
  -- posted incoming-invoice source and journal movement atomically.
  repair_transition := OLD.accounting_repair_required AND NOT NEW.accounting_repair_required
      AND NEW.status IS NOT DISTINCT FROM OLD.status
      AND NEW.disposal_date IS NOT DISTINCT FROM OLD.disposal_date
      AND NEW.disposal_proceeds IS NOT DISTINCT FROM OLD.disposal_proceeds
      AND NEW.asset_number IS NOT DISTINCT FROM OLD.asset_number
      AND NEW.asset_class IS NOT DISTINCT FROM OLD.asset_class
      AND NEW.activation_date IS NOT DISTINCT FROM OLD.activation_date
      AND NEW.acquisition_cost IS NOT DISTINCT FROM OLD.acquisition_cost
      AND NEW.useful_life_years IS NOT DISTINCT FROM OLD.useful_life_years
      AND NEW.depreciation_method IS NOT DISTINCT FROM OLD.depreciation_method
      AND NEW.asset_account_number IS NOT DISTINCT FROM OLD.asset_account_number
      AND NEW.acquisition_offset_account_number IS NOT DISTINCT FROM OLD.acquisition_offset_account_number
      AND NEW.activation_journal_entry_id IS NOT NULL
      AND NEW.source_incoming_invoice_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM asset_movements m
        JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
        WHERE m.tenant_id = OLD.tenant_id AND m.asset_id = OLD.id AND m.type = 'activation'
          AND m.journal_entry_id = NEW.activation_journal_entry_id
          AND m.source_type = 'incoming_invoice'
          AND m.source_key = 'incoming-invoice:' || NEW.source_incoming_invoice_id
          AND j.source_type = m.source_type AND j.source_key = m.source_key
      );

  depreciation_transition := OLD.status = 'aktiv'
    AND NEW.status = 'voll_abgeschrieben'
    AND OLD.disposal_date IS NULL AND NEW.disposal_date IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM asset_depreciation_schedule
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id AND status = 'planned'
    )
    AND COALESCE((SELECT SUM(amount) FROM asset_depreciation_schedule
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id AND status = 'posted'), 0) >= OLD.acquisition_cost
    AND EXISTS (
      SELECT 1 FROM asset_movements
      WHERE tenant_id = OLD.tenant_id AND asset_id = OLD.id
        AND type = 'depreciation' AND source_type = 'asset_depreciation'
        AND journal_entry_id IS NOT NULL
    );

  disposal_transition := OLD.status IN ('aktiv', 'voll_abgeschrieben')
    AND OLD.disposal_date IS NULL
    AND NEW.status IN ('verkauft', 'stillgelegt')
    AND NEW.disposal_date IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM asset_movements m
      JOIN journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
      WHERE m.tenant_id = OLD.tenant_id AND m.asset_id = OLD.id
        AND m.type = 'disposal' AND m.source_type = 'asset_disposal'
        AND m.source_key = 'asset_disposal:' || OLD.id
        AND m.journal_entry_id IS NOT NULL
        AND m.movement_date = NEW.disposal_date
        AND COALESCE(m.proceeds, -1) = COALESCE(NEW.disposal_proceeds, -1)
        AND ((m.proceeds > 0 AND NEW.status = 'verkauft')
          OR (COALESCE(m.proceeds, 0) = 0 AND NEW.status = 'stillgelegt'))
        AND j.source_type = m.source_type AND j.source_key = m.source_key
    );

  IF financial_fields_changed AND NOT repair_transition THEN
    RAISE EXCEPTION 'accounting-affecting asset fields are immutable';
  END IF;

  IF lifecycle_fields_changed AND NOT disposal_transition AND NOT depreciation_transition THEN
    RAISE EXCEPTION 'asset status and disposal fields are immutable after accounting ownership';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_accounting_ownership_guard ON assets;
CREATE TRIGGER assets_accounting_ownership_guard
  BEFORE UPDATE ON assets
  FOR EACH ROW
  EXECUTE FUNCTION billme_protect_asset_accounting();
