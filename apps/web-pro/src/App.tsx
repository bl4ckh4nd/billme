import React from 'react';
import { AuthScreen, Button, EmptyState, formatEmptyValue, Input, Select, type AuthScreenMode } from '@billme/ui';
import {
  BusinessOnboarding,
  shouldShowBusinessOnboarding,
  type BusinessOnboardingDraft,
} from '@billme/desktop-ui';
import {
  ProAccountingWorkspace,
  type Account as WorkspaceAccount,
  type BookingDraft as WorkspaceBookingDraft,
  type ProAccountingSeed,
  type Transaction as WorkspaceTransaction,
  type UserRole,
  type ProAccountingDataAdapter,
  type OposBankTransaction,
  type EurCashItem,
  permissionContextForRole,
  nativeEurRange,
  reportDateRange,
} from '@billme/accounting-ui-pro';
import type {
  BalanceSheetPreview,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSelection,
  ReportFilterState,
  SusaReport,
  AccountingCommandInput,
  AccountingSourceRun,
  EurCashFact,
  EurCashFactInput,
  EurAnnexFact,
  EurAnnexFactInput,
} from '@billme/accounting-ui-pro';
import type { OpenItemPaymentEntity } from '@billme/accounting-shared';
import { createProWebClient, type ProWebClient } from './api';
import { mapTransactionBankAccounts } from './accountingSeed';

const DEFAULT_API_URL = (import.meta.env.VITE_SERVER_API_URL as string | undefined) ?? 'http://127.0.0.1:3100';
const SESSION_STORAGE_KEY = 'billme.web-pro.session.v1';
const API_URL_STORAGE_KEY = 'billme.web-pro.api-url.v1';
const DEV_CREDENTIALS = import.meta.env.DEV
  ? { email: 'owner@example.com', password: 'billme-server-123', fullName: 'Billme Pro Owner' }
  : undefined;

const accountingErrorsFrom = (value: unknown): Array<{ code: string; message: string; field?: string; blocking?: boolean }> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const direct = Array.isArray(record.errors)
    ? record.errors.flatMap((error) => {
      if (!error || typeof error !== 'object' || Array.isArray(error)) return [];
      const issue = error as Record<string, unknown>;
      return typeof issue.code === 'string' && typeof issue.message === 'string'
        ? [{ code: issue.code, message: issue.message, ...(typeof issue.field === 'string' ? { field: issue.field } : {}), ...(typeof issue.blocking === 'boolean' ? { blocking: issue.blocking } : {}) }]
        : [];
    })
    : [];
  return [...direct, ...accountingErrorsFrom(record.result)].filter((issue, index, all) => all.findIndex((candidate) => candidate.code === issue.code && candidate.message === issue.message && candidate.field === issue.field) === index);
};

type AppRoute = 'overview' | 'documents' | 'clients' | 'catalog' | 'recurring' | 'settings' | 'accounting';

type AppData = {
  health: Awaited<ReturnType<ProWebClient['getHealth']>>;
  capabilities: Awaited<ReturnType<ProWebClient['getCapabilities']>>;
  sessionInfo: Awaited<ReturnType<ProWebClient['getSessionInfo']>>;
  clients: Awaited<ReturnType<ProWebClient['listClients']>>;
  invoices: Awaited<ReturnType<ProWebClient['listInvoices']>>;
  offers: Awaited<ReturnType<ProWebClient['listOffers']>>;
  recurringProfiles: Awaited<ReturnType<ProWebClient['listRecurringProfiles']>>;
  settings: Awaited<ReturnType<ProWebClient['getSettings']>>;
  articles: Awaited<ReturnType<ProWebClient['listArticles']>>;
  bankAccounts: Awaited<ReturnType<ProWebClient['listAccounts']>>;
  templates: Awaited<ReturnType<ProWebClient['listTemplates']>>;
  activeTemplates: {
    invoice: Awaited<ReturnType<ProWebClient['getActiveTemplate']>>;
    offer: Awaited<ReturnType<ProWebClient['getActiveTemplate']>>;
  };
  workflowEntries: Awaited<ReturnType<ProWebClient['listWorkflowEntries']>>;
  accountingTransactions: Awaited<ReturnType<ProWebClient['listAccountingTransactions']>>;
  accountingDrafts: Awaited<ReturnType<ProWebClient['listAccountingDrafts']>>;
  accountingPolicy: Awaited<ReturnType<ProWebClient['getAccountingPolicy']>>;
  ledgerStats: Awaited<ReturnType<ProWebClient['getLedgerStats']>>;
  ledgerAccounts: Awaited<ReturnType<ProWebClient['listLedgerAccounts']>>;
  taxCases: Awaited<ReturnType<ProWebClient['listTaxCases']>>;
  taxMappings: Awaited<ReturnType<ProWebClient['listTaxCaseMappings']>>;
  suggestionRules: Awaited<ReturnType<ProWebClient['listAccountSuggestionRules']>>;
};

type StoredSession = Awaited<ReturnType<ProWebClient['login']>> & {
  apiUrl: string;
};

type SettingsRecord = NonNullable<Awaited<ReturnType<ProWebClient['getSettings']>>>;

type NoticeTone = 'neutral' | 'success' | 'danger';

type Notice = {
  tone: NoticeTone;
  text: string;
} | null;

const ROUTES: Array<{ id: AppRoute; label: string; summary: string }> = [
  { id: 'overview', label: 'Überblick', summary: 'Gesundheit, Nutzung und Rollen' },
  { id: 'documents', label: 'Dokumente', summary: 'Rechnungen, Angebote und Exporte' },
  { id: 'clients', label: 'Kunden', summary: 'Mandanten- und Projektbestand' },
  { id: 'catalog', label: 'Katalog', summary: 'Artikel, Konten und Vorlagen' },
  { id: 'recurring', label: 'Wiederkehrend', summary: 'Profile und Automatisierung' },
  { id: 'settings', label: 'Einstellungen', summary: 'Firma, Nummernkreis und Ziele' },
  { id: 'accounting', label: 'Buchhaltung', summary: 'Workflow, Regeln und Ledger' },
];

const invoiceDocumentLabels: Record<string, string> = {
  invoice: 'Rechnung',
  order_confirmation: 'Auftragsbestätigung',
  delivery_note: 'Lieferschein',
  advance_invoice: 'Abschlagsrechnung',
  partial_invoice: 'Teilrechnung',
  final_invoice: 'Schlussrechnung',
  credit_note: 'Gutschrift',
  cancellation_invoice: 'Stornorechnung',
};

const invoiceDocumentLabel = (kind: string | undefined) => invoiceDocumentLabels[kind ?? 'invoice'] ?? 'Rechnung';
const invoiceChainLabel = (invoice: { documentKind?: string; revisionNumber?: number }) =>
  invoice.revisionNumber && invoice.revisionNumber > 0
    ? `${invoiceDocumentLabel(invoice.documentKind)} · Revision ${invoice.revisionNumber}`
    : invoiceDocumentLabel(invoice.documentKind);

const WORKFLOW_ROUTE_TARGET = '#/accounting';

const mapServerRoleToWorkspaceRole = (role: AppData['sessionInfo']['role']): UserRole => {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'admin':
      return 'admin';
    case 'accountant':
      return 'accountant';
    case 'sales':
      return 'sales';
    case 'viewer':
      return 'viewer';
  }
};

const currencyFormatter = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

const formatCurrency = (value: number) => currencyFormatter.format(value ?? 0);
const formatDate = (value: string | null | undefined) => {
  if (!value) return formatEmptyValue(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(parsed);
};

const taxRoleLabels = {
  output_tax: 'Umsatzsteuer',
  input_tax: 'Vorsteuer',
  datev_bu: 'DATEV-BU',
} as const;

const suggestionFieldLabels = {
  counterparty: 'Gegenpartei',
  purpose: 'Verwendungszweck',
  any: 'Beliebiges Feld',
} as const;

const suggestionOperatorLabels = {
  contains: 'enthält',
  equals: 'ist gleich',
  startsWith: 'beginnt mit',
} as const;

const suggestionFlowLabels = {
  income: 'Einnahme',
  expense: 'Ausgabe',
  any: 'Beliebig',
} as const;

const invoiceStatusLabels: Record<string, string> = {
  draft: 'Entwurf',
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
  cancelled: 'Storniert',
};

const offerStatusLabels: Record<string, string> = {
  draft: 'Entwurf',
  open: 'Offen',
  accepted: 'Angenommen',
  declined: 'Abgelehnt',
  expired: 'Abgelaufen',
  cancelled: 'Storniert',
};

const offerDecisionLabels: Record<string, string> = {
  accepted: 'Angenommen',
  declined: 'Abgelehnt',
};

const clientStatusLabels: Record<string, string> = {
  active: 'Aktiv',
  inactive: 'Inaktiv',
};

const recurringIntervalLabels: Record<string, string> = {
  daily: 'Täglich',
  weekly: 'Wöchentlich',
  monthly: 'Monatlich',
  quarterly: 'Quartalsweise',
  yearly: 'Jährlich',
};

const accountTypeLabels: Record<string, string> = {
  bank: 'Bank',
  checking: 'Girokonto',
  savings: 'Sparkonto',
  paypal: 'PayPal',
  cash: 'Bargeld',
  credit: 'Kreditkarte',
  other: 'Sonstiges',
};

const templateKindLabels: Record<string, string> = {
  invoice: 'Rechnung',
  offer: 'Angebot',
};

const labelFromMap = (labels: Record<string, string>, value: string | null | undefined): string =>
  labels[value ?? ''] ?? formatEmptyValue(value);

/**
 * Belegfelder zeigen nur fachliche Werte. Rohe UUIDs und generierte Vorgangs-IDs
 * (etwa `sonderbuchung-1789547678430`) gehören in die technischen Details, nicht
 * in den Belegkopf; solche Werte werden ausgelassen statt angezeigt.
 */
const TECHNICAL_ID_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{32,}$/i,
  /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*-(?:1[0-9]{12}|[0-9]{13,})$/,
];

const userFacingReference = (value: string | null | undefined): string | undefined => {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  return TECHNICAL_ID_PATTERNS.some((pattern) => pattern.test(candidate)) ? undefined : candidate;
};

const getApiUrlFromStorage = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_API_URL;
  }
  return window.localStorage.getItem(API_URL_STORAGE_KEY) ?? DEFAULT_API_URL;
};

const readStoredSession = (): StoredSession | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed || typeof parsed.token !== 'string' || !parsed.user || typeof parsed.user !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const persistSession = (session: StoredSession | null) => {
  if (typeof window === 'undefined') {
    return;
  }
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
};

const persistApiUrl = (apiUrl: string) => {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(API_URL_STORAGE_KEY, apiUrl);
};

