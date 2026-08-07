import Database from "better-sqlite3";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type {
  CustomerAccessTokenRecord,
  DecisionRecord,
  OfferStore,
  PortalDocumentKind,
  PortalDocumentListItem,
} from "./types";
import { ensurePortalSchema } from "./legacySqliteBridge";
import * as schema from "./schema";

const documentIdFromTokenHash = (tokenHash: string): string =>
  `d${tokenHash.slice(0, 31)}`;
const parseDecision = (value: string | null): DecisionRecord | null =>
  value ? (JSON.parse(value) as DecisionRecord) : null;
const mapPortalDocRow = (
  row: typeof schema.portalDocuments.$inferSelect,
): PortalDocumentListItem => ({
  documentId: row.tokenValue,
  tokenHash: row.tokenHash,
  kind: row.kind as PortalDocumentKind,
  publishedAt: row.publishedAt,
  expiresAt: row.expiresAt,
  customerRef: row.customerRef,
  customerLabel: row.customerLabel ?? null,
  snapshotJson: JSON.parse(row.snapshotJson),
  pdfKey: row.pdfKey ?? null,
  decision: parseDecision(row.decisionJson),
});

export const createNodeSqliteOfferStore = (dbPath: string): OfferStore => {
  const rawDb = new Database(dbPath);
  rawDb.pragma("foreign_keys = ON");
  ensurePortalSchema(rawDb);
  const db = drizzle(rawDb, { schema });

  const findDocument = (tokenHash: string) =>
    db
      .select()
      .from(schema.portalDocuments)
      .where(eq(schema.portalDocuments.tokenHash, tokenHash))
      .get();
  const findOffer = (tokenHash: string) =>
    db
      .select()
      .from(schema.offers)
      .where(eq(schema.offers.tokenHash, tokenHash))
      .get();
  const setDecision = (
    tokenHash: string,
    decision: DecisionRecord,
  ): DecisionRecord => {
    const existing = findOffer(tokenHash);
    if (!existing) throw new Error("not found");
    if (existing.decisionJson)
      return JSON.parse(existing.decisionJson) as DecisionRecord;
    const decisionJson = JSON.stringify(decision);
    db.update(schema.offers)
      .set({ decisionJson })
      .where(eq(schema.offers.tokenHash, tokenHash))
      .run();
    db.update(schema.portalDocuments)
      .set({ decisionJson })
      .where(
        and(
          eq(schema.portalDocuments.tokenHash, tokenHash),
          eq(schema.portalDocuments.kind, "offer"),
        ),
      )
      .run();
    return decision;
  };

  return {
    async upsertOffer(offer) {
      const documentId =
        offer.documentId ?? documentIdFromTokenHash(offer.tokenHash);
      const values = {
        tokenHash: offer.tokenHash,
        publishedAt: offer.publishedAt,
        expiresAt: offer.expiresAt,
        snapshotJson: JSON.stringify(offer.snapshotJson ?? null),
        pdfKey: offer.pdfKey ?? null,
        decisionJson: offer.decision ? JSON.stringify(offer.decision) : null,
      };
      db.insert(schema.offers)
        .values(values)
        .onConflictDoUpdate({ target: schema.offers.tokenHash, set: values })
        .run();
      const docValues = {
        tokenHash: offer.tokenHash,
        tokenValue: documentId,
        kind: "offer",
        customerRef:
          offer.customerRef ?? `anon:${offer.tokenHash.slice(0, 16)}`,
        customerLabel: offer.customerLabel ?? null,
        publishedAt: offer.publishedAt,
        expiresAt: offer.expiresAt,
        snapshotJson: JSON.stringify(offer.snapshotJson ?? null),
        pdfKey: offer.pdfKey ?? null,
        decisionJson: offer.decision ? JSON.stringify(offer.decision) : null,
      } as const;
      db.insert(schema.portalDocuments)
        .values(docValues)
        .onConflictDoUpdate({
          target: schema.portalDocuments.tokenHash,
          set: { ...docValues, tokenHash: undefined },
        })
        .run();
    },
    async upsertInvoice(invoice) {
      const documentId =
        invoice.documentId ?? documentIdFromTokenHash(invoice.tokenHash);
      const values = {
        tokenHash: invoice.tokenHash,
        tokenValue: documentId,
        kind: "invoice",
        customerRef: invoice.customerRef,
        customerLabel: invoice.customerLabel ?? null,
        publishedAt: invoice.publishedAt,
        expiresAt: invoice.expiresAt,
        snapshotJson: JSON.stringify(invoice.snapshotJson ?? null),
        pdfKey: invoice.pdfKey ?? null,
        decisionJson: null,
      } as const;
      db.insert(schema.portalDocuments)
        .values(values)
        .onConflictDoUpdate({
          target: schema.portalDocuments.tokenHash,
          set: { ...values, tokenHash: undefined },
        })
        .run();
    },
    async getOfferByTokenHash(tokenHash) {
      const offer = findOffer(tokenHash);
      if (!offer) return null;
      const doc = findDocument(tokenHash);
      return {
        tokenHash: offer.tokenHash,
        documentId: doc?.tokenValue ?? documentIdFromTokenHash(tokenHash),
        publishedAt: offer.publishedAt,
        expiresAt: offer.expiresAt,
        snapshotJson: JSON.parse(offer.snapshotJson),
        pdfKey: offer.pdfKey ?? null,
        customerRef: doc?.customerRef,
        customerLabel: doc?.customerLabel ?? null,
        decision: parseDecision(offer.decisionJson),
      };
    },
    async getInvoiceByTokenHash(tokenHash) {
      const doc = db
        .select()
        .from(schema.portalDocuments)
        .where(
          and(
            eq(schema.portalDocuments.tokenHash, tokenHash),
            eq(schema.portalDocuments.kind, "invoice"),
          ),
        )
        .get();
      if (!doc) return null;
      return {
        tokenHash: doc.tokenHash,
        documentId: doc.tokenValue,
        publishedAt: doc.publishedAt,
        expiresAt: doc.expiresAt,
        snapshotJson: JSON.parse(doc.snapshotJson),
        pdfKey: doc.pdfKey ?? null,
        customerRef: doc.customerRef,
        customerLabel: doc.customerLabel ?? null,
      };
    },
    async getDocumentById(documentId) {
      const row = db
        .select()
        .from(schema.portalDocuments)
        .where(eq(schema.portalDocuments.tokenValue, documentId))
        .get();
      return row ? mapPortalDocRow(row) : null;
    },
    async getDocumentByTokenHash(tokenHash) {
      const row = findDocument(tokenHash);
      return row ? mapPortalDocRow(row) : null;
    },
    async setDecisionOnce(tokenHash, decision) {
      return setDecision(tokenHash, decision);
    },
    async setDecisionOnceByDocumentId(documentId, decision) {
      const row = db
        .select({ tokenHash: schema.portalDocuments.tokenHash })
        .from(schema.portalDocuments)
        .where(
          and(
            eq(schema.portalDocuments.tokenValue, documentId),
            eq(schema.portalDocuments.kind, "offer"),
          ),
        )
        .get();
      if (!row) throw new Error("not found");
      return setDecision(row.tokenHash, decision);
    },
    async createCustomerAccessToken(token: CustomerAccessTokenRecord) {
      const values = {
        tokenHash: token.tokenHash,
        customerRef: token.customerRef,
        customerLabel: token.customerLabel ?? null,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt ?? null,
      };
      db.insert(schema.customerAccessTokens)
        .values(values)
        .onConflictDoUpdate({
          target: schema.customerAccessTokens.tokenHash,
          set: values,
        })
        .run();
    },
    async revokeCustomerAccessTokens(customerRef) {
      db.update(schema.customerAccessTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(schema.customerAccessTokens.customerRef, customerRef),
            isNull(schema.customerAccessTokens.revokedAt),
          ),
        )
        .run();
    },
    async getCustomerAccessByTokenHash(tokenHash) {
      const row = db
        .select()
        .from(schema.customerAccessTokens)
        .where(eq(schema.customerAccessTokens.tokenHash, tokenHash))
        .get();
      return row
        ? {
            tokenHash: row.tokenHash,
            customerRef: row.customerRef,
            customerLabel: row.customerLabel ?? null,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt ?? null,
          }
        : null;
    },
    async listDocumentsByCustomerRef({
      customerRef,
      kind = "all",
      limit,
      cursor,
    }) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const predicates = [eq(schema.portalDocuments.customerRef, customerRef)];
      if (kind !== "all")
        predicates.push(eq(schema.portalDocuments.kind, kind));
      if (cursor)
        predicates.push(lt(schema.portalDocuments.publishedAt, cursor));
      const rows = db
        .select()
        .from(schema.portalDocuments)
        .where(and(...predicates))
        .orderBy(
          desc(schema.portalDocuments.publishedAt),
          desc(schema.portalDocuments.tokenHash),
        )
        .limit(safeLimit)
        .all();
      const items = rows.map(mapPortalDocRow);
      return {
        items,
        nextCursor:
          items.length === safeLimit
            ? items[items.length - 1]!.publishedAt
            : null,
      };
    },
  };
};
