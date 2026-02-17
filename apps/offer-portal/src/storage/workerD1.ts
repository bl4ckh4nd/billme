import type {
  CustomerAccessTokenRecord,
  DecisionRecord,
  OfferRecord,
  OfferStore,
  PdfStore,
  PortalDocumentKind,
  PortalDocumentListItem,
} from './types';

export type WorkerEnv = {
  DB?: D1Database;
  PDF_BUCKET?: R2Bucket;
};

const bootstrapSql = `
  CREATE TABLE IF NOT EXISTS offers (
    token_hash TEXT PRIMARY KEY,
    published_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    pdf_key TEXT,
    decision_json TEXT
  );
  CREATE TABLE IF NOT EXISTS portal_documents (
    token_hash TEXT PRIMARY KEY,
    token_value TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    customer_ref TEXT NOT NULL,
    customer_label TEXT,
    published_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    pdf_key TEXT,
    decision_json TEXT
  );
  CREATE TABLE IF NOT EXISTS customer_access_tokens (
    token_hash TEXT PRIMARY KEY,
    customer_ref TEXT NOT NULL,
    customer_label TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_portal_docs_customer_ref_pub
    ON portal_documents(customer_ref, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_customer_tokens_customer_ref
    ON customer_access_tokens(customer_ref);
`;

let ensured = false;

const ensureSchema = async (db: D1Database) => {
  if (ensured) return;
  ensured = true;
  await db.exec(bootstrapSql);
};

