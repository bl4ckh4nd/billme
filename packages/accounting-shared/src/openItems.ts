/** Shared Pro document-accounting (OPOS) contracts.  Amounts are EUR values rounded to cents. */
export type VatAccountingMethod = 'soll' | 'ist';
export type OpenItemPartyType = 'debtor' | 'creditor';
export type OpenItemStatus = 'open' | 'partially_paid' | 'paid' | 'overpaid' | 'unresolved';
export type AccountingDocumentSource = 'outgoing_invoice' | 'incoming_invoice' | 'legacy_transaction';

/** Caller supplied audit context for a server-side accounting mutation. */
export interface AccountingMutationContext {
  reason: string;
  actor?: {
    type: 'system' | 'user' | 'service';
    id?: string;
    displayName?: string;
  };
}

export interface VendorEntity {
  id: string;
  tenantId: string;
  vendorNumber?: string;
  name: string;
  email?: string;
  address?: string;
  vatId?: string;
  iban?: string;
  defaultExpenseAccount?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IncomingInvoiceLineEntity {
  id: string;
  incomingInvoiceId: string;
  position: number;
  description: string;
  quantity: number;
  unitPrice: number;
  netAmount: number;
  taxRate: number;
  taxAmount: number;
  grossAmount: number;
  accountNumber?: string;
  assetAccountNumber?: string;
}

export interface IncomingInvoiceEntity {
  id: string;
  tenantId: string;
  vendorId: string;
  number: string;
  invoiceDate: string;
  dueDate: string;
  servicePeriod?: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  status: 'draft' | 'open' | 'paid' | 'cancelled' | 'unresolved';
  taxRate: number;
  taxCaseKey?: string;
  notes?: string;
  lines: IncomingInvoiceLineEntity[];
  accountingStatus: 'unposted' | 'posted' | 'unresolved' | 'reversed';
  accountingSnapshot?: AccountingSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface AccountingSnapshot {
  sourceType: AccountingDocumentSource;
  sourceId: string;
  sourceVersion: string;
  chart: 'SKR03' | 'SKR04';
  vatMethod: VatAccountingMethod;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  lines: Array<{
    accountNumber: string;
    debitAmount: number;
    creditAmount: number;
    taxCaseKey?: string;
    netAmount?: number;
    taxRate?: number;
    taxAmount?: number;
    grossAmount?: number;
    datevSachverhaltLl?: string;
    countryCode?: string;
    counterpartyVatId?: string;
    evidenceType?: string;
    evidenceReference?: string;
    memo?: string;
  }>;
  capturedAt: string;
}

export interface OpenItemEntity {
  id: string;
  tenantId: string;
  partyType: OpenItemPartyType;
  partyId: string;
  sourceType: AccountingDocumentSource;
  sourceId: string;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  originalAmount: number;
  allocatedAmount: number;
  residualAmount: number;
  status: OpenItemStatus;
  journalEntryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenItemPaymentEntity {
  id: string;
  tenantId: string;
  partyType: OpenItemPartyType;
  partyId?: string;
  paymentDate: string;
  amount: number;
  bankAccountNumber: string;
  method?: string;
  sourceType: 'bank_transaction' | 'invoice_payment' | 'manual';
  sourceId: string;
  allocatedAmount: number;
  residualAmount: number;
  status: 'open' | 'partially_allocated' | 'overpaid' | 'allocated';
  journalEntryId?: string;
  createdAt: string;
}

export interface OpenItemPaymentInput {
  paymentId?: string;
  partyType: OpenItemPartyType;
  partyId?: string;
  paymentDate: string;
  amount: number;
  bankAccountNumber: string;
  method?: string;
  sourceType: 'bank_transaction' | 'invoice_payment' | 'manual';
  sourceId: string;
  allocations: Array<{ openItemId: string; amount: number }>;
  mutation?: AccountingMutationContext;
  /** Required UI audit reason for this allocation event. */
  reason: string;
  /** Stable retry key for one allocation event (not the payment id). */
  allocationEventId: string;
}

export interface OpenItemAllocationEntity {
  id: string;
  tenantId: string;
  paymentId: string;
  openItemId: string;
  amount: number;
  createdAt: string;
}

export interface AccountingAccountMapping {
  id: string;
  tenantId: string;
  chart: 'SKR03' | 'SKR04';
  role: 'accounts_receivable' | 'accounts_payable' | 'bank' | 'revenue' | 'expense' | 'asset' | 'output_vat' | 'output_vat_deferred' | 'input_vat';
  accountNumber: string;
  updatedAt: string;
}

export interface AccountingPostingPreview {
  sourceType: AccountingDocumentSource;
  sourceId: string;
  status: 'ready' | 'unresolved';
  reason?: string;
  snapshot?: AccountingSnapshot;
  issues: Array<{ code: string; message: string; blocking: boolean }>;
}

export interface AccountingBackfillPreview {
  runId: string;
  status: 'preview' | 'confirmed' | 'completed';
  candidates: Array<{
    sourceType: AccountingDocumentSource;
    sourceId: string;
    status: 'ready' | 'unresolved';
    reason?: string;
    sourceVersion: string;
    snapshot?: unknown;
  }>;
  readyCount: number;
  unresolvedCount: number;
  confirmationHash: string;
}

export interface AccountingBackfillConfirmation {
  runId: string;
  confirmationHash: string;
  reason: string;
  mutation?: AccountingMutationContext;
}

export interface AccountingBackfillResult {
  runId: string;
  postedCount: number;
  unresolvedCount: number;
  status: 'completed';
}
