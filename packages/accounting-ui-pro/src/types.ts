export type LegacyTransactionStatus = 'ungebucht' | 'gebucht' | 'fehlerhaft';

export type BookingWorkflowStatus =
  | 'imported'
  | 'suggested'
  | 'incomplete'
  | 'ready_for_review'
  | 'pending_approval'
  | 'approved'
  | 'posted'
  | 'reversed'
  | 'corrected'
  | 'period_locked'
  | 'integration_error';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationCode =
  | 'MISSING_ACCOUNT'
  | 'MISSING_TAX_CODE'
  | 'MISSING_TAX_CASE'
  | 'UNBALANCED_ENTRY'
  | 'MISSING_RECEIPT'
  | 'POSTING_DATE_IN_CLOSED_PERIOD'
  | 'MISSING_POSTING_DATE'
  | 'INVALID_AMOUNT_FORMAT'
  | 'TAX_ACCOUNT_MISMATCH'
  | 'UNKNOWN_TAX_CASE'
  | 'MISSING_COUNTERPARTY_VAT_ID'
  | 'MISSING_COUNTRY_CODE'
  | 'MISSING_TAX_EVIDENCE'
  | 'MISSING_REVERSE_CHARGE_MAPPING'
  | 'MISSING_DATEV_BU_KEY'
  | 'DUPLICATE_SUSPECTED'
  | 'MANUAL_TAX_OVERRIDE'
  | 'MISSING_BOOKING_TEXT';

export interface ValidationIssue {
  id: string;
  code: ValidationCode;
  severity: ValidationSeverity;
  message: string;
  fieldPath?: string;
  blocking: boolean;
  source: 'system' | 'user' | 'rule';
}

export type BookingAction =
  | 'save_draft'
  | 'submit_for_review'
  | 'approve'
  | 'reject'
  | 'post'
  | 'reverse'
  | 'create_correction'
  | 'request_receipt';

export interface ActivityEvent {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  type:
    | 'state_changed'
    | 'field_changed'
    | 'validation_acknowledged'
    | 'comment_added'
    | 'booking_posted'
    | 'booking_reversed';
  label: string;
  details?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

// Includes the server-mode roles so the shared workspace can render the
// authenticated Web Pro session without pretending every user is an admin.
export type UserRole = 'bookkeeper' | 'reviewer' | 'accountant' | 'admin' | 'auditor' | 'owner' | 'sales' | 'viewer';
export type AccountingActorRole = Exclude<UserRole, 'owner' | 'sales' | 'viewer'>;

export const toAccountingActorRole = (role: UserRole): AccountingActorRole => {
  if (role === 'owner') return 'admin';
  if (role === 'sales' || role === 'viewer') return 'bookkeeper';
  return role;
};

export interface UiPermissionContext {
  role: UserRole;
  canMutate: boolean;
  canApprove: boolean;
  canPost: boolean;
  canReverse: boolean;
}

export interface IssueCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export type ExceptionState = 'open' | 'snoozed' | 'resolved';

export interface ExceptionCase {
  state: ExceptionState;
  owner?: string;
  snoozedUntil?: string;
  resolutionNote?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export type TransactionFlag =
  | 'missing_receipt'
  | 'duplicate_suspected'
  | 'tax_unclear'
  | 'period_locked';

export interface Transaction {
  id: string;
  date: string;
  payee: string;
  description: string;
  amount: number;
  currency: string;
  status?: LegacyTransactionStatus;
  workflowStatus: BookingWorkflowStatus;
  suggestion?: string;
  suggestionConfidence?: number;
  hasReceipt: boolean;
  issueCounts: IssueCounts;
  flags: TransactionFlag[];
  bookingDraftId: string;
  owner?: string;
  exceptionCase?: ExceptionCase;
  isVirtualPosted?: boolean;
}

export interface JournalLine {
  id: string;
  accountId: string;
  accountName: string;
  type: 'Soll' | 'Haben';
  amount: number | string;
  taxCode?: string;
  taxCaseKey?: TaxCaseKey;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
}

export type TaxCaseKey =
  | 'DE_STD_19'
  | 'DE_STD_7'
  | 'DE_ZERO_EXEMPT'
  | 'DE_KU19'
  | 'DE_RC_13B_DOMESTIC'
  | 'EU_B2C_OSS'
  | 'DE_MARGIN_25A'
  | 'DE_BAUABZUG_48'
  | 'DE_TRIANGULAR_25B'
  | 'EU_B2B_SERVICE_RC'
  | 'EU_IGL_GOODS_0'
  | 'EU_IGE_GOODS_RC'
  | 'NON_EU_EXPORT_0'
  | 'NON_EU_SERVICE_RC';

export interface JournalEntry {
  id: string;
  transactionId?: string;
  date: string;
  reference: string;
  description: string;
  lines: JournalLine[];
}

export interface Account {
  id: string;
  number: string;
  name: string;
  type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
  defaultTaxCode?: string;
  keywords?: string[];
  postingLocked?: boolean;
  aliases?: string[];
}

export interface BookingDraft {
  id: string;
  transactionId: string;
  workflowStatus: BookingWorkflowStatus;
  documentDate?: string;
  postingDate?: string;
  serviceDate?: string;
  bookingText: string;
  externalReference?: string;
  chartFramework: 'SKR03' | 'SKR04';
  lines: JournalLine[];
  validationIssues: ValidationIssue[];
  isVirtualProjection?: boolean;
  activity: ActivityEvent[];
  assignedTo?: string;
  approval: {
    required: boolean;
    status: 'not_required' | 'pending' | 'approved' | 'rejected';
    reviewerId?: string;
    reviewerName?: string;
    reviewedAt?: string;
    reason?: string;
  };
}

export interface User {
  id: string;
  name: string;
  role: UserRole;
}
