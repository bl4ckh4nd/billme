import type Database from "better-sqlite3";

/**
 * Compatibility bridge for databases released before the portal moved to Drizzle.
 * Keep all schema bootstrap SQL here; application reads/writes use schema.ts.
 */
export const ensurePortalSchema = (db: Database.Database): void => {
  db.exec(`
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
  `);
  // Released builds did not always persist document ids. Backfill deterministically.
  db.prepare(
    "UPDATE portal_documents SET token_value = 'd' || substr(token_hash, 1, 31) WHERE token_value IS NULL OR token_value = ''",
  ).run();
};
