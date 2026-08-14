import React from 'react';
import {
  BusinessOnboarding,
  Button,
  Input,
  shouldShowBusinessOnboarding,
  type BusinessOnboardingDraft,
} from '@billme/ui';
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

type AuthMeta = {
  health: Awaited<ReturnType<ProWebClient['getHealth']>> | null;
  capabilities: Awaited<ReturnType<ProWebClient['getCapabilities']>> | null;
  bootstrapStatus: Awaited<ReturnType<ProWebClient['getBootstrapStatus']>> | null;
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
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(parsed);
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
    externalReference: draft.reference,
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
        evidenceReference: line.evidenceReference,
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
  <div className="stat-card">
    <span className="stat-label">{label}</span>
    <strong className="stat-value">{value}</strong>
    <span className="stat-hint">{hint}</span>
  </div>
);

const SectionCard = ({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="section-card">
    <header className="section-header">
      <div>
        <p className="section-eyebrow">{eyebrow}</p>
        <h2 className="section-title">{title}</h2>
      </div>
      {actions ? <div className="section-actions">{actions}</div> : null}
    </header>
    {children}
  </section>
);

const NoticeBanner = ({ notice }: { notice: Notice }) => {
  if (!notice) {
    return null;
  }
  return <div className={`notice-banner notice-${notice.tone}`}>{notice.text}</div>;
};

const EmptyState = ({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) => (
  <div className="empty-state">
    <strong>{title}</strong>
    <p>{body}</p>
    {action}
  </div>
);

const DataTable = ({ children }: { children: React.ReactNode }) => <div className="table-wrap">{children}</div>;

export default function App() {
  const [session, setSession] = React.useState<StoredSession | null>(() => readStoredSession());
  const [apiUrl, setApiUrl] = React.useState(() => readStoredSession()?.apiUrl ?? getApiUrlFromStorage());
  const [route, navigate] = useHashRoute();
  const [authMeta, setAuthMeta] = React.useState<AuthMeta>({
    health: null,
    capabilities: null,
    bootstrapStatus: null,
  });
  const [authPending, setAuthPending] = React.useState(false);
  const [data, setData] = React.useState<AppData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [loadError, setLoadError] = React.useState<string>('');
  const [onboardingSaving, setOnboardingSaving] = React.useState(false);
  const [email, setEmail] = React.useState('owner@example.com');
  const [password, setPassword] = React.useState('billme-server-123');
  const [fullName, setFullName] = React.useState('Billme Pro Owner');
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
    iban: 'DE00 0000 0000 0000 0000 00',
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
    setAuthPending(true);
    try {
      const [health, capabilities, bootstrapStatus] = await Promise.all([
        client.getHealth(),
        client.getCapabilities(),
        client.getBootstrapStatus(),
      ]);
      setAuthMeta({ health, capabilities, bootstrapStatus });
      setNotice(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(createNotice('danger', message));
    } finally {
      setAuthPending(false);
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

  React.useEffect(() => {
    if (session) {
      void refreshData();
      return;
    }
    void refreshAuthMeta();
  }, [refreshAuthMeta, refreshData, session]);

  const handleAuthenticate = async () => {
    setAuthPending(true);
    try {
      const response = authMeta.bootstrapStatus?.bootstrapped
        ? await client.login({ email, password })
        : await client.bootstrap({ email, password, fullName });
      const nextSession = { ...response, apiUrl };
      setSession(nextSession);
      persistSession(nextSession);
      setNotice(
        createNotice(
          'success',
          authMeta.bootstrapStatus?.bootstrapped
            ? `Angemeldet als ${response.user.fullName}.`
            : `Owner ${response.user.fullName} angelegt und angemeldet.`,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(createNotice('danger', message));
    } finally {
      setAuthPending(false);
    }
  };

  const handleLogout = React.useCallback(() => {
    setSession(null);
    setData(null);
    persistSession(null);
    setNotice(createNotice('neutral', 'Abgemeldet.'));
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
      throw new Error(`${operation} is unavailable in the legacy snapshot fallback. Reload canonical accounting data.`);
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
        const entries = await client.listAccountingJournalEntries({ limit: 5000, offset: 0 });
        return entries.find((entry) => entry.id === id) ?? null;
      },
      async saveDraft(draft: WorkspaceBookingDraft, actorName = 'Web Pro') {
        if (!canonical) return readOnly('Draft mutation');
        const saved = await client.saveAccountingDraft(
          mapWorkspaceDraftToEntity(draft, data.sessionInfo.tenantId),
          requireMutationReason(actorName, 'Speichern des Entwurfs'),
        );
        await refreshCanonicalSnapshots();
        await refreshData();
        return mapWorkflowDraftToWorkspace(saved);
      },
      async dispatchBookingAction(transactionId: string, action: string, options?: { actorName?: string; rejectReason?: string }) {
        if (!canonical) return readOnly('Workflow mutation');
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
        return readOnly('Workspace reset');
      },
      async updateExceptionCase(_transactionId: string, _patch: Partial<NonNullable<WorkspaceTransaction['exceptionCase']>>, _actorName: string) {
        return readOnly('Exception mutation');
      },
      async assignExceptionOwner(_transactionId: string, _owner: string, _actorName: string) {
        return readOnly('Exception mutation');
      },
      async snoozeException(_transactionId: string, _snoozedUntil: string, _actorName: string, _note?: string) {
        return readOnly('Exception mutation');
      },
      async resolveException(_transactionId: string, _resolutionNote: string, _actorName: string) {
        return readOnly('Exception mutation');
      },
      async reopenException(_transactionId: string, _actorName: string) {
        return readOnly('Exception mutation');
      },
      async setTransactionReceiptStatus(_transactionId: string, _hasReceipt: boolean, _actorName: string) {
        return readOnly('Receipt mutation');
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
  }), [settingsDraft]);

  const handleCompleteOnboarding = async (draft: BusinessOnboardingDraft) => {
    const updatedSettings: SettingsRecord = {
      ...settingsDraft,
      company: { ...settingsDraft.company, ...draft.company },
      finance: { ...settingsDraft.finance, ...draft.finance },
      legal: { ...settingsDraft.legal, ...draft.legal },
      numbers: { ...settingsDraft.numbers, ...draft.numbers },
      onboardingCompleted: true,
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
        iban: 'DE00 0000 0000 0000 0000 00',
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
      setNotice(createNotice('neutral', 'Legacy-Workflow-Snapshots sind im Web nur lesbar.'));
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
      <main className="auth-shell">
        <section className="auth-hero">
          <p className="hero-kicker">Billme Pro · Browser Shell</p>
          <h1>Server-Modus für Pro-Buchhaltung, ohne Electron-Annahmen.</h1>
          <p className="hero-copy">
            Dieses Web-Shell spricht direkt mit der neuen Fastify-API, speichert Sitzungen im Browser und nutzt die
            geteilten Pro-Domänen für Workflow-, Katalog- und Accounting-Oberflächen.
          </p>
          <div className="hero-metrics">
            <StatCard
              label="Produkte"
              value={authMeta.capabilities?.products.join(' / ') ?? '…'}
              hint="Pro ist als eigener Auth-Scope aktiv."
            />
            <StatCard
              label="Rollen"
              value={String(authMeta.capabilities?.auth.roles.length ?? 0)}
              hint="Mehrbenutzerbetrieb ab Tag eins."
            />
            <StatCard
              label="Bootstrap"
              value={authMeta.bootstrapStatus?.bootstrapped ? 'aktiv' : 'offen'}
              hint="Owner-Setup pro Deployment."
            />
          </div>
        </section>

        <section className="auth-panel">
          <NoticeBanner notice={notice} />
          <SectionCard
            eyebrow="Verbindung"
            title="API prüfen und anmelden"
            actions={
              <Button variant="secondary" onClick={() => void refreshAuthMeta()} disabled={authPending}>
                Status laden
              </Button>
            }
          >
            <div className="form-grid two-col compact-grid">
              <Input label="Server API URL" fullWidth value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} />
              <div className="meta-chip-row">
                <span className="meta-chip">{authMeta.health?.service ?? 'Kein Healthcheck'}</span>
                <span className="meta-chip">{authMeta.health?.backend ?? '—'}</span>
                <span className="meta-chip">{authMeta.capabilities?.database.production ?? '—'}</span>
              </div>
              <Input label="Vollständiger Name" fullWidth value={fullName} onChange={(event) => setFullName(event.target.value)} />
              <Input label="E-Mail" fullWidth value={email} onChange={(event) => setEmail(event.target.value)} />
              <Input
                label="Passwort"
                fullWidth
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="action-row">
              <Button onClick={() => void handleAuthenticate()} disabled={authPending}>
                {authMeta.bootstrapStatus?.bootstrapped ? 'In Pro anmelden' : 'Pro-Owner anlegen'}
              </Button>
              <span className="helper-copy">
                {authMeta.bootstrapStatus?.bootstrapped
                  ? `Bereits ${authMeta.bootstrapStatus.userCount} Nutzer im Pro-Scope.`
                  : 'Noch kein Owner vorhanden – der erste Login bootstrapped die Pro-Instanz.'}
              </span>
            </div>
          </SectionCard>
        </section>
      </main>
    );
  }

  const openInvoices = data?.invoices.filter((invoice) => invoice.status !== 'paid').length ?? 0;
  const openOffers = data?.offers.filter((offer) => offer.status !== 'cancelled').length ?? 0;
  const activeClients = data?.clients.filter((clientRecord) => clientRecord.status === 'active').length ?? 0;
  const showOnboarding = Boolean(data) && !loading && shouldShowBusinessOnboarding(settingsDraft);

  return (
    <main className="app-shell">
      <div className="topbar">
        <div>
          <p className="hero-kicker">Billme Pro Web</p>
          <h1>Pro-Shell mit HTTP-Transport und Buchhaltungsoberflächen</h1>
          <p className="topbar-copy">
            Sitzung: {session.user.fullName} · Scope {data?.sessionInfo.tenantId ?? '—'} · API {apiUrl}
          </p>
        </div>
        <div className="topbar-actions">
          <Button variant="secondary" onClick={() => void refreshData()} disabled={loading}>
            {loading ? 'Lädt…' : 'Neu laden'}
          </Button>
          <Button variant="ghost" onClick={handleLogout}>
            Logout
          </Button>
        </div>
      </div>

      <NoticeBanner notice={notice} />
      {loadError ? <NoticeBanner notice={createNotice('danger', loadError)} /> : null}

      <nav className="route-nav" aria-label="Web-Pro Navigation">
        {ROUTES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`route-button ${route === item.id ? 'route-button-active' : ''}`}
            onClick={() => navigate(item.id)}
            aria-current={route === item.id ? 'page' : undefined}
          >
            <strong>{item.label}</strong>
            <span>{item.summary}</span>
          </button>
        ))}
      </nav>

      {data ? (
        <>
          {route === 'overview' ? (
            <div className="page-grid">
              <SectionCard eyebrow="Snapshot" title="Mandant, API und Pro-Abdeckung">
                <div className="stats-grid">
                  <StatCard label="Kunden" value={String(activeClients)} hint="aktive Kundensätze" />
                  <StatCard label="Dokumente offen" value={String(openInvoices + openOffers)} hint="Rechnungen + Angebote" />
                  <StatCard label="Ledger" value={String(data.ledgerStats.total)} hint="geladene Kontenrahmen" />
                  <StatCard label="Workflow" value={String(data.workflowEntries.length)} hint="persistierte Snapshots" />
                </div>
              </SectionCard>

              <SectionCard eyebrow="Betriebszustand" title="Server und Rechte">
                <div className="info-list">
                  <div><span>Service</span><strong>{data.health.service}</strong></div>
                  <div><span>Backend</span><strong>{data.capabilities.backend}</strong></div>
                  <div><span>Deployment</span><strong>{data.capabilities.deploymentMode}</strong></div>
                  <div><span>Rolle</span><strong>{data.sessionInfo.role}</strong></div>
                  <div><span>Produkte</span><strong>{data.capabilities.products.join(', ')}</strong></div>
                  <div><span>Rollenmodell</span><strong>{data.capabilities.auth.roles.join(', ')}</strong></div>
                </div>
              </SectionCard>

              <SectionCard eyebrow="Arbeitslast" title="Was diese Shell heute abdeckt">
                <ul className="bullet-list">
                  <li>HTTP-Auth gegen den Pro-Scope mit Browser-Session anstelle von Electron IPC.</li>
                  <li>Lesen und Pflegen von Artikeln, Bankkonten, Templates, Settings und Accounting-Regeln.</li>
                  <li>Persistenz von Pro-Workflow-Snapshots über die neue <code>/api/v1/pro/workflow</code>-API.</li>
                  <li>Export von JSON/CSV-Dokumenten direkt aus der API ohne lokale Dateisystemannahmen.</li>
                </ul>
              </SectionCard>
            </div>
          ) : null}

          {route === 'documents' ? (
            <div className="page-grid wide-grid">
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
                    body="Sobald der Server Rechnungen enthält, werden sie hier mit History und Export angezeigt."
                  />
                ) : (
                  <DataTable>
                    <table>
                      <thead>
                        <tr>
                          <th>Nummer</th>
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
                            <td>{invoice.client}</td>
                            <td>{invoice.status}</td>
                            <td>{formatCurrency(invoice.amount)}</td>
                            <td>{formatDate(invoice.date)}</td>
                            <td>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => void handleDownloadDocument('invoice', invoice.id, invoice.number)}
                              >
                                JSON
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
                    body="Hier erscheinen geteilte Angebote inklusive Entscheidung und Export-Status."
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
                            <td>{offer.status}</td>
                            <td>{offer.share?.decision ?? 'offen'}</td>
                            <td>{formatCurrency(offer.amount)}</td>
                            <td>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => void handleDownloadDocument('offer', offer.id, offer.number)}
                              >
                                JSON
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
            <div className="page-grid">
              <SectionCard eyebrow="Kundenstamm" title="Mandanten und Projekte">
                {data.clients.length === 0 ? (
                  <EmptyState
                    title="Keine Kunden vorhanden"
                    body="Die Pro-Shell zeigt hier denselben Kundenbestand wie Desktop/Server-API – ohne lokale SQLite-Abhängigkeit."
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
                              <div className="stacked-cell">
                                <strong>{clientRecord.company}</strong>
                                <span>{clientRecord.email}</span>
                              </div>
                            </td>
                            <td>{clientRecord.contactPerson || '—'}</td>
                            <td>{clientRecord.status}</td>
                            <td>{clientRecord.customerNumber ?? '—'}</td>
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
            <div className="page-grid wide-grid">
              <SectionCard eyebrow="Artikel" title="Leistungs- und Produktkatalog">
                <div className="form-grid three-col">
                  <Input label="Titel" fullWidth value={articleDraft.title} onChange={(event) => setArticleDraft((current) => ({ ...current, title: event.target.value }))} />
                  <Input label="Preis" fullWidth value={articleDraft.price} onChange={(event) => setArticleDraft((current) => ({ ...current, price: event.target.value }))} />
                  <Input label="Einheit" fullWidth value={articleDraft.unit} onChange={(event) => setArticleDraft((current) => ({ ...current, unit: event.target.value }))} />
                  <Input label="Kategorie" fullWidth value={articleDraft.category} onChange={(event) => setArticleDraft((current) => ({ ...current, category: event.target.value }))} />
                  <Input label="Steuer %" fullWidth value={articleDraft.taxRate} onChange={(event) => setArticleDraft((current) => ({ ...current, taxRate: event.target.value }))} />
                  <Input label="Beschreibung" fullWidth value={articleDraft.description} onChange={(event) => setArticleDraft((current) => ({ ...current, description: event.target.value }))} />
                </div>
                <div className="action-row">
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
                <div className="form-grid three-col">
                  <Input label="Name" fullWidth value={accountDraft.name} onChange={(event) => setAccountDraft((current) => ({ ...current, name: event.target.value }))} />
                  <Input label="IBAN" fullWidth value={accountDraft.iban} onChange={(event) => setAccountDraft((current) => ({ ...current, iban: event.target.value }))} />
                  <Input label="Saldo" fullWidth value={accountDraft.balance} onChange={(event) => setAccountDraft((current) => ({ ...current, balance: event.target.value }))} />
                  <Input
                    label="Default SKR-Konto"
                    fullWidth
                    value={accountDraft.defaultSkrAccountNumber}
                    onChange={(event) => setAccountDraft((current) => ({ ...current, defaultSkrAccountNumber: event.target.value }))}
                  />
                  <label className="select-field">
                    <span>Kontoart</span>
                    <select value={accountDraft.type} onChange={(event) => setAccountDraft((current) => ({ ...current, type: event.target.value as typeof current.type }))}>
                      <option value="bank">Bank</option>
                      <option value="checking">Checking</option>
                      <option value="savings">Savings</option>
                      <option value="paypal">PayPal</option>
                      <option value="cash">Cash</option>
                      <option value="credit">Credit</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <Input label="Farbe" fullWidth value={accountDraft.color} onChange={(event) => setAccountDraft((current) => ({ ...current, color: event.target.value }))} />
                </div>
                <div className="action-row">
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
                          <td>{account.type}</td>
                          <td>{account.defaultSkrAccountNumber}</td>
                          <td>{formatCurrency(account.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>

              <SectionCard eyebrow="Vorlagen" title="Serverweite Templates und aktive Auswahl">
                <div className="form-grid three-col compact-grid">
                  <label className="select-field">
                    <span>Typ</span>
                    <select value={templateDraft.kind} onChange={(event) => setTemplateDraft({ kind: event.target.value as 'invoice' | 'offer', name: templateDraft.name })}>
                      <option value="invoice">Rechnung</option>
                      <option value="offer">Angebot</option>
                    </select>
                  </label>
                  <Input label="Name" fullWidth value={templateDraft.name} onChange={(event) => setTemplateDraft((current) => ({ ...current, name: event.target.value }))} />
                  <div className="select-field static-field">
                    <span>Aktiv</span>
                    <strong>{data.activeTemplates[templateDraft.kind]?.name ?? 'keine aktive Vorlage'}</strong>
                  </div>
                </div>
                <div className="action-row">
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
                          <td>{template.kind}</td>
                          <td>{formatDate(template.updatedAt)}</td>
                          <td>
                            <button
                              type="button"
                              className="text-button"
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
            <div className="page-grid">
              <SectionCard eyebrow="Recurring" title="Profile und Automatisierungsfenster">
                <div className="stats-grid">
                  <StatCard label="Profile" value={String(data.recurringProfiles.length)} hint="registrierte Serienläufe" />
                  <StatCard
                    label="Dunning"
                    value={data.settings?.automation.dunningEnabled ? 'aktiv' : 'inaktiv'}
                    hint={`Laufzeit ${data.settings?.automation.dunningRunTime ?? '—'}`}
                  />
                  <StatCard
                    label="Recurring"
                    value={data.settings?.automation.recurringEnabled ? 'aktiv' : 'inaktiv'}
                    hint={`Laufzeit ${data.settings?.automation.recurringRunTime ?? '—'}`}
                  />
                </div>
                {data.recurringProfiles.length === 0 ? (
                  <EmptyState
                    title="Noch keine Wiederholungen"
                    body="Die Shell zeigt Serverprofile an, greift aber nicht mehr auf lokale Scheduler im Electron-Mainprozess zu."
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
                            <td>{profile.interval}</td>
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
            <div className="page-grid">
              <SectionCard eyebrow="Einstellungen" title="Firmenkopf und Nummernkreise">
                <div className="form-grid two-col">
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
                    label="Portal Base URL"
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
                <div className="action-row">
                  <Button onClick={() => void handleSaveSettings()}>Einstellungen speichern</Button>
                </div>
              </SectionCard>
            </div>
          ) : null}

          {route === 'accounting' ? (
            <div className="page-grid accounting-grid">
              <SectionCard
                eyebrow="Accounting"
                title="Ledger, Regeln und Workflow-Snapshots"
                actions={
                  <Button variant="secondary" onClick={() => void handleCreateSampleWorkflow()} disabled={data.accountingTransactions.length === 0}>
                    {data.accountingTransactions.length > 0 ? 'Beispiel-Workflow anlegen' : 'Legacy-Snapshots nur lesen'}
                  </Button>
                }
              >
                <div className="stats-grid">
                  <StatCard label="SKR03" value={String(data.ledgerStats.byChart.SKR03)} hint="Konten im Chart" />
                  <StatCard label="SKR04" value={String(data.ledgerStats.byChart.SKR04)} hint="Konten im Chart" />
                  <StatCard label="Steuerfälle" value={String(data.taxCases.length)} hint="aktive Compliance-Definitionen" />
                  <StatCard label="Regeln" value={String(data.suggestionRules.length)} hint="Kontovorschläge" />
                </div>
                <p className="helper-copy">
                  {data.accountingTransactions.length > 0
                    ? 'Die Pro-Workspace-UI liest kanonische Accounting-Daten aus Postgres; Entwürfe, Aktionen und Reports werden über die Accounting-API persistiert.'
                    : 'Legacy-Workflow-Snapshots sind eine read-only Fallback-Ansicht. Mutationen bleiben deaktiviert, bis kanonische Accounting-Daten verfügbar sind.'}
                </p>
              </SectionCard>

              <SectionCard eyebrow="Steuer-Mapping" title="Tax Cases auf Konten abbilden">
                {!canMutateAccountingRules ? <p className="helper-copy" role="status">Ihre Rolle darf Steuer-Mappings nur lesen.</p> : null}
                <div className="form-grid three-col compact-grid">
                  <label className="select-field">
                    <span>Chart</span>
                    <select disabled={!canMutateAccountingRules} value={taxMappingDraft.chart} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, chart: event.target.value as 'SKR03' | 'SKR04' }))}>
                      <option value="SKR03">SKR03</option>
                      <option value="SKR04">SKR04</option>
                    </select>
                  </label>
                  <label className="select-field">
                    <span>Steuerfall</span>
                    <select disabled={!canMutateAccountingRules} value={taxMappingDraft.taxCaseKey} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, taxCaseKey: event.target.value }))}>
                      {data.taxCases.map((taxCase) => (
                        <option key={taxCase.key} value={taxCase.key}>
                          {taxCase.key}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="select-field">
                    <span>Rolle</span>
                    <select disabled={!canMutateAccountingRules} value={taxMappingDraft.role} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, role: event.target.value as typeof current.role }))}>
                      <option value="output_tax">Output tax</option>
                      <option value="input_tax">Input tax</option>
                      <option value="datev_bu">DATEV BU</option>
                    </select>
                  </label>
                  <Input disabled={!canMutateAccountingRules} label="Account" fullWidth value={taxMappingDraft.accountNumber} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, accountNumber: event.target.value }))} />
                  <Input disabled={!canMutateAccountingRules} label="DATEV BU Key" fullWidth value={taxMappingDraft.datevBuKey} onChange={(event) => setTaxMappingDraft((current) => ({ ...current, datevBuKey: event.target.value }))} />
                </div>
                <div className="action-row">
                  <Button disabled={!canMutateAccountingRules} onClick={() => void handleSaveTaxMapping()}>Mapping speichern</Button>
                </div>
                <DataTable>
                  <table>
                    <thead>
                      <tr>
                        <th>Steuerfall</th>
                        <th>Chart</th>
                        <th>Rolle</th>
                        <th>Konto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.taxMappings.map((mapping) => (
                        <tr key={mapping.id}>
                          <td>{mapping.taxCaseKey}</td>
                          <td>{mapping.chart}</td>
                          <td>{mapping.role}</td>
                          <td>{mapping.accountNumber}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>

              <SectionCard eyebrow="Kontovorschläge" title="Rule-based Assignment im Browser pflegen">
                {!canMutateAccountingRules ? <p className="helper-copy" role="status">Ihre Rolle darf Vorschlagsregeln nur lesen.</p> : null}
                <div className="form-grid three-col compact-grid">
                  <label className="select-field">
                    <span>Chart</span>
                    <select disabled={!canMutateAccountingRules} value={suggestionRuleDraft.chart} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, chart: event.target.value as 'SKR03' | 'SKR04' }))}>
                      <option value="SKR03">SKR03</option>
                      <option value="SKR04">SKR04</option>
                    </select>
                  </label>
                  <Input disabled={!canMutateAccountingRules} label="Priorität" fullWidth value={suggestionRuleDraft.priority} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, priority: event.target.value }))} />
                  <label className="select-field">
                    <span>Feld</span>
                    <select disabled={!canMutateAccountingRules} value={suggestionRuleDraft.field} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, field: event.target.value as typeof current.field }))}>
                      <option value="counterparty">Counterparty</option>
                      <option value="purpose">Purpose</option>
                      <option value="any">Any</option>
                    </select>
                  </label>
                  <label className="select-field">
                    <span>Operator</span>
                    <select disabled={!canMutateAccountingRules} value={suggestionRuleDraft.operator} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, operator: event.target.value as typeof current.operator }))}>
                      <option value="contains">contains</option>
                      <option value="equals">equals</option>
                      <option value="startsWith">startsWith</option>
                    </select>
                  </label>
                  <Input disabled={!canMutateAccountingRules} label="Suchwert" fullWidth value={suggestionRuleDraft.value} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, value: event.target.value }))} />
                  <Input
                    disabled={!canMutateAccountingRules}
                    label="Zielkonto"
                    fullWidth
                    value={suggestionRuleDraft.targetAccountNumber}
                    onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, targetAccountNumber: event.target.value }))}
                  />
                  <label className="select-field">
                    <span>Flow</span>
                    <select disabled={!canMutateAccountingRules} value={suggestionRuleDraft.flowType} onChange={(event) => setSuggestionRuleDraft((current) => ({ ...current, flowType: event.target.value as typeof current.flowType }))}>
                      <option value="income">income</option>
                      <option value="expense">expense</option>
                      <option value="any">any</option>
                    </select>
                  </label>
                </div>
                <div className="action-row">
                  <Button disabled={!canMutateAccountingRules} onClick={() => void handleSaveSuggestionRule()}>Regel speichern</Button>
                </div>
                <DataTable>
                  <table>
                    <thead>
                      <tr>
                        <th>Priorität</th>
                        <th>Match</th>
                        <th>Zielkonto</th>
                        <th>Flow</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.suggestionRules.map((rule) => (
                        <tr key={rule.id}>
                          <td>{rule.priority}</td>
                          <td>{`${rule.field} ${rule.operator} ${rule.value}`}</td>
                          <td>{rule.targetAccountNumber}</td>
                          <td>{rule.flowType}</td>
                          <td>
                            <button type="button" className="text-button" disabled={!canMutateAccountingRules} onClick={() => void handleDeleteSuggestionRule(rule.id)}>
                              Löschen
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </SectionCard>

              <SectionCard eyebrow="Workspace" title="Geteilte Pro-Accounting-Oberfläche im Browser">
                {accountingSeed && accountingDataAdapter ? (
                  <div className="workspace-frame">
                    <ProAccountingWorkspace
                      seed={accountingSeed}
                      dataAdapter={accountingDataAdapter}
                      role={workspaceRole}
                      assetsAvailable
                    />
                  </div>
                ) : (
                  <EmptyState title="Workspace nicht verfügbar" body="Die Accounting-Daten konnten nicht für die Workspace-Oberfläche bereitgestellt werden." />
                )}
              </SectionCard>
            </div>
          ) : null}
        </>
      ) : (
        <SectionCard eyebrow="Ladezustand" title="Pro-Daten werden geladen">
          <p className="helper-copy">Die Shell verbindet sich mit der Pro-API und hydriert Katalog-, Billing- und Accounting-Surfaces.</p>
        </SectionCard>
      )}
      {showOnboarding ? (
        <BusinessOnboarding
          initialData={onboardingInitialData}
          onSubmit={handleCompleteOnboarding}
          saving={onboardingSaving}
          productName="Billme Pro"
          submitLabel="Workspace freischalten"
        />
      ) : null}
    </main>
  );
}
