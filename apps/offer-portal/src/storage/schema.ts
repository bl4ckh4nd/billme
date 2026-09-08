import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const offers = sqliteTable("offers", {
  tokenHash: text("token_hash").primaryKey(),
  publishedAt: text("published_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  pdfKey: text("pdf_key"),
  decisionJson: text("decision_json"),
});

export const portalDocuments = sqliteTable(
  "portal_documents",
  {
    tokenHash: text("token_hash").primaryKey(),
    tokenValue: text("token_value").notNull(),
    kind: text("kind").notNull(),
    customerRef: text("customer_ref").notNull(),
    customerLabel: text("customer_label"),
    publishedAt: text("published_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    pdfKey: text("pdf_key"),
    decisionJson: text("decision_json"),
  },
  (table) => ({
    tokenValueUnique: uniqueIndex("portal_documents_token_value_unique").on(
      table.tokenValue,
    ),
    customerPublished: index("idx_portal_docs_customer_ref_pub").on(
      table.customerRef,
      table.publishedAt,
    ),
  }),
);

export const customerAccessTokens = sqliteTable(
  "customer_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    customerRef: text("customer_ref").notNull(),
    customerLabel: text("customer_label"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => ({
    customerRefIndex: index("idx_customer_tokens_customer_ref").on(
      table.customerRef,
    ),
  }),
);