export const createWorkerD1OfferStore = (db: D1Database): OfferStore => {
  const mapPortalDocRow = (row: {
    kind: string;
    token_value: string;
    published_at: string;
    expires_at: string;
    customer_ref: string;
    customer_label: string | null;
    snapshot_json: string;
    pdf_key: string | null;
    decision_json: string | null;
  }): PortalDocumentListItem => ({
    kind: row.kind as PortalDocumentKind,
    token: row.token_value,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    customerRef: row.customer_ref,
    customerLabel: row.customer_label ?? null,
    snapshotJson: JSON.parse(row.snapshot_json),
    pdfKey: row.pdf_key ?? null,
    decision: row.decision_json ? (JSON.parse(row.decision_json) as DecisionRecord) : null,
  });

  return {
    upsertOffer: async (offer) => {
      await ensureSchema(db);
      await db
        .prepare(
          `
            INSERT INTO offers (token_hash, published_at, expires_at, snapshot_json, pdf_key, decision_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(token_hash) DO UPDATE SET
              published_at=excluded.published_at,
              expires_at=excluded.expires_at,
              snapshot_json=excluded.snapshot_json,
              pdf_key=excluded.pdf_key,
              decision_json=excluded.decision_json
          `,
        )
        .bind(
          offer.tokenHash,
          offer.publishedAt,
          offer.expiresAt,
          JSON.stringify(offer.snapshotJson ?? null),
          offer.pdfKey ?? null,
          offer.decision ? JSON.stringify(offer.decision) : null,
        )
        .run();
      if (offer.token) {
        const customerRef = offer.customerRef ?? `anon:${offer.tokenHash.slice(0, 16)}`;
        await db
          .prepare(
            `
              INSERT INTO portal_documents (
                token_hash, token_value, kind, customer_ref, customer_label, published_at, expires_at, snapshot_json, pdf_key, decision_json
              ) VALUES (?1, ?2, 'offer', ?3, ?4, ?5, ?6, ?7, ?8, ?9)
              ON CONFLICT(token_hash) DO UPDATE SET
                token_value=excluded.token_value,
                customer_ref=excluded.customer_ref,
                customer_label=excluded.customer_label,
                published_at=excluded.published_at,
                expires_at=excluded.expires_at,
                snapshot_json=excluded.snapshot_json,
                pdf_key=excluded.pdf_key,
                decision_json=excluded.decision_json
            `,
          )
          .bind(
            offer.tokenHash,
            offer.token,
            customerRef,
            offer.customerLabel ?? null,
            offer.publishedAt,
            offer.expiresAt,
            JSON.stringify(offer.snapshotJson ?? null),
            offer.pdfKey ?? null,
            offer.decision ? JSON.stringify(offer.decision) : null,
          )
          .run();
      }
    },
    upsertInvoice: async (invoice) => {
      await ensureSchema(db);
      await db
        .prepare(
          `
            INSERT INTO portal_documents (
              token_hash, token_value, kind, customer_ref, customer_label, published_at, expires_at, snapshot_json, pdf_key, decision_json
            ) VALUES (?1, ?2, 'invoice', ?3, ?4, ?5, ?6, ?7, ?8, NULL)
            ON CONFLICT(token_hash) DO UPDATE SET
              token_value=excluded.token_value,
              customer_ref=excluded.customer_ref,
              customer_label=excluded.customer_label,
              published_at=excluded.published_at,
              expires_at=excluded.expires_at,
              snapshot_json=excluded.snapshot_json,
              pdf_key=excluded.pdf_key,
              decision_json=NULL
          `,
        )
        .bind(
          invoice.tokenHash,
          invoice.token,
          invoice.customerRef,
          invoice.customerLabel ?? null,
          invoice.publishedAt,
          invoice.expiresAt,
          JSON.stringify(invoice.snapshotJson ?? null),
          invoice.pdfKey ?? null,
        )
        .run();
    },
    getOfferByTokenHash: async (tokenHash) => {
      await ensureSchema(db);
      const res = await db
        .prepare(
          `SELECT token_hash, published_at, expires_at, snapshot_json, pdf_key, decision_json
           FROM offers WHERE token_hash = ?1`,
        )
        .bind(tokenHash)
        .first<{
          token_hash: string;
          published_at: string;
          expires_at: string;
          snapshot_json: string;
          pdf_key: string | null;
          decision_json: string | null;
        }>();

      if (!res) return null;
      return {
        tokenHash: res.token_hash,
        publishedAt: res.published_at,
        expiresAt: res.expires_at,
        snapshotJson: JSON.parse(res.snapshot_json),
        pdfKey: res.pdf_key ?? null,
        decision: res.decision_json ? (JSON.parse(res.decision_json) as DecisionRecord) : null,
      };
    },
    getInvoiceByTokenHash: async (tokenHash) => {
      await ensureSchema(db);
      const res = await db
        .prepare(
          `SELECT token_hash, token_value, published_at, expires_at, snapshot_json, pdf_key, customer_ref, customer_label
           FROM portal_documents WHERE token_hash = ?1 AND kind = 'invoice'`,
        )
        .bind(tokenHash)
        .first<{
          token_hash: string;
          token_value: string;
          published_at: string;
          expires_at: string;
          snapshot_json: string;
          pdf_key: string | null;
          customer_ref: string;
          customer_label: string | null;
        }>();
      if (!res) return null;
      return {
        token: res.token_value,
        tokenHash: res.token_hash,
        publishedAt: res.published_at,
        expiresAt: res.expires_at,
        snapshotJson: JSON.parse(res.snapshot_json),
        pdfKey: res.pdf_key ?? null,
        customerRef: res.customer_ref,
        customerLabel: res.customer_label ?? null,
      };
    },
    setDecisionOnce: async (tokenHash, decision) => {
      await ensureSchema(db);
      const existing = await db
        .prepare('SELECT decision_json FROM offers WHERE token_hash = ?1')
        .bind(tokenHash)
        .first<{ decision_json: string | null }>();
      if (!existing) throw new Error('not found');
      if (existing.decision_json) return JSON.parse(existing.decision_json) as DecisionRecord;

      await db
        .prepare('UPDATE offers SET decision_json = ?1 WHERE token_hash = ?2')
        .bind(JSON.stringify(decision), tokenHash)
        .run();
      await db
        .prepare("UPDATE portal_documents SET decision_json = ?1 WHERE token_hash = ?2 AND kind = 'offer'")
        .bind(JSON.stringify(decision), tokenHash)
        .run();
      return decision;
    },
    createCustomerAccessToken: async (token) => {
      await ensureSchema(db);
      await db
        .prepare(
          `
            INSERT INTO customer_access_tokens (token_hash, customer_ref, customer_label, created_at, expires_at, revoked_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          `,
        )
        .bind(
          token.tokenHash,
          token.customerRef,
          token.customerLabel ?? null,
          token.createdAt,
          token.expiresAt,
          token.revokedAt ?? null,
        )
        .run();
    },
    revokeCustomerAccessTokens: async (customerRef) => {
      await ensureSchema(db);
      await db
        .prepare('UPDATE customer_access_tokens SET revoked_at = ?1 WHERE customer_ref = ?2 AND revoked_at IS NULL')
        .bind(new Date().toISOString(), customerRef)
        .run();
    },
    getCustomerAccessByTokenHash: async (tokenHash) => {
      await ensureSchema(db);
      const res = await db
        .prepare(
          `SELECT token_hash, customer_ref, customer_label, created_at, expires_at, revoked_at
           FROM customer_access_tokens WHERE token_hash = ?1`,
        )
        .bind(tokenHash)
        .first<{
          token_hash: string;
          customer_ref: string;
          customer_label: string | null;
          created_at: string;
          expires_at: string;
          revoked_at: string | null;
        }>();
      if (!res) return null;
      return {
        tokenHash: res.token_hash,
        customerRef: res.customer_ref,
        customerLabel: res.customer_label ?? null,
        createdAt: res.created_at,
        expiresAt: res.expires_at,
        revokedAt: res.revoked_at ?? null,
      } as CustomerAccessTokenRecord;
    },
    listDocumentsByCustomerRef: async ({ customerRef, kind = 'all', limit, cursor }) => {
      await ensureSchema(db);
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const query =
        kind === 'all'
          ? `
              SELECT kind, token_value, published_at, expires_at, customer_ref, customer_label, snapshot_json, pdf_key, decision_json
              FROM portal_documents
              WHERE customer_ref = ?1
                AND (?2 IS NULL OR published_at < ?2)
              ORDER BY published_at DESC, token_hash DESC
              LIMIT ?3
            `
          : `
              SELECT kind, token_value, published_at, expires_at, customer_ref, customer_label, snapshot_json, pdf_key, decision_json
              FROM portal_documents
              WHERE customer_ref = ?1
                AND kind = ?2
                AND (?3 IS NULL OR published_at < ?3)
              ORDER BY published_at DESC, token_hash DESC
              LIMIT ?4
            `;
      const stmt = db.prepare(query);
      const res =
        kind === 'all'
          ? await stmt
              .bind(customerRef, cursor ?? null, safeLimit)
              .all<{
                kind: string;
                token_value: string;
                published_at: string;
                expires_at: string;
                customer_ref: string;
                customer_label: string | null;
                snapshot_json: string;
                pdf_key: string | null;
                decision_json: string | null;
              }>()
          : await stmt
              .bind(customerRef, kind, cursor ?? null, safeLimit)
              .all<{
                kind: string;
                token_value: string;
                published_at: string;
                expires_at: string;
                customer_ref: string;
                customer_label: string | null;
                snapshot_json: string;
                pdf_key: string | null;
                decision_json: string | null;
              }>();
      const items = (res.results ?? []).map(mapPortalDocRow);
      const nextCursor = items.length === safeLimit ? items[items.length - 1]!.publishedAt : null;
      return { items, nextCursor };
    },
  };
};

export const createWorkerR2PdfStore = (bucket: R2Bucket): PdfStore => {
  return {
    putPdf: async (pdfKey, bytes) => {
      await bucket.put(pdfKey, bytes, { httpMetadata: { contentType: 'application/pdf' } });
    },
    getPdf: async (pdfKey) => {
      const obj = await bucket.get(pdfKey);
      if (!obj) return null;
      const arr = await obj.arrayBuffer();
      return new Uint8Array(arr);
    },
  };
};
