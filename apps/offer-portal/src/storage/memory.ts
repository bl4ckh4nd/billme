import type {
  OfferRecord,
  OfferStore,
  DecisionRecord,
  PdfStore,
  CustomerAccessTokenRecord,
  PortalDocumentListItem,
  InvoiceRecord,
} from './types';

export const createMemoryOfferStore = (): OfferStore => {
  const offersByTokenHash = new Map<string, OfferRecord>();
  const invoicesByTokenHash = new Map<string, InvoiceRecord>();
  const customerAccessByTokenHash = new Map<string, CustomerAccessTokenRecord>();
  const portalDocumentsByTokenHash = new Map<string, PortalDocumentListItem>();
  const tokenHashByDocumentId = new Map<string, string>();

  const generateDocumentId = () => {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID().replace(/-/g, '');
    }
    return `d${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  };
  const setDecisionInternal = (tokenHash: string, decision: DecisionRecord): DecisionRecord => {
    const rec = offersByTokenHash.get(tokenHash);
    if (!rec) throw new Error('not found');
    if (rec.decision) return structuredClone(rec.decision) as DecisionRecord;
    rec.decision = structuredClone(decision);
    offersByTokenHash.set(tokenHash, rec);
    const doc = portalDocumentsByTokenHash.get(tokenHash);
    if (doc?.kind === 'offer') {
      doc.decision = structuredClone(decision);
      portalDocumentsByTokenHash.set(tokenHash, doc);
    }
    return structuredClone(decision);
  };
  const resolveDocumentId = (tokenHash: string, explicitDocumentId?: string): string => {
    if (explicitDocumentId) return explicitDocumentId;
    const existing = portalDocumentsByTokenHash.get(tokenHash);
    if (existing?.documentId) return existing.documentId;
    return generateDocumentId();
  };
  const updateDocumentIndex = (tokenHash: string, nextDocumentId: string): void => {
    const previous = portalDocumentsByTokenHash.get(tokenHash);
    if (previous?.documentId && previous.documentId !== nextDocumentId) {
      tokenHashByDocumentId.delete(previous.documentId);
    }
    tokenHashByDocumentId.set(nextDocumentId, tokenHash);
  };

  return {
    upsertOffer: async (offer) => {
      const documentId = resolveDocumentId(offer.tokenHash, offer.documentId);
      offersByTokenHash.set(offer.tokenHash, structuredClone(offer));
      const customerRef = offer.customerRef ?? `anon:${offer.tokenHash.slice(0, 16)}`;
      portalDocumentsByTokenHash.set(offer.tokenHash, {
        documentId,
        tokenHash: offer.tokenHash,
        kind: 'offer',
        publishedAt: offer.publishedAt,
        expiresAt: offer.expiresAt,
        customerRef,
        customerLabel: offer.customerLabel ?? null,
        snapshotJson: offer.snapshotJson,
        pdfKey: offer.pdfKey ?? null,
        decision: offer.decision ?? null,
      });
      updateDocumentIndex(offer.tokenHash, documentId);
    },
    upsertInvoice: async (invoice) => {
      const documentId = resolveDocumentId(invoice.tokenHash, invoice.documentId);
      invoicesByTokenHash.set(invoice.tokenHash, structuredClone(invoice));
      portalDocumentsByTokenHash.set(invoice.tokenHash, {
        documentId,
        tokenHash: invoice.tokenHash,
        kind: 'invoice',
        publishedAt: invoice.publishedAt,
        expiresAt: invoice.expiresAt,
        customerRef: invoice.customerRef,
        customerLabel: invoice.customerLabel ?? null,
        snapshotJson: invoice.snapshotJson,
        pdfKey: invoice.pdfKey ?? null,
        decision: null,
      });
      updateDocumentIndex(invoice.tokenHash, documentId);
    },
    getOfferByTokenHash: async (tokenHash) => {
      const rec = offersByTokenHash.get(tokenHash);
      return rec ? structuredClone(rec) : null;
    },
    getInvoiceByTokenHash: async (tokenHash) => {
      const rec = invoicesByTokenHash.get(tokenHash);
      return rec ? structuredClone(rec) : null;
    },
    getDocumentById: async (documentId) => {
      const tokenHash = tokenHashByDocumentId.get(documentId);
      if (!tokenHash) return null;
      const rec = portalDocumentsByTokenHash.get(tokenHash);
      if (!rec || rec.documentId !== documentId) return null;
      return rec ? structuredClone(rec) : null;
    },
    getDocumentByTokenHash: async (tokenHash) => {
      const rec = portalDocumentsByTokenHash.get(tokenHash);
      return rec ? structuredClone(rec) : null;
    },
    setDecisionOnce: async (tokenHash, decision) => {
      return setDecisionInternal(tokenHash, decision);
    },
    setDecisionOnceByDocumentId: async (documentId, decision) => {
      const tokenHash = tokenHashByDocumentId.get(documentId);
      if (!tokenHash) throw new Error('not found');
      return setDecisionInternal(tokenHash, decision);
    },
    createCustomerAccessToken: async (token) => {
      customerAccessByTokenHash.set(token.tokenHash, structuredClone(token));
    },
    revokeCustomerAccessTokens: async (customerRef) => {
      const now = new Date().toISOString();
      for (const entry of customerAccessByTokenHash.values()) {
        if (entry.customerRef !== customerRef || entry.revokedAt) continue;
        entry.revokedAt = now;
      }
    },
    getCustomerAccessByTokenHash: async (tokenHash) => {
      const rec = customerAccessByTokenHash.get(tokenHash);
      return rec ? structuredClone(rec) : null;
    },
    listDocumentsByCustomerRef: async ({ customerRef, kind = 'all', limit, cursor }) => {
      const items = [...portalDocumentsByTokenHash.values()]
        .filter((d) => d.customerRef === customerRef)
        .filter((d) => kind === 'all' || d.kind === kind)
        .filter((d) => (cursor ? d.publishedAt < cursor : true))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, Math.max(1, limit));
      const nextCursor = items.length === Math.max(1, limit) ? items[items.length - 1]!.publishedAt : null;
      return { items: structuredClone(items), nextCursor };
    },
  };
};

export const createMemoryPdfStore = (): PdfStore => {
  const pdfByKey = new Map<string, Uint8Array>();
  return {
    putPdf: async (pdfKey, bytes) => {
      pdfByKey.set(pdfKey, bytes);
    },
    getPdf: async (pdfKey) => {
      return pdfByKey.get(pdfKey) ?? null;
    },
  };
};
