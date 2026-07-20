import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  documentDeliverySchema,
  mobileDeviceSchema,
  mobileDocumentFinalizeResponseSchema,
  receiptSchema,
  receiptSuggestionSchema,
  type DocumentDelivery,
  type MobileDevice,
  type MobileDocumentFinalizeResponse,
  type MobilePlatform,
  type Receipt,
  type ReceiptSuggestion,
  type ServerProduct,
  type ServerRole,
} from '@billme/server-core';
import type { Pool } from 'pg';
import type { PostgresQueryable } from './connection.js';

const tokenHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const createMobileRefreshToken = (): string => `billme_mobile_${randomBytes(32).toString('base64url')}`;
export const createMobilePairingCode = (): string => randomBytes(24).toString('base64url');

type DeviceRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  product: ServerProduct;
  device_name: string;
  platform: MobilePlatform;
  refresh_expires_at: string;
  last_active_at: string;
  created_at: string;
  revoked_at: string | null;
};

const toDevice = (row: DeviceRow): MobileDevice => mobileDeviceSchema.parse({
  id: row.id,
  name: row.device_name,
  platform: row.platform,
  product: row.product,
  lastActiveAt: row.last_active_at,
  createdAt: row.created_at,
  revokedAt: row.revoked_at ?? undefined,
});

export type MobilePrincipal = {
  tenantId: string;
  userId: string;
  product: ServerProduct;
  role: ServerRole;
  deploymentMode: 'single-tenant' | 'multi-tenant';
  email: string;
  fullName: string;
};

export const insertMobileDeviceSession = async (
  db: PostgresQueryable,
  input: MobilePrincipal & { deviceName: string; platform: MobilePlatform; refreshToken: string; refreshExpiresAt: string },
): Promise<MobileDevice> => {
  const now = new Date().toISOString();
  const result = await db.query<DeviceRow>(
    `
      INSERT INTO mobile_device_sessions (
        id, tenant_id, user_id, product, device_name, platform, refresh_token_hash,
        refresh_expires_at, last_active_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      RETURNING *
    `,
    [randomUUID(), input.tenantId, input.userId, input.product, input.deviceName, input.platform,
      tokenHash(input.refreshToken), input.refreshExpiresAt, now],
  );
  return toDevice(result.rows[0]!);
};

export const rotateMobileDeviceSession = async (
  db: PostgresQueryable,
  currentToken: string,
  nextToken: string,
  nextExpiresAt: string,
): Promise<{ principal: MobilePrincipal; device: MobileDevice } | null> => {
  const now = new Date().toISOString();
  const result = await db.query<DeviceRow & {
    email: string;
    full_name: string;
    role: ServerRole;
    deployment_mode: 'single-tenant' | 'multi-tenant';
  }>(
    `
      UPDATE mobile_device_sessions device
      SET refresh_token_hash = $2, refresh_expires_at = $3, last_active_at = $4
      FROM user_accounts users, tenant_memberships memberships, tenants
      WHERE device.refresh_token_hash = $1
        AND device.revoked_at IS NULL
        AND device.refresh_expires_at > $4
        AND users.id = device.user_id
        AND users.status = 'active'
        AND memberships.tenant_id = device.tenant_id
        AND memberships.user_id = device.user_id
        AND tenants.id = device.tenant_id
        AND tenants.status = 'active'
      RETURNING device.*, users.email, users.full_name, memberships.role, tenants.deployment_mode
    `,
    [tokenHash(currentToken), tokenHash(nextToken), nextExpiresAt, now],
  );
  const row = result.rows[0];
  return row ? {
    principal: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      product: row.product,
      role: row.role,
      deploymentMode: row.deployment_mode,
      email: row.email,
      fullName: row.full_name,
    },
    device: toDevice(row),
  } : null;
};

export const listMobileDeviceSessions = async (
  db: PostgresQueryable,
  tenantId: string,
  userId: string,
  product: ServerProduct,
): Promise<MobileDevice[]> => {
  const result = await db.query<DeviceRow>(
    `SELECT * FROM mobile_device_sessions
     WHERE tenant_id = $1 AND user_id = $2 AND product = $3
     ORDER BY created_at DESC`,
    [tenantId, userId, product],
  );
  return result.rows.map(toDevice);
};

export const revokeMobileDeviceSession = async (
  db: PostgresQueryable,
  tenantId: string,
  userId: string,
  id: string,
): Promise<boolean> => {
  const result = await db.query(
    `UPDATE mobile_device_sessions SET revoked_at = COALESCE(revoked_at, $4)
     WHERE tenant_id = $1 AND user_id = $2 AND id = $3 RETURNING id`,
    [tenantId, userId, id, new Date().toISOString()],
  );
  return result.rowCount === 1;
};

