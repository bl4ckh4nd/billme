import type {
  Account,
  AppSettings,
  Article,
  Client,
  DocumentTemplate,
  DocumentTemplateKind,
  Invoice,
  InvoiceElement,
  Project,
  RecurringProfile,
  Transaction,
} from '../types';
import type { IpcArgs, IpcResult, IpcRouteKey } from './contract';
import {
  calculateInvoiceTaxSnapshot,
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  ensureDefaultProjectForClient as ensureDefaultProjectForClientDomain,
  finalizeDocumentNumber,
  prepareClientForUpsert,
  releaseDocumentNumber,
  reserveDocumentNumber,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';
import type {
  DocumentNumberKind,
  SyncDefaultProjectPorts,
  SyncDocumentNumberingPorts,
} from '@billme/server-core/ports';
import {
  MOCK_ACCOUNTS,
  MOCK_ARTICLES,
  MOCK_CLIENTS,
  MOCK_INVOICES,
  MOCK_RECURRING_PROFILES,
  MOCK_SETTINGS,
} from '../data/mockData';
import EUR_LINES_2025 from '../eur/lines-2025.json';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '../constants';
import { formatAddressMultiline } from '../utils/formatters';

export const createMockInvoke = () => {
const invoices: Invoice[] = structuredClone(MOCK_INVOICES);
const clients: Client[] = structuredClone(MOCK_CLIENTS);
const articles: Article[] = structuredClone(MOCK_ARTICLES);
const accounts: Account[] = structuredClone(MOCK_ACCOUNTS);
const recurringProfiles: RecurringProfile[] = structuredClone(MOCK_RECURRING_PROFILES);
let settings: AppSettings = structuredClone(MOCK_SETTINGS);
const mockSecrets = new Map<string, string>();

const projects: Project[] = [];
for (const c of clients) {
  for (const p of c.projects ?? []) {
    projects.push({ ...p, clientId: c.id });
  }
}

const now = new Date().toISOString();
const templates: DocumentTemplate[] = [
  {
    id: 'default-invoice',
    kind: 'invoice',
    name: 'Standard Rechnung',
    elements: structuredClone(INITIAL_INVOICE_TEMPLATE as unknown as InvoiceElement[]),
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'default-offer',
    kind: 'offer',
    name: 'Standard Angebot',
    elements: structuredClone(INITIAL_OFFER_TEMPLATE as unknown as InvoiceElement[]),
    createdAt: now,
    updatedAt: now,
  },
];
let activeTemplateIds: { invoice: string | null; offer: string | null } = {
  invoice: 'default-invoice',
  offer: 'default-offer',
};
let mockIsMaximized = false;
const mockEurClassifications = new Map<string, any>();
const mockEurRules: Array<any> = [];
type MockEurLine = {
  id: string;
  taxYear: number;
  kennziffer?: string;
  label: string;
  kind: 'income' | 'expense' | 'computed';
  exportable: boolean;
  sortOrder: number;
  computedFromIds: string[];
  sourceVersion: string;
};

const mockEurLines: MockEurLine[] = (EUR_LINES_2025 as Array<{
  year: number;
  id: string;
  kennziffer?: string;
  label: string;
  kind: 'income' | 'expense' | 'computed';
  exportable: boolean;
  computedFromIds?: string[];
}>).map((line, index) => ({
  id: line.id,
  taxYear: line.year,
  kennziffer: line.kennziffer,
  label: line.label,
  kind: line.kind,
  exportable: line.exportable,
  sortOrder: index,
  computedFromIds: line.computedFromIds ?? [],
  sourceVersion: 'BMF-2025',
}));

const eurLineByKz = new Map(
  mockEurLines.filter((line) => line.kennziffer).map((line) => [line.kennziffer!, line.id]),
);

const eurKeywordRules: Array<{ includes: string[]; lineId: string }> = [
  { includes: ['adobe', 'notion', 'software', 'saas', 'edv', 'hosting'], lineId: eurLineByKz.get('228') ?? 'E2025_KZ228' },
  { includes: ['telekom', 'telefon', 'internet', 'mobilfunk'], lineId: eurLineByKz.get('280') ?? 'E2025_KZ280' },
  { includes: ['steuerberater', 'buchhaltung', 'rechtsanwalt'], lineId: eurLineByKz.get('194') ?? 'E2025_KZ194' },
  { includes: ['werbung', 'ads', 'kampagne', 'meta ads', 'google ads'], lineId: eurLineByKz.get('224') ?? 'E2025_KZ224' },
  { includes: ['miete', 'leasing'], lineId: eurLineByKz.get('222') ?? 'E2025_KZ222' },
  { includes: ['bahn', 'reise', 'hotel', 'flug'], lineId: eurLineByKz.get('221') ?? 'E2025_KZ221' },
  { includes: ['finanzamt', 'ust', 'umsatzsteuer'], lineId: eurLineByKz.get('186') ?? 'E2025_KZ186' },
  { includes: ['büro', 'buero', 'arbeitsmittel', 'material'], lineId: eurLineByKz.get('229') ?? 'E2025_KZ229' },
  { includes: ['wareneinkauf', 'rohstoff', 'waren'], lineId: eurLineByKz.get('100') ?? 'E2025_KZ100' },
  { includes: ['paypal checkout', 'shop', 'rechnung', 'zahlung'], lineId: eurLineByKz.get('112') ?? 'E2025_KZ112' },
];

type NumberReservation = {
  id: string;
  kind: DocumentNumberKind;
  number: string;
  counterValue: number;
  status: 'reserved' | 'released' | 'finalized';
  documentId: string | null;
};
const numberReservations = new Map<string, NumberReservation>();
const documentNumberingPorts: SyncDocumentNumberingPorts<AppSettings> = {
  tx: {
    inTransaction<TResult>(work: () => TResult): TResult {
      return work();
    },
  },
  getSettings: () => settings,
  saveSettings: (nextSettings) => {
    settings = structuredClone(nextSettings);
  },
  createReservation: (reservation) => {
    numberReservations.set(reservation.id, { ...reservation });
  },
  getReservationById: (reservationId) => {
    const reservation = numberReservations.get(reservationId);
    return reservation ? { ...reservation } : null;
  },
  updateReservation: (reservation) => {
    numberReservations.set(reservation.id, { ...reservation });
  },
  isNumberTaken: (kind, number) => {
    const entityTaken = kind === 'customer'
      ? clients.some((client) => client.customerNumber === number)
      : (kind === 'invoice' ? invoices : offers).some((document) => document.number === number);
    if (entityTaken) {
      return true;
    }
    return [...numberReservations.values()].some(
      (reservation) =>
        reservation.kind === kind &&
        reservation.number === number &&
        reservation.status !== 'released',
    );
  },
  generateReservationId: () => Math.random().toString(36).slice(2),
};

const reserveNumber = (kind: DocumentNumberKind): { reservationId: string; number: string } => {
  return reserveDocumentNumber(documentNumberingPorts, kind);
};

const releaseNumber = (reservationId: string): { ok: true } => {
  return releaseDocumentNumber(documentNumberingPorts, reservationId);
};

const finalizeNumber = (reservationId: string, documentId: string): { ok: true } => {
  return finalizeDocumentNumber(documentNumberingPorts, reservationId, documentId);
};

const defaultProjectPorts: SyncDefaultProjectPorts<Project & { clientId: string }> = {
  tx: {
    inTransaction<TResult>(work: () => TResult): TResult {
      return work();
    },
  },
  getActiveDefaultProjectForClient: (clientId) => {
    const project = projects.find((entry) => entry.clientId === clientId && entry.name === 'Allgemein' && !entry.archivedAt);
    return project ? project as Project & { clientId: string } : null;
  },
  listProjectCodesByPrefix: (prefix) => {
    return projects
      .map((project) => project.code)
      .filter((code): code is string => typeof code === 'string' && code.startsWith(prefix));
  },
  saveProject: (project) => {
    const saved = structuredClone(project);
    projects.unshift(saved);
    return saved;
  },
};

const ensureDefaultProject = (clientId: string): Project => {
  return ensureDefaultProjectForClientDomain(defaultProjectPorts, {
    clientId,
    createProjectId: () => `p_${Math.random().toString(36).slice(2)}`,
  }).project;
};

for (const client of clients) {
  ensureDefaultProject(client.id);
}

const offers: Invoice[] = [
  {
    id: 'o1',
    clientId: 'c1',
    clientNumber: 'KD-0001',
    number: 'ANG-2023-082',
    client: 'Musterfirma GmbH',
    clientEmail: 'info@muster.de',
    taxMode: 'standard_vat',
    date: '2023-11-01',
    dueDate: '2023-11-15',
    amount: 5200.0,
    status: 'open',
    items: [{ description: 'Projektumfang Phase 1', quantity: 1, price: 5200, total: 5200 }],
    payments: [],
    history: [],
  },
  {
    id: 'o2',
    clientId: 'c2',
    clientNumber: 'KD-0002',
    number: 'ANG-2023-083',
    client: 'StartUp Berlin AG',
    clientEmail: 'hello@startup.io',
    taxMode: 'standard_vat',
    date: '2023-11-03',
    dueDate: '2023-11-17',
    amount: 1850.0,
    status: 'draft',
    items: [{ description: 'Workshop Konzept', quantity: 1, price: 1850, total: 1850 }],
    payments: [],
    history: [],
  },
];

type MockImportBatch = {
  id: string;
  accountId: string;
  profile: string;
  fileName: string;
  fileSha256: string;
  mappingJson: unknown;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  createdAt: string;
  rolledBackAt?: string;
  rollbackReason?: string;
};

const mockImportBatches: MockImportBatch[] = [];
type MockLedgerAccount = {
  id: string;
  chart: 'SKR03' | 'SKR04';
  accountNumber: string;
  name: string;
  keywords?: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
};
const mockLedgerAccounts: MockLedgerAccount[] = [];
const mockAccountSuggestionRules: Array<{
  id: string;
  tenantId: string;
  chart: 'SKR03' | 'SKR04';
  priority: number;
  field: 'counterparty' | 'purpose' | 'any';
  operator: 'contains' | 'equals' | 'startsWith';
  value: string;
  targetAccountNumber: string;
  flowType: 'income' | 'expense' | 'any';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}> = [];
const mockWorkflowEntries = new Map<
  string,
  { transactionId: string; transactionJson: string; draftJson: string; updatedAt: string }
>();
const mockTaxCases = [
  { key: 'DE_STD_19', label: 'Inland steuerpflichtig 19%', mechanism: 'standard_vat', defaultRate: 19, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: false, active: true },
  { key: 'DE_STD_7', label: 'Inland steuerpflichtig 7%', mechanism: 'standard_vat', defaultRate: 7, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: false, active: true },
  { key: 'DE_ZERO_EXEMPT', label: 'Inland steuerfrei / nicht steuerbar', mechanism: 'exempt', defaultRate: 0, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: true, active: true },
  { key: 'DE_KU19', label: 'Kleinunternehmer §19 UStG', mechanism: 'exempt', defaultRate: 0, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: true, active: true },
  { key: 'DE_RC_13B_DOMESTIC', label: 'Reverse Charge §13b Inland', mechanism: 'reverse_charge', defaultRate: 19, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: true, active: true },
  { key: 'EU_B2C_OSS', label: 'EU B2C OSS (One-Stop-Shop)', mechanism: 'standard_vat', defaultRate: 19, requiresCounterpartyVatId: false, requiresCountry: true, requiresEvidence: true, active: true },
  { key: 'DE_MARGIN_25A', label: 'Differenzbesteuerung §25a UStG', mechanism: 'exempt', defaultRate: 0, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: true, active: true },
  { key: 'DE_BAUABZUG_48', label: 'Bauabzugsteuer §48 EStG', mechanism: 'exempt', defaultRate: 0, requiresCounterpartyVatId: false, requiresCountry: false, requiresEvidence: true, active: true },
  { key: 'DE_TRIANGULAR_25B', label: 'Innergemeinschaftliches Dreiecksgeschäft §25b', mechanism: 'zero_rate', defaultRate: 0, requiresCounterpartyVatId: true, requiresCountry: true, requiresEvidence: true, active: true },
  { key: 'EU_B2B_SERVICE_RC', label: 'EU B2B Dienstleistung RC', mechanism: 'reverse_charge', defaultRate: 19, requiresCounterpartyVatId: true, requiresCountry: true, requiresEvidence: true, active: true },
  { key: 'EU_IGL_GOODS_0', label: 'Innergemeinschaftliche Lieferung 0%', mechanism: 'zero_rate', defaultRate: 0, requiresCounterpartyVatId: true, requiresCountry: true, requiresEvidence: true, active: true },
  { key: 'EU_IGE_GOODS_RC', label: 'Innergemeinschaftlicher Erwerb RC', mechanism: 'reverse_charge', defaultRate: 19, requiresCounterpartyVatId: true, requiresCountry: true, requiresEvidence: true, active: true },
  { key: 'NON_EU_EXPORT_0', label: 'Ausfuhrlieferung Drittland 0%', mechanism: 'zero_rate', defaultRate: 0, requiresCounterpartyVatId: false, requiresCountry: true, requiresEvidence: true, active: true },
  { key: 'NON_EU_SERVICE_RC', label: 'Drittland Dienstleistungsbezug RC', mechanism: 'reverse_charge', defaultRate: 19, requiresCounterpartyVatId: false, requiresCountry: true, requiresEvidence: true, active: true },
] as const;
const mockTaxCaseMappings: Array<{
  id: string;
  chart: 'SKR03' | 'SKR04';
  taxCaseKey: (typeof mockTaxCases)[number]['key'];
  role: 'output_tax' | 'input_tax' | 'datev_bu';
  accountNumber: string;
  datevBuKey?: string;
  validFrom?: string;
  validTo?: string;
  updatedAt: string;
}> = [];
type MockDraft = {
  id: string;
  tenantId: string;
  transactionId: string;
  workflowStatus:
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
  postingDate?: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  lines: Array<{
    id: string;
    accountNumber: string;
    debitAmount: number;
    creditAmount: number;
    taxCode?: string;
    taxCaseKey?: (typeof mockTaxCases)[number]['key'];
    taxRate?: number;
    netAmount?: number;
    taxAmount?: number;
    grossAmount?: number;
    countryCode?: string;
    counterpartyVatId?: string;
    evidenceType?: string;
    evidenceReference?: string;
    costCenter?: string;
    memo?: string;
  }>;
  validationIssues: Array<{
    id: string;
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    fieldPath?: string;
    blocking: boolean;
    source: 'system' | 'user' | 'rule';
  }>;
  updatedAt: string;
};
const mockDrafts = new Map<string, MockDraft>();
const mockJournalEntries: Array<{
  id: string;
  tenantId: string;
  entryNumber: number;
  postingDate: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  status: 'posted' | 'reversed';
  sourceDraftId?: string;
  reversedEntryId?: string;
  createdAt: string;
  lines: Array<{
    id: string;
    accountNumber: string;
    debitAmount: number;
    creditAmount: number;
    taxCode?: string;
    taxCaseKey?: (typeof mockTaxCases)[number]['key'];
    taxRate?: number;
    netAmount?: number;
    taxAmount?: number;
    grossAmount?: number;
    countryCode?: string;
    counterpartyVatId?: string;
    evidenceType?: string;
    evidenceReference?: string;
    costCenter?: string;
    memo?: string;
  }>;
}> = [];
const mockDatevExports: Array<{
  id: string;
  filePath: string;
  recordCount: number;
  fromDate?: string;
  toDate?: string;
  createdAt: string;
}> = [];
const mockDunningHistory = new Map<string, Array<{
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  dunningLevel: number;
  daysOverdue: number;
  feeApplied: number;
  emailSent: boolean;
  emailLogId?: string;
  processedAt: string;
  createdAt: string;
}>>();

const getAllTransactions = (): Transaction[] => {
  const rows: Transaction[] = [];
  for (const account of accounts) {
    for (const tx of account.transactions ?? []) {
      rows.push({ ...tx, accountId: tx.accountId ?? account.id });
    }
  }
  return rows;
};

const suggestMockAccount = (tx: Transaction): {
  suggestedAccountNumber?: string;
  suggestionReason?: string;
  suggestionLayer?: 'rule' | 'keyword' | 'fallback';
  suggestionConfidence?: number;
} => {
  const text = `${tx.counterparty || ''} ${tx.purpose || ''}`.toLowerCase();
  const sortedRules = [...mockAccountSuggestionRules]
    .filter((rule) => rule.active)
    .sort((a, b) => a.priority - b.priority);
  for (const rule of sortedRules) {
    if (rule.flowType !== 'any' && rule.flowType !== tx.type) continue;
    const fields: string[] = [];
    if (rule.field === 'counterparty' || rule.field === 'any') fields.push(tx.counterparty || '');
    if (rule.field === 'purpose' || rule.field === 'any') fields.push(tx.purpose || '');
    const needle = rule.value.toLowerCase();
    const matched = fields.some((value) => {
      const hay = value.toLowerCase();
      if (rule.operator === 'contains') return hay.includes(needle);
      if (rule.operator === 'equals') return hay === needle;
      return hay.startsWith(needle);
    });
    if (matched) {
      return {
        suggestedAccountNumber: rule.targetAccountNumber,
        suggestionReason: `Regel: "${rule.value}"`,
        suggestionLayer: 'rule',
        suggestionConfidence: 0.99,
      };
    }
  }

  for (const row of mockLedgerAccounts) {
    for (const keyword of row.keywords ?? []) {
      if (text.includes(keyword.toLowerCase())) {
        return {
          suggestedAccountNumber: row.accountNumber,
          suggestionReason: `Stichwort: ${keyword}`,
          suggestionLayer: 'keyword',
          suggestionConfidence: 0.8,
        };
      }
    }
  }

  return {
    suggestedAccountNumber: tx.type === 'income' ? '8400' : '6000',
    suggestionReason: 'Fallback nach Buchungstyp',
    suggestionLayer: 'fallback',
    suggestionConfidence: 0.3,
  };
};

const toDefaultDraft = (tx: Transaction): MockDraft => {
  const absAmount = Math.abs(Number(tx.amount) || 0);
  const period = (tx.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const suggestion = suggestMockAccount(tx);
  const suggested = suggestion.suggestedAccountNumber;
  return {
    id: `draft-${tx.id}`,
    tenantId: 'default',
    transactionId: tx.id,
    workflowStatus: tx.status === 'booked' ? 'posted' : 'imported',
    postingDate: tx.date,
    documentDate: tx.date,
    bookingText: tx.purpose || (tx.type === 'income' ? 'Einnahme' : 'Ausgabe'),
    reference: tx.id,
    period,
    fiscalYear: Number(period.slice(0, 4)),
    lines: [
      {
        id: `line-${tx.id}-1`,
        accountNumber: tx.type === 'income' ? '1200' : suggested || '6000',
        debitAmount: absAmount,
        creditAmount: 0,
      },
      {
        id: `line-${tx.id}-2`,
        accountNumber: tx.type === 'income' ? suggested || '8400' : '1200',
        debitAmount: 0,
        creditAmount: absAmount,
      },
    ],
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };
};

const getMockDraft = (transactionId: string): MockDraft | undefined => {
  const draft = mockDrafts.get(transactionId);
  if (draft) return draft;
  const tx = getAllTransactions().find((row) => row.id === transactionId);
  if (!tx) return undefined;
  const seeded = toDefaultDraft(tx);
  mockDrafts.set(transactionId, seeded);
  return seeded;
};

const getInvoiceById = (id: string): Invoice | undefined => invoices.find((inv) => inv.id === id);

const recomputeInvoicePaymentState = (invoice: Invoice): void => {
  const paid = (invoice.payments ?? []).reduce((sum, p) => sum + Math.abs(Number(p.amount) || 0), 0);
  if (paid >= invoice.amount && invoice.amount > 0) {
    invoice.status = 'paid';
  } else if (invoice.status !== 'draft' && invoice.status !== 'cancelled') {
    invoice.status = 'open';
  }
};

const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number => {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const getMockLedgerStats = () => {
  const byChart = {
    SKR03: 0,
    SKR04: 0,
  };
  for (const account of mockLedgerAccounts) {
    if (account.chart === 'SKR03') byChart.SKR03 += 1;
    if (account.chart === 'SKR04') byChart.SKR04 += 1;
  }
  return {
    total: byChart.SKR03 + byChart.SKR04,
    byChart,
  };
};

const ensureMockTaxMappings = () => {
  if (mockTaxCaseMappings.length > 0) return;
  const nowIso = new Date().toISOString();
  const push = (
    chart: 'SKR03' | 'SKR04',
    taxCaseKey: (typeof mockTaxCases)[number]['key'],
    role: 'output_tax' | 'input_tax' | 'datev_bu',
    accountNumber: string,
    datevBuKey?: string,
  ) => {
    mockTaxCaseMappings.push({
      id: `tmap-${chart}-${taxCaseKey}-${role}`,
      chart,
      taxCaseKey,
      role,
      accountNumber,
      datevBuKey,
      updatedAt: nowIso,
    });
  };

  push('SKR03', 'DE_STD_19', 'datev_bu', '1776', '1');
  push('SKR03', 'DE_STD_19', 'output_tax', '1776', '1');
  push('SKR03', 'DE_STD_19', 'input_tax', '1576', '1');
  push('SKR03', 'DE_STD_7', 'datev_bu', '1771', '2');
  push('SKR03', 'DE_STD_7', 'output_tax', '1771', '2');
  push('SKR03', 'DE_STD_7', 'input_tax', '1571', '2');
  push('SKR03', 'EU_B2C_OSS', 'datev_bu', '1776', '1');
  push('SKR03', 'EU_B2C_OSS', 'output_tax', '1776', '1');
  push('SKR03', 'EU_B2C_OSS', 'input_tax', '1576', '1');
  push('SKR03', 'DE_MARGIN_25A', 'datev_bu', '8400', '0');
  push('SKR03', 'DE_BAUABZUG_48', 'datev_bu', '8400', '0');
  push('SKR03', 'DE_TRIANGULAR_25B', 'datev_bu', '8125', '42');
  push('SKR03', 'DE_RC_13B_DOMESTIC', 'datev_bu', '1774', '94');
  push('SKR03', 'DE_RC_13B_DOMESTIC', 'output_tax', '1774', '94');
  push('SKR03', 'DE_RC_13B_DOMESTIC', 'input_tax', '1574', '94');
  push('SKR03', 'EU_B2B_SERVICE_RC', 'datev_bu', '1774', '94');
  push('SKR03', 'EU_B2B_SERVICE_RC', 'output_tax', '1774', '94');
  push('SKR03', 'EU_B2B_SERVICE_RC', 'input_tax', '1574', '94');
  push('SKR03', 'EU_IGE_GOODS_RC', 'datev_bu', '1774', '89');
  push('SKR03', 'EU_IGE_GOODS_RC', 'output_tax', '1774', '89');
  push('SKR03', 'EU_IGE_GOODS_RC', 'input_tax', '1574', '89');
  push('SKR04', 'DE_STD_19', 'datev_bu', '3806', '1');
  push('SKR04', 'DE_STD_19', 'output_tax', '3806', '1');
  push('SKR04', 'DE_STD_19', 'input_tax', '1406', '1');
  push('SKR04', 'DE_STD_7', 'datev_bu', '3801', '2');
  push('SKR04', 'DE_STD_7', 'output_tax', '3801', '2');
  push('SKR04', 'DE_STD_7', 'input_tax', '1401', '2');
  push('SKR04', 'EU_B2C_OSS', 'datev_bu', '3806', '1');
  push('SKR04', 'EU_B2C_OSS', 'output_tax', '3806', '1');
  push('SKR04', 'EU_B2C_OSS', 'input_tax', '1406', '1');
  push('SKR04', 'DE_MARGIN_25A', 'datev_bu', '4400', '0');
  push('SKR04', 'DE_BAUABZUG_48', 'datev_bu', '4400', '0');
  push('SKR04', 'DE_TRIANGULAR_25B', 'datev_bu', '4125', '42');
  push('SKR04', 'DE_RC_13B_DOMESTIC', 'datev_bu', '3804', '94');
  push('SKR04', 'DE_RC_13B_DOMESTIC', 'output_tax', '3804', '94');
  push('SKR04', 'DE_RC_13B_DOMESTIC', 'input_tax', '1404', '94');
};

const normalizeMockTaxCaseKey = (value?: string): (typeof mockTaxCases)[number]['key'] | undefined => {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (raw === 'USt19' || raw === 'VSt19') return 'DE_STD_19';
  if (raw === 'USt7' || raw === 'VSt7') return 'DE_STD_7';
  const upper = raw.toUpperCase();
  return mockTaxCases.some((item) => item.key === upper) ? (upper as (typeof mockTaxCases)[number]['key']) : undefined;
};

const toMockLegacyTaxCode = (taxCaseKey?: (typeof mockTaxCases)[number]['key']): string | undefined => {
  if (!taxCaseKey) return undefined;
  if (taxCaseKey === 'DE_STD_19') return 'USt19';
  if (taxCaseKey === 'DE_STD_7') return 'USt7';
  return taxCaseKey;
};

const getMockTaxCaseByKey = (taxCaseKey?: string) => {
  const normalized = normalizeMockTaxCaseKey(taxCaseKey);
  if (!normalized) return undefined;
  return mockTaxCases.find((item) => item.key === normalized);
};

const getMockActiveChart = (): 'SKR03' | 'SKR04' => {
  const stats = getMockLedgerStats();
  return stats.byChart.SKR03 > 0 ? 'SKR03' : 'SKR04';
};

const getMockTaxMapping = (
  chart: 'SKR03' | 'SKR04',
  taxCaseKey: (typeof mockTaxCases)[number]['key'],
  role: 'output_tax' | 'input_tax' | 'datev_bu',
) => mockTaxCaseMappings.find((row) => row.chart === chart && row.taxCaseKey === taxCaseKey && row.role === role);

const normalizeMockDraftLineTaxFields = (line: MockDraft['lines'][number]): MockDraft['lines'][number] => {
  const taxCaseKey = normalizeMockTaxCaseKey(line.taxCaseKey ?? line.taxCode);
  const taxCase = getMockTaxCaseByKey(taxCaseKey);
  const amount = Math.max(Number(line.debitAmount || 0), Number(line.creditAmount || 0));
  const rate = line.taxRate ?? taxCase?.defaultRate;

  if (!taxCase || rate === undefined) {
    return {
      ...line,
      taxCaseKey,
      taxCode: toMockLegacyTaxCode(taxCaseKey) ?? line.taxCode,
    };
  }

  const normalizedRate = Number(rate || 0);
  if (taxCase.mechanism === 'standard_vat' && normalizedRate > 0) {
    const netAmount = line.netAmount ?? round2(amount / (1 + normalizedRate / 100));
    const taxAmount = line.taxAmount ?? round2(amount - netAmount);
    return {
      ...line,
      taxCaseKey,
      taxCode: toMockLegacyTaxCode(taxCaseKey) ?? line.taxCode,
      taxRate: normalizedRate,
      grossAmount: line.grossAmount ?? amount,
      netAmount,
      taxAmount,
    };
  }

  if (taxCase.mechanism === 'reverse_charge' && normalizedRate > 0) {
    const netAmount = line.netAmount ?? amount;
    return {
      ...line,
      taxCaseKey,
      taxCode: toMockLegacyTaxCode(taxCaseKey) ?? line.taxCode,
      taxRate: normalizedRate,
      grossAmount: line.grossAmount ?? netAmount,
      netAmount,
      taxAmount: line.taxAmount ?? round2(netAmount * (normalizedRate / 100)),
    };
  }

  return {
    ...line,
    taxCaseKey,
    taxCode: toMockLegacyTaxCode(taxCaseKey) ?? line.taxCode,
    taxRate: 0,
    grossAmount: line.grossAmount ?? amount,
    netAmount: line.netAmount ?? amount,
    taxAmount: line.taxAmount ?? 0,
  };
};

const validateMockTaxComplianceIssues = (draft: MockDraft) => {
  ensureMockTaxMappings();
  const issues: Array<{
    id: string;
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    fieldPath?: string;
    blocking: boolean;
    source: 'system' | 'user' | 'rule';
  }> = [];
  const chart = getMockActiveChart();

  draft.lines.forEach((line, idx) => {
    const accountNumber = String(line.accountNumber ?? '').trim();
    const isPnl = accountNumber.startsWith('4') || accountNumber.startsWith('8');
    const taxCaseKey = normalizeMockTaxCaseKey(line.taxCaseKey ?? line.taxCode);
    const taxCase = getMockTaxCaseByKey(taxCaseKey);

    if (isPnl && !taxCaseKey) {
      issues.push({
        id: `tax-missing-${idx}`,
        code: 'MISSING_TAX_CASE',
        severity: 'error',
        message: `Steuerfall fehlt für Konto ${accountNumber || '(leer)'}.`,
        fieldPath: `lines[${idx}].taxCaseKey`,
        blocking: true,
        source: 'system',
      });
      return;
    }

    if (!taxCaseKey) return;

    if (!taxCase?.active) {
      issues.push({
        id: `tax-inactive-${idx}`,
        code: 'UNKNOWN_TAX_CASE',
        severity: 'error',
        message: `Unbekannter oder inaktiver Steuerfall: ${taxCaseKey}.`,
        fieldPath: `lines[${idx}].taxCaseKey`,
        blocking: true,
        source: 'system',
      });
      return;
    }

    if (taxCase.requiresCounterpartyVatId && !line.counterpartyVatId) {
      issues.push({
        id: `tax-vatid-${idx}`,
        code: 'MISSING_COUNTERPARTY_VAT_ID',
        severity: 'error',
        message: `USt-IdNr. fehlt für Steuerfall ${taxCase.key}.`,
        fieldPath: `lines[${idx}].counterpartyVatId`,
        blocking: true,
        source: 'system',
      });
    }

    if (taxCase.requiresCountry && !line.countryCode) {
      issues.push({
        id: `tax-country-${idx}`,
        code: 'MISSING_COUNTRY_CODE',
        severity: 'error',
        message: `Ländercode fehlt für Steuerfall ${taxCase.key}.`,
        fieldPath: `lines[${idx}].countryCode`,
        blocking: true,
        source: 'system',
      });
    }

    if (taxCase.requiresEvidence && (!line.evidenceType || !line.evidenceReference)) {
      issues.push({
        id: `tax-evidence-${idx}`,
        code: 'MISSING_TAX_EVIDENCE',
        severity: 'error',
        message: `Steuernachweis fehlt für Steuerfall ${taxCase.key}.`,
        fieldPath: `lines[${idx}].evidenceReference`,
        blocking: true,
        source: 'system',
      });
    }

    const datevBu = getMockTaxMapping(chart, taxCase.key, 'datev_bu');
    if (!datevBu && taxCase.mechanism !== 'exempt' && taxCase.mechanism !== 'zero_rate') {
      issues.push({
        id: `tax-bu-${idx}`,
        code: 'MISSING_DATEV_BU_KEY',
        severity: 'error',
        message: `DATEV BU-Schlüssel fehlt für Steuerfall ${taxCase.key} (${chart}).`,
        fieldPath: `lines[${idx}].taxCaseKey`,
        blocking: true,
        source: 'system',
      });
    }

    if (taxCase.mechanism === 'reverse_charge') {
      const output = getMockTaxMapping(chart, taxCase.key, 'output_tax');
      const input = getMockTaxMapping(chart, taxCase.key, 'input_tax');
      if (!output || !input) {
        issues.push({
          id: `tax-rc-map-${idx}`,
          code: 'MISSING_REVERSE_CHARGE_MAPPING',
          severity: 'error',
          message: `Steuerkonten-Mapping fehlt für Steuerfall ${taxCase.key} (${chart}).`,
          fieldPath: `lines[${idx}].taxCaseKey`,
          blocking: true,
          source: 'system',
        });
      }
    }
  });

  return issues;
};

const toNet = (amountGross: number, classification: any): number => {
  if (settings.legal.smallBusinessRule) return round2(amountGross);
  if ((classification?.vatMode ?? 'none') !== 'default') return round2(amountGross);
  const rate = Number(settings.legal.defaultVatRate) || 0;
  if (rate <= 0) return round2(amountGross);
  return round2(amountGross / (1 + rate / 100));
};

const getEurDateRange = (taxYear: number, from?: string, to?: string): { from: string; to: string } => ({
  from: from ?? `${taxYear}-01-01`,
  to: to ?? `${taxYear}-12-31`,
});

const getRawEurItems = (from: string, to: string) => {
  const items: Array<{
    sourceType: 'transaction' | 'invoice';
    sourceId: string;
    date: string;
    amountGross: number;
    flowType: 'income' | 'expense';
    accountId?: string;
    linkedViaInvoice?: boolean;
    counterparty: string;
    purpose: string;
  }> = [];

  for (const inv of invoices) {
    for (const payment of inv.payments ?? []) {
      if (!payment?.date) continue;
      if (payment.date < from || payment.date > to) continue;
      items.push({
        sourceType: 'invoice',
        sourceId: inv.id,
        date: payment.date,
        amountGross: Math.abs(Number(payment.amount) || 0),
        flowType: 'income',
        linkedViaInvoice: false,
        counterparty: inv.client,
        purpose: `Rechnung ${inv.number}`,
      });
    }
  }

  for (const account of accounts) {
    for (const tx of account.transactions ?? []) {
      if (!tx?.date || tx.date < from || tx.date > to) continue;
      if (tx.status !== 'booked') continue;

      const linkedInvoiceId = (tx as any).linkedInvoiceId as string | undefined;
      if (tx.type === 'income' && linkedInvoiceId) continue;
      if (tx.type !== 'income' && tx.type !== 'expense') continue;

      items.push({
        sourceType: 'transaction',
        sourceId: tx.id,
        date: tx.date,
        amountGross: Math.abs(Number(tx.amount) || 0),
        flowType: tx.type,
        accountId: account.id,
        linkedViaInvoice: Boolean(linkedInvoiceId),
        counterparty: tx.counterparty,
        purpose: tx.purpose,
      });
    }
  }

  items.sort((a, b) => {
    if (a.date === b.date) return a.sourceId.localeCompare(b.sourceId);
    return a.date > b.date ? -1 : 1;
  });

  return items;
};

const listMockEurItems = (params: IpcArgs<'eur:listItems'>) => {
  const { taxYear, from, to } = params;
  const range = getEurDateRange(taxYear, from, to);
  const lines = mockEurLines.filter((line) => line.taxYear === taxYear);
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const defaultIncomeLineId =
    eurLineByKz.get('112')
    ?? lines.find((line) => line.kind === 'income' && line.exportable)?.id
    ?? lines.find((line) => line.kind === 'income')?.id;
  const defaultExpenseLineId =
    eurLineByKz.get('183')
    ?? lines.find((line) => line.kind === 'expense' && line.exportable)?.id
    ?? lines.find((line) => line.kind === 'expense')?.id;

  const suggestLine = (item: { flowType: 'income' | 'expense'; counterparty: string; purpose: string }) => {
    const haystack = `${item.counterparty} ${item.purpose}`.toLowerCase();
    for (const rule of eurKeywordRules) {
      const matchedKeyword = rule.includes.find((keyword) =>
        haystack.includes(keyword.toLowerCase()),
      );
      if (matchedKeyword) {
        const line = linesById.get(rule.lineId);
        if (line && line.kind === item.flowType && line.exportable) {
          return {
            lineId: line.id,
            reason: `Mock-Vorschlag per Stichwort (${matchedKeyword})`,
          };
        }
      }
    }
    const fallback = item.flowType === 'income' ? defaultIncomeLineId : defaultExpenseLineId;
    return {
      lineId: fallback,
      reason: fallback ? 'Mock-Vorschlag nach Buchungstyp' : undefined,
    };
  };

  let items = getRawEurItems(range.from, range.to).map((item) => {
    const key = `${item.sourceType}:${item.sourceId}:${taxYear}`;
    const classification = mockEurClassifications.get(key);
    const line = classification?.eurLineId ? linesById.get(classification.eurLineId) : undefined;
    const suggestion = suggestLine(item);
    return {
      ...item,
      amountNet: toNet(item.amountGross, classification),
      suggestedLineId: suggestion.lineId,
      suggestionReason: suggestion.reason,
      suggestionLayer: suggestion.lineId ? ('keyword' as const) : undefined,
      classification,
      line,
    };
  });

  if (params.sourceType) {
    items = items.filter((item) => item.sourceType === params.sourceType);
  }

  if (params.flowType) {
    items = items.filter((item) => item.flowType === params.flowType);
  }

  if (params.accountId) {
    items = items.filter((item) => item.accountId === params.accountId);
  }

  const effectiveStatus = params.onlyUnclassified ? 'unclassified' : params.status;
  if (effectiveStatus && effectiveStatus !== 'all') {
    items = items.filter((item) => {
      if (effectiveStatus === 'unclassified') return !item.classification?.eurLineId && !item.classification?.excluded;
      if (effectiveStatus === 'classified') return Boolean(item.classification?.eurLineId) && !item.classification?.excluded;
      return Boolean(item.classification?.excluded);
    });
  }

  if (params.search && params.search.trim().length > 0) {
    const needle = params.search.trim().toLowerCase();
    items = items.filter((item) =>
      item.counterparty.toLowerCase().includes(needle)
      || item.purpose.toLowerCase().includes(needle)
      || item.date.includes(needle)
      || String(item.amountGross).includes(needle),
    );
  }

  const offset = Math.max(0, params.offset ?? 0);
  if (params.limit && params.limit > 0) {
    items = items.slice(offset, offset + params.limit);
  } else if (offset > 0) {
    items = items.slice(offset);
  }

  return items;
};

const getMockEurReport = (params: IpcArgs<'eur:getReport'>) => {
  const { taxYear, from, to } = params;
  const range = getEurDateRange(taxYear, from, to);
  const lines = mockEurLines.filter((line) => line.taxYear === taxYear);
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const totals = new Map<string, number>();
  const warnings: string[] = [];
  let unclassifiedCount = 0;

  for (const line of lines) totals.set(line.id, 0);

  const items = listMockEurItems({ taxYear, from: range.from, to: range.to });
  for (const item of items) {
    const cls = item.classification;
    if (cls?.excluded) continue;
    if (!cls?.eurLineId) {
      unclassifiedCount += 1;
      continue;
    }

    const line = linesById.get(cls.eurLineId);
    if (!line) {
      warnings.push(`Unknown EÜR line for ${item.sourceType}:${item.sourceId}: ${cls.eurLineId}`);
      unclassifiedCount += 1;
      continue;
    }
    if (line.kind === 'computed') {
      warnings.push(`Computed line cannot be used for classification: ${line.id}`);
      unclassifiedCount += 1;
      continue;
    }
    if (line.kind !== item.flowType) {
      warnings.push(`Flow mismatch for ${item.sourceType}:${item.sourceId}: line ${line.id} is ${line.kind}`);
      unclassifiedCount += 1;
      continue;
    }

    totals.set(line.id, round2((totals.get(line.id) ?? 0) + item.amountNet));
  }

  const computedMemo = new Map<string, number>();
  const resolveTotal = (lineId: string): number => {
    if (computedMemo.has(lineId)) return computedMemo.get(lineId)!;
    const line = linesById.get(lineId);
    if (!line) return 0;
    if (line.kind !== 'computed') {
      const direct = totals.get(lineId) ?? 0;
      computedMemo.set(lineId, direct);
      return direct;
    }
    const value = round2((line.computedFromIds ?? []).reduce((sum, childId) => sum + resolveTotal(childId), 0));
    computedMemo.set(lineId, value);
    totals.set(lineId, value);
    return value;
  };

  for (const line of lines) resolveTotal(line.id);

  const rows = lines.map((line) => ({
    lineId: line.id,
    kennziffer: line.kennziffer,
    label: line.label,
    kind: line.kind,
    exportable: line.exportable,
    total: round2(totals.get(line.id) ?? 0),
    sortOrder: line.sortOrder,
  }));

  const incomeTotal = round2(rows.filter((row) => row.kind === 'income').reduce((sum, row) => sum + row.total, 0));
  const expenseTotal = round2(rows.filter((row) => row.kind === 'expense').reduce((sum, row) => sum + row.total, 0));

  return {
    taxYear,
    from: range.from,
    to: range.to,
    rows,
    summary: {
      incomeTotal,
      expenseTotal,
      surplus: round2(incomeTotal - expenseTotal),
    },
    unclassifiedCount,
    warnings,
  };
};

const buildMockEurCsv = (report: ReturnType<typeof getMockEurReport>): string => {
  const header = ['Kennziffer', 'Bezeichnung', 'Betrag'].join(';');
  const rows = report.rows
    .filter((row) => row.exportable)
    .map((row) => [row.kennziffer ?? '', row.label, row.total.toFixed(2).replace('.', ',')].join(';'));
  return `\uFEFF${[header, ...rows].join('\n')}`;
};

const normalizeInvoiceTaxData = (doc: Invoice): Invoice => {
  const taxMode = resolveInvoiceTaxMode(doc.taxMode, settings);
  const taxSnapshot = calculateInvoiceTaxSnapshot(
    {
      items: doc.items ?? [],
      taxMode,
      taxMeta: doc.taxMeta,
    },
    settings,
  );
  return {
    ...doc,
    taxMode,
    taxSnapshot,
    amount: taxSnapshot.grossAmount,
  };
};

const invoke = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
  switch (key) {
    case 'invoices:list':
      return structuredClone(invoices) as IpcResult<K>;
    case 'invoices:upsert': {
      const { invoice } = args as IpcArgs<'invoices:upsert'>;
      const normalized = structuredClone(invoice) as Invoice;
      delete normalized.numberReservationId;
      const idx = invoices.findIndex((i) => i.id === normalized.id);
      if (idx >= 0) invoices[idx] = normalized;
      else invoices.unshift(normalized);
      return structuredClone(normalized) as IpcResult<K>;
    }
    case 'invoices:delete': {
      const { id } = args as IpcArgs<'invoices:delete'>;
      const idx = invoices.findIndex((i) => i.id === id);
      if (idx >= 0) invoices.splice(idx, 1);
      return { ok: true } as IpcResult<K>;
    }

    case 'offers:list':
      return structuredClone(offers) as IpcResult<K>;
    case 'offers:upsert': {
      const { offer } = args as IpcArgs<'offers:upsert'>;
      const normalized = structuredClone(offer) as Invoice;
      delete normalized.numberReservationId;
      const idx = offers.findIndex((o) => o.id === normalized.id);
      if (idx >= 0) offers[idx] = normalized;
      else offers.unshift(normalized);
      return structuredClone(normalized) as IpcResult<K>;
    }
    case 'offers:delete': {
      const { id } = args as IpcArgs<'offers:delete'>;
      const idx = offers.findIndex((o) => o.id === id);
      if (idx >= 0) offers.splice(idx, 1);
      return { ok: true } as IpcResult<K>;
    }

    case 'clients:list':
      return structuredClone(clients) as IpcResult<K>;
    case 'clients:upsert': {
      const { client } = args as IpcArgs<'clients:upsert'>;
      const normalized = structuredClone(client) as Client;
      const existingCustomerNumber = clients.find((currentClient) => currentClient.id === normalized.id)?.customerNumber ?? '';
      const prepared = prepareClientForUpsert(normalized, {
        existingCustomerNumber,
        customerNumberExists: (customerNumber: string) => {
          return clients.some((currentClient) => currentClient.id !== normalized.id && currentClient.customerNumber === customerNumber);
        },
        reserveCustomerNumber: () => reserveNumber('customer'),
      });
      const { customerNumberReservationId, ...storedClient } = prepared;
      if (customerNumberReservationId) {
        finalizeNumber(customerNumberReservationId, normalized.id);
      }
      const idx = clients.findIndex((c) => c.id === normalized.id);
      if (idx >= 0) clients[idx] = storedClient;
      else clients.unshift(storedClient);
      // Keep client_number in sync on existing documents.
      const newCustomerNumber = storedClient.customerNumber ?? '';
      for (const inv of invoices) {
        if (inv.clientId === normalized.id) inv.clientNumber = newCustomerNumber;
      }
      for (const off of offers) {
        if (off.clientId === normalized.id) off.clientNumber = newCustomerNumber;
      }
      return structuredClone(storedClient) as IpcResult<K>;
    }
    case 'clients:delete': {
      const { id } = args as IpcArgs<'clients:delete'>;
      const idx = clients.findIndex((c) => c.id === id);
      if (idx >= 0) clients.splice(idx, 1);
      for (let i = projects.length - 1; i >= 0; i--) {
        if (projects[i]!.clientId === id) projects.splice(i, 1);
      }
      return { ok: true } as IpcResult<K>;
    }

    case 'projects:list': {
      const { clientId, includeArchived } = args as IpcArgs<'projects:list'>;
      const list = clientId ? projects.filter((p) => p.clientId === clientId) : projects;
      const filtered = includeArchived ? list : list.filter((p) => !p.archivedAt);
      return structuredClone(filtered) as IpcResult<K>;
    }
    case 'projects:get': {
      const { id } = args as IpcArgs<'projects:get'>;
      return structuredClone(projects.find((p) => p.id === id) ?? null) as IpcResult<K>;
    }
    case 'projects:upsert': {
      const { project } = args as IpcArgs<'projects:upsert'>;
      const idx = projects.findIndex((p) => p.id === project.id);
      if (idx >= 0) projects[idx] = project as any;
      else projects.unshift(project as any);
      return structuredClone(project) as IpcResult<K>;
    }
    case 'projects:archive': {
      const { id } = args as IpcArgs<'projects:archive'>;
      const idx = projects.findIndex((p) => p.id === id);
      if (idx < 0) throw new Error('Project not found');
      projects[idx] = { ...projects[idx]!, archivedAt: new Date().toISOString() };
      return structuredClone(projects[idx]!) as IpcResult<K>;
    }

    case 'articles:list':
      return structuredClone(articles) as IpcResult<K>;
    case 'articles:upsert': {
      const { article } = args as IpcArgs<'articles:upsert'>;
      const idx = articles.findIndex((a) => a.id === article.id);
      if (idx >= 0) articles[idx] = article as any;
      else articles.unshift(article as any);
      return structuredClone(article) as IpcResult<K>;
    }
    case 'articles:delete': {
      const { id } = args as IpcArgs<'articles:delete'>;
      const idx = articles.findIndex((a) => a.id === id);
      if (idx >= 0) articles.splice(idx, 1);
      return { ok: true } as IpcResult<K>;
    }

    case 'accounts:list':
      return structuredClone(accounts) as IpcResult<K>;
    case 'accounts:upsert': {
      const { account } = args as IpcArgs<'accounts:upsert'>;
      const idx = accounts.findIndex((a) => a.id === account.id);
      if (idx >= 0) accounts[idx] = account as any;
      else accounts.unshift(account as any);
      return structuredClone(account) as IpcResult<K>;
    }
    case 'accounts:delete': {
      const { id } = args as IpcArgs<'accounts:delete'>;
      const idx = accounts.findIndex((a) => a.id === id);
      if (idx >= 0) accounts.splice(idx, 1);
      return { ok: true } as IpcResult<K>;
    }

    case 'recurring:list':
      return structuredClone(recurringProfiles) as IpcResult<K>;
    case 'recurring:upsert': {
      const { profile } = args as IpcArgs<'recurring:upsert'>;
      const idx = recurringProfiles.findIndex((p) => p.id === profile.id);
      if (idx >= 0) recurringProfiles[idx] = profile as any;
      else recurringProfiles.unshift(profile as any);
      return structuredClone(profile) as IpcResult<K>;
    }
    case 'recurring:delete': {
      const { id } = args as IpcArgs<'recurring:delete'>;
      const idx = recurringProfiles.findIndex((p) => p.id === id);
      if (idx >= 0) recurringProfiles.splice(idx, 1);
      return { ok: true } as IpcResult<K>;
    }
    case 'recurring:manualRun':
      return {
        success: true,
        result: { generated: 0, deactivated: 0, errors: [] },
      } as IpcResult<K>;

    case 'settings:get':
      return structuredClone(settings) as IpcResult<K>;
    case 'settings:set': {
      const { settings: next } = args as IpcArgs<'settings:set'>;
      settings = structuredClone(next) as any;
      return { ok: true } as IpcResult<K>;
    }

    case 'numbers:reserve': {
      const { kind } = args as IpcArgs<'numbers:reserve'>;
      return reserveNumber(kind) as IpcResult<K>;
    }
    case 'numbers:release': {
      const { reservationId } = args as IpcArgs<'numbers:release'>;
      return releaseNumber(reservationId) as IpcResult<K>;
    }
    case 'numbers:finalize': {
      const { reservationId, documentId } = args as IpcArgs<'numbers:finalize'>;
      return finalizeNumber(reservationId, documentId) as IpcResult<K>;
    }

    case 'documents:createFromClient': {
      const { kind, clientId } = args as IpcArgs<'documents:createFromClient'>;
      const client = clients.find((c) => c.id === clientId);
      if (!client) throw new Error('Client not found');

      const defaultProject = ensureDefaultProject(clientId);

      const today = new Date().toISOString().split('T')[0];
      const billingAddress = chooseDefaultBillingAddress(client.addresses ?? []) ?? client.addresses?.[0] ?? null;
      const shippingAddress =
        (client.addresses ?? []).find((a: any) => a.isDefaultShipping) ?? billingAddress ?? null;
      const billingEmail = chooseDefaultBillingEmail(client.emails ?? []) ?? client.emails?.[0] ?? null;
      const numberReservation = reserveNumber(kind === 'offer' ? 'offer' : 'invoice');

      const doc: Invoice = {
        id: Math.random().toString(36).substr(2, 9),
        clientId,
        clientNumber: client.customerNumber,
        projectId: defaultProject.id,
        number: numberReservation.number,
        numberReservationId: numberReservation.reservationId,
        client: client.company,
        clientEmail: billingEmail?.email ?? client.email,
        clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : client.address,
        billingAddressJson: billingAddress,
        shippingAddressJson: shippingAddress,
        taxMode: 'standard_vat',
        date: today,
        dueDate: kind === 'offer' ? today : '',
        amount: 0,
        status: 'draft',
        items: [],
        payments: [],
        history: [],
      };

      return structuredClone(normalizeInvoiceTaxData(doc)) as IpcResult<K>;
    }
    case 'documents:convertOfferToInvoice': {
      const { offerId, invoiceDate, dueDate } = args as IpcArgs<'documents:convertOfferToInvoice'>;
      const offer = offers.find((o) => o.id === offerId);
      if (!offer) throw new Error('Offer not found');
      const reservation = reserveNumber('invoice');
      const today = toIsoDate(new Date());
      const paymentTerms = settings.legal?.paymentTermsDays ?? 14;
      const defaultDueDate = (() => {
        const d = new Date();
        d.setDate(d.getDate() + paymentTerms);
        return toIsoDate(d);
      })();
      const invoice: Invoice = {
        ...structuredClone(offer),
        id: Math.random().toString(36).slice(2),
        number: reservation.number,
        numberReservationId: reservation.reservationId,
        taxMode: offer.taxMode ?? 'standard_vat',
        date: invoiceDate ?? today,
        dueDate: dueDate ?? defaultDueDate,
        status: 'open',
        history: [
          {
            date: today,
            action: `Erstellt aus Angebot ${offer.number}`,
          },
          ...(offer.history ?? []),
        ],
      };
      const normalizedInvoice = normalizeInvoiceTaxData(invoice);
      invoices.unshift(normalizedInvoice);
      finalizeNumber(reservation.reservationId, normalizedInvoice.id);
      return structuredClone(normalizedInvoice) as IpcResult<K>;
    }

    case 'templates:list': {
      const { kind } = args as IpcArgs<'templates:list'>;
      const list = kind ? templates.filter((t) => t.kind === kind) : templates;
      return structuredClone(list) as IpcResult<K>;
    }
    case 'templates:active': {
      const { kind } = args as IpcArgs<'templates:active'>;
      const id = kind === 'invoice' ? activeTemplateIds.invoice : activeTemplateIds.offer;
      if (!id) return null as IpcResult<K>;
      return structuredClone(templates.find((t) => t.id === id) ?? null) as IpcResult<K>;
    }
    case 'templates:upsert': {
      const { template } = args as IpcArgs<'templates:upsert'>;
      const idx = templates.findIndex((t) => t.id === template.id);
      const next: DocumentTemplate = {
        ...template,
        elements: template.elements as InvoiceElement[],
        createdAt: idx >= 0 ? templates[idx]!.createdAt : now,
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) templates[idx] = next;
      else templates.unshift(next);
      return structuredClone(next) as IpcResult<K>;
    }
    case 'templates:delete': {
      const { id } = args as IpcArgs<'templates:delete'>;
      const idx = templates.findIndex((t) => t.id === id);
      if (idx >= 0) templates.splice(idx, 1);
      if (activeTemplateIds.invoice === id) activeTemplateIds.invoice = null;
      if (activeTemplateIds.offer === id) activeTemplateIds.offer = null;
      return { ok: true } as IpcResult<K>;
    }
    case 'templates:setActive': {
      const { kind, templateId } = args as IpcArgs<'templates:setActive'>;
      if (kind === 'invoice') activeTemplateIds.invoice = templateId;
      else activeTemplateIds.offer = templateId;
      return { ok: true } as IpcResult<K>;
    }

    case 'audit:verify':
      return { ok: true, errors: [], count: 0, headHash: null } as IpcResult<K>;
    case 'audit:exportCsv':
      return '\uFEFFsequence,ts,entity_type,entity_id,action,reason,prev_hash,hash,actor,before_json,after_json\n' as IpcResult<K>;
    case 'pdf:export': {
      const { kind, id } = args as IpcArgs<'pdf:export'>;
      return { path: `mock://pdf/${kind}/${id}.pdf` } as IpcResult<K>;
    }
    case 'portal:health':
      return { ok: true, ts: new Date().toISOString() } as IpcResult<K>;
    case 'portal:publishOffer':
      return {
        ok: true,
        token: 'mock-offer-token-1234567890',
        publicUrl: `${settings.portal.baseUrl.replace(/\/+$/, '')}/offers/mock-offer-token-1234567890`,
      } as IpcResult<K>;
    case 'portal:publishInvoice':
      return {
        ok: true,
        token: 'mock-invoice-token-1234567890',
        publicUrl: `${settings.portal.baseUrl.replace(/\/+$/, '')}/invoices/mock-invoice-token-1234567890`,
      } as IpcResult<K>;
    case 'portal:syncOfferStatus':
      return { ok: true, decision: null, updated: false } as IpcResult<K>;
    case 'portal:createCustomerAccessLink':
    case 'portal:rotateCustomerAccessLink': {
      const { customerRef } = args as IpcArgs<'portal:createCustomerAccessLink'>;
      const token = `mock-customer-${customerRef.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}-token`;
      return {
        ok: true,
        token,
        publicUrl: `${settings.portal.baseUrl.replace(/\/+$/, '')}/customers/${token}`,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      } as IpcResult<K>;
    }

    case 'eur:getReport': {
      const payload = args as IpcArgs<'eur:getReport'>;
      return getMockEurReport(payload) as IpcResult<K>;
    }

    case 'eur:listItems': {
      const payload = args as IpcArgs<'eur:listItems'>;
      return listMockEurItems(payload) as IpcResult<K>;
    }

    case 'eur:upsertClassification': {
      const payload = args as IpcArgs<'eur:upsertClassification'>;
      const key = `${payload.sourceType}:${payload.sourceId}:${payload.taxYear}`;
      const value = {
        id: mockEurClassifications.get(key)?.id ?? Math.random().toString(36).slice(2),
        sourceType: payload.sourceType,
        sourceId: payload.sourceId,
        taxYear: payload.taxYear,
        eurLineId: payload.excluded ? undefined : payload.eurLineId,
        excluded: payload.excluded ?? false,
        vatMode: payload.vatMode ?? 'none',
        note: payload.note,
        updatedAt: new Date().toISOString(),
      };
      mockEurClassifications.set(key, value);
      return value as IpcResult<K>;
    }

    case 'eur:exportCsv': {
      const payload = args as IpcArgs<'eur:exportCsv'>;
      const report = getMockEurReport(payload);
      return buildMockEurCsv(report) as IpcResult<K>;
    }

    case 'eur:exportPdf':
      return { path: 'mock://eur/export.pdf' } as IpcResult<K>;

    case 'eur:listRules': {
      const { taxYear } = args as IpcArgs<'eur:listRules'>;
      return mockEurRules.filter((r: any) => r.taxYear === taxYear) as IpcResult<K>;
    }
    case 'eur:upsertRule': {
      const payload = args as IpcArgs<'eur:upsertRule'>;
      const id = payload.id ?? Math.random().toString(36).slice(2);
      const rule = {
        id,
        taxYear: payload.taxYear,
        priority: payload.priority,
        field: payload.field,
        operator: payload.operator,
        value: payload.value,
        targetEurLineId: payload.targetEurLineId,
        active: payload.active !== false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const idx = mockEurRules.findIndex((r: any) => r.id === id);
      if (idx >= 0) mockEurRules[idx] = rule;
      else mockEurRules.push(rule);
      return rule as IpcResult<K>;
    }
    case 'eur:deleteRule': {
      const { id } = args as IpcArgs<'eur:deleteRule'>;
      const idx = mockEurRules.findIndex((r: any) => r.id === id);
      if (idx >= 0) mockEurRules.splice(idx, 1);
      return { ok: true } as IpcResult<K>;
    }

    case 'secrets:get': {
      const { key } = args as IpcArgs<'secrets:get'>;
      return (mockSecrets.get(key) ?? null) as IpcResult<K>;
    }
    case 'secrets:set': {
      const { key, value } = args as IpcArgs<'secrets:set'>;
      mockSecrets.set(key, value);
      return undefined as IpcResult<K>;
    }
    case 'secrets:delete': {
      const { key } = args as IpcArgs<'secrets:delete'>;
      return mockSecrets.delete(key) as IpcResult<K>;
    }
    case 'secrets:has': {
      const { key } = args as IpcArgs<'secrets:has'>;
      return mockSecrets.has(key) as IpcResult<K>;
    }

    case 'db:backup':
      return { path: 'mock://backup/billme-demo.sqlite' } as IpcResult<K>;
    case 'db:restore':
      return { ok: true, verification: { ok: true, errors: [], count: 0, headHash: null } } as IpcResult<K>;
    case 'tax:auditExportPackage': {
      const now = new Date().toISOString();
      const bundleDir = `mock://exports/tax-audit/${Date.now()}`;
      const files = [
        {
          name: 'audit-log.csv',
          path: `${bundleDir}/audit-log.csv`,
          sha256: '0'.repeat(64),
          sizeBytes: 256,
          rowCount: 1,
        },
        {
          name: 'journal-entries.jsonl',
          path: `${bundleDir}/journal-entries.jsonl`,
          sha256: '1'.repeat(64),
          sizeBytes: 512,
          rowCount: 1,
        },
      ];
      return {
        bundleDir,
        manifestPath: `${bundleDir}/manifest.json`,
        createdAt: now,
        fileCount: files.length,
        files,
      } as IpcResult<K>;
    }

    case 'shell:openPath':
    case 'shell:openExportsDir':
    case 'shell:openExternal':
      return { ok: true } as IpcResult<K>;

    case 'dialog:pickCsv':
      return { path: 'mock://imports/sample.csv' } as IpcResult<K>;

    case 'finance:importPreview': {
      const payload = args as IpcArgs<'finance:importPreview'>;
      const nowDate = toIsoDate(new Date());
      const rows = [
        {
          rowIndex: 2,
          raw: {
            date: nowDate,
            amount: '1890.00',
            counterparty: 'Demo Kunde GmbH',
            purpose: 'Zahlung Rechnung RE-2026-001',
            status: 'booked',
          },
          parsed: {
            date: nowDate,
            amount: 1890,
            type: 'income' as const,
            counterparty: 'Demo Kunde GmbH',
            purpose: 'Zahlung Rechnung RE-2026-001',
            status: 'booked' as const,
          },
          errors: [],
          dedupHash: 'mock-dedup-1',
        },
        {
          rowIndex: 3,
          raw: {
            date: nowDate,
            amount: '-79.99',
            counterparty: 'SaaS Tools Ltd',
            purpose: 'Software Abo',
            status: 'booked',
          },
          parsed: {
            date: nowDate,
            amount: -79.99,
            type: 'expense' as const,
            counterparty: 'SaaS Tools Ltd',
            purpose: 'Software Abo',
            status: 'booked' as const,
          },
          errors: [],
          dedupHash: 'mock-dedup-2',
        },
      ];
      return {
        path: payload.path,
        fileName: 'sample.csv',
        fileSha256: 'mock-sha256-sample',
        delimiter: ';',
        headers: ['date', 'amount', 'counterparty', 'purpose', 'status'],
        profile: payload.profile && payload.profile !== 'auto' ? payload.profile : 'generic',
        suggestedMapping: {
          dateColumn: 'date',
          amountColumn: 'amount',
          counterpartyColumn: 'counterparty',
          purposeColumn: 'purpose',
          statusColumn: 'status',
        },
        rows,
        stats: {
          totalRows: rows.length,
          previewRows: rows.length,
          validRows: rows.length,
          errorRows: 0,
        },
      } as IpcResult<K>;
    }

    case 'finance:importCommit': {
      const payload = args as IpcArgs<'finance:importCommit'>;
      const account = accounts.find((a) => a.id === payload.accountId);
      if (!account) throw new Error('Account not found');

      const batchId = `batch_${Math.random().toString(36).slice(2)}`;
      const createdAt = new Date().toISOString();
      const importedRows = [
        {
          id: `tx_${Math.random().toString(36).slice(2)}`,
          date: toIsoDate(new Date()),
          amount: 1890,
          type: 'income' as const,
          counterparty: 'Demo Kunde GmbH',
          purpose: 'CSV Import Zahlung',
          status: 'booked' as const,
          importBatchId: batchId,
        },
      ];
      account.transactions = [...importedRows, ...(account.transactions ?? [])];
      mockImportBatches.unshift({
        id: batchId,
        accountId: account.id,
        profile: payload.profile && payload.profile !== 'auto' ? payload.profile : 'generic',
        fileName: 'sample.csv',
        fileSha256: 'mock-sha256-sample',
        mappingJson: payload.mapping,
        importedCount: importedRows.length,
        skippedCount: 0,
        errorCount: 0,
        createdAt,
      });
      return {
        batchId,
        imported: importedRows.length,
        skipped: 0,
        errors: [],
        fileSha256: 'mock-sha256-sample',
      } as IpcResult<K>;
    }

    case 'finance:listImportBatches': {
      const { accountId, limit } = args as IpcArgs<'finance:listImportBatches'>;
      const filtered = mockImportBatches.filter((b) => !accountId || b.accountId === accountId);
      return structuredClone(filtered.slice(0, Math.max(1, limit ?? 50))) as IpcResult<K>;
    }

    case 'finance:getImportBatchDetails': {
      const { batchId } = args as IpcArgs<'finance:getImportBatchDetails'>;
      const batch = mockImportBatches.find((b) => b.id === batchId);
      if (!batch) throw new Error('Import batch not found');
      const transactions = getAllTransactions().filter((tx) => tx.importBatchId === batchId);
      return {
        batch,
        transactions,
        canRollback: !batch.rolledBackAt,
        linkedInvoiceCount: transactions.filter((tx) => Boolean(tx.linkedInvoiceId)).length,
      } as IpcResult<K>;
    }

    case 'finance:rollbackImportBatch': {
      const { batchId, reason } = args as IpcArgs<'finance:rollbackImportBatch'>;
      const batch = mockImportBatches.find((b) => b.id === batchId);
      if (!batch) throw new Error('Import batch not found');
      if (batch.rolledBackAt) return { success: true, deletedCount: 0 } as IpcResult<K>;
      let deletedCount = 0;
      for (const account of accounts) {
        const before = account.transactions.length;
        account.transactions = account.transactions.filter((tx) => tx.importBatchId !== batchId);
        deletedCount += before - account.transactions.length;
      }
      batch.rolledBackAt = new Date().toISOString();
      batch.rollbackReason = reason;
      return { success: true, deletedCount } as IpcResult<K>;
    }

    case 'pro:importSkr': {
      const nowIso = new Date().toISOString();
      let inserted = 0;
      let updated = 0;
      const seed = (chart: 'SKR03' | 'SKR04', accountNumber: string, name: string) => {
        const id = `ledger:${chart}:${accountNumber}`;
        const idx = mockLedgerAccounts.findIndex((row) => row.chart === chart && row.accountNumber === accountNumber);
      const next: MockLedgerAccount = {
        id,
        chart,
        accountNumber,
        name,
        keywords: [name.toLowerCase()],
        source: 'mock:seed',
        createdAt: idx >= 0 ? mockLedgerAccounts[idx]!.createdAt : nowIso,
        updatedAt: nowIso,
        };
        if (idx >= 0) {
          mockLedgerAccounts[idx] = next;
          updated += 1;
        } else {
          mockLedgerAccounts.push(next);
          inserted += 1;
        }
      };

      seed('SKR03', '1200', 'Bank');
      seed('SKR03', '1000', 'Kasse');
      seed('SKR03', '8400', 'Erlöse 19% USt');
      seed('SKR03', '1576', 'Vorsteuer 19%');
      seed('SKR04', '1800', 'Bank');
      seed('SKR04', '1600', 'Kasse');
      seed('SKR04', '4400', 'Erlöse 19% USt');
      seed('SKR04', '1406', 'Vorsteuer 19%');

      const stats = getMockLedgerStats();
      return {
        source: 'csv',
        sourceDetails: ['mock://skr-seed'],
        inserted,
        updated,
        total: inserted + updated,
        skipped: 0,
        warnings: [],
        stats,
      } as IpcResult<K>;
    }

    case 'pro:listLedgerAccounts': {
      const payload = args as IpcArgs<'pro:listLedgerAccounts'>;
      let rows = [...mockLedgerAccounts];
      if (payload.chart) {
        rows = rows.filter((row) => row.chart === payload.chart);
      }
      if (payload.search && payload.search.trim()) {
        const q = payload.search.trim().toLowerCase();
        rows = rows.filter(
          (row) => row.accountNumber.toLowerCase().includes(q) || row.name.toLowerCase().includes(q),
        );
      }
      const offset = Math.max(0, payload.offset ?? 0);
      const limit = Math.max(1, payload.limit ?? 500);
      rows.sort((a, b) => {
        if (a.chart !== b.chart) return a.chart.localeCompare(b.chart);
        return a.accountNumber.localeCompare(b.accountNumber);
      });
      return rows.slice(offset, offset + limit) as IpcResult<K>;
    }

    case 'pro:listTaxCases': {
      const { activeOnly } = args as IpcArgs<'pro:listTaxCases'>;
      return mockTaxCases.filter((item) => (activeOnly ? item.active : true)) as IpcResult<K>;
    }

    case 'pro:listTaxCaseAccountMappings': {
      ensureMockTaxMappings();
      const { chart, taxCaseKey } = args as IpcArgs<'pro:listTaxCaseAccountMappings'>;
      const normalizedKey = normalizeMockTaxCaseKey(taxCaseKey);
      return mockTaxCaseMappings
        .filter((row) => (chart ? row.chart === chart : true))
        .filter((row) => (normalizedKey ? row.taxCaseKey === normalizedKey : true))
        .sort((a, b) => {
          if (a.chart !== b.chart) return a.chart.localeCompare(b.chart);
          if (a.taxCaseKey !== b.taxCaseKey) return a.taxCaseKey.localeCompare(b.taxCaseKey);
          return a.role.localeCompare(b.role);
        }) as IpcResult<K>;
    }

    case 'pro:upsertTaxCaseAccountMapping': {
      ensureMockTaxMappings();
      const payload = args as IpcArgs<'pro:upsertTaxCaseAccountMapping'>;
      const nowIso = new Date().toISOString();
      const normalizedKey = normalizeMockTaxCaseKey(payload.taxCaseKey);
      if (!normalizedKey) throw new Error('Invalid taxCaseKey');

      const idx = mockTaxCaseMappings.findIndex(
        (row) => row.chart === payload.chart && row.taxCaseKey === normalizedKey && row.role === payload.role,
      );
      const next = {
        id: payload.id ?? (idx >= 0 ? mockTaxCaseMappings[idx]!.id : `tmap-${Math.random().toString(36).slice(2)}`),
        chart: payload.chart,
        taxCaseKey: normalizedKey,
        role: payload.role,
        accountNumber: payload.accountNumber,
        datevBuKey: payload.datevBuKey,
        validFrom: payload.validFrom,
        validTo: payload.validTo,
        updatedAt: nowIso,
      };
      if (idx >= 0) mockTaxCaseMappings[idx] = next;
      else mockTaxCaseMappings.push(next);
      return next as IpcResult<K>;
    }

    case 'pro:getLedgerStats':
      return getMockLedgerStats() as IpcResult<K>;

    case 'pro:listBankTransactions': {
      return getAllTransactions().map((tx) => ({
        ...tx,
        ...suggestMockAccount(tx),
      })) as IpcResult<K>;
    }

    case 'pro:listAccountSuggestionRules': {
      const { chart, activeOnly } = args as IpcArgs<'pro:listAccountSuggestionRules'>;
      return mockAccountSuggestionRules
        .filter((rule) => (chart ? rule.chart === chart : true))
        .filter((rule) => (activeOnly ? rule.active : true))
        .sort((a, b) => a.priority - b.priority) as IpcResult<K>;
    }

    case 'pro:upsertAccountSuggestionRule': {
      const payload = args as IpcArgs<'pro:upsertAccountSuggestionRule'>;
      const id = payload.id ?? `asr-${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString();
      const rule = {
        id,
        tenantId: 'default',
        chart: payload.chart,
        priority: payload.priority,
        field: payload.field,
        operator: payload.operator,
        value: payload.value,
        targetAccountNumber: payload.targetAccountNumber,
        flowType: payload.flowType ?? 'any',
        active: payload.active !== false,
        createdAt: now,
        updatedAt: now,
      };
      const idx = mockAccountSuggestionRules.findIndex((row) => row.id === id);
      if (idx >= 0) {
        rule.createdAt = mockAccountSuggestionRules[idx]!.createdAt;
        mockAccountSuggestionRules[idx] = rule;
      } else {
        mockAccountSuggestionRules.push(rule);
      }
      return rule as IpcResult<K>;
    }

    case 'pro:deleteAccountSuggestionRule': {
      const { id } = args as IpcArgs<'pro:deleteAccountSuggestionRule'>;
      const idx = mockAccountSuggestionRules.findIndex((row) => row.id === id);
      if (idx >= 0) mockAccountSuggestionRules.splice(idx, 1);
      return { ok: true } as IpcResult<K>;
    }

    case 'pro:getDraftByTransactionId': {
      const { transactionId } = args as IpcArgs<'pro:getDraftByTransactionId'>;
      return (getMockDraft(transactionId) ?? null) as IpcResult<K>;
    }

    case 'pro:saveDraft': {
      const { draft } = args as IpcArgs<'pro:saveDraft'>;
      const normalizedLines = (draft.lines ?? []).map(normalizeMockDraftLineTaxFields);
      const taxIssues = validateMockTaxComplianceIssues({ ...(draft as MockDraft), lines: normalizedLines });
      const next = {
        ...draft,
        lines: normalizedLines,
        validationIssues: taxIssues,
        workflowStatus: taxIssues.some((issue) => issue.blocking)
          ? 'incomplete'
          : draft.workflowStatus,
        updatedAt: new Date().toISOString(),
      };
      mockDrafts.set(draft.transactionId, next);
      return next as IpcResult<K>;
    }

    case 'pro:dispatchDraftAction': {
      const { transactionId, action, rejectReason } = args as IpcArgs<'pro:dispatchDraftAction'>;
      const current = getMockDraft(transactionId);
      if (!current) throw new Error('Draft not found');
      const next = { ...current, updatedAt: new Date().toISOString() };
      if (action === 'save_draft') {
        next.workflowStatus = 'suggested';
      } else if (action === 'submit_for_review') {
        next.workflowStatus = 'pending_approval';
      } else if (action === 'approve' || action === 'post') {
        next.workflowStatus = 'approved';
      } else if (action === 'reject' || action === 'request_receipt') {
        next.workflowStatus = 'incomplete';
        if (action === 'reject' && rejectReason) {
          next.validationIssues = [
            {
              id: `warn-${Date.now()}`,
              code: 'MANUAL_REVIEW_REJECTED',
              severity: 'warning',
              message: rejectReason,
              blocking: false,
              source: 'user',
            },
          ];
        }
      } else if (action === 'reverse') {
        next.workflowStatus = 'reversed';
      } else if (action === 'create_correction') {
        next.workflowStatus = 'corrected';
      }
      mockDrafts.set(transactionId, next);
      return next as IpcResult<K>;
    }

    case 'pro:postDraft': {
      const { draftId, postingDate } = args as IpcArgs<'pro:postDraft'>;
      const draft = Array.from(mockDrafts.values()).find((row) => row.id === draftId);
      if (!draft) throw new Error('Draft not found');
      ensureMockTaxMappings();
      const normalizedLines = draft.lines.map(normalizeMockDraftLineTaxFields);
      const debit = normalizedLines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0);
      const credit = normalizedLines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0);
      const issues: IpcResult<'pro:postDraft'>['issues'] = [];
      issues.push(...validateMockTaxComplianceIssues({ ...draft, lines: normalizedLines }));
      if (Math.abs(debit - credit) > 0.01) {
        issues.push({
          id: `err-${Date.now()}`,
          code: 'UNBALANCED_ENTRY',
          severity: 'error',
          message: 'Soll/Haben sind nicht ausgeglichen.',
          blocking: true,
          source: 'system',
        });
      }

      const chart = getMockActiveChart();
      const postingLines = [...normalizedLines];
      for (const line of normalizedLines) {
        const taxCaseKey = normalizeMockTaxCaseKey(line.taxCaseKey ?? line.taxCode);
        const taxCase = getMockTaxCaseByKey(taxCaseKey);
        if (!taxCase || taxCase.mechanism !== 'reverse_charge') continue;
        const taxAmount = round2(Number(line.taxAmount || 0));
        if (taxAmount <= 0) continue;
        const inputTax = getMockTaxMapping(chart, taxCase.key, 'input_tax');
        const outputTax = getMockTaxMapping(chart, taxCase.key, 'output_tax');
        if (!inputTax || !outputTax) continue;

        postingLines.push({
          id: `line-rc-input-${Math.random().toString(36).slice(2)}`,
          accountNumber: inputTax.accountNumber,
          debitAmount: taxAmount,
          creditAmount: 0,
          taxCode: toMockLegacyTaxCode(taxCase.key),
          taxCaseKey: taxCase.key,
          taxRate: line.taxRate ?? taxCase.defaultRate,
          netAmount: line.netAmount,
          taxAmount,
          grossAmount: line.grossAmount ?? line.netAmount,
          countryCode: line.countryCode,
          counterpartyVatId: line.counterpartyVatId,
          evidenceType: line.evidenceType,
          evidenceReference: line.evidenceReference,
          memo: `RC Vorsteuer ${taxCase.key}`,
        });
        postingLines.push({
          id: `line-rc-output-${Math.random().toString(36).slice(2)}`,
          accountNumber: outputTax.accountNumber,
          debitAmount: 0,
          creditAmount: taxAmount,
          taxCode: toMockLegacyTaxCode(taxCase.key),
          taxCaseKey: taxCase.key,
          taxRate: line.taxRate ?? taxCase.defaultRate,
          netAmount: line.netAmount,
          taxAmount,
          grossAmount: line.grossAmount ?? line.netAmount,
          countryCode: line.countryCode,
          counterpartyVatId: line.counterpartyVatId,
          evidenceType: line.evidenceType,
          evidenceReference: line.evidenceReference,
          memo: `RC Umsatzsteuer ${taxCase.key}`,
        });
      }

      const entry = {
        id: `je-${Math.random().toString(36).slice(2)}`,
        tenantId: 'default',
        entryNumber: mockJournalEntries.length + 1,
        postingDate: postingDate ?? draft.postingDate ?? new Date().toISOString().slice(0, 10),
        documentDate: draft.documentDate,
        bookingText: draft.bookingText,
        reference: draft.reference,
        period: (postingDate ?? draft.postingDate ?? new Date().toISOString().slice(0, 10)).slice(0, 7),
        fiscalYear: Number((postingDate ?? draft.postingDate ?? new Date().toISOString().slice(0, 10)).slice(0, 4)),
        status: 'posted' as const,
        sourceDraftId: draft.id,
        createdAt: new Date().toISOString(),
        lines: postingLines,
      };

      if (issues.length === 0) {
        mockJournalEntries.unshift(entry);
        mockDrafts.set(draft.transactionId, { ...draft, workflowStatus: 'posted', updatedAt: new Date().toISOString() });
      }

      return { entry, issues } as IpcResult<K>;
    }

    case 'pro:reverseJournalEntry': {
      const { entryId, reason } = args as IpcArgs<'pro:reverseJournalEntry'>;
      const entry = mockJournalEntries.find((row) => row.id === entryId);
      if (!entry) throw new Error('Journal entry not found');
      if (entry.status === 'reversed') throw new Error('Journal entry already reversed');
      const reversalId = `je-rev-${Math.random().toString(36).slice(2)}`;
      entry.status = 'reversed';
      entry.reversedEntryId = reversalId;
      mockJournalEntries.unshift({
        id: reversalId,
        tenantId: 'default',
        entryNumber: mockJournalEntries.length + 1,
        postingDate: new Date().toISOString().slice(0, 10),
        bookingText: `Storno: ${entry.bookingText}`,
        reference: reason,
        period: new Date().toISOString().slice(0, 7),
        fiscalYear: new Date().getFullYear(),
        status: 'posted',
        reversedEntryId: entryId,
        createdAt: new Date().toISOString(),
        lines: entry.lines.map((line) => ({
          ...line,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
        })),
      });
      return { ok: true, reversalEntryId: reversalId } as IpcResult<K>;
    }

    case 'pro:listJournalEntries': {
      const { from, to, limit = 500, offset = 0 } = args as IpcArgs<'pro:listJournalEntries'>;
      let rows = [...mockJournalEntries];
      if (from) rows = rows.filter((row) => row.postingDate >= from);
      if (to) rows = rows.filter((row) => row.postingDate <= to);
      return rows.slice(offset, offset + limit) as IpcResult<K>;
    }

    case 'pro:getLedgerBalances': {
      const { asOfDate } = args as IpcArgs<'pro:getLedgerBalances'>;
      const rows = mockJournalEntries
        .filter((entry) => entry.status === 'posted')
        .filter((entry) => !asOfDate || entry.postingDate <= asOfDate);
      const byAccount = new Map<string, { debit: number; credit: number }>();
      for (const entry of rows) {
        for (const line of entry.lines) {
          const current = byAccount.get(line.accountNumber) ?? { debit: 0, credit: 0 };
          current.debit += Number(line.debitAmount || 0);
          current.credit += Number(line.creditAmount || 0);
          byAccount.set(line.accountNumber, current);
        }
      }
      return Array.from(byAccount.entries())
        .map(([accountNumber, values]) => ({
          accountNumber,
          openingBalance: 0,
          debitTurnover: values.debit,
          creditTurnover: values.credit,
          closingBalance: values.debit - values.credit,
        }))
        .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)) as IpcResult<K>;
    }

    case 'pro:getSusaReport': {
      const payload = await invoke('pro:getLedgerBalances', args as IpcArgs<'pro:getLedgerBalances'>);
      const totals = payload.reduce(
        (acc, row) => ({
          debit: acc.debit + row.debitTurnover,
          credit: acc.credit + row.creditTurnover,
          balance: acc.balance + row.closingBalance,
        }),
        { debit: 0, credit: 0, balance: 0 },
      );
      return {
        asOfDate: (args as IpcArgs<'pro:getSusaReport'>).asOfDate ?? new Date().toISOString().slice(0, 10),
        rows: payload,
        totals,
      } as IpcResult<K>;
    }

    case 'pro:getGuvReport': {
      const balances = (await invoke('pro:getLedgerBalances', {} as IpcArgs<'pro:getLedgerBalances'>))
        .map((row) => ({ ...row }));
      const revenue = balances
        .filter((row) => row.accountNumber.startsWith('8') || row.accountNumber.startsWith('9'))
        .reduce((sum, row) => sum + (row.creditTurnover - row.debitTurnover), 0);
      const expense = balances
        .filter((row) => ['4', '5', '6', '7'].includes(row.accountNumber[0] ?? ''))
        .reduce((sum, row) => sum + (row.debitTurnover - row.creditTurnover), 0);
      return {
        from: (args as IpcArgs<'pro:getGuvReport'>).from,
        to: (args as IpcArgs<'pro:getGuvReport'>).to,
        rows: [
          { positionKey: 'revenue', positionLabel: 'Umsatzerloese', amount: revenue },
          { positionKey: 'expense', positionLabel: 'Aufwendungen', amount: expense },
        ],
        netResult: revenue - expense,
      } as IpcResult<K>;
    }

    case 'pro:getBilanzReport': {
      const balances = (await invoke('pro:getLedgerBalances', {} as IpcArgs<'pro:getLedgerBalances'>))
        .map((row) => ({ ...row }));
      const assets = balances
        .filter((row) => row.accountNumber.startsWith('0') || row.accountNumber.startsWith('1'))
        .map((row) => ({ accountNumber: row.accountNumber, amount: row.closingBalance }));
      const liabilities = balances
        .filter((row) => row.accountNumber.startsWith('2') || row.accountNumber.startsWith('3'))
        .map((row) => ({ accountNumber: row.accountNumber, amount: Math.abs(row.closingBalance) }));
      const totalAssets = assets.reduce((sum, row) => sum + row.amount, 0);
      const totalLiabilities = liabilities.reduce((sum, row) => sum + row.amount, 0);
      return {
        asOfDate: (args as IpcArgs<'pro:getBilanzReport'>).asOfDate ?? new Date().toISOString().slice(0, 10),
        assets,
        liabilities,
        totals: {
          assets: totalAssets,
          liabilities: totalLiabilities,
          delta: totalAssets - totalLiabilities,
        },
      } as IpcResult<K>;
    }

    case 'pro:exportDatevBuchungsstapel': {
      const createdAt = new Date().toISOString();
      const payload = {
        id: `datev-${Math.random().toString(36).slice(2)}`,
        filePath: `mock://exports/datev-${Date.now()}.csv`,
        recordCount: mockJournalEntries.length,
        fromDate: (args as IpcArgs<'pro:exportDatevBuchungsstapel'>).from,
        toDate: (args as IpcArgs<'pro:exportDatevBuchungsstapel'>).to,
        createdAt,
      };
      mockDatevExports.unshift(payload);
      return payload as IpcResult<K>;
    }

    case 'pro:listDatevExports': {
      const { limit } = args as IpcArgs<'pro:listDatevExports'>;
      return (limit ? mockDatevExports.slice(0, limit) : mockDatevExports) as IpcResult<K>;
    }

    case 'pro:getAccountingHealth': {
      const unbalanced = Array.from(mockDrafts.values()).filter((draft) => {
        const debit = draft.lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0);
        const credit = draft.lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0);
        return Math.abs(debit - credit) > 0.01;
      }).length;
      return {
        draftCount: mockDrafts.size,
        postedCount: mockJournalEntries.filter((entry) => entry.status === 'posted').length,
        reversedCount: mockJournalEntries.filter((entry) => entry.status === 'reversed').length,
        unbalancedDraftCount: unbalanced,
        unmappedAccountCount: 0,
        lastDatevExportAt: mockDatevExports[0]?.createdAt,
      } as IpcResult<K>;
    }

    case 'pro:validateTaxCompliance': {
      const { draftId, transactionId } = args as IpcArgs<'pro:validateTaxCompliance'>;
      const draft = draftId
        ? Array.from(mockDrafts.values()).find((row) => row.id === draftId)
        : (transactionId ? getMockDraft(transactionId) : undefined);
      if (!draft) throw new Error('Draft not found');
      const normalizedLines = draft.lines.map(normalizeMockDraftLineTaxFields);
      const issues = validateMockTaxComplianceIssues({ ...draft, lines: normalizedLines });
      draft.lines = normalizedLines;
      draft.validationIssues = issues;
      draft.updatedAt = new Date().toISOString();
      mockDrafts.set(draft.transactionId, draft);
      return {
        ok: !issues.some((issue) => issue.blocking),
        issues,
      } as IpcResult<K>;
    }

    case 'pro:getVatSummary': {
      const { from, to } = args as IpcArgs<'pro:getVatSummary'>;
      const rows = new Map<
        (typeof mockTaxCases)[number]['key'],
        { netAmount: number; taxAmount: number; grossAmount: number; lineCount: number }
      >();
      for (const entry of mockJournalEntries) {
        if (entry.status !== 'posted') continue;
        if (from && entry.postingDate < from) continue;
        if (to && entry.postingDate > to) continue;
        for (const line of entry.lines) {
          const taxCaseKey = normalizeMockTaxCaseKey(line.taxCaseKey ?? line.taxCode);
          if (!taxCaseKey) continue;
          const current = rows.get(taxCaseKey) ?? { netAmount: 0, taxAmount: 0, grossAmount: 0, lineCount: 0 };
          const grossFallback = Math.max(Number(line.debitAmount || 0), Number(line.creditAmount || 0));
          current.netAmount = round2(current.netAmount + Number(line.netAmount ?? grossFallback));
          current.taxAmount = round2(current.taxAmount + Number(line.taxAmount ?? 0));
          current.grossAmount = round2(current.grossAmount + Number(line.grossAmount ?? grossFallback));
          current.lineCount += 1;
          rows.set(taxCaseKey, current);
        }
      }
      return {
        from,
        to,
        rows: Array.from(rows.entries())
          .map(([taxCaseKey, values]) => ({
            taxCaseKey,
            ...values,
          }))
          .sort((a, b) => a.taxCaseKey.localeCompare(b.taxCaseKey)),
      } as IpcResult<K>;
    }

    case 'pro:listWorkflowEntries':
      return Array.from(mockWorkflowEntries.values())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) as IpcResult<K>;

    case 'pro:upsertWorkflowEntry': {
      const payload = args as IpcArgs<'pro:upsertWorkflowEntry'>;
      mockWorkflowEntries.set(payload.transactionId, {
        transactionId: payload.transactionId,
        transactionJson: payload.transactionJson,
        draftJson: payload.draftJson,
        updatedAt: new Date().toISOString(),
      });
      return { ok: true } as IpcResult<K>;
    }

    case 'email:send': {
      const payload = args as IpcArgs<'email:send'>;
      const doc = payload.documentType === 'invoice'
        ? invoices.find((inv) => inv.id === payload.documentId)
        : offers.find((off) => off.id === payload.documentId);
      if (!doc) return { success: false, error: 'Document not found' } as IpcResult<K>;
      doc.history = [
        {
          date: toIsoDate(new Date()),
          action: `Per E-Mail gesendet an ${payload.recipientEmail}`,
        },
        ...(doc.history ?? []),
      ];
      return {
        success: true,
        messageId: `mock-msg-${Math.random().toString(36).slice(2)}`,
      } as IpcResult<K>;
    }

    case 'email:testConfig': {
      const payload = args as IpcArgs<'email:testConfig'>;
      if (payload.provider === 'smtp' && (!payload.smtpHost || !payload.smtpUser)) {
        return { success: false, error: 'SMTP-Konfiguration unvollständig' } as IpcResult<K>;
      }
      if (payload.provider === 'resend' && !payload.resendApiKey) {
        return { success: false, error: 'Resend API-Key fehlt' } as IpcResult<K>;
      }
      return { success: true, messageId: 'mock-email-config-ok' } as IpcResult<K>;
    }

    case 'transactions:list': {
      const { accountId, type, linkedOnly, unlinkedOnly } = args as IpcArgs<'transactions:list'>;
      let rows = getAllTransactions();
      if (accountId) rows = rows.filter((tx) => tx.accountId === accountId);
      if (type) rows = rows.filter((tx) => tx.type === type);
      if (linkedOnly) rows = rows.filter((tx) => Boolean(tx.linkedInvoiceId));
      if (unlinkedOnly) rows = rows.filter((tx) => !tx.linkedInvoiceId);
      rows.sort((a, b) => b.date.localeCompare(a.date));
      return rows as IpcResult<K>;
    }

    case 'transactions:findMatches': {
      const { transactionId } = args as IpcArgs<'transactions:findMatches'>;
      const tx = getAllTransactions().find((row) => row.id === transactionId);
      if (!tx) throw new Error('Transaction not found');
      const candidates = invoices.filter((inv) => inv.status !== 'paid');
      const suggestions = candidates
        .map((inv) => {
          const diff = Math.abs((Number(inv.amount) || 0) - Math.abs(Number(tx.amount) || 0));
          const confidence: 'high' | 'medium' | 'low' = diff < 0.01 ? 'high' : diff < 25 ? 'medium' : 'low';
          const reasons = [`Betragsabweichung: ${diff.toFixed(2)} EUR`];
          if (inv.client && tx.counterparty.toLowerCase().includes(inv.client.toLowerCase().slice(0, 5))) {
            reasons.unshift('Kunde passt zur Gegenpartei');
          }
          return { invoice: inv, confidence, matchReasons: reasons, amountDiff: round2(diff) };
        })
        .sort((a, b) => a.amountDiff - b.amountDiff)
        .slice(0, 5);
      return {
        transaction: tx,
        suggestions,
      } as IpcResult<K>;
    }

    case 'transactions:link': {
      const { transactionId, invoiceId } = args as IpcArgs<'transactions:link'>;
      let targetTx: Transaction | undefined;
      for (const account of accounts) {
        const tx = account.transactions.find((row) => row.id === transactionId);
        if (tx) {
          tx.linkedInvoiceId = invoiceId;
          targetTx = tx;
          break;
        }
      }
      if (!targetTx) throw new Error('Transaction not found');
      const invoice = getInvoiceById(invoiceId);
      if (!invoice) throw new Error('Invoice not found');

      const paymentId = `tx:${transactionId}`;
      const existing = invoice.payments.find((p) => p.id === paymentId);
      if (!existing) {
        invoice.payments.unshift({
          id: paymentId,
          date: targetTx.date,
          amount: Math.abs(targetTx.amount),
          method: 'Bankimport',
        });
      }
      recomputeInvoicePaymentState(invoice);
      return { success: true, invoice: structuredClone(invoice) } as IpcResult<K>;
    }

    case 'transactions:unlink': {
      const { transactionId } = args as IpcArgs<'transactions:unlink'>;
      let linkedInvoiceId: string | undefined;
      for (const account of accounts) {
        const tx = account.transactions.find((row) => row.id === transactionId);
        if (tx) {
          linkedInvoiceId = tx.linkedInvoiceId;
          delete tx.linkedInvoiceId;
          break;
        }
      }
      if (linkedInvoiceId) {
        const invoice = getInvoiceById(linkedInvoiceId);
        if (invoice) {
          invoice.payments = invoice.payments.filter((p) => p.id !== `tx:${transactionId}`);
          recomputeInvoicePaymentState(invoice);
        }
      }
      return { success: true } as IpcResult<K>;
    }

    case 'dunning:manualRun': {
      const today = toIsoDate(new Date());
      let processed = 0;
      let feesApplied = 0;
      for (const invoice of invoices) {
        if (!invoice.dueDate || invoice.status === 'paid' || invoice.status === 'draft' || invoice.status === 'cancelled') continue;
        const daysOverdue = daysBetween(invoice.dueDate, today);
        if (daysOverdue <= 0) continue;
        const levels = (settings.dunning.levels ?? []).filter((l) => l.enabled).sort((a, b) => a.daysAfterDueDate - b.daysAfterDueDate);
        const target = levels.filter((l) => daysOverdue >= l.daysAfterDueDate).at(-1);
        if (!target) continue;
        const current = invoice.dunningLevel ?? 0;
        if (target.id <= current) continue;
        invoice.dunningLevel = target.id;
        invoice.status = 'overdue';
        const nowIso = new Date().toISOString();
        const history = mockDunningHistory.get(invoice.id) ?? [];
        history.unshift({
          id: `du_${Math.random().toString(36).slice(2)}`,
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          dunningLevel: target.id,
          daysOverdue,
          feeApplied: target.fee,
          emailSent: true,
          processedAt: nowIso,
          createdAt: nowIso,
        });
        mockDunningHistory.set(invoice.id, history);
        processed += 1;
        feesApplied += target.fee;
      }
      return {
        success: true,
        result: {
          processedInvoices: processed,
          emailsSent: processed,
          feesApplied,
          errors: [],
        },
      } as IpcResult<K>;
    }

    case 'dunning:getInvoiceStatus': {
      const { invoiceId } = args as IpcArgs<'dunning:getInvoiceStatus'>;
      const invoice = getInvoiceById(invoiceId);
      if (!invoice) throw new Error('Invoice not found');
      const today = toIsoDate(new Date());
      const daysOverdue = invoice.dueDate ? Math.max(0, daysBetween(invoice.dueDate, today)) : 0;
      const history = mockDunningHistory.get(invoice.id) ?? [];
      return {
        currentLevel: invoice.dunningLevel ?? 0,
        daysOverdue,
        lastReminderSent: history[0]?.processedAt,
        totalFeesApplied: history.reduce((sum, entry) => sum + entry.feeApplied, 0),
        history,
      } as IpcResult<K>;
    }

    case 'window:minimize':
      return { ok: true } as IpcResult<K>;
    case 'window:toggleMaximize':
      mockIsMaximized = !mockIsMaximized;
      return { ok: true } as IpcResult<K>;
    case 'window:close':
      return { ok: true } as IpcResult<K>;
    case 'window:isMaximized':
      return { isMaximized: mockIsMaximized } as IpcResult<K>;

    case 'updater:getStatus':
      return { status: 'idle' as const } as IpcResult<K>;
    case 'updater:downloadUpdate':
      return { ok: true } as IpcResult<K>;
    case 'updater:quitAndInstall':
      return { ok: true } as IpcResult<K>;

    default:
      throw new Error(`Unsupported IPC route in mock backend: ${String(key)}`);
  }
};

  return invoke;
};
