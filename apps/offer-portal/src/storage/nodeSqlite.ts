import Database from 'better-sqlite3';
import type {
  CustomerAccessTokenRecord,
  DecisionRecord,
  OfferStore,
  PortalDocumentKind,
  PortalDocumentListItem,
} from './types';

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
    kind TEXT NOT NULL CHECK(kind IN ('offer', 'invoice')),
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

export const createNodeSqliteOfferStore = (dbPath: string): OfferStore => {
  const db = new Database(dbPath);
  db.exec(bootstrapSql);

  return {
    upsertOffer: async (offer) => {
      db.prepare(
        `
          INSERT INTO offers (token_hash, published_at, expires_at, snapshot_json, pdf_key, decision_json)
          VALUES (@tokenHash, @publishedAt, @expiresAt, @snapshotJson, @pdfKey, @decisionJson)
          ON CONFLICT(token_hash) DO UPDATE SET
            published_at=excluded.published_at,
            expires_at=excluded.expires_at,
            snapshot_json=excluded.snapshot_json,
            pdf_key=excluded.pdf_key,
            decision_json=excluded.decision_json
        `,
      ).run({
        tokenHash: offer.tokenHash,
        publishedAt: offer.publishedAt,
        expiresAt: offer.expiresAt,
        snapshotJson: JSON.stringify(offer.snapshotJson ?? null),
        pdfKey: offer.pdfKey ?? null,
        decisionJson: offer.decision ? JSON.stringify(offer.decision) : null,
      });
      if (offer.token) {
        const customerRef = offer.customerRef ?? `anon:${offer.tokenHash.slice(0, 16)}`;
        db.prepare(
          `
            INSERT INTO portal_documents (
              token_hash, token_value, kind, customer_ref, customer_label, published_at, expires_at, snapshot_json, pdf_key, decision_json
            ) VALUES (
              @tokenHash, @tokenValue, 'offer', @customerRef, @customerLabel, @publishedAt, @expiresAt, @snapshotJson, @pdfKey, @decisionJson
            )
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
        ).run({
          tokenHash: offer.tokenHash,
          tokenValue: offer.token,
          customerRef,
          customerLabel: offer.customerLabel ?? null,
          publishedAt: offer.publishedAt,
          expiresAt: offer.expiresAt,
          snapshotJson: JSON.stringify(offer.snapshotJson ?? null),
          pdfKey: offer.pdfKey ?? null,
          decisionJson: offer.decision ? JSON.stringify(offer.decision) : null,
        });
      }
    },
    upsertInvoice: async (invoice) => {
      db.prepare(
        `
          INSERT INTO portal_documents (
            token_hash, token_value, kind, customer_ref, customer_label, published_at, expires_at, snapshot_json, pdf_key, decision_json
          ) VALUES (
            @tokenHash, @tokenValue, 'invoice', @customerRef, @customerLabel, @publishedAt, @expiresAt, @snapshotJson, @pdfKey, NULL
          )
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
      ).run({
        tokenHash: invoice.tokenHash,
        tokenValue: invoice.token,
        customerRef: invoice.customerRef,
        customerLabel: invoice.customerLabel ?? null,
        publishedAt: invoice.publishedAt,
        expiresAt: invoice.expiresAt,
        snapshotJson: JSON.stringify(invoice.snapshotJson ?? null),
        pdfKey: invoice.pdfKey ?? null,
      });
    },
    getOfferByTokenHash: async (tokenHash) => {
      const row = db
        .prepare(
          `SELECT token_hash, published_at, expires_at, snapshot_json, pdf_key, decision_json
           FROM offers WHERE token_hash = ?`,
        )
        .get(tokenHash) as
        | {
            token_hash: string;
            published_at: string;
            expires_at: string;
            snapshot_json: string;
            pdf_key: string | null;
            decision_json: string | null;
          }
        | undefined;

      if (!row) return null;
      return {
        tokenHash: row.token_hash,
        publishedAt: row.published_at,
        expiresAt: row.expires_at,
        snapshotJson: JSON.parse(row.snapshot_json),
        pdfKey: row.pdf_key ?? null,
        decision: row.decision_json ? (JSON.parse(row.decision_json) as DecisionRecord) : null,
      };
    },
    getInvoiceByTokenHash: async (tokenHash) => {
      const row = db
        .prepare(
          `SELECT token_hash, token_value, published_at, expires_at, snapshot_json, pdf_key, customer_ref, customer_label
           FROM portal_documents WHERE token_hash = ? AND kind = 'invoice'`,
        )
        .get(tokenHash) as
        | {
            token_hash: string;
            token_value: string;
            published_at: string;
            expires_at: string;
            snapshot_json: string;
            pdf_key: string | null;
            customer_ref: string;
            customer_label: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        token: row.token_value,
        tokenHash: row.token_hash,
        publishedAt: row.published_at,
        expiresAt: row.expires_at,
        snapshotJson: JSON.parse(row.snapshot_json),
        pdfKey: row.pdf_key ?? null,
        customerRef: row.customer_ref,
        customerLabel: row.customer_label ?? null,
      };
    },
    setDecisionOnce: async (tokenHash, decision) => {
      const row = db.prepare('SELECT decision_json FROM offers WHERE token_hash = ?').get(tokenHash) as
        | { decision_json: string | null }
        | undefined;
      if (!row) throw new Error('not found');
      if (row.decision_json) return JSON.parse(row.decision_json) as DecisionRecord;

      db.prepare('UPDATE offers SET decision_json = ? WHERE token_hash = ?').run(
        JSON.stringify(decision),
        tokenHash,
      );
      db.prepare(
        "UPDATE portal_documents SET decision_json = ? WHERE token_hash = ? AND kind = 'offer'",
      ).run(JSON.stringify(decision), tokenHash);
      return decision;
    },
    createCustomerAccessToken: async (token) => {
      db.prepare(
        `
          INSERT INTO customer_access_tokens (
            token_hash, customer_ref, customer_label, created_at, expires_at, revoked_at
          ) VALUES (
            @tokenHash, @customerRef, @customerLabel, @createdAt, @expiresAt, @revokedAt
          )
        `,
      ).run({
        tokenHash: token.tokenHash,
        customerRef: token.customerRef,
        customerLabel: token.customerLabel ?? null,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt ?? null,
      });
    },
    revokeCustomerAccessTokens: async (customerRef) => {
      db.prepare(
        "UPDATE customer_access_tokens SET revoked_at = ? WHERE customer_ref = ? AND revoked_at IS NULL",
      ).run(new Date().toISOString(), customerRef);
    },
    getCustomerAccessByTokenHash: async (tokenHash) => {
      const row = db
        .prepare(
          `SELECT token_hash, customer_ref, customer_label, created_at, expires_at, revoked_at
           FROM customer_access_tokens WHERE token_hash = ?`,
        )
        .get(tokenHash) as
        | {
            token_hash: string;
            customer_ref: string;
            customer_label: string | null;
            created_at: string;
            expires_at: string;
            revoked_at: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        tokenHash: row.token_hash,
        customerRef: row.customer_ref,
        customerLabel: row.customer_label ?? null,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at ?? null,
      } as CustomerAccessTokenRecord;
    },
    listDocumentsByCustomerRef: async ({ customerRef, kind = 'all', limit, cursor }) => {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const query =
        kind === 'all'
          ? `
            SELECT kind, token_value, published_at, expires_at, customer_ref, customer_label, snapshot_json, pdf_key, decision_json
            FROM portal_documents
            WHERE customer_ref = @customerRef
              AND (@cursor IS NULL OR published_at < @cursor)
            ORDER BY published_at DESC, token_hash DESC
            LIMIT @limit
          `
          : `
            SELECT kind, token_value, published_at, expires_at, customer_ref, customer_label, snapshot_json, pdf_key, decision_json
            FROM portal_documents
            WHERE customer_ref = @customerRef
              AND kind = @kind
              AND (@cursor IS NULL OR published_at < @cursor)
            ORDER BY published_at DESC, token_hash DESC
            LIMIT @limit
          `;
      const rows = db.prepare(query).all({
        customerRef,
        kind,
        cursor: cursor ?? null,
        limit: safeLimit,
      }) as Array<{
        kind: string;
        token_value: string;
        published_at: string;
        expires_at: string;
        customer_ref: string;
        customer_label: string | null;
        snapshot_json: string;
        pdf_key: string | null;
        decision_json: string | null;
      }>;
      const items = rows.map(mapPortalDocRow);
      const nextCursor = items.length === safeLimit ? items[items.length - 1]!.publishedAt : null;
      return { items, nextCursor };
    },
  };
};
