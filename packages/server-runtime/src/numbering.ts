import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appSettingsSchema } from '@billme/desktop-contracts-pro/schemas';
import type { TenantScope } from '@billme/server-core';
import { getServerSettings, saveServerSettings, listServerNumberReservations, saveServerNumberReservation, type ServerDatabaseSession } from '@billme/server-data';
type AppSettings = z.infer<typeof appSettingsSchema>;

export const createNumberingPortsForDb = (
  db: ServerDatabaseSession,
  scope: TenantScope,
) => ({
  tx: {
    async inTransaction<TResult>(work: () => Promise<TResult> | TResult): Promise<TResult> {
      return await work();
    },
  },
  async getSettings() {
    await db.query('SELECT tenant_id FROM server_settings WHERE tenant_id = $1 FOR UPDATE', [scope.tenantId]);
    const record = await getServerSettings(db, scope.tenantId);
    return record ? appSettingsSchema.parse(JSON.parse(record.settingsJson)) : null;
  },
  async saveSettings(settings: AppSettings) {
    await saveServerSettings(db, {
      tenantId: scope.tenantId,
      settingsJson: JSON.stringify(appSettingsSchema.parse(settings)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  async createReservation(reservation: {
    id: string;
    kind: 'invoice' | 'offer' | 'customer';
    number: string;
    counterValue: number;
    status: 'reserved' | 'released' | 'finalized';
    documentId: string | null;
  }) {
    await saveServerNumberReservation(db, {
      ...reservation,
      tenantId: scope.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  async getReservationById(reservationId: string) {
    const reservations = await listServerNumberReservations(db, scope.tenantId);
    const reservation = reservations.find((entry) => entry.id === reservationId);
    return reservation
      ? {
          id: reservation.id,
          kind: reservation.kind,
          number: reservation.number,
          counterValue: reservation.counterValue,
          status: reservation.status,
          documentId: reservation.documentId,
        }
      : null;
  },
  async updateReservation(reservation: {
    id: string;
    kind: 'invoice' | 'offer' | 'customer';
    number: string;
    counterValue: number;
    status: 'reserved' | 'released' | 'finalized';
    documentId: string | null;
  }) {
    await saveServerNumberReservation(db, {
      ...reservation,
      tenantId: scope.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  async isNumberTaken(kind: 'invoice' | 'offer' | 'customer', number: string) {
    const entityTable = kind === 'customer' ? 'clients' : kind === 'invoice' ? 'invoices' : 'offers';
    const entityColumn = kind === 'customer' ? 'customer_number' : 'number';
    const entityMatch = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${entityTable} WHERE tenant_id = $1 AND ${entityColumn} = $2) AS exists`,
      [scope.tenantId, number],
    );
    if (entityMatch.rows[0]?.exists) {
      return true;
    }
    const reservationMatch = await db.query<{ exists: boolean }>(
      `
        SELECT EXISTS(
          SELECT 1
          FROM number_reservations
          WHERE tenant_id = $1
            AND kind = $2
            AND number = $3
            AND status <> 'released'
        ) AS exists
      `,
      [scope.tenantId, kind, number],
    );
    return Boolean(reservationMatch.rows[0]?.exists);
  },
  async generateReservationId() {
    return randomUUID();
  },
});
