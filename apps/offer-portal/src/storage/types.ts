export type DecisionRecord = {
  decidedAt: string;
  decision: 'accepted' | 'declined';
  acceptedName: string;
  acceptedEmail: string;
  decisionTextVersion: string;
};

export type PortalDocumentKind = 'offer' | 'invoice';

export type OfferRecord = {
  tokenHash: string;
  documentId?: string;
  publishedAt: string;
  expiresAt: string;
  snapshotJson: unknown;
  customerRef?: string;
  customerLabel?: string | null;
  pdfKey?: string | null;
  decision?: DecisionRecord | null;
};

export type InvoiceRecord = {
  tokenHash: string;
  documentId?: string;
  publishedAt: string;
  expiresAt: string;
  snapshotJson: unknown;
  customerRef: string;
  customerLabel?: string | null;
  pdfKey?: string | null;
};

export type CustomerAccessTokenRecord = {
  tokenHash: string;
  customerRef: string;
  customerLabel?: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
};

export type PortalDocumentListItem = {
  documentId: string;
  kind: PortalDocumentKind;
  tokenHash: string;
  publishedAt: string;
  expiresAt: string;
  customerRef: string;
  customerLabel?: string | null;
  snapshotJson: unknown;
  pdfKey?: string | null;
  decision?: DecisionRecord | null;
};

export interface OfferStore {
  upsertOffer: (offer: OfferRecord) => Promise<void>;
  upsertInvoice: (invoice: InvoiceRecord) => Promise<void>;
  getOfferByTokenHash: (tokenHash: string) => Promise<OfferRecord | null>;
  getInvoiceByTokenHash: (tokenHash: string) => Promise<InvoiceRecord | null>;
  getDocumentById: (documentId: string) => Promise<PortalDocumentListItem | null>;
  getDocumentByTokenHash: (tokenHash: string) => Promise<PortalDocumentListItem | null>;
  setDecisionOnce: (tokenHash: string, decision: DecisionRecord) => Promise<DecisionRecord>;
  setDecisionOnceByDocumentId: (documentId: string, decision: DecisionRecord) => Promise<DecisionRecord>;
  createCustomerAccessToken: (token: CustomerAccessTokenRecord) => Promise<void>;
  revokeCustomerAccessTokens: (customerRef: string) => Promise<void>;
  getCustomerAccessByTokenHash: (tokenHash: string) => Promise<CustomerAccessTokenRecord | null>;
  listDocumentsByCustomerRef: (params: {
    customerRef: string;
    kind?: PortalDocumentKind | 'all';
    limit: number;
    cursor?: string;
  }) => Promise<{ items: PortalDocumentListItem[]; nextCursor: string | null }>;
}

export interface PdfStore {
  putPdf: (pdfKey: string, bytes: Uint8Array) => Promise<void>;
  getPdf: (pdfKey: string) => Promise<Uint8Array | null>;
}
