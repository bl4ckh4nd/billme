import { createHash, randomUUID } from 'node:crypto';
import type { TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';

export type PortalPublicationDocumentType = 'offer' | 'invoice';

export interface PortalPublication {
  id: string;
  tenantId: string;
  documentType: PortalPublicationDocumentType;
  documentId: string;
  token: string;
  tokenHash: string;
  customerRef?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  expiresAt?: string;
}

export const hashPortalToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const fromRow = (row: Record<string, unknown>): PortalPublication => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  documentType: row.document_type as PortalPublicationDocumentType,
  documentId: String(row.document_id),
  token: String(row.token),
  tokenHash: String(row.token_hash),
  customerRef: row.customer_ref == null ? undefined : String(row.customer_ref),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  publishedAt: row.published_at == null ? undefined : String(row.published_at),
  expiresAt: row.expires_at == null ? undefined : String(row.expires_at),
});

export const getPortalPublication = async (
  target: PostgresQueryable,
  scope: TenantScope,
  documentType: PortalPublicationDocumentType,
  documentId: string,
): Promise<PortalPublication | null> => {
  const result = await target.query<Record<string, unknown>>(
    `SELECT id, tenant_id, document_type, document_id, token, token_hash,
            customer_ref, created_at, updated_at, published_at, expires_at
       FROM portal_publications
      WHERE tenant_id = $1 AND document_type = $2 AND document_id = $3`,
    [scope.tenantId, documentType, documentId],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
};

export const reservePortalPublication = async (
  target: PostgresQueryable,
  scope: TenantScope,
  input: {
    documentType: PortalPublicationDocumentType;
    documentId: string;
    token: string;
    customerRef?: string;
    now: string;
  },
): Promise<PortalPublication> => {
  await target.query(
    `INSERT INTO portal_publications
       (id, tenant_id, document_type, document_id, token, token_hash,
        customer_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
    [
      randomUUID(),
      scope.tenantId,
      input.documentType,
      input.documentId,
      input.token,
      hashPortalToken(input.token),
      input.customerRef ?? null,
      input.now,
    ],
  );
  const publication = await getPortalPublication(target, scope, input.documentType, input.documentId);
  if (!publication) throw new Error('Portal publication reservation was not persisted');
  return publication;
};

export const markPortalPublicationPublished = async (
  target: PostgresQueryable,
  scope: TenantScope,
  documentType: PortalPublicationDocumentType,
  documentId: string,
  publishedAt: string,
  expiresAt?: string,
): Promise<PortalPublication> => {
  await target.query(
    `UPDATE portal_publications
        SET published_at = $1, expires_at = COALESCE($2, expires_at), updated_at = $1
      WHERE tenant_id = $3 AND document_type = $4 AND document_id = $5`,
    [publishedAt, expiresAt ?? null, scope.tenantId, documentType, documentId],
  );
  const publication = await getPortalPublication(target, scope, documentType, documentId);
  if (!publication) throw new Error('Portal publication reservation was not found');
  return publication;
};