const parseRouteFromHash = (hash: string): AppRoute => {
  const normalized = hash.replace(/^#\/?/, '').trim().toLowerCase();
  const match = ROUTES.find((route) => route.id === normalized);
  return match?.id ?? 'overview';
};

const useHashRoute = (): [AppRoute, (route: AppRoute) => void] => {
  const [route, setRoute] = React.useState<AppRoute>(() => {
    if (typeof window === 'undefined') {
      return 'overview';
    }
    return parseRouteFromHash(window.location.hash);
  });

  React.useEffect(() => {
    const handleHashChange = () => setRoute(parseRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigate = React.useCallback((nextRoute: AppRoute) => {
    const nextHash = nextRoute === 'overview' ? '#/' : `#/${nextRoute}`;
    if (window.location.hash === nextHash) {
      setRoute(nextRoute);
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return [route, navigate];
};

const createDefaultSettings = (): SettingsRecord => ({
  company: {
    name: '',
    owner: '',
    street: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
    website: '',
  },
  catalog: {
    categories: [],
  },
  finance: {
    bankName: '',
    iban: '',
    bic: '',
    taxId: '',
    vatId: '',
    registerCourt: '',
  },
  numbers: {
    invoicePrefix: 'RE-',
    nextInvoiceNumber: 1,
    numberLength: 4,
    offerPrefix: 'AN-',
    nextOfferNumber: 1,
    customerPrefix: 'KD-',
    nextCustomerNumber: 1,
    customerNumberLength: 4,
  },
  dunning: {
    levels: [],
  },
  legal: {
    smallBusinessRule: false,
    defaultVatRate: 19,
    taxAccountingMethod: 'soll' as const,
    paymentTermsDays: 14,
    defaultIntroText: '',
    defaultFooterText: '',
  },
  portal: {
    baseUrl: '',
  },
  eInvoice: {
    enabled: false,
    standard: 'zugferd-en16931' as const,
    profile: 'EN16931' as const,
    version: '2.3' as const,
  },
  email: {
    provider: 'none' as const,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: true,
    smtpUser: '',
    fromName: '',
    fromEmail: '',
  },
  automation: {
    dunningEnabled: false,
    dunningRunTime: '09:00',
    recurringEnabled: false,
    recurringRunTime: '03:00',
  },
  dashboard: {
    monthlyRevenueGoal: 30000,
    dueSoonDays: 7,
    topCategoriesLimit: 5,
    recentPaymentsLimit: 5,
    topClientsLimit: 5,
  },
  onboardingCompleted: false,
});

const inferLedgerAccountType = (accountNumber: string): WorkspaceAccount['type'] => {
  const first = accountNumber[0];
  if (first === '0' || first === '1') return 'Asset';
  if (first === '2' || first === '3') return 'Equity';
  if (first === '8' || first === '9') return 'Revenue';
  if (first === '4' || first === '5' || first === '6' || first === '7') return 'Expense';
  return 'Asset';
};

const mapLedgerAccountsToWorkspace = (ledgerAccounts: AppData['ledgerAccounts']): WorkspaceAccount[] => {
  return ledgerAccounts.map((row) => ({
    id: row.accountNumber,
    number: row.accountNumber,
    name: row.name,
    type: inferLedgerAccountType(row.accountNumber),
    keywords: row.keywords && row.keywords.length > 0 ? row.keywords : [row.name],
  }));
};

const reportQuality = (health: { unmappedAccounts: string[]; warnings: string[]; blocking: boolean }): GuvReport['quality'] => ({
  unmappedAccounts: health.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 })),
  warnings: health.warnings.length,
  generatedAt: new Date().toISOString(),
  source: 'live',
  mappingStatus: health.blocking ? 'blocked' : health.warnings.length > 0 ? 'warning' : 'healthy',
  mappingNotes: health.warnings,
});

const reportLines = (rows: Array<{ position: string; label: string; amount: number; accountNumbers: string[]; accountRefs?: string[]; kind?: string; parentPosition?: string }>) => rows.map((row) => ({
  id: row.position,
  code: row.position,
  label: row.label,
  level: row.parentPosition ? 1 : 0,
  amountCurrent: row.amount,
  accountRefs: row.accountRefs ?? row.accountNumbers,
  isSubtotal: row.kind === 'heading' || row.kind === 'subtotal' || row.kind === 'result',
}));

const mapWebEurCashItem = (item: Awaited<ReturnType<ProWebClient['listEurCashItems']>>[number]): EurCashItem => ({
  ...item,
  splits: item.splits?.map((split) => ({ ...split, reason: split.reason ?? '' })),
});

const mapWorkflowTransactionToWorkspace = (
  row: ReturnType<ProWebClient['parseWorkflowTransaction']>,
): WorkspaceTransaction => {
  const workflowStatus: WorkspaceTransaction['workflowStatus'] =
    row.linkedInvoiceId ? 'posted' : row.status === 'booked' ? 'suggested' : 'imported';
  const missingReceipt = !row.linkedInvoiceId;

  return {
    id: row.id,
    date: row.date,
    payee: row.counterparty || 'Unbekannt',
    description: row.purpose || 'Workflow-Eintrag',
    amount: Number(row.amount || 0),
    currency: 'EUR',
    workflowStatus,
    suggestion: row.suggestedAccountNumber,
    suggestionConfidence: row.suggestionConfidence,
    hasReceipt: !missingReceipt,
    issueCounts: {
      errors: 0,
      warnings: missingReceipt ? 1 : 0,
      infos: 0,
    },
    flags: missingReceipt ? ['missing_receipt'] : [],
    bookingDraftId: `draft-${row.id}`,
    owner: 'Server workflow',
  };
};

const mapWorkflowDraftToWorkspace = (
  draft: ReturnType<ProWebClient['parseWorkflowDraft']>,
): WorkspaceBookingDraft => {
  return {
    id: draft.id,
    transactionId: draft.transactionId,
    workflowStatus: draft.workflowStatus,
    documentDate: draft.documentDate,
    postingDate: draft.postingDate,
    serviceDate: draft.documentDate,
    bookingText: draft.bookingText,
    externalReference: userFacingReference(draft.reference),
    chartFramework: 'SKR03',
    lines: draft.lines.map((line) => {
      const hasDebit = Number(line.debitAmount || 0) > 0;
      const amount = hasDebit ? Number(line.debitAmount || 0) : Number(line.creditAmount || 0);
      return {
        id: line.id,
        accountId: line.accountNumber,
        accountName: line.accountNumber,
        type: hasDebit ? 'Soll' : 'Haben',
        amount,
        taxCode: line.taxCode,
        taxCaseKey: line.taxCaseKey,
        taxRate: line.taxRate,
        netAmount: line.netAmount,
        taxAmount: line.taxAmount,
        grossAmount: line.grossAmount,
        countryCode: line.countryCode,
        counterpartyVatId: line.counterpartyVatId,
        evidenceType: line.evidenceType,
        evidenceReference: userFacingReference(line.evidenceReference),
        costCenter: line.costCenter,
      };
    }),
    validationIssues: draft.validationIssues.map((issue) => ({
      id: issue.id,
      code: issue.code as WorkspaceBookingDraft['validationIssues'][number]['code'],
      severity: issue.severity,
      message: issue.message,
      fieldPath: issue.fieldPath,
      blocking: issue.blocking,
      source: issue.source,
    })),
    activity: [],
    approval: {
      required: false,
      status: 'not_required',
    },
  };
};

const mapWorkspaceDraftToEntity = (
  draft: WorkspaceBookingDraft,
  tenantId: string,
) => {
  const postingDate = draft.postingDate ?? draft.documentDate ?? new Date().toISOString().slice(0, 10);
  return {
    id: draft.id,
    tenantId,
    transactionId: draft.transactionId,
    workflowStatus: draft.workflowStatus,
    postingDate: draft.postingDate,
    documentDate: draft.documentDate,
    bookingText: draft.bookingText,
    reference: draft.externalReference,
    period: postingDate.slice(0, 7),
    fiscalYear: Number(postingDate.slice(0, 4)),
    lines: draft.lines.map((line) => ({
      id: line.id,
      accountNumber: line.accountId,
      debitAmount: line.type === 'Soll' ? Number(line.amount || 0) : 0,
      creditAmount: line.type === 'Haben' ? Number(line.amount || 0) : 0,
      taxCode: line.taxCode,
      taxCaseKey: line.taxCaseKey,
      taxRate: line.taxRate,
      netAmount: line.netAmount,
      taxAmount: line.taxAmount,
      grossAmount: line.grossAmount,
      countryCode: line.countryCode,
      counterpartyVatId: line.counterpartyVatId,
      evidenceType: line.evidenceType,
      evidenceReference: line.evidenceReference,
      costCenter: line.costCenter,
      memo: undefined,
    })),
    validationIssues: draft.validationIssues.map((issue) => ({
      id: issue.id,
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      fieldPath: issue.fieldPath,
      blocking: issue.blocking,
      source: issue.source,
    })),
    updatedAt: new Date().toISOString(),
  };
};

const readWorkflowSeed = (client: ProWebClient, workflowEntries: AppData['workflowEntries']): ProAccountingSeed => {
  const transactions: WorkspaceTransaction[] = [];
  const drafts: WorkspaceBookingDraft[] = [];

  workflowEntries.forEach((entry) => {
    try {
      transactions.push(mapWorkflowTransactionToWorkspace(client.parseWorkflowTransaction(entry.transactionJson)));
      drafts.push(mapWorkflowDraftToWorkspace(client.parseWorkflowDraft(entry.draftJson)));
    } catch {
      // Ignore invalid workflow snapshots so the shell stays usable.
    }
  });

  return {
    transactions,
    drafts,
  };
};

const readCanonicalSeed = (
  transactions: AppData['accountingTransactions'],
  drafts: AppData['accountingDrafts'],
): ProAccountingSeed => {
  const draftByTransactionId = new Map(
    drafts.filter((draft): draft is NonNullable<typeof draft> => draft !== null).map((draft) => [draft.transactionId, draft]),
  );
  return {
    transactions: transactions.map((row) => {
      const draft = draftByTransactionId.get(row.id);
      const workflowStatus: WorkspaceTransaction['workflowStatus'] = draft
        ? draft.workflowStatus
        : row.status === 'booked'
          ? 'posted'
          : 'imported';
      return {
        id: row.id,
        date: row.date,
        payee: row.counterparty || 'Unbekannt',
        description: row.purpose || 'Banktransaktion',
        amount: Number(row.amount || 0),
        currency: 'EUR',
        workflowStatus,
        suggestion: row.suggestedAccountNumber,
        suggestionConfidence: row.suggestionConfidence,
        hasReceipt: Boolean(row.linkedInvoiceId),
        issueCounts: { errors: 0, warnings: row.linkedInvoiceId ? 0 : 1, infos: 0 },
        flags: row.linkedInvoiceId ? [] : ['missing_receipt'],
        bookingDraftId: draft?.id ?? `draft-${row.id}`,
        owner: 'Server accounting',
      } satisfies WorkspaceTransaction;
    }),
    drafts: drafts.filter((draft): draft is NonNullable<typeof draft> => draft !== null).map(mapWorkflowDraftToWorkspace),
  };
};

const WORKSPACE_ROLE_VALUES = new Set<UserRole>(['bookkeeper', 'reviewer', 'accountant', 'admin', 'auditor']);

const requireMutationReason = (candidate: string | undefined, operation: string): string => {
  const supplied = candidate?.trim();
  // Shared workspace actions historically passed the UI role as actorName. A role
  // is authorization context, not an audit reason, so never forward it as one.
  if (supplied && supplied !== 'Web Pro' && !WORKSPACE_ROLE_VALUES.has(supplied.toLowerCase() as UserRole)) {
    return supplied;
  }
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
    throw new Error(`Eine ausdrückliche Begründung ist für ${operation} erforderlich.`);
  }
  const entered = window.prompt(`Begründung für ${operation}`)?.trim() ?? '';
  if (!entered || WORKSPACE_ROLE_VALUES.has(entered.toLowerCase() as UserRole)) {
    throw new Error(`Eine ausdrückliche Begründung ist für ${operation} erforderlich.`);
  }
  return entered;
};

const triggerBlobDownload = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

const createNotice = (tone: NoticeTone, text: string): Notice => ({ tone, text });

const buildSampleWorkflowPayload = (tenantId: string, ledgerAccounts: AppData['ledgerAccounts']) => {
  const transactionId = crypto.randomUUID();
  const draftId = `draft-${transactionId}`;
  const today = new Date().toISOString().slice(0, 10);
  const amount = 1248.5;
  const debitAccount = ledgerAccounts.find((entry) => inferLedgerAccountType(entry.accountNumber) === 'Asset')?.accountNumber ?? '1200';
  const creditAccount = ledgerAccounts.find((entry) => inferLedgerAccountType(entry.accountNumber) === 'Revenue')?.accountNumber ?? '8400';

  const transaction = {
    id: transactionId,
    date: today,
    amount,
    type: 'income' as const,
    counterparty: 'Nordlicht Consulting GmbH',
    purpose: 'Server-mode Pilotauftrag',
    status: 'pending' as const,
    suggestedAccountNumber: creditAccount,
    suggestionConfidence: 0.82,
  };

  const draft = {
    id: draftId,
    tenantId,
    transactionId,
    workflowStatus: 'ready_for_review' as const,
    postingDate: today,
    documentDate: today,
    bookingText: 'Pilotauftrag Web-Pro',
    period: today.slice(0, 7),
    fiscalYear: Number(today.slice(0, 4)),
    lines: [
      {
        id: `${draftId}-debit`,
        accountNumber: debitAccount,
        debitAmount: amount,
        creditAmount: 0,
      },
      {
        id: `${draftId}-credit`,
        accountNumber: creditAccount,
        debitAmount: 0,
        creditAmount: amount,
      },
    ],
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };

  return {
    transactionId,
    transactionJson: JSON.stringify(transaction),
    draftJson: JSON.stringify(draft),
    updatedAt: new Date().toISOString(),
  };
};

const StatCard = ({ label, value, hint }: { label: string; value: string; hint: string }) => (
  <div className="grid gap-1 rounded-lg border border-border bg-surface p-4">
    <span className="text-xs font-semibold text-muted">{label}</span>
    <strong className="text-2xl font-bold tracking-tight tabular-nums text-foreground">{value}</strong>
    <span className="text-xs text-muted">{hint}</span>
  </div>
);

const SectionCard = ({
  eyebrow,
  title,
  actions,
  children,
  className = '',
}: {
  eyebrow: string;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <section className={`rounded-xl border border-border bg-surface p-5 ${className}`}>
    <header className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">{eyebrow}</p>
        <h2 className="mt-1 text-xl font-bold tracking-tight text-foreground">{title}</h2>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
    {children}
  </section>
);

const TechnicalDetails = ({ apiUrl, data }: { apiUrl: string; data: AppData | null }) => {
  const rows: Array<[string, string]> = [
    ['Mandant', formatEmptyValue(data?.sessionInfo.tenantId)],
    ['API-Adresse', apiUrl],
    ['Dienst', formatEmptyValue(data?.health.service)],
    ['Backend', formatEmptyValue(data?.capabilities.backend)],
    ['Bereitstellung', formatEmptyValue(data?.capabilities.deploymentMode)],
    ['Rolle', formatEmptyValue(data?.sessionInfo.role)],
    ['Produkte', formatEmptyValue(data?.capabilities.products.join(', '))],
    ['Rollenmodell', formatEmptyValue(data?.capabilities.auth.roles.join(', '))],
  ];

  return (
    <details className="mt-3 rounded-lg border border-control-border bg-surface px-4 py-2 text-xs text-muted">
      <summary className="flex min-h-6 cursor-pointer items-center font-semibold uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">
        Technische Details
      </summary>
      <dl className="mt-2 grid gap-1">
        {rows.map(([label, value]) => (
          <div className="flex flex-wrap items-baseline gap-2" key={label}>
            <dt className="font-semibold">{label}</dt>
            <dd className="break-all font-mono text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 leading-relaxed">
        Anmeldung per HTTP-Session gegen die Pro-API statt Electron-IPC. Workflow-Einträge werden über die Route{' '}
        <code className="rounded-sm bg-surface-muted px-1 py-0.5 font-mono">/api/v1/pro/workflow</code> übertragen.
      </p>
    </details>
  );
};

const noticeToneClasses: Record<NoticeTone, string> = {
  neutral: 'border-border bg-surface-muted text-foreground',
  success: 'border-success-border bg-success-bg text-success-text',
  danger: 'border-error-border bg-error-bg text-error-text',
};

const NoticeBanner = ({ notice }: { notice: Notice }) => {
  if (!notice) {
    return null;
  }
  return (
    <div role="status" className={`mb-4 rounded-xl border px-4 py-3 text-sm ${noticeToneClasses[notice.tone]}`}>
      {notice.text}
    </div>
  );
};

const DataTable = ({ children }: { children: React.ReactNode }) => (
  <div className="overflow-x-auto rounded-xl border border-border bg-surface [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-border [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted [&_td]:border-b [&_td]:border-border-subtle [&_td]:px-4 [&_td]:py-3 [&_td]:text-left [&_td]:align-top [&_td]:text-sm [&_td]:text-foreground [&_td]:tabular-nums">
    {children}
  </div>
);

export default function App() {
  const [session, setSession] = React.useState<StoredSession | null>(() => readStoredSession());
  const [apiUrl, setApiUrl] = React.useState(() => readStoredSession()?.apiUrl ?? getApiUrlFromStorage());
  const [route, navigate] = useHashRoute();
  const [authMode, setAuthMode] = React.useState<AuthScreenMode>('checking');
  const [data, setData] = React.useState<AppData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [loadError, setLoadError] = React.useState<string>('');
  const [onboardingSaving, setOnboardingSaving] = React.useState(false);
  const [settingsDraft, setSettingsDraft] = React.useState<SettingsRecord>(createDefaultSettings());
  const [articleDraft, setArticleDraft] = React.useState({
    title: '',
    description: '',
    price: '0',
    unit: 'h',
    category: 'Beratung',
    taxRate: '19',
  });
  const [accountDraft, setAccountDraft] = React.useState({
    name: '',
    iban: '',
    balance: '0',
    defaultSkrAccountNumber: '1200',
    type: 'bank' as const,
    color: '#3c6e71',
  });
  const [templateDraft, setTemplateDraft] = React.useState<{ kind: 'invoice' | 'offer'; name: string }>({
    kind: 'invoice',
    name: '',
  });
  const [taxMappingDraft, setTaxMappingDraft] = React.useState<{
    chart: 'SKR03' | 'SKR04';
    taxCaseKey: string;
    role: 'output_tax' | 'input_tax' | 'datev_bu';
    accountNumber: string;
    datevBuKey: string;
  }>({
    chart: 'SKR03',
    taxCaseKey: 'DE_STD_19',
    role: 'output_tax',
    accountNumber: '1776',
    datevBuKey: '',
  });
  const [suggestionRuleDraft, setSuggestionRuleDraft] = React.useState<{
    chart: 'SKR03' | 'SKR04';
    priority: string;
    field: 'counterparty' | 'purpose' | 'any';
    operator: 'contains' | 'equals' | 'startsWith';
    value: string;
    targetAccountNumber: string;
    flowType: 'income' | 'expense' | 'any';
  }>({
    chart: 'SKR03',
    priority: '10',
    field: 'counterparty',
    operator: 'contains',
    value: '',
    targetAccountNumber: '8400',
    flowType: 'income',
  });

  const client = React.useMemo(
    () =>
      createProWebClient({
        baseUrl: apiUrl,
        getToken: () => session?.token ?? null,
      }),
    [apiUrl, session?.token],
  );

  React.useEffect(() => {
    persistApiUrl(apiUrl);
  }, [apiUrl]);

  const refreshAuthMeta = React.useCallback(async () => {
    setAuthMode('checking');
    try {
      const bootstrapStatus = await client.getBootstrapStatus();
      setAuthMode(bootstrapStatus.bootstrapped ? 'login' : 'setup');
    } catch {
      setAuthMode('unreachable');
    }
  }, [client]);

  const refreshData = React.useCallback(async () => {
    if (!session) {
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const accountingPolicy = await client.getAccountingPolicy();
      const accountingTransactionsPromise = client.listAccountingTransactions();
      const [
        health,
        capabilities,
        sessionInfo,
        clients,
        invoices,
        offers,
        recurringProfiles,
        settings,
        articles,
        bankAccounts,
        templates,
        activeInvoiceTemplate,
        activeOfferTemplate,
        workflowEntries,
        accountingTransactions,
        accountingDrafts,
        ledgerStats,
        ledgerAccounts,
        taxCases,
        taxMappings,
        suggestionRules,
      ] = await Promise.all([
        client.getHealth(),
        client.getCapabilities(),
        client.getSessionInfo(),
        client.listClients(),
        client.listInvoices(),
        client.listOffers(),
        client.listRecurringProfiles(),
        client.getSettings(),
        client.listArticles(),
        client.listAccounts(),
        client.listTemplates(),
        client.getActiveTemplate('invoice'),
        client.getActiveTemplate('offer'),
        client.listWorkflowEntries(),
        accountingTransactionsPromise,
        accountingTransactionsPromise.then((rows) => client.listAccountingDrafts(rows.map((row) => row.id))),
        client.getLedgerStats(),
        client.listLedgerAccounts({ chart: accountingPolicy.activeChart, limit: 5000 }),
        client.listTaxCases({ activeOnly: false }),
        client.listTaxCaseMappings({ chart: accountingPolicy.activeChart }),
        client.listAccountSuggestionRules({ chart: accountingPolicy.activeChart, activeOnly: false }),
      ]);

      setData({
        health,
        capabilities,
        sessionInfo,
        clients,
        invoices,
        offers,
        recurringProfiles,
        settings,
        articles,
        bankAccounts,
        templates,
        activeTemplates: {
          invoice: activeInvoiceTemplate,
          offer: activeOfferTemplate,
        },
        workflowEntries,
        accountingTransactions,
        accountingDrafts,
        accountingPolicy,
        ledgerStats,
        ledgerAccounts,
        taxCases,
        taxMappings,
        suggestionRules,
      });
      setSettingsDraft(settings ?? createDefaultSettings());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/bearer token|expired bearer token|missing bearer token|not authorized/i.test(message)) {
        setSession(null);
        persistSession(null);
        setData(null);
        setNotice(createNotice('danger', 'Sitzung abgelaufen. Bitte erneut anmelden.'));
        return;
      }
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [client, session]);

  const validatedSessionKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!session) {
        await refreshAuthMeta();
        return;
      }
      const sessionKey = `${apiUrl}::${session.token}`;
      if (validatedSessionKey.current !== sessionKey) {
        validatedSessionKey.current = sessionKey;
        setAuthMode('checking');
        try {
          await client.getSessionInfo();
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          if (/bearer token|expired bearer token|missing bearer token|not authorized/i.test(message)) {
            setSession(null);
            persistSession(null);
            setData(null);
            setNotice(createNotice('danger', 'Sitzung abgelaufen. Bitte erneut anmelden.'));
          } else {
            setSession(null);
            persistSession(null);
            setData(null);
            setNotice(createNotice('danger', 'Sitzung konnte nicht geprüft werden. Bitte erneut anmelden.'));
          }
          try {
            const bootstrapStatus = await createProWebClient({ baseUrl: apiUrl, getToken: () => null }).getBootstrapStatus();
            if (!cancelled) setAuthMode(bootstrapStatus.bootstrapped ? 'login' : 'setup');
          } catch {
            if (!cancelled) setAuthMode('unreachable');
          }
          return;
        }
      }
      await refreshData();
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, client, refreshAuthMeta, refreshData, session]);

  const handleAuthenticate = async ({ email, password, fullName }: { email: string; password: string; fullName: string }) => {
    const response = authMode === 'setup'
      ? await client.bootstrap({ email, password, fullName })
      : await client.login({ email, password });
    const nextSession = { ...response, apiUrl };
    setNotice(null);
    setSession(nextSession);
    persistSession(nextSession);
  };

  const handleServerUrlChange = async (nextUrl: string) => {
    await createProWebClient({ baseUrl: nextUrl, getToken: () => null }).getBootstrapStatus();
    setApiUrl(nextUrl);
  };

  const handleLogout = React.useCallback(() => {
    setSession(null);
    setData(null);
    persistSession(null);
    setNotice(createNotice('neutral', 'Du wurdest abgemeldet.'));
  }, []);

  const runAction = React.useCallback(
    async (work: () => Promise<void>, successMessage: string) => {
      setNotice(null);
      try {
        await work();
        await refreshData();
        setNotice(createNotice('success', successMessage));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotice(createNotice('danger', message));
      }
    },
    [refreshData],
  );

  const accountingSeed = React.useMemo(() => {
    if (!data) {
      return undefined;
    }
    const canonical = readCanonicalSeed(data.accountingTransactions, data.accountingDrafts);
    const base = data.accountingTransactions.length > 0
      ? canonical
      : readWorkflowSeed(client, data.workflowEntries);
    const bankAccountNumberByTransactionId = mapTransactionBankAccounts(data.accountingTransactions, data.bankAccounts);
    const bankAccountNumbers = [...new Set(Object.values(bankAccountNumberByTransactionId))];
    return {
      ...base,
      accounts: mapLedgerAccountsToWorkspace(data.ledgerAccounts),
      bankAccountNumber: bankAccountNumbers.length === 1 ? bankAccountNumbers[0] : undefined,
      bankAccountNumberByTransactionId,
      chartFramework: data.accountingPolicy.activeChart,
      businessReportingProfile: data.settings?.businessReportingProfile,
      seedVersion: `${data.accountingTransactions.length}:${data.accountingDrafts.length}:${data.workflowEntries.length}:${data.ledgerAccounts.length}:${data.accountingPolicy.updatedAt}`,
    } satisfies ProAccountingSeed;
  }, [client, data]);

  const workspaceRole = data ? mapServerRoleToWorkspaceRole(data.sessionInfo.role) : 'viewer';
  const canMutateAccountingRules = data ? permissionContextForRole(workspaceRole).canMutate : false;

  const accountingDataAdapter = React.useMemo<ProAccountingDataAdapter | undefined>(() => {
    if (!accountingSeed || !data) return undefined;
    let transactions = structuredClone(accountingSeed.transactions ?? []);
    let drafts = structuredClone(accountingSeed.drafts ?? []);
    const canonical = data.accountingTransactions.length > 0;
    const refreshCanonicalSnapshots = async () => {
      const nextTransactions = await client.listAccountingTransactions();
      const nextDrafts = await client.listAccountingDrafts(nextTransactions.map((row) => row.id));
      const nextSeed = readCanonicalSeed(nextTransactions, nextDrafts);
      transactions = structuredClone(nextSeed.transactions ?? []);
      drafts = structuredClone(nextSeed.drafts ?? []);
    };
    const readOnly = (operation: string): never => {
      throw new Error(`${operation} ist bei alten Workflow-Snapshots nicht verfügbar. Lade die kanonischen Buchhaltungsdaten neu.`);
    };
    const reportFilter = (filters: ReportFilterState) => ({ ...reportDateRange(filters), chart: filters.chart });
    return {
      hydrate(seed: ProAccountingSeed) {
        transactions = structuredClone(seed.transactions ?? []);
        drafts = structuredClone(seed.drafts ?? []);
      },
      listTransactions() {
        return structuredClone(transactions);
      },
      listBookingDrafts() {
        return structuredClone(drafts);
      },
      getTransactionById(id: string) {
        return structuredClone(transactions.find((row) => row.id === id));
      },
      getBookingDraftByTransactionId(transactionId: string) {
        return structuredClone(drafts.find((row) => row.transactionId === transactionId));
      },
      async getJournalEntryById(id: string) {
        return client.getAccountingJournalEntryById(id);
      },
      async saveDraft(draft: WorkspaceBookingDraft, actorName = 'Web Pro') {
        if (!canonical) return readOnly('Entwurf speichern');
        const saved = await client.saveAccountingDraft(
          mapWorkspaceDraftToEntity(draft, data.sessionInfo.tenantId),
          requireMutationReason(actorName, 'Speichern des Entwurfs'),
        );
        await refreshCanonicalSnapshots();
        await refreshData();
        return mapWorkflowDraftToWorkspace(saved);
      },
      async dispatchBookingAction(transactionId: string, action: string, options?: { actorName?: string; rejectReason?: string }) {
        if (!canonical) return readOnly('Workflow-Aktion');
        const saved = await client.dispatchAccountingDraftAction(
          transactionId,
          action,
          requireMutationReason(options?.actorName, `Workflow-Aktion ${action}`),
          options?.rejectReason,
        );
        await refreshCanonicalSnapshots();
        await refreshData();
        return mapWorkflowDraftToWorkspace(saved);
      },
      listActivity(_transactionId: string) {
        return [];
      },
      reset() {
        return readOnly('Arbeitsbereich zurücksetzen');
      },
      async updateExceptionCase(_transactionId: string, _patch: Partial<NonNullable<WorkspaceTransaction['exceptionCase']>>, _actorName: string) {
        return readOnly('Ausnahme bearbeiten');
      },
      async assignExceptionOwner(_transactionId: string, _owner: string, _actorName: string) {
        return readOnly('Ausnahme bearbeiten');
      },
      async snoozeException(_transactionId: string, _snoozedUntil: string, _actorName: string, _note?: string) {
        return readOnly('Ausnahme bearbeiten');
      },
      async resolveException(_transactionId: string, _resolutionNote: string, _actorName: string) {
        return readOnly('Ausnahme bearbeiten');
      },
      async reopenException(_transactionId: string, _actorName: string) {
        return readOnly('Ausnahme bearbeiten');
      },
      async setTransactionReceiptStatus(_transactionId: string, _hasReceipt: boolean, _actorName: string) {
        return readOnly('Belegstatus ändern');
      },
      listAssets() {
        return client.listAssets();
      },
      async upsertAsset(asset, reason) {
        return client.upsertAsset(asset, requireMutationReason(reason, 'Anlage speichern'));
      },
      getDepreciationSchedule(assetId) {
        return client.getDepreciationSchedule(assetId).then((rows) => rows.filter((row) => row.status !== 'cancelled'));
      },
      async runDepreciation(args) {
        const { actorRole: _actorRole, ...input } = args;
        const result = await client.runDepreciation({
          ...input,
          reason: requireMutationReason(args.reason, 'AfA buchen'),
        });
        if (result.scheduleEntry.status === 'cancelled') {
          throw new Error('Die Abschreibung wurde storniert und nicht gebucht.');
        }
        return result;
      },
      async disposeAsset(args) {
        const { actorRole: _actorRole, ...input } = args;
        return client.disposeAsset({
          ...input,
          reason: requireMutationReason(args.reason, 'Anlage ausbuchen'),
        });
      },
      listDatevExports(limit?: number) {
        return client.listDatevExports(limit);
      },
      async exportDatevBuchungsstapel(args: {
        from: string;
        to: string;
        consultantNumber: string;
        clientNumber: string;
        fiscalYearStart: string;
        accountLength: number;
        encoding: 'cp1252' | 'utf8-bom';
      }) {
        const exported = await client.exportDatevCsv({
          from: args.from,
          to: args.to,
          consultantNumber: args.consultantNumber,
          clientNumber: args.clientNumber,
          fiscalYearStart: args.fiscalYearStart,
          accountLength: args.accountLength,
          encoding: args.encoding,
          reason: 'DATEV-Buchungsstapel exportiert',
        });
        if (!exported.exportId) throw new Error('DATEV-Export ohne Serverbeleg-ID.');
        if (typeof document !== 'undefined') triggerBlobDownload(exported.blob, `datev-${args.from}.csv`);
        const history = await client.listDatevExports();
        const receipt = history.find((item) => item.id === exported.exportId);
        if (!receipt) throw new Error('DATEV-Export wurde nicht in der Serverhistorie gefunden.');
        return receipt;
      },
      getDatevExportContent(exportId: string) {
        return client.downloadDatevExport(exportId);
      },
      async listOpenItems() {
        return client.listOpenItems();
      },
      async listBankTransactions(): Promise<OposBankTransaction[]> {
        const byAccountId = new Map(data.bankAccounts.map((account) => [account.id, account.defaultSkrAccountNumber]));
        const rows = await client.listAccountingTransactions();
        return rows.flatMap((row) => {
          const bankAccountNumber = row.accountId ? byAccountId.get(row.accountId) : undefined;
          if (!bankAccountNumber || (row.status !== 'pending' && row.status !== 'booked')) return [];
          const transaction: OposBankTransaction = {
            ...row,
            status: row.status as 'pending' | 'booked',
            accountId: row.accountId ?? '',
            bankAccountNumber,
          };
          return [transaction];
        });
      },
      allocateOpenItemPayment(input): Promise<OpenItemPaymentEntity> {
        return client.allocateOpenItemPayment(input, requireMutationReason(input.reason, 'Zahlung zuordnen')) as Promise<OpenItemPaymentEntity>;
      },
      allocateRemainingOpenItemPayment(paymentId, allocations, allocationEventId, reason): Promise<OpenItemPaymentEntity> {
        return client.allocateRemainingOpenItemPayment(
          paymentId,
          allocations,
          requireMutationReason(reason, 'Restzahlung zuordnen'),
          allocationEventId,
        ) as Promise<OpenItemPaymentEntity>;
      },
      listVendors() {
        return client.listAccountingVendors();
      },
      upsertVendor(vendor, reason) {
        return client.saveAccountingVendor(vendor, requireMutationReason(reason, 'Kreditor speichern'));
      },
      listIncomingInvoices() {
        return client.listIncomingInvoices();
      },
      upsertIncomingInvoice(invoice, reason) {
        return client.saveIncomingInvoice({ ...invoice, tenantId: data.sessionInfo.tenantId }, requireMutationReason(reason, 'Eingangsrechnung speichern'));
      },
      listIncomingInvoiceDocuments(invoiceId) {
        return client.listIncomingInvoiceDocuments(invoiceId);
      },
      uploadIncomingInvoiceDocument(input) {
        return client.uploadIncomingInvoiceDocument({ ...input, reason: requireMutationReason(input.reason, 'Eingangsbeleg archivieren') });
      },
      downloadIncomingInvoiceDocument(documentId) {
        return client.downloadIncomingInvoiceDocument(documentId);
      },
      reviewIncomingInvoiceDocument(input) {
        return client.reviewIncomingInvoiceDocument({ ...input, reason: requireMutationReason(input.reason, 'Eingangsbeleg prüfen') });
      },
      previewIncomingInvoiceAccounting(invoiceId) {
        return client.previewIncomingInvoice(invoiceId, 'Vorschau');
      },
      postIncomingInvoiceAccounting(invoiceId, options) {
        return client.postIncomingInvoice(invoiceId, requireMutationReason(options.reason, 'Eingangsrechnung buchen'), {
          softLockOverride: options.softLockOverride,
          overrideReason: options.overrideReason,
        });
      },
      async getReportMappingHealth(args) {
        const health = await client.getAccountMappingHealth(args?.chart, args?.statement, args?.asOfDate);
        return {
          chart: health.chart as 'SKR03' | 'SKR04',
          unmapped: (health.unmapped ?? []).map((entry: { accountNumber: string; statementType: string }) => ({
            accountNumber: entry.accountNumber,
            statement: entry.statementType as 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz',
          })),
        };
      },
      listReportMappingPositions(args) {
        return client.listReportMappingPositions(args.statement, args.asOfDate);
      },
      upsertReportMappingOverride(input) {
        return client.saveAccountMappingOverride({
          chart: input.chart,
          asOfDate: input.asOfDate,
          accountNumber: input.accountNumber,
          statementType: input.statement,
          positionKey: input.position,
          positionLabel: input.label,
          balanceSide: input.side,
          reason: requireMutationReason(input.reason, 'Report-Mapping speichern'),
        });
      },
      async getSusaReport(filters: ReportFilterState): Promise<SusaReport> {
        const report = await client.getSusaReport(reportFilter(filters));
        const names = new Map(data.ledgerAccounts.map((account) => [account.accountNumber, account.name]));
        const openingDebit = report.rows.reduce((sum, row) => sum + Math.max(0, row.openingBalance), 0);
        const openingCredit = report.rows.reduce((sum, row) => sum + Math.max(0, -row.openingBalance), 0);
        const warnings = report.rows.filter((row) => Boolean((row as { hasWarnings?: boolean }).hasWarnings)).length;
        return {
          rows: report.rows.map((row) => ({
            ...row,
            accountName: names.get(row.accountNumber) ?? row.accountNumber,
            normalBalance: row.closingBalance >= 0 ? 'debit' : 'credit',
          })),
          totals: {
            openingDebit,
            openingCredit,
            turnoverDebit: report.totals.debit,
            turnoverCredit: report.totals.credit,
            closingDebit: Math.max(0, report.totals.balance),
            closingCredit: Math.max(0, -report.totals.balance),
          },
          quality: { unmappedAccounts: report.unmappedAccounts?.length ?? 0, warnings, generatedAt: new Date().toISOString(), source: 'live' },
        };
      },
      async getGuvReport(filters: ReportFilterState): Promise<GuvReport> {
        const report = await client.getGuvReport(reportFilter(filters));
        return {
          lines: reportLines(report.rows),
          totals: {
            revenue: report.rows.filter((row) => row.position === 'revenue').reduce((sum, row) => sum + row.amount, 0),
            expenses: report.rows.filter((row) => row.position !== 'revenue' && row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount), 0),
            result: report.netResult,
          },
          quality: reportQuality(report.mappingHealth),
        };
      },
      async getEurReport(filters: ReportFilterState): Promise<GuvReport> {
        // EÜR is a calendar-year cash report; do not send the double-entry
        // chart or current fiscal-year filter to its native endpoint.
        const taxYear = Number(filters.asOfDate.slice(0, 4));
        const report = await client.getEurReport({ taxYear, ...nativeEurRange(taxYear) });
        const rows = report.rows.map((row) => ({
          position: row.id,
          label: row.kennziffer ? `${row.kennziffer} · ${row.label}` : row.label,
          amount: row.kind === 'expense' ? -row.total : row.total,
          accountNumbers: [] as string[],
          kind: row.kind === 'computed' ? 'subtotal' : 'line',
        }));
        return {
          lines: reportLines(rows),
          totals: { revenue: report.summary.incomeTotal, expenses: report.summary.expenseTotal, result: report.summary.surplus },
          quality: {
            unmappedAccounts: [],
            warnings: report.warnings.length + (report.unclassifiedCount > 0 ? 1 : 0),
            generatedAt: new Date().toISOString(),
            source: 'live',
            mappingStatus: report.warnings.length || report.unclassifiedCount > 0 ? 'blocked' : 'healthy',
            mappingNotes: [...report.warnings, ...(report.unclassifiedCount > 0 ? [`Nicht klassifiziert: ${report.unclassifiedCount}`] : [])],
          },
          filing: {
            kind: 'euer',
            taxYear: report.taxYear,
            catalog: report.catalog,
            lineProvenance: report.rows.map((row) => ({ lineId: row.id, kennziffer: row.kennziffer, providerPath: row.providerPath, exportable: row.exportable })),
          },
        };
      },
      listEurCashItems(taxYear = 2025) {
        return client.listEurCashItems({ taxYear, ...nativeEurRange(taxYear) }).then((items) => items.map(mapWebEurCashItem));
      },
      upsertEurClassification(input) {
        return client.upsertEurClassification({
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          taxYear: input.taxYear,
          eurLineId: input.eurLineId,
          excluded: input.excluded,
          vatMode: input.vatMode,
          vatRate: input.vatRate,
          note: input.note,
          reason: requireMutationReason(input.reason, 'EÜR-Klassifikation speichern'),
        });
      },
      async postAccountingCommand(input: AccountingCommandInput) {
        const result = await client.postAccountingCommand(input);
        return {
          status: result.replayed ? 'duplicate' as const : result.run.status === 'posted' ? 'posted' as const : result.run.status === 'rejected' ? 'rejected' as const : 'noop' as const,
          sourceRun: { ...result.run, sourceRevision: result.run.sourceRevision ?? '1' } as AccountingSourceRun,
          errors: result.run.status === 'rejected'
            ? [...accountingErrorsFrom(result.result), ...accountingErrorsFrom(result.run.result)].filter((issue, index, all) => all.findIndex((candidate) => candidate.code === issue.code && candidate.message === issue.message && candidate.field === issue.field) === index)
            : [],
          idempotencyKey: `${result.run.sourceType}:${result.run.sourceId}:${result.run.sourceRevision ?? '1'}`,
        };
      },
      async listAccountingSourceRuns(): Promise<AccountingSourceRun[]> {
        return (await client.listAccountingSourceRuns()).map((run) => ({ ...run, sourceRevision: run.sourceRevision ?? '1' } as AccountingSourceRun));
      },
      async prepareTaxExport(input) {
        const result = await client.prepareTaxExport(input);
        return { artifact: result.artifact as any, run: result.run as any, replayed: result.replayed };
      },
      exportTaxArtifact(kind, id) {
        return client.exportTaxArtifact(kind, id);
      },
      async saveEurCashFact(input: EurCashFactInput): Promise<EurCashFact> {
        return client.saveEurCashFact({ ...input, reason: requireMutationReason(input.reason, 'EÜR-Fakt speichern') }) as Promise<EurCashFact>;
      },
      listEurCashFacts(taxYear: number): Promise<EurCashFact[]> {
        return client.listEurCashFacts(taxYear) as Promise<EurCashFact[]>;
      },
      async saveEurAnnexFact(input: EurAnnexFactInput): Promise<EurAnnexFact> {
        return client.saveEurAnnexFact({ ...input, reason: requireMutationReason(input.reason, 'EÜR-Anlage speichern') }) as Promise<EurAnnexFact>;
      },
      listEurAnnexFacts(taxYear: number, annex?: string): Promise<EurAnnexFact[]> {
        return client.listEurAnnexFacts(taxYear, annex) as Promise<EurAnnexFact[]>;
      },
      async getManagementGuvReport(filters: ReportFilterState): Promise<GuvReport> {
        const report = await client.getManagementGuvReport(reportFilter(filters));
        return {
          lines: reportLines(report.rows),
          totals: { revenue: report.rows.filter((row) => row.position === 'revenue').reduce((sum, row) => sum + row.amount, 0), expenses: report.rows.filter((row) => row.position !== 'revenue' && row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount), 0), result: report.netResult },
          quality: reportQuality(report.mappingHealth),
        };
      },
      async getHgbGuvReport(filters: ReportFilterState): Promise<GuvReport> {
        const report = await client.getHgbGuvReport(reportFilter(filters));
        return {
          lines: reportLines(report.rows),
          totals: { revenue: report.rows.filter((row) => row.position === 'revenue').reduce((sum, row) => sum + row.amount, 0), expenses: report.rows.filter((row) => row.position !== 'revenue' && row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount), 0), result: report.netResult },
          quality: reportQuality(report.mappingHealth),
        };
      },
      async getBwaReport(filters: ReportFilterState): Promise<GuvReport> {
        const report = await client.getBwa01Report(reportFilter(filters));
        return {
          lines: reportLines(report.rows),
          totals: {
            revenue: report.totals.revenue,
            expenses: report.totals.expenses,
            result: report.totals.operatingResult,
          },
          quality: reportQuality(report.mappingHealth),
        };
      },
      async getBalanceSheetPreview(filters: ReportFilterState): Promise<BalanceSheetPreview> {
        const report = await client.getBilanzReport({ asOfDate: filters.asOfDate, chart: filters.chart });
        const unmappedNotes = report.mappingHealth.unmappedAccounts.map((accountNumber) => `Konto ${accountNumber} ist nicht zugeordnet.`);
        const mapping = reportQuality(report.mappingHealth);
        const mappingBlocked = report.mappingHealth.blocking || mapping.mappingStatus === 'blocked';
        return {
          aktiva: report.assets.map((row) => ({ id: row.position, code: row.position, label: row.label, amount: row.amount, level: row.parentPosition ? 1 : 0, side: 'aktiva' as const, accountRefs: row.accountRefs ?? row.accountNumbers, isSubtotal: row.kind === 'heading' || row.kind === 'subtotal' || row.kind === 'result' })),
          passiva: report.liabilities.map((row) => ({ id: row.position, code: row.position, label: row.label, amount: row.amount, level: row.parentPosition ? 1 : 0, side: 'passiva' as const, accountRefs: row.accountRefs ?? row.accountNumbers, isSubtotal: row.kind === 'heading' || row.kind === 'subtotal' || row.kind === 'result' })),
          totals: { aktiva: report.totals.assets, passiva: report.totals.liabilities, difference: report.totals.delta },
          quality: {
            status: mappingBlocked ? 'error' : Math.abs(report.totals.delta) < 0.01 && unmappedNotes.length === 0 ? 'ok' : 'warning',
            notes: [...unmappedNotes, ...report.mappingHealth.warnings],
            generatedAt: mapping.generatedAt,
            source: mapping.source,
            mappingStatus: mapping.mappingStatus,
            mappingNotes: mapping.mappingNotes,
            unmappedAccounts: mapping.unmappedAccounts,
          },
        };
      },
      async getReportDrilldownEntries(selection: ReportDrilldownSelection): Promise<ReportDrilldownEntry[]> {
        const rows = await client.listAccountingJournalEntries({
          accountNumbers: selection.accountNumbers,
          from: selection.from,
          to: selection.to,
        });
        return rows.flatMap((entry) => entry.lines.filter((line) => selection.accountNumbers.length === 0 || selection.accountNumbers.includes(line.accountNumber)).map((line) => ({
          id: line.id,
          date: entry.postingDate,
          bookingText: entry.bookingText,
          reference: entry.reference,
          journalEntryId: entry.id,
          sourceType: entry.sourceType === 'outgoing_invoice' ? 'invoice' : entry.sourceType === 'incoming_invoice' ? 'incoming_invoice' : entry.sourceType === 'payment' ? 'payment' : 'journal_entry',
          sourceId: entry.sourceKey ?? entry.id,
          transactionId: entry.sourceType === 'legacy_transaction' ? entry.sourceKey : undefined,
          accountNumber: line.accountNumber,
          debit: line.debitAmount,
          credit: line.creditAmount,
          amount: line.debitAmount || line.creditAmount,
          source: 'Manuell' as const,
        })));
      },
    };
  }, [accountingSeed, client, data, refreshData]);

  const handleSaveSettings = async () => {
    await runAction(async () => {
      await client.saveSettings(settingsDraft);
    }, 'Einstellungen gespeichert.');
  };

  const onboardingInitialData = React.useMemo<BusinessOnboardingDraft>(() => ({
    company: {
      name: settingsDraft.company.name,
      owner: settingsDraft.company.owner,
      street: settingsDraft.company.street,
      zip: settingsDraft.company.zip,
      city: settingsDraft.company.city,
      email: settingsDraft.company.email,
      phone: settingsDraft.company.phone,
      website: settingsDraft.company.website,
    },
    finance: {
      bankName: settingsDraft.finance.bankName,
      iban: settingsDraft.finance.iban,
      bic: settingsDraft.finance.bic,
      taxId: settingsDraft.finance.taxId,
      vatId: settingsDraft.finance.vatId,
      registerCourt: settingsDraft.finance.registerCourt,
    },
    legal: {
      smallBusinessRule: settingsDraft.legal.smallBusinessRule,
      defaultVatRate: settingsDraft.legal.defaultVatRate,
      paymentTermsDays: settingsDraft.legal.paymentTermsDays,
    },
    numbers: {
      invoicePrefix: settingsDraft.numbers.invoicePrefix,
      offerPrefix: settingsDraft.numbers.offerPrefix,
    },
    businessReportingProfile: settingsDraft.businessReportingProfile ?? {
      jurisdiction: 'DE',
      legalForm: 'gmbh',
      profitDetermination: 'double_entry',
      hgbSizeClass: 'small',
      fiscalYearStart: '01-01',
      chart: 'SKR03',
      vatMethod: settingsDraft.legal.taxAccountingMethod ?? 'soll',
    },
  }), [settingsDraft]);

  const handleCompleteOnboarding = async (draft: BusinessOnboardingDraft) => {
    const updatedSettings: SettingsRecord = {
      ...settingsDraft,
      company: { ...settingsDraft.company, ...draft.company },
      finance: { ...settingsDraft.finance, ...draft.finance },
      legal: {
        ...settingsDraft.legal,
        ...draft.legal,
        defaultVatRate: draft.legal.defaultVatRate ?? settingsDraft.legal.defaultVatRate,
        paymentTermsDays: draft.legal.paymentTermsDays ?? settingsDraft.legal.paymentTermsDays,
      },
      numbers: { ...settingsDraft.numbers, ...draft.numbers },
      businessReportingProfile: draft.businessReportingProfile,
      onboardingCompleted: true,
      onboardingDraftSaved: false,
    };

    setOnboardingSaving(true);
    try {
      await client.saveSettings(updatedSettings);
      setSettingsDraft(updatedSettings);
      await refreshData();
      setNotice(createNotice('success', 'Ersteinrichtung gespeichert.'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(createNotice('danger', message));
    } finally {
      setOnboardingSaving(false);
    }
  };

  const handleSaveOnboardingDraft = async (draft: BusinessOnboardingDraft) => {
    const updatedSettings: SettingsRecord = {
      ...settingsDraft,
      company: { ...settingsDraft.company, ...draft.company },
      finance: { ...settingsDraft.finance, ...draft.finance },
      legal: {
        ...settingsDraft.legal,
        ...draft.legal,
        defaultVatRate: draft.legal.defaultVatRate ?? settingsDraft.legal.defaultVatRate,
        paymentTermsDays: draft.legal.paymentTermsDays ?? settingsDraft.legal.paymentTermsDays,
      },
      numbers: { ...settingsDraft.numbers, ...draft.numbers },
      businessReportingProfile: draft.businessReportingProfile,
      onboardingCompleted: false,
      onboardingDraftSaved: true,
    };

    setOnboardingSaving(true);
    try {
      await client.saveSettings(updatedSettings);
      setSettingsDraft(updatedSettings);
      await refreshData();
      setNotice(createNotice('success', 'Entwurf gespeichert. Du kannst später weitermachen.'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(createNotice('danger', message));
      throw error;
    } finally {
      setOnboardingSaving(false);
    }
  };

  const handleCreateArticle = async () => {
    await runAction(async () => {
      await client.saveArticle({
        id: crypto.randomUUID(),
        sku: undefined,
        title: articleDraft.title,
        description: articleDraft.description,
        price: Number(articleDraft.price),
        unit: articleDraft.unit,
        category: articleDraft.category,
        taxRate: Number(articleDraft.taxRate),
      });
      setArticleDraft({ title: '', description: '', price: '0', unit: 'h', category: 'Beratung', taxRate: '19' });
    }, 'Artikel gespeichert.');
  };

  const handleCreateAccount = async () => {
    if (!accountDraft.name.trim() || !accountDraft.iban.trim()) {
      setNotice(createNotice('danger', 'Name und IBAN sind erforderlich. Bitte echte Kontodaten eingeben, kein Beispielformat.'));
      return;
    }
    await runAction(async () => {
      await client.saveAccount({
        id: crypto.randomUUID(),
        name: accountDraft.name,
        iban: accountDraft.iban,
        balance: Number(accountDraft.balance),
        defaultSkrAccountNumber: accountDraft.defaultSkrAccountNumber,
        transactions: [],
        type: accountDraft.type,
        color: accountDraft.color,
      });
      setAccountDraft({
        name: '',
        iban: '',
        balance: '0',
        defaultSkrAccountNumber: '1200',
        type: 'bank',
        color: '#3c6e71',
      });
    }, 'Bankkonto gespeichert.');
  };

  const handleCreateTemplate = async () => {
    await runAction(async () => {
      const timestamp = new Date().toISOString();
      await client.saveTemplate({
        id: crypto.randomUUID(),
        kind: templateDraft.kind,
        name: templateDraft.name,
        createdAt: timestamp,
        updatedAt: timestamp,
        elements: [],
      });
      setTemplateDraft((current) => ({ ...current, name: '' }));
    }, 'Vorlage gespeichert.');
  };

  const handleSetActiveTemplate = async (kind: 'invoice' | 'offer', templateId: string | null) => {
    await runAction(async () => {
      await client.setActiveTemplate({ kind, templateId });
    }, `Aktive ${kind === 'invoice' ? 'Rechnungs' : 'Angebots'}vorlage aktualisiert.`);
  };

  const handleSaveTaxMapping = async () => {
    await runAction(async () => {
      await client.saveTaxCaseMapping({
        chart: taxMappingDraft.chart,
        taxCaseKey: taxMappingDraft.taxCaseKey,
        role: taxMappingDraft.role,
        accountNumber: taxMappingDraft.accountNumber,
        datevBuKey: taxMappingDraft.datevBuKey || undefined,
        reason: 'Steuer-Mapping im Pro-Kontenplan aktualisiert',
      });
    }, 'Steuer-Mapping gespeichert.');
  };

  const handleSaveSuggestionRule = async () => {
    await runAction(async () => {
      await client.saveAccountSuggestionRule({
        chart: suggestionRuleDraft.chart,
        priority: Number(suggestionRuleDraft.priority),
        field: suggestionRuleDraft.field,
        operator: suggestionRuleDraft.operator,
        value: suggestionRuleDraft.value,
        targetAccountNumber: suggestionRuleDraft.targetAccountNumber,
        flowType: suggestionRuleDraft.flowType,
        active: true,
        reason: 'Kontierungsvorschlagsregel aktualisiert',
      });
      setSuggestionRuleDraft((current) => ({ ...current, value: '' }));
    }, 'Vorschlagsregel gespeichert.');
  };

  const handleDeleteSuggestionRule = async (ruleId: string) => {
    await runAction(async () => {
      await client.deleteAccountSuggestionRule(ruleId, 'Kontierungsvorschlagsregel gelöscht');
    }, 'Vorschlagsregel gelöscht.');
  };

  const handleDownloadDocument = async (kind: 'invoice' | 'offer', id: string, number: string) => {
    await runAction(async () => {
      const blob = await client.downloadDocumentJson(kind, id);
      triggerBlobDownload(blob, `${number || id}.json`);
    }, `${kind === 'invoice' ? 'Rechnung' : 'Angebot'} exportiert.`);
  };

  const handleDownloadCsv = async (kind: 'invoice' | 'offer') => {
    await runAction(async () => {
      const blob = await client.downloadDocumentsCsv(kind);
      triggerBlobDownload(blob, `${kind}s.csv`);
    }, `${kind === 'invoice' ? 'Rechnungs' : 'Angebots'}-CSV exportiert.`);
  };

  const handleCreateSampleWorkflow = async () => {
    if (!data || data.accountingTransactions.length === 0) {
      setNotice(createNotice('neutral', 'Alte Workflow-Snapshots können im Browser nur angezeigt werden.'));
      return;
    }
    await runAction(async () => {
      await client.upsertWorkflowEntry(buildSampleWorkflowPayload(data.sessionInfo.tenantId, data.ledgerAccounts));
      if (window.location.hash !== WORKFLOW_ROUTE_TARGET) {
        navigate('accounting');
      }
    }, 'Beispiel-Workflow angelegt.');
  };

  if (!session) {
    return (
      <AuthScreen
        product="pro"
        mode={authMode}
        serverUrl={apiUrl}
        defaultServerUrl={DEFAULT_API_URL}
        notice={notice && notice.tone !== 'success' ? notice.text : null}
        initialCredentials={DEV_CREDENTIALS}
        onSubmit={handleAuthenticate}
        onRetry={() => void refreshAuthMeta()}
        onServerUrlChange={handleServerUrlChange}
      />
    );
  }

  const openInvoices = data?.invoices.filter((invoice) => invoice.status !== 'paid').length ?? 0;
  const openOffers = data?.offers.filter((offer) => offer.status !== 'cancelled').length ?? 0;
  const activeClients = data?.clients.filter((clientRecord) => clientRecord.status === 'active').length ?? 0;
  const documentChains = (() => {
    const groups = new Map<string, NonNullable<typeof data>['invoices']>();
    for (const invoice of data?.invoices ?? []) {
      const rootId = invoice.rootDocumentId ?? invoice.id;
      const group = groups.get(rootId) ?? [];
      group.push(invoice);
      groups.set(rootId, group);
    }
    return [...groups.entries()]
      .map(([rootId, documents]) => ({
        rootId,
        documents: documents.slice().sort((left, right) => `${left.date}-${left.number}`.localeCompare(`${right.date}-${right.number}`)),
      }))
      .filter(({ documents }) => documents.length > 1);
  })();
  const showOnboarding = Boolean(data) && !loading && shouldShowBusinessOnboarding(settingsDraft);

  return (
    <main className="mx-auto min-h-screen w-full max-w-[90rem] px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Billme Pro im Browser</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">Pro-Buchhaltung und Dokumente im Browser</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Angemeldet als {formatEmptyValue(session.user.fullName)}
          </p>
          <TechnicalDetails apiUrl={apiUrl} data={data} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => void refreshData()} disabled={loading}>
            {loading ? 'Lädt…' : 'Neu laden'}
          </Button>
          <Button variant="ghost" onClick={handleLogout}>
            Abmelden
          </Button>
        </div>
      </div>

      <NoticeBanner notice={notice} />
      {loadError ? <NoticeBanner notice={createNotice('danger', loadError)} /> : null}

      <nav
        className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3"
        aria-label="Pro-Navigation"
      >
        {ROUTES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`rounded-lg border p-4 text-left transition-colors motion-reduce:transition-none ${
              route === item.id
                ? 'border-foreground bg-foreground text-background'
                : 'border-control-border bg-surface hover:bg-surface-muted'
            }`}
            onClick={() => navigate(item.id)}
            aria-current={route === item.id ? 'page' : undefined}
          >
            <strong className="block text-sm font-semibold">{item.label}</strong>
            <span className={`mt-1 block text-xs ${route === item.id ? 'text-background' : 'text-muted'}`}>{item.summary}</span>
          </button>
        ))}
      </nav>

      {data ? (
        <>
          {route === 'overview' ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-4">
              <SectionCard eyebrow="Übersicht" title="Mandant und Nutzung">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
                  <StatCard label="Kunden" value={String(activeClients)} hint="aktive Kundensätze" />
                  <StatCard label="Dokumente offen" value={String(openInvoices + openOffers)} hint="Rechnungen + Angebote" />
                  <StatCard label="Kontenrahmen" value={String(data.ledgerStats.total)} hint="geladene Konten" />
                  <StatCard label="Workflow" value={String(data.workflowEntries.length)} hint="gespeicherte Einträge" />
                </div>
              </SectionCard>

              <SectionCard eyebrow="Funktionen" title="Im Browser verfügbar">
                <ul className="grid list-disc gap-2 pl-5 text-sm leading-relaxed text-foreground">
                  <li>Kunden, Artikel, Bankkonten und Vorlagen pflegen.</li>
                  <li>Rechnungen, Angebote und Buchhaltungsdaten einsehen und exportieren.</li>
                  <li>Workflow-Einträge und Buchhaltungsregeln direkt im Browser bearbeiten.</li>
                </ul>
              </SectionCard>
            </div>
          ) : null}

          {route === 'documents' ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {documentChains.length > 0 ? (
                <SectionCard eyebrow="Vorgang" title="Dokumentkette und Revisionen">
                  <div className="divide-y divide-border-subtle" data-testid="document-chain-overview">
                    {documentChains.map(({ rootId, documents }) => (
                      <div className="flex flex-wrap items-start justify-between gap-4 py-3" key={rootId} data-testid={`document-chain-row-${rootId}`}>
                        <div className="grid gap-0.5">
                          <strong className="text-sm font-semibold text-foreground">{documents[0] ? invoiceChainLabel(documents[0]) : 'Dokument'} · {documents[0]?.number}</strong>
                          <span className="text-xs text-muted">{documents.map((invoice) => `${invoiceChainLabel(invoice)} · ${invoice.number}`).join(' → ')}</span>
                        </div>
                        <span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-semibold text-foreground">{documents.length} Dokumente</span>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              ) : null}
              <SectionCard
                eyebrow="Rechnungen"
                title="Vertrieb und Export"
                actions={
                  <Button variant="secondary" onClick={() => void handleDownloadCsv('invoice')}>
                    Rechnungen CSV
                  </Button>
                }
              >
                {data.invoices.length === 0 ? (
                  <EmptyState
                    title="Noch keine Rechnungen"
                    description="Sobald der Server Rechnungen enthält, werden sie hier mit History und Export angezeigt."
                  />
                ) : (
                  <DataTable>
                    <table>
                      <thead>
                        <tr>
                          <th>Nummer</th>
                          <th>Dokument</th>
                          <th>Kunde</th>
                          <th>Status</th>
                          <th>Betrag</th>
                          <th>Datum</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.invoices.slice(0, 12).map((invoice) => (
                          <tr key={invoice.id}>
                            <td>{invoice.number}</td>
                            <td>
                              <div className="grid gap-0.5">
                                <strong>{invoiceDocumentLabel(invoice.documentKind)}</strong>
                                {invoice.revisionOfId ? <span>Revision {invoice.revisionNumber ?? 1}</span> : null}
                              </div>
                            </td>
                            <td>{invoice.client}</td>
                            <td>{labelFromMap(invoiceStatusLabels, invoice.status)}</td>
                            <td>{formatCurrency(invoice.amount)}</td>
                            <td>{formatDate(invoice.date)}</td>
                            <td>
                              <button
                                type="button"
                                className="inline-flex min-h-6 items-center text-sm font-semibold text-foreground underline decoration-control-border underline-offset-4 transition-colors motion-reduce:transition-none hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:text-disabled-foreground disabled:no-underline"
                                onClick={() => void handleDownloadDocument('invoice', invoice.id, invoice.number)}
                              >
                                JSON exportieren
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                )}
              </SectionCard>

              <SectionCard
                eyebrow="Angebote"
                title="Angebote und Entscheidungsstand"
                actions={
                  <Button variant="secondary" onClick={() => void handleDownloadCsv('offer')}>
                    Angebote CSV
                  </Button>
                }
              >
                {data.offers.length === 0 ? (
                  <EmptyState
                    title="Noch keine Angebote"
                    description="Hier erscheinen geteilte Angebote inklusive Entscheidung und Export-Status."
                  />
                ) : (
                  <DataTable>
                    <table>
                      <thead>
                        <tr>
                          <th>Nummer</th>
                          <th>Kunde</th>
                          <th>Status</th>
                          <th>Entscheidung</th>
                          <th>Betrag</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.offers.slice(0, 12).map((offer) => (
                          <tr key={offer.id}>
                            <td>{offer.number}</td>
                            <td>{offer.client}</td>
                            <td>{labelFromMap(offerStatusLabels, offer.status)}</td>
                            <td>{offer.share?.decision ? labelFromMap(offerDecisionLabels, offer.share.decision) : 'Offen'}</td>
                            <td>{formatCurrency(offer.amount)}</td>
                            <td>
                              <button
                                type="button"
                                className="inline-flex min-h-6 items-center text-sm font-semibold text-foreground underline decoration-control-border underline-offset-4 transition-colors motion-reduce:transition-none hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:text-disabled-foreground disabled:no-underline"
                                onClick={() => void handleDownloadDocument('offer', offer.id, offer.number)}
                              >
                                JSON exportieren
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                )}
              </SectionCard>
            </div>
          ) : null}

          {route === 'clients' ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-4">
              <SectionCard eyebrow="Kundenstamm" title="Mandanten und Projekte">
                {data.clients.length === 0 ? (
                  <EmptyState
                    title="Keine Kunden vorhanden"
                    description="Die Liste stammt aus Desktop und Server-API. Der Browser greift nicht auf SQLite zu."
                  />
                ) : (
                  <DataTable>
                    <table>
                      <thead>
                        <tr>
                          <th>Kunde</th>
                          <th>Ansprechpartner</th>
                          <th>Status</th>
                          <th>Kundennr.</th>
                          <th>Projekte</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.clients.map((clientRecord) => (
                          <tr key={clientRecord.id}>
                            <td>
                              <div className="grid gap-0.5">
                                <strong>{clientRecord.company}</strong>
                                <span>{clientRecord.email}</span>
                              </div>
                            </td>
                            <td>{formatEmptyValue(clientRecord.contactPerson)}</td>
                            <td>{labelFromMap(clientStatusLabels, clientRecord.status)}</td>
                            <td>{formatEmptyValue(clientRecord.customerNumber)}</td>
                            <td>{clientRecord.projects.length}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                )}
              </SectionCard>
            </div>
          ) : null}

          {route === 'catalog' ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <SectionCard eyebrow="Artikel" title="Leistungs- und Produktkatalog">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Input label="Titel" fullWidth value={articleDraft.title} onChange={(event) => setArticleDraft((current) => ({ ...current, title: event.target.value }))} />
                  <Input label="Preis" fullWidth value={articleDraft.price} onChange={(event) => setArticleDraft((current) => ({ ...current, price: event.target.value }))} />
                  <Input label="Einheit" fullWidth value={articleDraft.unit} onChange={(event) => setArticleDraft((current) => ({ ...current, unit: event.target.value }))} />
                  <Input label="Kategorie" fullWidth value={articleDraft.category} onChange={(event) => setArticleDraft((current) => ({ ...current, category: event.target.value }))} />
                  <Input label="Steuer %" fullWidth value={articleDraft.taxRate} onChange={(event) => setArticleDraft((current) => ({ ...current, taxRate: event.target.value }))} />
                  <Input label="Beschreibung" fullWidth value={articleDraft.description} onChange={(event) => setArticleDraft((current) => ({ ...current, description: event.target.value }))} />
                </div>
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <Button onClick={() => void handleCreateArticle()}>Artikel speichern</Button>
                </div>
                <DataTable>
                  <table>
                    <thead>
                      <tr>
                        <th>Titel</th>
                        <th>Kategorie</th>
                        <th>Einheit</th>
                        <th>Preis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.articles.map((article) => (
                        <tr key={article.id}>
                          <td>{article.title}</td>
                          <td>{article.category}</td>
                          <td>{article.unit}</td>
                          <td>{formatCurrency(article.price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>

              <SectionCard eyebrow="Konten" title="Bankkonten und Default-SKR-Zuordnung">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Input label="Name" fullWidth value={accountDraft.name} onChange={(event) => setAccountDraft((current) => ({ ...current, name: event.target.value }))} />
                  <Input label="IBAN" fullWidth value={accountDraft.iban} placeholder="DE00 0000 0000 0000 0000 00 (Beispielformat, hier echte IBAN eingeben)" onChange={(event) => setAccountDraft((current) => ({ ...current, iban: event.target.value }))} />
                  <Input label="Saldo" fullWidth value={accountDraft.balance} onChange={(event) => setAccountDraft((current) => ({ ...current, balance: event.target.value }))} />
                  <Input
                    label="Default SKR-Konto"
                    fullWidth
                    value={accountDraft.defaultSkrAccountNumber}
                    onChange={(event) => setAccountDraft((current) => ({ ...current, defaultSkrAccountNumber: event.target.value }))}
                  />
                  <Select label="Kontoart" fullWidth value={accountDraft.type} onChange={(event) => setAccountDraft((current) => ({ ...current, type: event.target.value as typeof current.type }))}>
                    {Object.entries(accountTypeLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <Input label="Farbe" fullWidth value={accountDraft.color} onChange={(event) => setAccountDraft((current) => ({ ...current, color: event.target.value }))} />
                </div>
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <Button onClick={() => void handleCreateAccount()}>Bankkonto speichern</Button>
                </div>
                <DataTable>
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>IBAN</th>
                        <th>Typ</th>
                        <th>SKR</th>
                        <th>Saldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bankAccounts.map((account) => (
                        <tr key={account.id}>
                          <td>{account.name}</td>
                          <td>{account.iban}</td>
                          <td>{labelFromMap(accountTypeLabels, account.type)}</td>
                          <td>{account.defaultSkrAccountNumber}</td>
                          <td>{formatCurrency(account.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>

              <SectionCard eyebrow="Vorlagen" title="Serverweite Templates und aktive Auswahl">
                <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Select label="Typ" fullWidth value={templateDraft.kind} onChange={(event) => setTemplateDraft({ kind: event.target.value as 'invoice' | 'offer', name: templateDraft.name })}>
                    {Object.entries(templateKindLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <Input label="Name" fullWidth value={templateDraft.name} onChange={(event) => setTemplateDraft((current) => ({ ...current, name: event.target.value }))} />
                  <div className="grid gap-2 text-sm font-medium text-foreground">
                    <span>Aktiv</span>
                    <strong className="flex min-h-12 items-center rounded-xl border border-control-border bg-surface-muted px-4 text-sm font-semibold text-foreground">
                      {data.activeTemplates[templateDraft.kind]?.name ?? 'keine aktive Vorlage'}
                    </strong>
                  </div>
                </div>
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <Button onClick={() => void handleCreateTemplate()}>Leere Vorlage speichern</Button>
                </div>
                <DataTable>
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Typ</th>
                        <th>Aktualisiert</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.templates.map((template) => (
                        <tr key={template.id}>
                          <td>{template.name}</td>
                          <td>{labelFromMap(templateKindLabels, template.kind)}</td>
                          <td>{formatDate(template.updatedAt)}</td>
                          <td>
                            <button
                              type="button"
                              className="inline-flex min-h-6 items-center text-sm font-semibold text-foreground underline decoration-control-border underline-offset-4 transition-colors motion-reduce:transition-none hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:text-disabled-foreground disabled:no-underline"
                              onClick={() => void handleSetActiveTemplate(template.kind, template.id)}
                            >
                              Aktiv setzen
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>
            </div>
          ) : null}

          {route === 'recurring' ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-4">
              <SectionCard eyebrow="Wiederkehrende Rechnungen" title="Profile und Automatisierungsfenster">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
                  <StatCard label="Profile" value={String(data.recurringProfiles.length)} hint="registrierte Serienläufe" />
                  <StatCard
                    label="Mahnwesen"
                    value={data.settings?.automation.dunningEnabled ? 'aktiv' : 'inaktiv'}
                    hint={`Laufzeit ${formatEmptyValue(data.settings?.automation.dunningRunTime)}`}
                  />
                  <StatCard
                    label="Wiederkehrende Rechnungen"
                    value={data.settings?.automation.recurringEnabled ? 'aktiv' : 'inaktiv'}
                    hint={`Laufzeit ${formatEmptyValue(data.settings?.automation.recurringRunTime)}`}
                  />
                </div>
                {data.recurringProfiles.length === 0 ? (
                  <EmptyState
                    title="Noch keine Wiederholungen"
                    description="Die Ansicht zeigt Serverprofile. Lokale Scheduler des Electron-Hauptprozesses laufen hier nicht."
                  />
                ) : (
                  <DataTable>
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Intervall</th>
                          <th>Nächster Lauf</th>
                          <th>Status</th>
                          <th>Betrag</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recurringProfiles.map((profile) => (
                          <tr key={profile.id}>
                            <td>{profile.name}</td>
                            <td>{labelFromMap(recurringIntervalLabels, profile.interval)}</td>
                            <td>{formatDate(profile.nextRun)}</td>
                            <td>{profile.active ? 'aktiv' : 'pausiert'}</td>
                            <td>{formatCurrency(profile.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                )}
              </SectionCard>
            </div>
          ) : null}

          {route === 'settings' ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-4">
              <SectionCard eyebrow="Einstellungen" title="Firmenkopf und Nummernkreise">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Firmenname"
                    fullWidth
                    value={settingsDraft.company.name}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        company: { ...current.company, name: event.target.value },
                      }))
                    }
                  />
                  <Input
                    label="Owner"
                    fullWidth
                    value={settingsDraft.company.owner}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        company: { ...current.company, owner: event.target.value },
                      }))
                    }
                  />
                  <Input
                    label="E-Mail"
                    fullWidth
                    value={settingsDraft.company.email}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        company: { ...current.company, email: event.target.value },
                      }))
                    }
                  />
                  <Input
                    label="Website"
                    fullWidth
                    value={settingsDraft.company.website}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        company: { ...current.company, website: event.target.value },
                      }))
                    }
                  />
                  <Input
                    label="Rechnungspräfix"
                    fullWidth
                    value={settingsDraft.numbers.invoicePrefix}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        numbers: { ...current.numbers, invoicePrefix: event.target.value },
                      }))
                    }
                  />
                  <Input
                    label="Angebotspräfix"
                    fullWidth
                    value={settingsDraft.numbers.offerPrefix}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        numbers: { ...current.numbers, offerPrefix: event.target.value },
                      }))
                    }
                  />
                  <Input
                    label="MwSt-Standard %"
                    fullWidth
                    value={String(settingsDraft.legal.defaultVatRate)}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        legal: { ...current.legal, defaultVatRate: Number(event.target.value) || 0 },
                      }))
                    }
                  />
                  <Input
                    label="Zahlungsziel in Tagen"
                    fullWidth
                    value={String(settingsDraft.legal.paymentTermsDays)}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        legal: { ...current.legal, paymentTermsDays: Number(event.target.value) || 0 },
                      }))
                    }
                  />
                  <Input
                    label="Monatliches Umsatzziel"
                    fullWidth
                    value={String(settingsDraft.dashboard.monthlyRevenueGoal)}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        dashboard: { ...current.dashboard, monthlyRevenueGoal: Number(event.target.value) || 0 },
                      }))
                    }
                  />
                  <Input
                    label="Portal-Basis-URL"
                    fullWidth
                    value={settingsDraft.portal.baseUrl}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        portal: { ...current.portal, baseUrl: event.target.value },
                      }))
                    }
                  />
                </div>
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <Button onClick={() => void handleSaveSettings()}>Einstellungen speichern</Button>
                </div>
              </SectionCard>
            </div>
          ) : null}

          {route === 'accounting' ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <SectionCard
                eyebrow="Buchhaltung"
                title="Ledger, Regeln und Workflow-Snapshots"
                actions={
                  <Button variant="secondary" onClick={() => void handleCreateSampleWorkflow()} disabled={data.accountingTransactions.length === 0}>
                    {data.accountingTransactions.length > 0 ? 'Beispiel-Workflow anlegen' : 'Alte Snapshots nur lesen'}
                  </Button>
                }
              >
                <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
                  <StatCard label="SKR03" value={String(data.ledgerStats.byChart.SKR03)} hint="Konten im Kontenrahmen" />
                  <StatCard label="SKR04" value={String(data.ledgerStats.byChart.SKR04)} hint="Konten im Kontenrahmen" />
                  <StatCard label="Steuerfälle" value={String(data.taxCases.length)} hint="aktive Steuerfälle" />
                  <StatCard label="Regeln" value={String(data.suggestionRules.length)} hint="Kontovorschläge" />
                </div>
                <p className="text-sm leading-relaxed text-muted">
                  {data.accountingTransactions.length > 0
                    ? 'Entwürfe, Buchungen und Auswertungen werden direkt auf dem Server gespeichert.'
                    : 'Gespeicherte Workflow-Einträge können nur angezeigt werden. Änderungen sind erst möglich, wenn Buchhaltungsdaten vorliegen.'}
                </p>
              </SectionCard>

              <SectionCard eyebrow="Steuer-Mapping" title="Steuerfälle Konten zuordnen">
                {!canMutateAccountingRules ? <p className="text-sm leading-relaxed text-muted" role="status">Ihre Rolle darf Steuer-Mappings nur lesen.</p> : null}
                <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Select label="Kontenrahmen" fullWidth disabled={!canMutateAccountingRules} value={taxMappingDraft.chart} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, chart: event.target.value as 'SKR03' | 'SKR04' }))}>
                    <option value="SKR03">SKR03</option>
                    <option value="SKR04">SKR04</option>
                  </Select>
                  <Select label="Steuerfall" fullWidth disabled={!canMutateAccountingRules} value={taxMappingDraft.taxCaseKey} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, taxCaseKey: event.target.value }))}>
                    {data.taxCases.map((taxCase) => (
                      <option key={taxCase.key} value={taxCase.key}>
                        {taxCase.key}
                      </option>
                    ))}
                  </Select>
                  <Select label="Rolle" fullWidth disabled={!canMutateAccountingRules} value={taxMappingDraft.role} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, role: event.target.value as typeof current.role }))}>
                    <option value="output_tax">Umsatzsteuer</option>
                    <option value="input_tax">Vorsteuer</option>
                    <option value="datev_bu">DATEV-BU</option>
                  </Select>
                  <Input disabled={!canMutateAccountingRules} label="Konto" fullWidth value={taxMappingDraft.accountNumber} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, accountNumber: event.target.value }))} />
                  <Input disabled={!canMutateAccountingRules} label="DATEV-BU-Schlüssel" fullWidth value={taxMappingDraft.datevBuKey} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, datevBuKey: event.target.value }))} />
                </div>
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <Button disabled={!canMutateAccountingRules} onClick={() => void handleSaveTaxMapping()}>Mapping speichern</Button>
                </div>
                <DataTable>
                  <table>
                    <thead>
                      <tr>
                        <th>Steuerfall</th>
                        <th>Kontenrahmen</th>
                        <th>Rolle</th>
                        <th>Konto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.taxMappings.map((mapping) => (
                        <tr key={mapping.id}>
                          <td>{mapping.taxCaseKey}</td>
                          <td>{mapping.chart}</td>
                          <td>{taxRoleLabels[mapping.role as keyof typeof taxRoleLabels] ?? mapping.role}</td>
                          <td>{mapping.accountNumber}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>

              <SectionCard eyebrow="Kontovorschläge" title="Regelbasierte Kontovorschläge im Browser pflegen">
                {!canMutateAccountingRules ? <p className="text-sm leading-relaxed text-muted" role="status">Ihre Rolle darf Vorschlagsregeln nur lesen.</p> : null}
                <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Select label="Kontenrahmen" fullWidth disabled={!canMutateAccountingRules} value={suggestionRuleDraft.chart} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, chart: event.target.value as 'SKR03' | 'SKR04' }))}>
                    <option value="SKR03">SKR03</option>
                    <option value="SKR04">SKR04</option>
                  </Select>
                  <Input disabled={!canMutateAccountingRules} label="Priorität" fullWidth value={suggestionRuleDraft.priority} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, priority: event.target.value }))} />
                  <Select label="Feld" fullWidth disabled={!canMutateAccountingRules} value={suggestionRuleDraft.field} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, field: event.target.value as typeof current.field }))}>
                    <option value="counterparty">Gegenpartei</option>
                    <option value="purpose">Verwendungszweck</option>
                    <option value="any">Beliebiges Feld</option>
                  </Select>
                  <Select label="Vergleich" fullWidth disabled={!canMutateAccountingRules} value={suggestionRuleDraft.operator} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, operator: event.target.value as typeof current.operator }))}>
                    <option value="contains">enthält</option>
                    <option value="equals">ist gleich</option>
                    <option value="startsWith">beginnt mit</option>
                  </Select>
                  <Input disabled={!canMutateAccountingRules} label="Suchwert" fullWidth value={suggestionRuleDraft.value} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, value: event.target.value }))} />
                  <Input
                    disabled={!canMutateAccountingRules}
                    label="Zielkonto"
                    fullWidth
                    value={suggestionRuleDraft.targetAccountNumber}
                    onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, targetAccountNumber: event.target.value }))}
                  />
                  <Select label="Art" fullWidth disabled={!canMutateAccountingRules} value={suggestionRuleDraft.flowType} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, flowType: event.target.value as typeof current.flowType }))}>
                    <option value="income">Einnahme</option>
                    <option value="expense">Ausgabe</option>
                    <option value="any">Beliebig</option>
                  </Select>
                </div>
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <Button disabled={!canMutateAccountingRules} onClick={() => void handleSaveSuggestionRule()}>Regel speichern</Button>
                </div>
                <DataTable>
                  <table>
                    <thead>
                      <tr>
                        <th>Priorität</th>
                        <th>Treffer</th>
                        <th>Zielkonto</th>
                        <th>Art</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.suggestionRules.map((rule) => (
                        <tr key={rule.id}>
                          <td>{rule.priority}</td>
                          <td>{`${suggestionFieldLabels[rule.field as keyof typeof suggestionFieldLabels] ?? rule.field} ${suggestionOperatorLabels[rule.operator as keyof typeof suggestionOperatorLabels] ?? rule.operator} ${rule.value}`}</td>
                          <td>{rule.targetAccountNumber}</td>
                          <td>{suggestionFlowLabels[rule.flowType as keyof typeof suggestionFlowLabels] ?? rule.flowType}</td>
                          <td>
                            <button type="button" className="inline-flex min-h-6 items-center text-sm font-semibold text-foreground underline decoration-control-border underline-offset-4 transition-colors motion-reduce:transition-none hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:text-disabled-foreground disabled:no-underline" disabled={!canMutateAccountingRules} onClick={() => void handleDeleteSuggestionRule(rule.id)}>
                              Löschen
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>

              <SectionCard eyebrow="Arbeitsbereich" title="Pro-Buchhaltung im Browser" className="lg:col-span-2">
                {accountingSeed && accountingDataAdapter ? (
                  <div className="overflow-hidden rounded-xl border border-border bg-surface">
                    <ProAccountingWorkspace
                      seed={accountingSeed}
                      dataAdapter={accountingDataAdapter}
                      role={workspaceRole}
                      assetsAvailable
                    />
                  </div>
                ) : (
                  <EmptyState title="Arbeitsbereich nicht verfügbar" description="Die Buchhaltungsdaten konnten nicht für den Arbeitsbereich bereitgestellt werden." />
                )}
              </SectionCard>
            </div>
          ) : null}
        </>
      ) : (
        <SectionCard eyebrow="Ladezustand" title="Pro-Daten werden geladen">
          <p className="text-sm leading-relaxed text-muted">Die Pro-API liefert Kataloge, Rechnungen und Buchhaltungsdaten.</p>
        </SectionCard>
      )}
      {showOnboarding ? (
        <BusinessOnboarding
          initialData={onboardingInitialData}
          onSubmit={handleCompleteOnboarding}
          onSaveAndExit={handleSaveOnboardingDraft}
          saving={onboardingSaving}
          productName="Billme Pro"
          submitLabel="Arbeitsbereich einrichten"
          edition="pro"
        />
      ) : null}
    </main>
  );
}
