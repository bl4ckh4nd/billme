ALTER TABLE number_reservations
  DROP CONSTRAINT IF EXISTS number_reservations_tenant_id_kind_number_key;

DROP INDEX IF EXISTS number_reservations_tenant_id_kind_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS number_reservations_tenant_id_kind_number_key
  ON number_reservations (tenant_id, kind, number)
  WHERE status <> 'released';