export const registerMobilePushToken = async (
  db: PostgresQueryable,
  tenantId: string,
  userId: string,
  id: string,
  token: string,
  provider: 'expo' | 'apns' | 'fcm',
): Promise<boolean> => {
  const result = await db.query(
    `UPDATE mobile_device_sessions SET push_token = $4, push_provider = $5, last_active_at = $6
     WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND revoked_at IS NULL RETURNING id`,
    [tenantId, userId, id, token, provider, new Date().toISOString()],
  );
  return result.rowCount === 1;
};

export type MobilePushOutboxEntry = {
  id: string;
  tenantId: string;
  product: ServerProduct;
  title: string;
  body: string;
  route?: string;
  tokens: string[];
};

export const enqueueMobilePush = async (
  db: PostgresQueryable,
  input: { tenantId: string; product: ServerProduct; title: string; body: string; route?: string },
): Promise<void> => {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO mobile_push_outbox (id, tenant_id, product, title, body, route, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
    [randomUUID(), input.tenantId, input.product, input.title, input.body, input.route ?? null, now],
  );
};

export const claimMobilePushBatch = async (db: Pool, limit = 20): Promise<MobilePushOutboxEntry[]> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      id: string; tenant_id: string; product: ServerProduct; title: string; body: string; route: string | null;
    }>(
      `SELECT * FROM mobile_push_outbox
       WHERE status = 'queued'
          OR (status = 'failed' AND attempt_count < 4 AND updated_at < $2)
          OR (status = 'sending' AND updated_at < $3)
       ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 5 * 60_000).toISOString()],
    );
    const entries: MobilePushOutboxEntry[] = [];
    for (const row of result.rows) {
      await client.query(`UPDATE mobile_push_outbox SET status = 'sending', updated_at = $2 WHERE id = $1`, [row.id, new Date().toISOString()]);
      const tokens = await client.query<{ push_token: string }>(
        `SELECT push_token FROM mobile_device_sessions
         WHERE tenant_id = $1 AND product = $2 AND revoked_at IS NULL AND push_provider = 'expo' AND push_token IS NOT NULL`,
        [row.tenant_id, row.product],
      );
      entries.push({ id: row.id, tenantId: row.tenant_id, product: row.product, title: row.title, body: row.body,
        route: row.route ?? undefined, tokens: tokens.rows.map((entry) => entry.push_token) });
    }
    await client.query('COMMIT');
    return entries;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const completeMobilePush = async (db: PostgresQueryable, id: string, errorCode?: string): Promise<void> => {
  await db.query(
    `UPDATE mobile_push_outbox SET status = $2, attempt_count = attempt_count + 1, error_code = $3, updated_at = $4 WHERE id = $1`,
    [id, errorCode ? 'failed' : 'sent', errorCode ?? null, new Date().toISOString()],
  );
};

export const insertMobilePairingCode = async (
  db: PostgresQueryable,
  input: { code: string; principal: MobilePrincipal; expiresAt: string },
): Promise<void> => {
  await db.query(
    `INSERT INTO mobile_pairing_codes (code_hash, tenant_id, user_id, product, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tokenHash(input.code), input.principal.tenantId, input.principal.userId, input.principal.product,
      input.expiresAt, new Date().toISOString()],
  );
};

export const consumeMobilePairingCode = async (
  db: PostgresQueryable,
  code: string,
): Promise<MobilePrincipal | null> => {
  const now = new Date().toISOString();
  const result = await db.query<{
    tenant_id: string;
    user_id: string;
    product: ServerProduct;
    role: ServerRole;
    deployment_mode: 'single-tenant' | 'multi-tenant';
    email: string;
    full_name: string;
  }>(
    `
      UPDATE mobile_pairing_codes pairing
      SET consumed_at = $2
      FROM user_accounts users, tenant_memberships memberships, tenants
      WHERE pairing.code_hash = $1
        AND pairing.consumed_at IS NULL
        AND pairing.expires_at > $2
        AND users.id = pairing.user_id
        AND users.status = 'active'
        AND memberships.tenant_id = pairing.tenant_id
        AND memberships.user_id = pairing.user_id
        AND tenants.id = pairing.tenant_id
        AND tenants.status = 'active'
      RETURNING pairing.tenant_id, pairing.user_id, pairing.product, memberships.role,
        tenants.deployment_mode, users.email, users.full_name
    `,
    [tokenHash(code), now],
  );
  const row = result.rows[0];
  return row ? {
    tenantId: row.tenant_id,
    userId: row.user_id,
    product: row.product,
    role: row.role,
    deploymentMode: row.deployment_mode,
    email: row.email,
    fullName: row.full_name,
  } : null;
};

type ReceiptRow = {
  id: string;
  tenant_id: string;
  product: ServerProduct;
  original_name: string;
  mime_type: Receipt['mimeType'];
  byte_size: number;
  sha256: string;
  status: Receipt['status'];
  storage_key: string;
  suggestion_json: string | null;
  confirmed_at: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

const toReceipt = (row: ReceiptRow): Receipt => receiptSchema.parse({
  id: row.id,
  tenantId: row.tenant_id,
  product: row.product,
  originalName: row.original_name,
  mimeType: row.mime_type,
  byteSize: row.byte_size,
  sha256: row.sha256,
  status: row.status,
  storageKey: row.storage_key,
  suggestion: row.suggestion_json ? JSON.parse(row.suggestion_json) : undefined,
  confirmedAt: row.confirmed_at ?? undefined,
  failureCode: row.failure_code ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const insertPostgresReceipt = async (
  db: PostgresQueryable,
  receipt: Receipt,
): Promise<Receipt> => {
  const parsed = receiptSchema.parse(receipt);
  const result = await db.query<ReceiptRow>(
    `
      INSERT INTO receipts (
        id, tenant_id, product, original_name, mime_type, byte_size, sha256, status,
        storage_key, suggestion_json, confirmed_at, failure_code, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (tenant_id, sha256) DO UPDATE SET updated_at = EXCLUDED.updated_at
      RETURNING *
    `,
    [parsed.id, parsed.tenantId, parsed.product, parsed.originalName, parsed.mimeType, parsed.byteSize,
      parsed.sha256, parsed.status, parsed.storageKey, parsed.suggestion ? JSON.stringify(parsed.suggestion) : null,
      parsed.confirmedAt ?? null, parsed.failureCode ?? null, parsed.createdAt, parsed.updatedAt],
  );
  return toReceipt(result.rows[0]!);
};

export const listPostgresReceipts = async (db: PostgresQueryable, tenantId: string): Promise<Receipt[]> => {
  const result = await db.query<ReceiptRow>(
    'SELECT * FROM receipts WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC',
    [tenantId],
  );
  return result.rows.map(toReceipt);
};

export const getPostgresReceipt = async (db: PostgresQueryable, tenantId: string, id: string): Promise<Receipt | null> => {
  const result = await db.query<ReceiptRow>('SELECT * FROM receipts WHERE tenant_id = $1 AND id = $2 LIMIT 1', [tenantId, id]);
  return result.rows[0] ? toReceipt(result.rows[0]) : null;
};

export const updatePostgresReceipt = async (
  db: PostgresQueryable,
  tenantId: string,
  id: string,
  update: { status: Receipt['status']; suggestion?: ReceiptSuggestion; confirmedAt?: string; failureCode?: string },
): Promise<Receipt | null> => {
  const suggestion = update.suggestion ? receiptSuggestionSchema.parse(update.suggestion) : undefined;
  const result = await db.query<ReceiptRow>(
    `UPDATE receipts SET status = $3, suggestion_json = COALESCE($4, suggestion_json),
       confirmed_at = COALESCE($5, confirmed_at), failure_code = $6, updated_at = $7
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, update.status, suggestion ? JSON.stringify(suggestion) : null,
      update.confirmedAt ?? null, update.failureCode ?? null, new Date().toISOString()],
  );
  return result.rows[0] ? toReceipt(result.rows[0]) : null;
};

export const claimQueuedPostgresReceipts = async (pool: Pool, limit = 5): Promise<Receipt[]> => {
  const result = await pool.query<ReceiptRow>(
    `WITH due AS (
       SELECT id FROM receipts
       WHERE status = 'queued' OR (status = 'processing' AND updated_at < $1)
       ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $2
     )
     UPDATE receipts SET status = 'processing', updated_at = $3
     FROM due WHERE receipts.id = due.id RETURNING receipts.*`,
    [new Date(Date.now() - 15 * 60_000).toISOString(), limit, new Date().toISOString()],
  );
  return result.rows.map(toReceipt);
};

export const getMobileDocumentMutation = async (
  db: PostgresQueryable,
  tenantId: string,
  mutationId: string,
): Promise<MobileDocumentFinalizeResponse | null> => {
  const result = await db.query<{ response_json: string }>(
    'SELECT response_json FROM mobile_document_mutations WHERE tenant_id = $1 AND client_mutation_id = $2 LIMIT 1',
    [tenantId, mutationId],
  );
  return result.rows[0] ? mobileDocumentFinalizeResponseSchema.parse(JSON.parse(result.rows[0].response_json)) : null;
};

export const insertMobileDocumentMutation = async (
  db: PostgresQueryable,
  input: { tenantId: string; product: ServerProduct; mutationId: string; response: MobileDocumentFinalizeResponse },
): Promise<void> => {
  await db.query(
    `INSERT INTO mobile_document_mutations (
       client_mutation_id, tenant_id, product, document_type, document_id, response_json, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.mutationId, input.tenantId, input.product, input.response.document.kind,
      input.response.document.id, JSON.stringify(input.response), new Date().toISOString()],
  );
};

type DeliveryRow = {
  id: string;
  tenant_id: string;
  created_by_user_id: string;
  document_type: 'invoice' | 'offer';
  document_id: string;
  recipient_email: string;
  status: DocumentDelivery['status'];
  attempt_count: number;
  attachment_storage_key: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

const toDelivery = (row: DeliveryRow): DocumentDelivery => documentDeliverySchema.parse({
  id: row.id,
  documentType: row.document_type,
  documentId: row.document_id,
  recipientEmail: row.recipient_email,
  status: row.status,
  errorCode: row.error_code ?? undefined,
  attemptCount: row.attempt_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  sentAt: row.sent_at ?? undefined,
});

export const insertDocumentDelivery = async (
  db: PostgresQueryable,
  input: { tenantId: string; userId: string; documentType: 'invoice' | 'offer'; documentId: string; recipientEmail: string },
): Promise<DocumentDelivery> => {
  const now = new Date().toISOString();
  const result = await db.query<DeliveryRow>(
    `INSERT INTO document_deliveries (
       id, tenant_id, created_by_user_id, document_type, document_id, recipient_email, status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$7) RETURNING *`,
    [randomUUID(), input.tenantId, input.userId, input.documentType, input.documentId, input.recipientEmail, now],
  );
  return toDelivery(result.rows[0]!);
};

export const updateDocumentDelivery = async (
  db: PostgresQueryable,
  tenantId: string,
  id: string,
  update: { status: DocumentDelivery['status']; attachmentStorageKey?: string; errorCode?: string; sentAt?: string },
): Promise<DocumentDelivery | null> => {
  const result = await db.query<DeliveryRow>(
    `UPDATE document_deliveries SET status = $3,
       attachment_storage_key = COALESCE($4, attachment_storage_key), error_code = $5,
       sent_at = COALESCE($6, sent_at), updated_at = $7
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, update.status, update.attachmentStorageKey ?? null, update.errorCode ?? null,
      update.sentAt ?? null, new Date().toISOString()],
  );
  return result.rows[0] ? toDelivery(result.rows[0]) : null;
};

export type DocumentDeliveryJob = {
  id: string;
  tenantId: string;
  userId: string;
  product: ServerProduct;
  documentType: 'invoice' | 'offer';
  documentId: string;
  documentNumber: string;
  attemptCount: number;
};

export const claimQueuedDocumentDeliveries = async (pool: Pool, limit = 3): Promise<DocumentDeliveryJob[]> => {
  const result = await pool.query<{
    id: string;
    tenant_id: string;
    created_by_user_id: string;
    product: ServerProduct;
    document_type: 'invoice' | 'offer';
    document_id: string;
    document_number: string;
    attempt_count: number;
  }>(
    `WITH due AS (
       SELECT id FROM document_deliveries
       WHERE status = 'queued' OR (status = 'rendering' AND updated_at < $1)
       ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $2
     ), claimed AS (
       UPDATE document_deliveries delivery SET status = 'rendering', attempt_count = attempt_count + 1, updated_at = $3
       FROM due WHERE delivery.id = due.id RETURNING delivery.*
     )
     SELECT claimed.id, claimed.tenant_id, claimed.created_by_user_id,
       tenants.product, claimed.document_type, claimed.document_id, claimed.attempt_count,
       COALESCE(invoices.number, offers.number) AS document_number
     FROM claimed
     JOIN tenants ON tenants.id = claimed.tenant_id
     LEFT JOIN invoices ON claimed.document_type = 'invoice'
       AND invoices.tenant_id = claimed.tenant_id AND invoices.id = claimed.document_id
     LEFT JOIN offers ON claimed.document_type = 'offer'
       AND offers.tenant_id = claimed.tenant_id AND offers.id = claimed.document_id`,
    [new Date(Date.now() - 15 * 60_000).toISOString(), limit, new Date().toISOString()],
  );
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.created_by_user_id,
    product: row.product,
    documentType: row.document_type,
    documentId: row.document_id,
    documentNumber: row.document_number,
    attemptCount: row.attempt_count,
  }));
};

export const attachRenderedDocument = async (
  db: PostgresQueryable,
  job: DocumentDeliveryJob,
  storageKey: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await db.query(
    `UPDATE document_deliveries SET status = 'sending', attachment_storage_key = $3,
       error_code = NULL, updated_at = $4 WHERE tenant_id = $1 AND id = $2`,
    [job.tenantId, job.id, storageKey, now],
  );
  await db.query(
    `UPDATE email_outbox SET attachment_storage_key = $3, updated_at = $4
     WHERE tenant_id = $1 AND delivery_id = $2`,
    [job.tenantId, job.id, storageKey, now],
  );
};
