import type {
  Account as BaseAccount,
  AppSettings,
  Article,
  Client,
  DocumentTemplate,
  Invoice,
  InvoiceElement,
  Project,
  RecurringProfile,
  Transaction,
} from '@billme/desktop-core/types';
import type { IpcInvoke as LiteIpcInvoke } from '@billme/desktop-contracts/api';
import type {
  IpcArgs,
  IpcResult,
  IpcRouteKey,
} from '@billme/desktop-contracts-pro/contract';
import {
  calculateInvoiceTaxSnapshot,
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  createCorrectionDocument,
  createDeliveryNoteFromOrder,
  createInvoiceRevision,
  createOrderConfirmationFromOffer,
  createSettlementInvoice,
  ensureDefaultProjectForClient as ensureDefaultProjectForClientDomain,
  finalizeDocumentNumber,
  prepareClientForUpsert,
  releaseDocumentNumber,
  reserveDocumentNumber,
  resolveInvoiceTaxMode,
  listDocumentChain,
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
  PRO_MOCK_ACCOUNTS,
  PRO_MOCK_INVOICES,
} from './mockData';
import { getCatalogForYear, getCatalogManifestForYear } from './eurCatalog';
import {
  INITIAL_INVOICE_TEMPLATE,
  INITIAL_OFFER_TEMPLATE,
} from '@billme/desktop-core/constants';
import { formatAddressMultiline } from '@billme/desktop-utils/formatters';

type Account = BaseAccount & { defaultSkrAccountNumber?: string };
type MockProduct = 'lite' | 'pro';

const EUR_LINES_2025 = getCatalogForYear(2025);

const createMockInvoke = (product: MockProduct) => {
const invoices: Invoice[] = structuredClone(product === 'pro' ? PRO_MOCK_INVOICES : MOCK_INVOICES);
const clients: Client[] = structuredClone(MOCK_CLIENTS);
const articles: Article[] = structuredClone(MOCK_ARTICLES);
const accounts: Account[] = structuredClone(product === 'pro' ? PRO_MOCK_ACCOUNTS : MOCK_ACCOUNTS);
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
const mockAssets: IpcResult<'pro:listAssets'> = [];
const mockAssetSchedules = new Map<string, IpcResult<'pro:getDepreciationSchedule'>>();
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

const MOCK_TENANT_ID = 'default';

/**
 * The mock also serves the browser fallback runtime, so it must stay free of
 * Node crypto. The digest only has to be deterministic and 64 hex characters
 * long, which is what the contract's hash fields are checked against.
 */
const mockDigest = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  let state = 0x9e3779b9;
  let digest = '';
  for (let block = 0; block < 8; block += 1) {
    for (let index = 0; index < text.length; index += 1) {
      state = (Math.imul(state ^ text.charCodeAt(index), 0x01000193) + block * 0x7feb352d) >>> 0;
    }
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    digest += state.toString(16).padStart(8, '0');
  }
  return digest;
};

const mockBase64 = (content: string): string => globalThis.btoa(content);
const mockBase64ByteLength = (data: string): number => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(1, Math.floor((data.length * 3) / 4) - padding);
};
const mockUtf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

type MockAccountingPolicy = IpcResult<'pro:getAccountingPolicy'>;
type MockAccountingAccountMapping = IpcResult<'pro:listAccountingAccountMappings'>[number];
type MockVendor = IpcResult<'pro:listVendors'>[number];
type MockIncomingInvoice = IpcResult<'pro:listIncomingInvoices'>[number];
type MockIncomingInvoiceDocument = IpcResult<'pro:listIncomingInvoiceDocuments'>[number];
type MockOpenItem = IpcResult<'pro:listOpenItems'>[number];
type MockOpenItemPayment = IpcResult<'pro:allocateOpenItemPayment'>;
type MockAccountingSourceRun = IpcResult<'pro:listAccountingSourceRuns'>[number];
type MockReportSnapshot = IpcResult<'pro:listReportSnapshots'>[number];
type MockEurCashFact = IpcResult<'eur:listCashFacts'>[number];
type MockEurAnnexFact = IpcResult<'eur:listAnnexFacts'>[number];
type MockAuditExportPackage = IpcResult<'tax:saveAuditExportPackage'>;
type MockDocumentType = 'outgoing_invoice' | 'incoming_invoice';

let mockAccountingPolicyChart: 'SKR03' | 'SKR04' | undefined;
let mockAccountingVatMethod: 'soll' | 'ist' = 'soll';
let mockAccountingPolicyUpdatedAt = now;
const mockAccountingRoleDefaults: Record<'SKR03' | 'SKR04', Record<MockAccountingAccountMapping['role'], string>> = {
  SKR03: {
    accounts_receivable: '1400', accounts_payable: '1600', bank: '1200', revenue: '8400',
    expense: '4900', asset: '0480', output_vat: '1776', output_vat_deferred: '1780', input_vat: '1576',
  },
  SKR04: {
    accounts_receivable: '1200', accounts_payable: '3300', bank: '1800', revenue: '4400',
    expense: '6300', asset: '0670', output_vat: '3806', output_vat_deferred: '3810', input_vat: '1406',
  },
};
const mockAccountingAccountMappings: MockAccountingAccountMapping[] = [];

const mockVendors: MockVendor[] = [
  {
    id: 'vendor-1',
    tenantId: MOCK_TENANT_ID,
    vendorNumber: '70001',
    name: 'Muster Bürobedarf GmbH',
    email: 'rechnung@muster-buero.example',
    address: 'Musterstraße 12\n10115 Berlin',
    vatId: 'DE123456789',
    iban: 'DE02120300000000202051',
    defaultExpenseAccount: '4930',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'vendor-2',
    tenantId: MOCK_TENANT_ID,
    vendorNumber: '70002',
    name: 'Muster Telekom GmbH',
    email: 'rechnung@muster-telekom.example',
    address: 'Musterring 4\n50667 Köln',
    vatId: 'DE987654321',
    iban: 'DE02500105170137075030',
    defaultExpenseAccount: '4920',
    createdAt: now,
    updatedAt: now,
  },
];

const mockIncomingInvoices: MockIncomingInvoice[] = [
  {
    id: 'incoming-1',
    tenantId: MOCK_TENANT_ID,
    vendorId: 'vendor-1',
    number: 'RE-2025-0147',
    invoiceDate: '2025-03-04',
    dueDate: '2025-03-18',
    servicePeriod: '2025-03',
    netAmount: 200,
    taxAmount: 38,
    grossAmount: 238,
    status: 'open',
    taxRate: 19,
    taxCaseKey: 'DE_STD_19',
    notes: 'Büromaterial Quartal 1',
    lines: [
      { id: 'incoming-1-line-1', incomingInvoiceId: 'incoming-1', position: 1, description: 'Kopierpapier A4', quantity: 20, unitPrice: 6, netAmount: 120, taxRate: 19, taxAmount: 22.8, grossAmount: 142.8, accountNumber: '4930' },
      { id: 'incoming-1-line-2', incomingInvoiceId: 'incoming-1', position: 2, description: 'Ordner und Register', quantity: 10, unitPrice: 8, netAmount: 80, taxRate: 19, taxAmount: 15.2, grossAmount: 95.2, accountNumber: '4930' },
    ],
    accountingStatus: 'unposted',
    createdAt: '2025-03-04T10:15:00.000Z',
    updatedAt: '2025-03-04T10:15:00.000Z',
  },
  {
    id: 'incoming-2',
    tenantId: MOCK_TENANT_ID,
    vendorId: 'vendor-2',
    number: 'TK-2025-0312',
    invoiceDate: '2025-03-12',
    dueDate: '2025-04-02',
    servicePeriod: '2025-03',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    status: 'open',
    taxRate: 19,
    taxCaseKey: 'DE_STD_19',
    notes: 'Internet und Telefon März',
    lines: [
      { id: 'incoming-2-line-1', incomingInvoiceId: 'incoming-2', position: 1, description: 'Internetanschluss März', quantity: 1, unitPrice: 50, netAmount: 50, taxRate: 19, taxAmount: 9.5, grossAmount: 59.5, accountNumber: '4920' },
      { id: 'incoming-2-line-2', incomingInvoiceId: 'incoming-2', position: 2, description: 'Telefonie März', quantity: 1, unitPrice: 50, netAmount: 50, taxRate: 19, taxAmount: 9.5, grossAmount: 59.5, accountNumber: '4920' },
    ],
    accountingStatus: 'unposted',
    createdAt: '2025-03-12T08:05:00.000Z',
    updatedAt: '2025-03-12T08:05:00.000Z',
  },
];

const mockIncomingInvoiceDocumentData = new Map<string, string>();
const mockIncomingDocumentSeed = (input: {
  id: string;
  incomingInvoiceId: string;
  originalFilename: string;
  mimeType: MockIncomingInvoiceDocument['mimeType'];
  content: string;
  reviewStatus: MockIncomingInvoiceDocument['reviewStatus'];
  createdAt: string;
}): MockIncomingInvoiceDocument => {
  const data = mockBase64(input.content);
  mockIncomingInvoiceDocumentData.set(input.id, data);
  return {
    id: input.id,
    tenantId: MOCK_TENANT_ID,
    incomingInvoiceId: input.incomingInvoiceId,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    byteLength: mockBase64ByteLength(data),
    sha256: mockDigest(data),
    reviewStatus: input.reviewStatus,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
};
const mockIncomingInvoiceDocuments: MockIncomingInvoiceDocument[] = [
  mockIncomingDocumentSeed({
    id: 'incoming-document-1',
    incomingInvoiceId: 'incoming-1',
    originalFilename: 'RE-2025-0147.pdf',
    mimeType: 'application/pdf',
    content: '%PDF-1.4 mock Eingangsrechnung RE-2025-0147',
    reviewStatus: 'accepted',
    createdAt: '2025-03-04T10:20:00.000Z',
  }),
  mockIncomingDocumentSeed({
    id: 'incoming-document-2',
    incomingInvoiceId: 'incoming-2',
    originalFilename: 'TK-2025-0312.png',
    mimeType: 'image/png',
    content: 'mock-scan-telekom-maerz',
    reviewStatus: 'pending',
    createdAt: '2025-03-12T08:10:00.000Z',
  }),
];

const mockOpenItems: MockOpenItem[] = [
  {
    id: 'open-item-1',
    tenantId: MOCK_TENANT_ID,
    partyType: 'debtor',
    partyId: 'c1',
    sourceType: 'outgoing_invoice',
    sourceId: '2',
    documentNumber: 'RE-2023-002',
    documentDate: '2023-10-20',
    dueDate: '2023-11-03',
    originalAmount: 2400,
    allocatedAmount: 0,
    residualAmount: 2400,
    status: 'open',
    createdAt: '2023-10-20T09:00:00.000Z',
    updatedAt: '2023-10-20T09:00:00.000Z',
  },
  {
    id: 'open-item-2',
    tenantId: MOCK_TENANT_ID,
    partyType: 'debtor',
    partyId: 'c2',
    sourceType: 'outgoing_invoice',
    sourceId: '3',
    documentNumber: 'RE-2023-003',
    documentDate: '2023-12-18',
    dueDate: '2024-01-15',
    originalAmount: 890.5,
    allocatedAmount: 300,
    residualAmount: 590.5,
    status: 'partially_paid',
    createdAt: '2023-12-18T11:30:00.000Z',
    updatedAt: '2024-01-08T09:12:00.000Z',
  },
  {
    id: 'open-item-3',
    tenantId: MOCK_TENANT_ID,
    partyType: 'creditor',
    partyId: 'vendor-1',
    sourceType: 'incoming_invoice',
    sourceId: 'incoming-1',
    documentNumber: 'RE-2025-0147',
    documentDate: '2025-03-04',
    dueDate: '2025-03-18',
    originalAmount: 238,
    allocatedAmount: 0,
    residualAmount: 238,
    status: 'open',
    createdAt: '2025-03-04T10:15:00.000Z',
    updatedAt: '2025-03-04T10:15:00.000Z',
  },
  {
    id: 'open-item-4',
    tenantId: MOCK_TENANT_ID,
    partyType: 'creditor',
    partyId: 'vendor-2',
    sourceType: 'incoming_invoice',
    sourceId: 'incoming-2',
    documentNumber: 'TK-2025-0312',
    documentDate: '2025-03-12',
    dueDate: '2025-04-02',
    originalAmount: 119,
    allocatedAmount: 0,
    residualAmount: 119,
    status: 'open',
    createdAt: '2025-03-12T08:05:00.000Z',
    updatedAt: '2025-03-12T08:05:00.000Z',
  },
];

const mockOpenItemPayments: MockOpenItemPayment[] = [];
const mockOpenItemAllocationEvents = new Set<string>();
const mockOutgoingAccountingStatus = new Map<string, 'unposted' | 'posted' | 'reversed'>();
const mockPostedDocumentEntries = new Map<string, string>();

mockJournalEntries.push({
  id: 'je-mock-sonderbuchung-1',
  tenantId: MOCK_TENANT_ID,
  entryNumber: 1,
  postingDate: '2025-03-31',
  documentDate: '2025-03-31',
  bookingText: 'Sonderbuchung Bank an Erlöse 19%',
  reference: 'sonderbuchung-1',
  period: '2025-03',
  fiscalYear: 2025,
  status: 'posted' as const,
  createdAt: '2025-03-31T09:00:00.000Z',
  lines: [
    { id: 'je-mock-sonderbuchung-1-line-1', accountNumber: '1200', debitAmount: 1190, creditAmount: 0, memo: 'Zahlungseingang' },
    { id: 'je-mock-sonderbuchung-1-line-2', accountNumber: '8400', debitAmount: 0, creditAmount: 1000, taxCode: 'USt19', taxCaseKey: 'DE_STD_19' as const, taxRate: 19, netAmount: 1000, taxAmount: 190, grossAmount: 1190 },
    { id: 'je-mock-sonderbuchung-1-line-3', accountNumber: '1776', debitAmount: 0, creditAmount: 190, taxCode: 'USt19', taxCaseKey: 'DE_STD_19' as const, taxRate: 19, taxAmount: 190 },
  ],
});

const mockAccountingSourceRuns: MockAccountingSourceRun[] = [
  {
    id: 'source-run-1',
    tenantId: MOCK_TENANT_ID,
    sourceType: 'standalone_source',
    sourceId: 'sonderbuchung-1',
    sourceRevision: '1',
    idempotencyKey: 'standalone_source:sonderbuchung-1:1',
    source: { sourceType: 'standalone_source', sourceId: 'sonderbuchung-1', sourceRevision: '1', bookingText: 'Sonderbuchung Bank an Erlöse 19%' },
    fact: {
      sourceType: 'standalone_source',
      sourceId: 'sonderbuchung-1',
      sourceRevision: '1',
      effectiveDate: '2025-03-31',
      postingDate: '2025-03-31',
      period: '2025-03',
      fiscalYear: 2025,
      currency: 'EUR',
      bookingText: 'Sonderbuchung Bank an Erlöse 19%',
      reference: 'sonderbuchung-1',
      lines: [
        { accountNumber: '1200', debitAmount: 1190, creditAmount: 0, memo: 'Zahlungseingang' },
        { accountNumber: '8400', debitAmount: 0, creditAmount: 1000, memo: 'Erlös' },
        { accountNumber: '1776', debitAmount: 0, creditAmount: 190, memo: 'Umsatzsteuer 19%' },
      ],
    },
    result: { status: 'posted' },
    status: 'posted',
    journalEntryId: 'je-mock-sonderbuchung-1',
    createdAt: '2025-03-31T09:00:00.000Z',
  },
  {
    id: 'source-run-2',
    tenantId: MOCK_TENANT_ID,
    sourceType: 'payroll_batch',
    sourceId: 'payroll-2025-03',
    sourceRevision: '1',
    idempotencyKey: 'payroll_batch:payroll-2025-03:1',
    source: { sourceType: 'payroll_batch', sourceId: 'payroll-2025-03', sourceRevision: '1', bookingText: 'Lohnlauf März 2025' },
    result: { status: 'valid', lineCount: 1 },
    status: 'noop',
    createdAt: '2025-03-31T09:05:00.000Z',
  },
];

const mockReportSnapshots: MockReportSnapshot[] = [
  {
    id: 'report-snapshot-1',
    reportType: 'eur',
    args: { taxYear: 2025, from: '2025-01-01', to: '2025-12-31' },
    payload: { kind: 'euer', taxYear: 2025, frozenBy: 'Pro Workspace' },
    createdAt: '2025-12-31T18:00:00.000Z',
    sourceHash: mockDigest('report-snapshot-1'),
  },
];

const mockReportMappingOverrides: Array<{
  chart: 'SKR03' | 'SKR04';
  asOfDate: string;
  accountNumber: string;
  statement: MockReportStatement;
  position: string;
  label: string;
  side?: 'asset' | 'liability';
  updatedAt: string;
}> = [];

const mockBackfillRuns = new Map<string, {
  confirmationHash: string;
  status: 'preview' | 'completed';
  candidates: Array<{
    sourceType: 'outgoing_invoice' | 'incoming_invoice' | 'legacy_transaction' | 'correction';
    sourceId: string;
    status: 'ready' | 'unresolved';
    reason?: string;
    sourceVersion: string;
  }>;
  result?: IpcResult<'pro:confirmAccountingBackfill'>;
}>();

const mockAuditExportPackages: MockAuditExportPackage[] = [
  {
    bundleDir: 'mock://exports/tax-audit/2025-03-31T09-00-00-000Z',
    manifestPath: 'mock://exports/tax-audit/2025-03-31T09-00-00-000Z/manifest.json',
    createdAt: '2025-03-31T09:00:00.000Z',
    fileCount: 2,
    files: [
      { name: 'audit-log.csv', path: 'mock://exports/tax-audit/2025-03-31T09-00-00-000Z/audit-log.csv', sha256: mockDigest('audit-log'), sizeBytes: 256, rowCount: 1 },
      { name: 'journal-entries.jsonl', path: 'mock://exports/tax-audit/2025-03-31T09-00-00-000Z/journal-entries.jsonl', sha256: mockDigest('journal-entries'), sizeBytes: 512, rowCount: 1 },
    ],
  },
  {
    bundleDir: 'mock://exports/tax-audit/2025-06-30T17-30-00-000Z',
    manifestPath: 'mock://exports/tax-audit/2025-06-30T17-30-00-000Z/manifest.json',
    createdAt: '2025-06-30T17:30:00.000Z',
    fileCount: 2,
    files: [
      { name: 'audit-log.csv', path: 'mock://exports/tax-audit/2025-06-30T17-30-00-000Z/audit-log.csv', sha256: mockDigest('audit-log-2'), sizeBytes: 384, rowCount: 2 },
      { name: 'journal-entries.jsonl', path: 'mock://exports/tax-audit/2025-06-30T17-30-00-000Z/journal-entries.jsonl', sha256: mockDigest('journal-entries-2'), sizeBytes: 768, rowCount: 2 },
    ],
  },
];

type MockTaxFilingCertificate = IpcResult<'taxFiling:installCertificate'>;
type MockTaxFilingRecord = IpcResult<'taxFiling:listRecords'>[number];
type MockTaxFilingProvider = IpcResult<'taxFiling:getStatus'>['provider'];

/** Colon-separated SHA-256 style fingerprint of a certificate blob. */
const mockFingerprint = (value: string): string =>
  mockDigest(value).toUpperCase().replace(/../g, '$&:').slice(0, -1);

const mockTaxFilingProvider: MockTaxFilingProvider = {
  available: true,
  provider: 'eric',
  version: '1.4.2',
  binaryPath: 'mock://elster/eric-1.4.2/bin/eric',
};

const mockTaxFilingCertificates: MockTaxFilingCertificate[] = [
  {
    id: 'cert-organisation',
    fingerprint: mockFingerprint('mock-elster-organisationszertifikat'),
    expiresAt: '2027-12-31T23:59:59.000Z',
    subject: 'CN=Mustermann GmbH, O=ELSTER, OU=Organisation, role=Uebermittlungsberechtigter',
  },
  {
    id: 'cert-berater',
    fingerprint: mockFingerprint('mock-elster-beraterzertifikat'),
    expiresAt: '2026-06-30T23:59:59.000Z',
    subject: 'CN=Max Mustermann, O=ELSTER, OU=Berater, role=Signaturberechtigter',
  },
];

const mockTaxFilingRecords: MockTaxFilingRecord[] = [
  {
    id: 'tax-filing-euer-2025',
    kind: 'euer',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    sourceHash: mockDigest('tax-filing-euer-2025'),
    status: 'frozen',
  },
  {
    id: 'tax-filing-ebilanz-2025',
    kind: 'e_bilanz',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    sourceHash: mockDigest('tax-filing-ebilanz-2025'),
    status: 'approved',
  },
  {
    id: 'tax-filing-unternehmensregister-2024',
    kind: 'unternehmensregister',
    periodStart: '2024-01-01',
    periodEnd: '2024-12-31',
    sourceHash: mockDigest('tax-filing-unternehmensregister-2024'),
    status: 'queued',
  },
];

const upsertMockTaxFilingRecord = (
  record: MockTaxFilingRecord,
  status: MockTaxFilingRecord['status'] = record.status,
): MockTaxFilingRecord => {
  const next: MockTaxFilingRecord = { ...record, status };
  const existing = mockTaxFilingRecords.findIndex((entry) => entry.id === record.id);
  if (existing >= 0) mockTaxFilingRecords[existing] = next;
  else mockTaxFilingRecords.push(next);
  return next;
};

const mockEurCashFacts: MockEurCashFact[] = [
  {
    id: 'eur-cash-fact-1',
    tenantId: MOCK_TENANT_ID,
    sourceType: 'transaction',
    sourceId: 't9',
    taxYear: 2025,
    kind: 'income',
    amountNet: 2200,
    flowType: 'income',
    eurLineId: 'E2025_KZ112',
    reason: 'Betriebseinnahme aus Bankimport zugeordnet',
    actorId: 'mock-pro-actor',
    actorName: 'Pro Workspace',
    idempotencyKey: 'eur-cash:transaction:t9:2025',
    provenance: { catalogId: 'anlage-euer-2025', catalogVersion: '2025.1', catalogSourceHash: 'b69b5cf0a982d28cbce20644e67677a36be0bc494bed4fae2310dc08230a1599' },
    createdAt: '2025-01-08T12:00:00.000Z',
    updatedAt: '2025-01-08T12:00:00.000Z',
  },
  {
    id: 'eur-cash-fact-2',
    tenantId: MOCK_TENANT_ID,
    sourceType: 'transaction',
    sourceId: 't10',
    taxYear: 2025,
    kind: 'expense',
    amountNet: 189,
    flowType: 'expense',
    eurLineId: 'E2025_KZ100',
    reason: 'Betriebsausgabe Internet und Telefon',
    actorId: 'mock-pro-actor',
    actorName: 'Pro Workspace',
    idempotencyKey: 'eur-cash:transaction:t10:2025',
    provenance: { catalogId: 'anlage-euer-2025', catalogVersion: '2025.1', catalogSourceHash: 'b69b5cf0a982d28cbce20644e67677a36be0bc494bed4fae2310dc08230a1599' },
    createdAt: '2025-01-12T12:00:00.000Z',
    updatedAt: '2025-01-12T12:00:00.000Z',
  },
];

const mockEurAnnexFacts: MockEurAnnexFact[] = [
  {
    id: 'eur-annex-fact-1',
    tenantId: MOCK_TENANT_ID,
    taxYear: 2025,
    annex: 'IAB',
    lineId: 'formed',
    amount: 1200,
    sourceId: 'sonderbuchung-1',
    date: '2025-12-31',
    reason: 'Investitionsabzugsbetrag gebildet',
    actorId: 'mock-pro-actor',
    actorName: 'Pro Workspace',
    idempotencyKey: 'eur-annex:2025:IAB:formed:2025-12-31:1200',
    provenance: { catalogId: 'anlage-euer-2025', catalogVersion: '2025.1', catalogSourceHash: 'b69b5cf0a982d28cbce20644e67677a36be0bc494bed4fae2310dc08230a1599' },
    createdAt: '2025-12-31T12:00:00.000Z',
  },
];

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
  if (mockAccountingPolicyChart) return mockAccountingPolicyChart;
  const stats = getMockLedgerStats();
  return stats.byChart.SKR04 > 0 && stats.byChart.SKR03 === 0 ? 'SKR04' : 'SKR03';
};

const getMockAccountingPolicy = (): MockAccountingPolicy => ({
  tenantId: MOCK_TENANT_ID,
  activeChart: getMockActiveChart(),
  vatMethod: mockAccountingVatMethod,
  periodPolicy: 'calendar_month',
  updatedAt: mockAccountingPolicyUpdatedAt,
});

const ensureMockAccountingMappings = (): void => {
  if (mockAccountingAccountMappings.length > 0) return;
  const updatedAt = new Date().toISOString();
  for (const chart of ['SKR03', 'SKR04'] as const) {
    for (const [role, accountNumber] of Object.entries(mockAccountingRoleDefaults[chart]) as Array<[MockAccountingAccountMapping['role'], string]>) {
      mockAccountingAccountMappings.push({
        id: `${MOCK_TENANT_ID}-${chart}-${role}`,
        tenantId: MOCK_TENANT_ID,
        chart,
        role,
        accountNumber,
        updatedAt,
      });
    }
  }
};

const getMockAccountingMappings = (chart: 'SKR03' | 'SKR04'): Record<MockAccountingAccountMapping['role'], string> => {
  ensureMockAccountingMappings();
  const mappings = { ...mockAccountingRoleDefaults[chart] };
  for (const row of mockAccountingAccountMappings) {
    if (row.chart === chart) mappings[row.role] = row.accountNumber;
  }
  return mappings;
};

const getMockIncomingInvoice = (invoiceId: string): MockIncomingInvoice | undefined =>
  mockIncomingInvoices.find((row) => row.id === invoiceId);

const getMockOpenItem = (openItemId: string): MockOpenItem | undefined =>
  mockOpenItems.find((row) => row.id === openItemId);

const getMockOutgoingAccountingStatus = (invoiceId: string): 'unposted' | 'posted' | 'reversed' =>
  mockOutgoingAccountingStatus.get(invoiceId) ?? 'unposted';

type MockSourceLine = { accountNumber: string; debitAmount: number; creditAmount: number; memo?: string };

const mockCreateJournalEntry = (input: {
  id?: string;
  postingDate: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  lines: MockSourceLine[];
}) => {
  const entry = {
    id: input.id ?? `je-mock-${mockJournalEntries.length + 1}-${Math.random().toString(36).slice(2)}`,
    tenantId: MOCK_TENANT_ID,
    entryNumber: mockJournalEntries.length + 1,
    postingDate: input.postingDate,
    documentDate: input.documentDate ?? input.postingDate,
    bookingText: input.bookingText,
    reference: input.reference,
    period: input.postingDate.slice(0, 7),
    fiscalYear: Number(input.postingDate.slice(0, 4)),
    status: 'posted' as const,
    createdAt: new Date().toISOString(),
    lines: input.lines.map((line, index) => ({
      id: `je-mock-line-${index + 1}-${Math.random().toString(36).slice(2)}`,
      accountNumber: line.accountNumber,
      debitAmount: line.debitAmount,
      creditAmount: line.creditAmount,
      memo: line.memo,
    })),
  };
  mockJournalEntries.unshift(entry);
  return entry;
};

const mockRecordSourceRun = (input: {
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  sourceRevision: string;
  status: 'posted' | 'rejected' | 'noop';
  result: unknown;
  source?: unknown;
  fact?: MockAccountingSourceRun['fact'];
  journalEntryId?: string;
}): MockAccountingSourceRun => {
  const run: MockAccountingSourceRun = {
    id: `source-run-${mockAccountingSourceRuns.length + 1}-${Math.random().toString(36).slice(2)}`,
    tenantId: MOCK_TENANT_ID,
    sourceType: input.sourceType as MockAccountingSourceRun['sourceType'],
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    idempotencyKey: input.idempotencyKey,
    source: input.source as Record<string, unknown> | undefined,
    fact: input.fact,
    result: input.result,
    status: input.status,
    journalEntryId: input.journalEntryId,
    createdAt: new Date().toISOString(),
  };
  mockAccountingSourceRuns.unshift(run);
  return run;
};

const mockUpsertOpenItem = (input: {
  documentType: MockDocumentType;
  documentId: string;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  partyType: 'debtor' | 'creditor';
  partyId: string;
  amount: number;
  journalEntryId?: string;
}): MockOpenItem => {
  const timestamp = new Date().toISOString();
  const existing = mockOpenItems.find((row) => row.sourceType === input.documentType && row.sourceId === input.documentId);
  if (existing) {
    existing.journalEntryId = input.journalEntryId ?? existing.journalEntryId;
    existing.updatedAt = timestamp;
    return existing;
  }
  const item: MockOpenItem = {
    id: `open-item-${mockOpenItems.length + 1}-${Math.random().toString(36).slice(2)}`,
    tenantId: MOCK_TENANT_ID,
    partyType: input.partyType,
    partyId: input.partyId,
    sourceType: input.documentType,
    sourceId: input.documentId,
    documentNumber: input.documentNumber,
    documentDate: input.documentDate,
    dueDate: input.dueDate,
    originalAmount: input.amount,
    allocatedAmount: 0,
    residualAmount: input.amount,
    status: 'open',
    journalEntryId: input.journalEntryId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  mockOpenItems.push(item);
  return item;
};

const buildMockAccountingSnapshot = (input: {
  documentType: MockDocumentType;
  documentId: string;
  amounts: { netAmount: number; taxAmount: number; grossAmount: number };
  documentNumber: string;
}): NonNullable<MockIncomingInvoice['accountingSnapshot']> => {
  const chart = getMockActiveChart();
  const policy = getMockAccountingPolicy();
  const mapping = getMockAccountingMappings(chart);
  const { netAmount, taxAmount, grossAmount } = input.amounts;
  const lines = input.documentType === 'outgoing_invoice'
    ? [
      { accountNumber: mapping.accounts_receivable, debitAmount: grossAmount, creditAmount: 0, memo: `Forderung ${input.documentNumber}` },
      { accountNumber: mapping.revenue, debitAmount: 0, creditAmount: netAmount, netAmount, taxRate: 19, taxAmount, grossAmount, memo: `Erlös ${input.documentNumber}` },
      { accountNumber: mapping.output_vat, debitAmount: 0, creditAmount: taxAmount, taxRate: 19, taxAmount, memo: 'Umsatzsteuer 19%' },
    ]
    : [
      { accountNumber: mapping.expense, debitAmount: netAmount, creditAmount: 0, netAmount, taxRate: 19, taxAmount, grossAmount, memo: `Aufwand ${input.documentNumber}` },
      { accountNumber: mapping.input_vat, debitAmount: taxAmount, creditAmount: 0, taxRate: 19, taxAmount, memo: 'Vorsteuer 19%' },
      { accountNumber: mapping.accounts_payable, debitAmount: 0, creditAmount: grossAmount, memo: `Verbindlichkeit ${input.documentNumber}` },
    ];
  return {
    sourceType: input.documentType,
    sourceId: input.documentId,
    sourceVersion: mockDigest({ documentType: input.documentType, documentId: input.documentId, ...input.amounts }),
    chart,
    vatMethod: policy.vatMethod,
    netAmount,
    taxAmount,
    grossAmount,
    lines,
    capturedAt: new Date().toISOString(),
  };
};

const postMockDocumentAccounting = (input: {
  documentType: MockDocumentType;
  documentId: string;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  partyType: 'debtor' | 'creditor';
  partyId: string;
  amounts: { netAmount: number; taxAmount: number; grossAmount: number };
}): NonNullable<MockIncomingInvoice['accountingSnapshot']> => {
  const snapshot = buildMockAccountingSnapshot(input);
  const entry = mockCreateJournalEntry({
    postingDate: input.documentDate,
    documentDate: input.documentDate,
    bookingText: `${input.documentType === 'outgoing_invoice' ? 'Ausgangsrechnung' : 'Eingangsrechnung'} ${input.documentNumber}`,
    reference: input.documentNumber,
    lines: snapshot.lines,
  });
  mockPostedDocumentEntries.set(`${input.documentType}:${input.documentId}`, entry.id);
  mockUpsertOpenItem({
    documentType: input.documentType,
    documentId: input.documentId,
    documentNumber: input.documentNumber,
    documentDate: input.documentDate,
    dueDate: input.dueDate,
    partyType: input.partyType,
    partyId: input.partyId,
    amount: input.amounts.grossAmount,
    journalEntryId: entry.id,
  });
  return snapshot;
};

const getMockInvoiceAccountingPreview = (
  documentType: MockDocumentType,
  documentId: string,
): IpcResult<'pro:previewOutgoingInvoiceAccounting'> => {
  if (documentType === 'incoming_invoice') {
    const invoice = getMockIncomingInvoice(documentId);
    if (!invoice) throw new Error('Incoming invoice not found');
    const mapping = getMockAccountingMappings(getMockActiveChart());
    const issues: IpcResult<'pro:previewIncomingInvoiceAccounting'>['issues'] = [];
    if (!invoice.lines.length) issues.push({ code: 'AMBIGUOUS_INVOICE_LINES', message: 'Eingangsrechnung benötigt mindestens eine Position.', blocking: true });
    if (Math.abs(invoice.grossAmount - invoice.netAmount - invoice.taxAmount) > 0.01) issues.push({ code: 'INVALID_INCOMING_TOTALS', message: 'Eingangsrechnung ist nicht ausgeglichen.', blocking: true });
    if (invoice.status === 'draft' || invoice.status === 'cancelled') issues.push({ code: 'DOCUMENT_NOT_FINALIZED', message: 'Nur freigegebene Eingangsrechnungen können gebucht werden.', blocking: true });
    if (invoice.accountingStatus === 'posted') {
      return {
        sourceType: 'incoming_invoice',
        sourceId: documentId,
        status: 'ready',
        snapshot: invoice.accountingSnapshot,
        issues: [],
      };
    }
    return {
      sourceType: 'incoming_invoice',
      sourceId: documentId,
      status: issues.some((issue) => issue.blocking) ? 'unresolved' : 'ready',
      reason: issues[0]?.message,
      snapshot: issues.some((issue) => issue.blocking)
        ? undefined
        : buildMockAccountingSnapshot({
          documentType: 'incoming_invoice',
          documentId,
          documentNumber: invoice.number,
          amounts: { netAmount: invoice.netAmount, taxAmount: invoice.taxAmount, grossAmount: invoice.grossAmount },
        }),
      issues: [...issues, { code: 'MAPPING_ACCOUNTS', message: `Kontenrahmen ${getMockActiveChart()}: Kreditor ${mapping.accounts_payable}, Vorsteuer ${mapping.input_vat}.`, blocking: false }],
    };
  }
  const invoice = getMockInvoiceById(documentId);
  if (!invoice) throw new Error('Invoice not found');
  const grossAmount = round2(Number(invoice.amount) || 0);
  const netAmount = round2(grossAmount / 1.19);
  const amounts = { netAmount, taxAmount: round2(grossAmount - netAmount), grossAmount };
  const issues: IpcResult<'pro:previewOutgoingInvoiceAccounting'>['issues'] = [];
  if (!invoice.items?.length) issues.push({ code: 'AMBIGUOUS_INVOICE_LINES', message: 'Rechnung benötigt mindestens eine Position.', blocking: true });
  if (invoice.status === 'draft' || invoice.status === 'cancelled') issues.push({ code: 'DOCUMENT_NOT_FINALIZED', message: 'Nur finalisierte Rechnungen können gebucht werden.', blocking: true });
  if (getMockOutgoingAccountingStatus(documentId) === 'posted') {
    return { sourceType: 'outgoing_invoice', sourceId: documentId, status: 'ready', issues: [] };
  }
  return {
    sourceType: 'outgoing_invoice',
    sourceId: documentId,
    status: issues.some((issue) => issue.blocking) ? 'unresolved' : 'ready',
    reason: issues[0]?.message,
    snapshot: issues.some((issue) => issue.blocking)
      ? undefined
      : buildMockAccountingSnapshot({ documentType: 'outgoing_invoice', documentId, documentNumber: invoice.number, amounts }),
    issues,
  };
};

const applyMockPaymentAllocations = (
  payment: MockOpenItemPayment,
  allocations: Array<{ openItemId: string; amount: number }>,
): void => {
  const timestamp = new Date().toISOString();
  for (const allocation of allocations) {
    const item = getMockOpenItem(allocation.openItemId);
    if (!item) throw new Error(`PAYMENT_OPEN_ITEM_NOT_FOUND:${allocation.openItemId}`);
    if (item.partyType !== payment.partyType || (payment.partyId && item.partyId !== payment.partyId)) {
      throw new Error('PAYMENT_PARTY_MISMATCH: Zahlung und offener Posten gehören zu unterschiedlichen Parteien.');
    }
    if (allocation.amount > item.residualAmount + 0.01) throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL: Zuordnung übersteigt den Restbetrag.');
    item.allocatedAmount = round2(item.allocatedAmount + allocation.amount);
    item.residualAmount = round2(Math.max(0, item.originalAmount - item.allocatedAmount));
    item.status = item.residualAmount <= 0.01 ? 'paid' : 'partially_paid';
    item.updatedAt = timestamp;
    payment.allocatedAmount = round2(payment.allocatedAmount + allocation.amount);
    payment.residualAmount = round2(Math.max(0, payment.amount - payment.allocatedAmount));
    payment.status = payment.residualAmount <= 0.01 ? 'allocated' : 'overpaid';
  }
};

type MockReportStatement = 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz';
type MockReportMappingPosition = IpcResult<'pro:listReportMappingPositions'>[number];
type MockReportPositionDefinition = MockReportMappingPosition & {
  /**
   * Mock-only account assignment. The real reports resolve positions from
   * persisted account mappings; the mock derives them from account ranges so
   * every catalog position renders with an amount.
   */
  prefixes: string[];
  parentPosition?: string;
  amountSign: 1 | -1;
};

const mockReportCatalog: Record<MockReportStatement, MockReportPositionDefinition[]> = {
  bwa01: [
    { key: 'umsatzerloese', label: 'Umsatzerlöse', kind: 'line', prefixes: ['8', '9'], amountSign: -1 },
    { key: 'bestandsveraenderungen', label: 'Bestandsveränderungen', kind: 'line', prefixes: [], amountSign: -1 },
    { key: 'materialaufwand', label: 'Materialaufwand', kind: 'line', prefixes: ['5'], amountSign: -1 },
    { key: 'personalaufwand', label: 'Personalaufwand', kind: 'line', prefixes: ['6'], amountSign: -1 },
    { key: 'sonstige_aufwendungen', label: 'Sonstige betriebliche Aufwendungen', kind: 'line', prefixes: ['4', '7'], amountSign: -1 },
    { key: 'betriebsergebnis', label: 'Betriebsergebnis', kind: 'result', prefixes: [], amountSign: 1 },
  ],
  'management-guv': [
    { key: 'umsatzerloese', label: 'Umsatzerlöse', kind: 'line', prefixes: ['8', '9'], amountSign: -1 },
    { key: 'bestandsveraenderungen', label: 'Bestandsveränderungen', kind: 'line', prefixes: ['7'], amountSign: -1 },
    { key: 'materialaufwand', label: 'Materialaufwand', kind: 'line', prefixes: ['5'], amountSign: -1 },
    { key: 'personalaufwand', label: 'Personalaufwand', kind: 'line', prefixes: ['6'], amountSign: -1 },
    { key: 'sonstige_aufwendungen', label: 'Sonstige betriebliche Aufwendungen', kind: 'line', prefixes: ['4'], amountSign: -1 },
    { key: 'ergebnis', label: 'Ergebnis', kind: 'result', prefixes: [], amountSign: 1 },
  ],
  'hgb-guv': [
    { key: 'umsatzerloese', label: 'Umsatzerlöse', kind: 'line', prefixes: ['8', '9'], amountSign: -1 },
    { key: 'bestandsveraenderungen', label: 'Bestandsveränderungen', kind: 'line', prefixes: ['7'], amountSign: -1 },
    { key: 'materialaufwand', label: 'Materialaufwand', kind: 'line', prefixes: ['5'], amountSign: -1 },
    { key: 'personalaufwand', label: 'Personalaufwand', kind: 'line', prefixes: ['6'], amountSign: -1 },
    { key: 'abschreibungen', label: 'Abschreibungen', kind: 'line', prefixes: ['48'], amountSign: -1 },
    { key: 'sonstige_aufwendungen', label: 'Sonstige betriebliche Aufwendungen', kind: 'line', prefixes: ['4'], amountSign: -1 },
    { key: 'ergebnis', label: 'Ergebnis', kind: 'result', prefixes: [], amountSign: 1 },
  ],
  'hgb-bilanz': [
    { key: 'anlagevermoegen', label: 'Anlagevermögen', kind: 'heading', side: 'asset', prefixes: [], amountSign: 1 },
    { key: 'anlagevermoegen.sachanlagen', label: 'Sachanlagen', kind: 'line', side: 'asset', prefixes: ['0'], parentPosition: 'anlagevermoegen', amountSign: 1 },
    { key: 'umlaufvermoegen', label: 'Umlaufvermögen', kind: 'heading', side: 'asset', prefixes: [], amountSign: 1 },
    { key: 'umlaufvermoegen.vorraete', label: 'Vorräte', kind: 'line', side: 'asset', prefixes: ['10', '11', '13'], parentPosition: 'umlaufvermoegen', amountSign: 1 },
    { key: 'umlaufvermoegen.forderungen', label: 'Forderungen aus Lieferungen und Leistungen', kind: 'line', side: 'asset', prefixes: ['12', '14'], parentPosition: 'umlaufvermoegen', amountSign: 1 },
    { key: 'umlaufvermoegen.sonstige', label: 'Sonstige Vermögensgegenstände', kind: 'line', side: 'asset', prefixes: ['15'], parentPosition: 'umlaufvermoegen', amountSign: 1 },
    { key: 'umlaufvermoegen.kasse_bank', label: 'Kasse und Bank', kind: 'line', side: 'asset', prefixes: ['1'], parentPosition: 'umlaufvermoegen', amountSign: 1 },
    { key: 'summe_aktiva', label: 'Summe Aktiva', kind: 'subtotal', side: 'asset', prefixes: [], amountSign: 1 },
    { key: 'eigenkapital', label: 'Eigenkapital', kind: 'heading', side: 'liability', prefixes: [], amountSign: -1 },
    { key: 'eigenkapital.gezeichnetes', label: 'Gezeichnetes Kapital', kind: 'line', side: 'liability', prefixes: ['08'], parentPosition: 'eigenkapital', amountSign: -1 },
    { key: 'eigenkapital.jahresueberschuss', label: 'Jahresüberschuss', kind: 'line', side: 'liability', prefixes: ['4', '5', '6', '7', '8', '9'], parentPosition: 'eigenkapital', amountSign: -1 },
    { key: 'verbindlichkeiten', label: 'Verbindlichkeiten', kind: 'heading', side: 'liability', prefixes: [], amountSign: -1 },
    { key: 'verbindlichkeiten.lieferanten', label: 'Verbindlichkeiten aus Lieferungen und Leistungen', kind: 'line', side: 'liability', prefixes: ['16', '33'], parentPosition: 'verbindlichkeiten', amountSign: -1 },
    { key: 'verbindlichkeiten.sonstige', label: 'Sonstige Verbindlichkeiten', kind: 'line', side: 'liability', prefixes: ['17', '18', '2', '3'], parentPosition: 'verbindlichkeiten', amountSign: -1 },
    { key: 'summe_passiva', label: 'Summe Passiva', kind: 'subtotal', side: 'liability', prefixes: [], amountSign: -1 },
  ],
};

const mockReportPositionForAccount = (
  statement: MockReportStatement,
  accountNumber: string,
): MockReportPositionDefinition | undefined => {
  const override = mockReportMappingOverrides.find(
    (row) => row.statement === statement && row.accountNumber === accountNumber,
  );
  if (override) {
    const position = mockReportCatalog[statement].find((entry) => entry.key === override.position);
    if (position) return position;
  }
  const matches = mockReportCatalog[statement]
    .map((entry) => ({
      entry,
      length: Math.max(0, ...entry.prefixes.filter((prefix) => accountNumber.startsWith(prefix)).map((prefix) => prefix.length)),
    }))
    .filter((candidate) => candidate.length > 0);
  return matches.sort((left, right) => right.length - left.length)[0]?.entry;
};

const mockReportAccountIsCovered = (accountNumber: string): boolean =>
  (Object.keys(mockReportCatalog) as MockReportStatement[])
    .some((statement) => Boolean(mockReportPositionForAccount(statement, accountNumber)));

const buildMockReportingReport = async (
  statement: MockReportStatement,
  payload: IpcArgs<'pro:getReportingReport'>,
): Promise<IpcResult<'pro:getReportingReport'>> => {
  const chart = getMockActiveChart();
  const balances = await invoke('pro:getLedgerBalances', {} as IpcArgs<'pro:getLedgerBalances'>);
  const catalog = mockReportCatalog[statement];
  const accounted = new Map<string, { amount: number; accountNumbers: string[] }>();
  const unmappedAccounts = new Set<string>();
  for (const balance of balances) {
    const position = mockReportPositionForAccount(statement, balance.accountNumber);
    if (!position) {
      if (!mockReportAccountIsCovered(balance.accountNumber)) unmappedAccounts.add(balance.accountNumber);
      continue;
    }
    const current = accounted.get(position.key) ?? { amount: 0, accountNumbers: [] };
    current.amount = round2(current.amount + balance.closingBalance * position.amountSign);
    current.accountNumbers.push(balance.accountNumber);
    accounted.set(position.key, current);
  }
  const childrenOf = (entry: MockReportPositionDefinition): MockReportPositionDefinition[] =>
    entry.kind === 'heading'
      ? catalog.filter((child) => child.kind === 'line' && child.parentPosition === entry.key)
      : entry.kind === 'subtotal'
        ? catalog.filter((child) => child.kind === 'line' && child.side === entry.side)
        : entry.kind === 'result'
          ? catalog.filter((child) => child.kind === 'line')
          : [entry];
  const rowAmount = (entry: MockReportPositionDefinition): number =>
    round2(childrenOf(entry).reduce((sum, child) => sum + (accounted.get(child.key)?.amount ?? 0), 0));
  const rowAccounts = (entry: MockReportPositionDefinition): string[] => [
    ...new Set(childrenOf(entry).flatMap((child) => accounted.get(child.key)?.accountNumbers ?? [])),
  ];
  const snapshot = {
    fiscalYear: Number((payload.to ?? payload.asOfDate ?? payload.from ?? new Date().toISOString()).slice(0, 4)),
    fiscalYearStart: `${Number((payload.to ?? payload.asOfDate ?? payload.from ?? new Date().toISOString()).slice(0, 4))}-01-01`,
    businessSize: 'micro',
    ledgerEntryCount: mockJournalEntries.filter((entry) => entry.status === 'posted').length,
    ledgerAccountCount: mockLedgerAccounts.filter((account) => account.chart === chart).length,
    cashEntryCount: mockEurCashFacts.length,
    ...(payload.from ? { from: payload.from } : {}),
    ...(payload.to ? { to: payload.to } : {}),
    ...(payload.asOfDate ? { asOfDate: payload.asOfDate } : {}),
  };
  const mappingHealth = {
    mappedAccounts: new Set([...accounted.values()].flatMap((value) => value.accountNumbers)).size,
    inferredAccounts: 0,
    unmappedAccounts: [...unmappedAccounts].sort(),
    warnings: [...unmappedAccounts].sort().map((accountNumber) => `Konto ${accountNumber} ist keinem Report zugeordnet.`),
    blocking: unmappedAccounts.size > 0,
  };
  if (statement === 'hgb-bilanz') {
    const toLine = (entry: MockReportPositionDefinition) => ({
      position: entry.key,
      label: entry.label,
      amount: rowAmount(entry),
      accountNumbers: rowAccounts(entry),
      kind: entry.kind,
      ...(entry.parentPosition ? { parentPosition: entry.parentPosition } : {}),
    });
    const assets = catalog.filter((entry) => entry.side === 'asset' && entry.kind !== 'subtotal').map(toLine);
    const liabilities = catalog.filter((entry) => entry.side === 'liability' && entry.kind !== 'subtotal').map(toLine);
    const assetTotal = round2(catalog.filter((entry) => entry.kind === 'line' && entry.side === 'asset').reduce((sum, entry) => sum + (accounted.get(entry.key)?.amount ?? 0), 0));
    const liabilityTotal = round2(catalog.filter((entry) => entry.kind === 'line' && entry.side === 'liability').reduce((sum, entry) => sum + (accounted.get(entry.key)?.amount ?? 0), 0));
    return {
      kind: statement,
      snapshot,
      mappingHealth,
      assets,
      liabilities,
      totals: { assets: assetTotal, liabilities: liabilityTotal, delta: round2(assetTotal - liabilityTotal) },
    };
  }
  const rows = catalog
    .filter((entry) => entry.kind === 'line' || entry.kind === 'result')
    .map((entry) => ({
      position: entry.key,
      label: entry.label,
      amount: rowAmount(entry),
      accountNumbers: rowAccounts(entry),
      kind: entry.kind,
    }));
  const lines = catalog.filter((entry) => entry.kind === 'line');
  const revenue = round2(lines.reduce((sum, entry) => sum + Math.max(0, accounted.get(entry.key)?.amount ?? 0), 0));
  const expenses = round2(lines.reduce((sum, entry) => sum + Math.abs(Math.min(0, accounted.get(entry.key)?.amount ?? 0)), 0));
  return {
    kind: statement,
    snapshot,
    mappingHealth,
    rows,
    netResult: round2(revenue - expenses),
    totals: { revenue, expenses, operatingResult: round2(revenue - expenses) },
    ...(statement === 'hgb-guv' ? { method: 'gkv' as const } : {}),
  };
};

const mockTaxSplit = (gross: number, rate: number): { net: number; tax: number } => {
  const net = round2(gross / (1 + rate / 100));
  return { net, tax: round2(gross - net) };
};

type MockCommandOutcome =
  | { status: 'posted'; lines: MockSourceLine[]; result: Record<string, unknown> }
  | { status: 'noop'; result: Record<string, unknown> }
  | { status: 'rejected'; result: Record<string, unknown>; errors: IpcResult<'pro:postAccountingCommand'>['errors'] };

const mockClosingLines = (
  balances: unknown,
  counterpartAccount: string,
  memo: string,
): MockSourceLine[] => (Array.isArray(balances) ? balances as Array<Record<string, unknown>> : []).flatMap((balance) => {
  const closing = typeof balance.closingBalance === 'number' && Number.isFinite(balance.closingBalance) ? round2(balance.closingBalance) : 0;
  const accountNumber = typeof balance.accountNumber === 'string' ? balance.accountNumber.trim() : '';
  if (!accountNumber || closing === 0) return [];
  const amount = Math.abs(closing);
  return closing > 0
    ? [{ accountNumber: counterpartAccount, debitAmount: amount, creditAmount: 0, memo }, { accountNumber, debitAmount: 0, creditAmount: amount, memo }]
    : [{ accountNumber, debitAmount: amount, creditAmount: 0, memo }, { accountNumber: counterpartAccount, debitAmount: 0, creditAmount: amount, memo }];
});

/**
 * Mirrors the desktop command registry: settlement and closing workflows derive
 * their own journal lines, while validation-only workflows never post.
 */
const mockCommandOutcome = (kind: string, facts: Record<string, unknown>): MockCommandOutcome => {
  const chart = getMockActiveChart();
  const mapping = getMockAccountingMappings(chart);
  const numeric = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? round2(value) : 0);
  const account = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const nested = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const breakdown = Array.isArray(facts.taxBreakdown) ? facts.taxBreakdown as Array<Record<string, unknown>> : [];
  const breakdownTax = round2(breakdown.reduce((sum, line) => sum + numeric(line.taxAmount), 0));
  const breakdownNet = round2(breakdown.reduce((sum, line) => sum + numeric(line.netAmount), 0));
  const rate = breakdownTax > 0 && breakdownNet > 0 ? round2((breakdownTax / breakdownNet) * 100) : 19;
  const reject = (code: string, message: string, field?: string): MockCommandOutcome => ({
    status: 'rejected',
    result: { code, message },
    errors: [{ code, message, ...(field ? { field } : {}), blocking: true }],
  });

  switch (kind) {
    case 'correction':
    case 'credit':
    case 'skonto': {
      const deltaGross = kind === 'skonto'
        ? numeric(facts.skontoAmount)
        : round2((Array.isArray(facts.deltas) ? facts.deltas as Array<Record<string, unknown>> : []).reduce((sum, delta) => sum + numeric(delta.grossAmount), 0));
      if (deltaGross === 0) return { status: 'noop', result: { correctionGrossAmount: 0 } };
      const sign = deltaGross < 0 ? -1 : 1;
      const { net, tax } = mockTaxSplit(Math.abs(deltaGross), rate);
      const documentType = nested(facts.original).documentType ?? facts.documentType;
      const correctionGrossAmount = round2(sign * (net + tax));
      return documentType === 'incoming_invoice'
        ? {
          status: 'posted',
          result: { correctionGrossAmount, documentType: 'incoming_invoice' },
          lines: [
            { accountNumber: mapping.accounts_payable, debitAmount: correctionGrossAmount, creditAmount: 0, memo: 'Korrektur Verbindlichkeit' },
            { accountNumber: mapping.expense, debitAmount: 0, creditAmount: round2(sign * net), memo: 'Korrektur Aufwand' },
            { accountNumber: mapping.input_vat, debitAmount: 0, creditAmount: round2(sign * tax), memo: 'Korrektur Vorsteuer' },
          ],
        }
        : {
          status: 'posted',
          result: { correctionGrossAmount, documentType: 'outgoing_invoice' },
          lines: [
            { accountNumber: mapping.revenue, debitAmount: round2(sign * net), creditAmount: 0, memo: 'Korrektur Erlös' },
            { accountNumber: mapping.output_vat, debitAmount: round2(sign * tax), creditAmount: 0, memo: 'Korrektur Umsatzsteuer' },
            { accountNumber: mapping.accounts_receivable, debitAmount: 0, creditAmount: correctionGrossAmount, memo: 'Korrektur Forderung' },
          ],
        };
    }
    case 'bad_debt':
    case 'ustg17': {
      const amount = numeric(facts.writeOffGrossAmount);
      if (amount <= 0) return reject('INVALID_AMOUNT', 'Für den Forderungsausfall wird ein Bruttobetrag benötigt.', 'writeOffGrossAmount');
      const { net, tax } = mockTaxSplit(amount, rate);
      return {
        status: 'posted',
        result: { writeOffGrossAmount: amount },
        lines: [
          { accountNumber: account(facts.badDebtExpenseAccount, mapping.expense), debitAmount: net, creditAmount: 0, memo: 'Forderungsausfall' },
          { accountNumber: mapping.output_vat, debitAmount: tax, creditAmount: 0, memo: 'Umsatzsteuerkorrektur §17 UStG' },
          { accountNumber: mapping.accounts_receivable, debitAmount: 0, creditAmount: amount, memo: 'Ausbuchung Forderung' },
        ],
      };
    }
    case 'advance_settlement': {
      const finalInvoice = nested(facts.finalInvoice);
      const finalGross = numeric(finalInvoice.grossAmount);
      const advanceGross = round2((Array.isArray(facts.advances) ? facts.advances as Array<Record<string, unknown>> : []).reduce((sum, advance) => sum + numeric(advance.grossAmount), 0));
      if (finalGross <= 0 || advanceGross <= 0) return reject('SETTLEMENT_DOCUMENT_REQUIRED', 'Schlussrechnung und Anzahlungen werden für die Verrechnung benötigt.', 'finalInvoice');
      const { net, tax } = mockTaxSplit(finalGross, rate);
      const remainder = round2(finalGross - advanceGross);
      return {
        status: 'posted',
        result: { settledGrossAmount: finalGross, advanceGrossAmount: advanceGross },
        lines: [
          { accountNumber: account(facts.advanceClearingReceivable, mapping.accounts_receivable), debitAmount: advanceGross, creditAmount: 0, memo: 'Verrechnung Anzahlungen' },
          ...(remainder > 0 ? [{ accountNumber: mapping.accounts_receivable, debitAmount: remainder, creditAmount: 0, memo: 'Restforderung' }] : []),
          { accountNumber: mapping.revenue, debitAmount: 0, creditAmount: net, memo: 'Schlussrechnung' },
          { accountNumber: mapping.output_vat, debitAmount: 0, creditAmount: tax, memo: 'Umsatzsteuer' },
        ],
      };
    }
    case 'fiscal_close': {
      const lines = mockClosingLines(facts.balances, account(facts.retainedEarningsAccount, '9000'), 'Erfolgskonten abschließen');
      if (!lines.length) return { status: 'noop', result: { closedAccounts: 0 } };
      return { status: 'posted', result: { closedAccounts: lines.length / 2 }, lines };
    }
    case 'carry_forward': {
      const lines = mockClosingLines(facts.balances, account(facts.openingBalanceAccount, '9000'), 'Saldenvortrag');
      if (!lines.length) return { status: 'noop', result: { carriedAccounts: 0 } };
      return { status: 'posted', result: { carriedAccounts: lines.length / 2 }, lines };
    }
    case 'provision': {
      const previousAmount = numeric(facts.previousAmount);
      const targetAmount = numeric(facts.targetAmount);
      const delta = round2(targetAmount - previousAmount);
      if (delta === 0) return { status: 'noop', result: { previousAmount, targetAmount } };
      const expenseAccount = account(facts.expenseAccount, mapping.expense);
      const provisionAccount = account(facts.provisionAccount, '0970');
      return delta > 0
        ? {
          status: 'posted',
          result: { previousAmount, targetAmount, delta },
          lines: [
            { accountNumber: expenseAccount, debitAmount: delta, creditAmount: 0, memo: 'Rückstellung bilden' },
            { accountNumber: provisionAccount, debitAmount: 0, creditAmount: delta, memo: 'Rückstellung bilden' },
          ],
        }
        : {
          status: 'posted',
          result: { previousAmount, targetAmount, delta },
          lines: [
            { accountNumber: provisionAccount, debitAmount: Math.abs(delta), creditAmount: 0, memo: 'Rückstellung auflösen' },
            { accountNumber: expenseAccount, debitAmount: 0, creditAmount: Math.abs(delta), memo: 'Rückstellung auflösen' },
          ],
        };
    }
    case 'accrual': {
      const startDate = typeof facts.startDate === 'string' ? facts.startDate : '';
      const endDate = typeof facts.endDate === 'string' ? facts.endDate : '';
      const totalAmount = numeric(facts.totalAmount);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || totalAmount === 0) {
        return reject('ACCRUAL_PERIOD_REQUIRED', 'Abgrenzung benötigt Start, Ende und Betrag.', 'startDate');
      }
      const months = Math.max(1, (Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 + (Number(endDate.slice(5, 7)) - Number(startDate.slice(5, 7))) + 1);
      const monthly = round2(totalAmount / months);
      if (monthly === 0) return { status: 'noop', result: { months, monthlyAmount: 0 } };
      return {
        status: 'posted',
        result: { months, monthlyAmount: monthly, totalAmount },
        lines: [
          { accountNumber: account(facts.expenseAccount, mapping.expense), debitAmount: monthly, creditAmount: 0, memo: 'Abgrenzung Aufwand' },
          { accountNumber: account(facts.deferralAccount, '2900'), debitAmount: 0, creditAmount: monthly, memo: 'Abgrenzung Rechnungsabgrenzung' },
        ],
      };
    }
    case 'inventory_closing': {
      const items = (Array.isArray(facts.items) ? facts.items as Array<Record<string, unknown>> : [])
        .map((item) => {
          const quantity = numeric(item.quantity);
          const unitCost = numeric(item.unitCost);
          const unitMarketValue = numeric(item.unitMarketValue);
          const value = round2(quantity * Math.min(unitCost, unitMarketValue));
          return {
            accountNumber: account(item.inventoryAccount, '1140'),
            expenseAccount: account(item.expenseAccount, mapping.expense),
            value,
          };
        })
        .filter((item) => item.value > 0);
      const total = round2(items.reduce((sum, item) => sum + item.value, 0));
      if (total <= 0) return { status: 'noop', result: { inventoryValue: 0 } };
      return {
        status: 'posted',
        result: { inventoryValue: total, itemCount: items.length },
        lines: items.flatMap((item) => [
          { accountNumber: item.accountNumber, debitAmount: item.value, creditAmount: 0, memo: 'Inventurbestand' },
          { accountNumber: item.expenseAccount, debitAmount: 0, creditAmount: item.value, memo: 'Bestandsveränderung' },
        ]),
      };
    }
    case 'fx_valuation': {
      const foreignAmount = numeric(facts.foreignAmount);
      const closingRate = numeric(facts.closingRate);
      const carryingAmount = numeric(facts.carryingAmount);
      const positionAccount = account(facts.positionAccount, mapping.asset);
      const gainAccount = account(facts.gainAccount, '2660');
      const lossAccount = account(facts.lossAccount, '6880');
      const balance = round2(foreignAmount * closingRate - carryingAmount);
      if (foreignAmount === 0 || closingRate === 0 || balance === 0) return { status: 'noop', result: { valuationDifference: 0 } };
      const isLiability = facts.position === 'liability';
      const amount = Math.abs(balance);
      const gains = isLiability ? balance < 0 : balance > 0;
      return {
        status: 'posted',
        result: { valuationDifference: balance, position: facts.position ?? 'asset' },
        lines: gains
          ? [
            { accountNumber: positionAccount, debitAmount: amount, creditAmount: 0, memo: 'Fremdwährungsbewertung' },
            { accountNumber: gainAccount, debitAmount: 0, creditAmount: amount, memo: 'Währungsgewinn' },
          ]
          : [
            { accountNumber: lossAccount, debitAmount: amount, creditAmount: 0, memo: 'Währungsverlust' },
            { accountNumber: positionAccount, debitAmount: 0, creditAmount: amount, memo: 'Fremdwährungsbewertung' },
          ],
      };
    }
    case 'loan_schedule': {
      const principal = numeric(facts.principal);
      const termMonths = numeric(facts.termMonths);
      const annualInterestRate = numeric(facts.annualInterestRate);
      if (principal <= 0 || termMonths <= 0) return reject('LOAN_FACTS_REQUIRED', 'Darlehen benötigt Nominalbetrag und Laufzeit.', 'principal');
      const repayment = round2(principal / termMonths);
      const interest = round2((principal * annualInterestRate) / 100 / 12);
      return {
        status: 'posted',
        result: { repayment, interest, termMonths },
        lines: [
          { accountNumber: account(facts.liabilityAccount, '1700'), debitAmount: repayment, creditAmount: 0, memo: 'Tilgung' },
          { accountNumber: account(facts.interestAccount, '2100'), debitAmount: interest, creditAmount: 0, memo: 'Zinsanteil' },
          { accountNumber: account(facts.cashAccount, mapping.bank), debitAmount: 0, creditAmount: round2(repayment + interest), memo: 'Darlehensrate' },
        ],
      };
    }
    case 'payroll_batch':
      return { status: 'noop', result: { status: 'valid', lineCount: Array.isArray(facts.lines) ? facts.lines.length : 0 } };
    case 'shareholder_flow':
      return { status: 'noop', result: { status: 'valid', flowType: facts.flowType ?? 'unspecified' } };
    case 'standalone':
      return reject('INVALID_AMOUNT', 'Standalone-Buchungen liefern ihre Journalzeilen über den Quellbeleg.', 'source.lines');
    default:
      return reject('MOCK_COMMAND_UNSUPPORTED', `Für ${kind} kann der Mock keine Journalzeilen ableiten.`, 'kind');
  }
};

const getMockInvoiceById = (id: string): Invoice | undefined => invoices.find((inv) => inv.id === id);

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

/**
 * Mirrors the Electron handler so the renderer sees the same tax data whether it
 * talks to SQLite or to this in-memory backend.
 */
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

const invoke = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
  switch (key) {
    case 'invoices:list':
      return structuredClone(invoices) as IpcResult<K>;
    case 'invoices:upsert': {
      const { invoice } = args as IpcArgs<'invoices:upsert'>;
      const normalized = normalizeInvoiceTaxData(structuredClone(invoice) as Invoice);
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
      const normalized = normalizeInvoiceTaxData(structuredClone(offer) as Invoice);
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
        taxMode: resolveInvoiceTaxMode(undefined, settings),
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
      const { offerId } = args as IpcArgs<'documents:convertOfferToInvoice'>;
      const offer = offers.find((o) => o.id === offerId);
      if (!offer) throw new Error('Offer not found');
      const reservation = reserveNumber('invoice');
      const invoice: Invoice = {
        ...structuredClone(offer),
        id: Math.random().toString(36).slice(2),
        number: reservation.number,
        numberReservationId: reservation.reservationId,
        status: 'open',
        history: [
          {
            date: toIsoDate(new Date()),
            action: `Erstellt aus Angebot ${offer.number}`,
          },
          ...(offer.history ?? []),
        ],
      };
      invoices.unshift(invoice);
      finalizeNumber(reservation.reservationId, invoice.id);
      return structuredClone(invoice) as IpcResult<K>;
    }
    case 'documents:chainCreate': {
      const input = args as IpcArgs<'documents:chainCreate'>;
      const scope = { tenantId: 'default', product, deploymentMode: 'single-tenant' as const };
      const dependencies = {
        invoiceRepo: {
          list: () => invoices,
          getById: (_scope: typeof scope, id: string) => invoices.find((invoice) => invoice.id === id) ?? null,
          save: (_scope: typeof scope, document: unknown) => {
            const invoice = document as Invoice;
            invoices.unshift(invoice);
            return invoice;
          },
          remove: (_scope: typeof scope, id: string) => {
            const index = invoices.findIndex((invoice) => invoice.id === id);
            if (index >= 0) invoices.splice(index, 1);
          },
        },
        offerRepo: {
          getById: (_scope: typeof scope, id: string) => offers.find((offer) => offer.id === id) ?? null,
        },
        auditLog: { append: () => undefined },
      };
      const chainDependencies = dependencies as unknown as Parameters<typeof createOrderConfirmationFromOffer>[1];
      const document = input.operation === 'order_confirmation'
        ? createOrderConfirmationFromOffer(scope, chainDependencies, input as Parameters<typeof createOrderConfirmationFromOffer>[2])
        : input.operation === 'delivery_note'
          ? createDeliveryNoteFromOrder(scope, chainDependencies, input as unknown as Parameters<typeof createDeliveryNoteFromOrder>[2])
          : input.operation === 'settlement_invoice'
            ? createSettlementInvoice(scope, chainDependencies, input as unknown as Parameters<typeof createSettlementInvoice>[2])
            : input.operation === 'correction'
              ? createCorrectionDocument(scope, chainDependencies, input as unknown as Parameters<typeof createCorrectionDocument>[2])
              : createInvoiceRevision(scope, chainDependencies, input as Parameters<typeof createInvoiceRevision>[2]);
      return structuredClone(document) as IpcResult<K>;
    }
    case 'documents:chainList': {
      const { rootDocumentId } = args as IpcArgs<'documents:chainList'>;
      const scope = { tenantId: 'default', product, deploymentMode: 'single-tenant' as const };
      const dependencies = {
        invoiceRepo: {
          list: () => invoices,
          getById: (_scope: typeof scope, id: string) => invoices.find((invoice) => invoice.id === id) ?? null,
          save: (_scope: typeof scope, document: unknown) => document as Invoice,
          remove: () => undefined,
        },
        offerRepo: { getById: () => null },
        auditLog: { append: () => undefined },
      };
      const chainDependencies = dependencies as unknown as Parameters<typeof listDocumentChain>[1];
      return structuredClone(listDocumentChain(scope, chainDependencies, rootDocumentId)) as IpcResult<K>;
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

    case 'eur:saveCashFact': {
      const payload = args as IpcArgs<'eur:saveCashFact'>;
      const manifest = getCatalogManifestForYear(payload.taxYear);
      const timestamp = new Date().toISOString();
      const idempotencyKey = payload.idempotencyKey ?? `eur-cash:${payload.sourceType}:${payload.sourceId}:${payload.taxYear}`;
      const existing = mockEurCashFacts.find((fact) => fact.idempotencyKey === idempotencyKey);
      const fact: MockEurCashFact = {
        id: existing?.id ?? `eur-cash-fact-${mockEurCashFacts.length + 1}-${Math.random().toString(36).slice(2)}`,
        tenantId: MOCK_TENANT_ID,
        sourceType: payload.sourceType,
        sourceId: payload.sourceId,
        taxYear: payload.taxYear,
        kind: payload.kind,
        amountNet: payload.amountNet,
        flowType: payload.flowType,
        eurLineId: payload.eurLineId,
        splits: payload.splits,
        reason: payload.reason,
        actorId: 'mock-pro-actor',
        actorName: 'Pro Workspace',
        idempotencyKey,
        provenance: {
          catalogId: manifest.id,
          catalogVersion: manifest.version,
          catalogSourceHash: manifest.sha256,
        },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) mockEurCashFacts.splice(mockEurCashFacts.indexOf(existing), 1, fact);
      else mockEurCashFacts.push(fact);
      return fact as IpcResult<K>;
    }

    case 'eur:listCashFacts': {
      const { taxYear } = args as IpcArgs<'eur:listCashFacts'>;
      return mockEurCashFacts
        .filter((fact) => fact.taxYear === taxYear)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)) as IpcResult<K>;
    }

    case 'eur:saveAnnexFact': {
      const payload = args as IpcArgs<'eur:saveAnnexFact'>;
      const manifest = getCatalogManifestForYear(payload.taxYear);
      const timestamp = new Date().toISOString();
      const idempotencyKey = payload.idempotencyKey ?? `eur-annex:${payload.taxYear}:${payload.annex}:${payload.lineId}`;
      const existing = mockEurAnnexFacts.find((fact) => fact.idempotencyKey === idempotencyKey);
      const fact: MockEurAnnexFact = {
        id: existing?.id ?? `eur-annex-fact-${mockEurAnnexFacts.length + 1}-${Math.random().toString(36).slice(2)}`,
        tenantId: MOCK_TENANT_ID,
        taxYear: payload.taxYear,
        annex: payload.annex,
        lineId: payload.lineId,
        amount: payload.amount,
        sourceId: payload.sourceId,
        date: payload.date,
        reason: payload.reason,
        actorId: 'mock-pro-actor',
        actorName: 'Pro Workspace',
        idempotencyKey,
        provenance: {
          catalogId: manifest.id,
          catalogVersion: manifest.version,
          catalogSourceHash: manifest.sha256,
        },
        createdAt: existing?.createdAt ?? timestamp,
      };
      if (existing) mockEurAnnexFacts.splice(mockEurAnnexFacts.indexOf(existing), 1, fact);
      else mockEurAnnexFacts.push(fact);
      return fact as IpcResult<K>;
    }

    case 'eur:listAnnexFacts': {
      const { taxYear, annex } = args as IpcArgs<'eur:listAnnexFacts'>;
      return mockEurAnnexFacts
        .filter((fact) => fact.taxYear === taxYear)
        .filter((fact) => (annex ? fact.annex === annex : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)) as IpcResult<K>;
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

    case 'tax:saveAuditExportPackage': {
      const artifact = args as IpcArgs<'tax:saveAuditExportPackage'>;
      const stamp = artifact.createdAt.replace(/[^A-Za-z0-9_-]/g, '-');
      const bundleDir = `mock://exports/tax-audit/${stamp}`;
      const seenNames = new Set<string>();
      const files = artifact.files.map((entry) => {
        if (entry.name !== entry.name.split(/[\\/]/).pop() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name) || seenNames.has(entry.name)) {
          throw new Error('Ungültiger Dateiname im Steuerprüfungsexport.');
        }
        seenNames.add(entry.name);
        const sizeBytes = mockUtf8ByteLength(entry.content);
        if (sizeBytes !== entry.sizeBytes) {
          throw new Error(`Integritätsprüfung für ${entry.name} fehlgeschlagen.`);
        }
        return {
          name: entry.name,
          path: `${bundleDir}/${entry.name}`,
          sha256: entry.sha256,
          sizeBytes,
          ...(entry.rowCount === undefined ? {} : { rowCount: entry.rowCount }),
        };
      });
      const result: MockAuditExportPackage = {
        bundleDir,
        manifestPath: `${bundleDir}/manifest.json`,
        createdAt: artifact.createdAt,
        fileCount: files.length,
        files,
      };
      mockAuditExportPackages.push(result);
      return result as IpcResult<K>;
    }

    case 'taxFiling:getStatus':
      return {
        provider: mockTaxFilingProvider,
        certificates: structuredClone(mockTaxFilingCertificates),
      } as IpcResult<K>;

    case 'taxFiling:listRecords':
      return structuredClone(mockTaxFilingRecords) as IpcResult<K>;

    case 'taxFiling:installCertificate': {
      const payload = args as IpcArgs<'taxFiling:installCertificate'>;
      const pem = payload.pem.trim();
      if (!/^-----BEGIN [A-Z ]*CERTIFICATE-----[\s\S]+-----END [A-Z ]*CERTIFICATE-----$/.test(pem)) {
        throw new Error('INVALID_CERTIFICATE_PEM: Das Zertifikat muss ein PEM-Block mit BEGIN/END CERTIFICATE sein.');
      }
      const certificate: MockTaxFilingCertificate = {
        id: payload.id,
        fingerprint: mockFingerprint(pem),
        expiresAt: payload.expiresAt,
        ...(payload.subject === undefined ? {} : { subject: payload.subject }),
      };
      const existing = mockTaxFilingCertificates.findIndex((entry) => entry.id === certificate.id);
      if (existing >= 0) mockTaxFilingCertificates[existing] = certificate;
      else mockTaxFilingCertificates.push(certificate);
      return structuredClone(certificate) as IpcResult<K>;
    }

    case 'taxFiling:removeCertificate': {
      const { id } = args as IpcArgs<'taxFiling:removeCertificate'>;
      const existing = mockTaxFilingCertificates.findIndex((entry) => entry.id === id);
      if (existing < 0) return false as IpcResult<K>;
      mockTaxFilingCertificates.splice(existing, 1);
      return true as IpcResult<K>;
    }

    case 'taxFiling:validate': {
      const { record } = args as IpcArgs<'taxFiling:validate'>;
      if (record.status !== 'frozen') {
        return {
          operation: 'validate',
          status: 'failed',
          sourceHash: record.sourceHash,
          issues: [{ code: 'RECORD_NOT_FROZEN', message: 'Nur eingefrorene Steuerberichte können validiert werden.' }],
        } as IpcResult<K>;
      }
      upsertMockTaxFilingRecord(record);
      return {
        operation: 'validate',
        status: 'validated',
        sourceHash: record.sourceHash,
        issues: [],
      } as IpcResult<K>;
    }

    case 'taxFiling:export': {
      const { record } = args as IpcArgs<'taxFiling:export'>;
      if (record.status !== 'frozen') {
        return {
          operation: 'export',
          status: 'failed',
          sourceHash: record.sourceHash,
          issues: [{ code: 'RECORD_NOT_FROZEN', message: 'Nur eingefrorene Steuerberichte können exportiert werden.' }],
        } as IpcResult<K>;
      }
      upsertMockTaxFilingRecord(record);
      return {
        operation: 'export',
        status: 'exported',
        sourceHash: record.sourceHash,
        outputPath: `mock://tax-filing/exports/${record.id}.${record.kind === 'e_bilanz' ? 'xml' : 'json'}`,
        issues: [],
      } as IpcResult<K>;
    }

    case 'taxFiling:submit': {
      const { record } = args as IpcArgs<'taxFiling:submit'>;
      if (record.status === 'queued') {
        return {
          operation: 'submit',
          status: 'failed',
          sourceHash: record.sourceHash,
          issues: [{ code: 'RECORD_ALREADY_QUEUED', message: 'Der Steuerbericht ist bereits zur Übermittlung eingereiht.' }],
        } as IpcResult<K>;
      }
      upsertMockTaxFilingRecord(record, 'queued');
      return {
        operation: 'submit',
        status: 'submitted',
        sourceHash: record.sourceHash,
        issues: [],
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
      seed('SKR03', '1400', 'Forderungen aus Lieferungen und Leistungen');
      seed('SKR03', '1600', 'Verbindlichkeiten aus Lieferungen und Leistungen');
      seed('SKR03', '1776', 'Umsatzsteuer 19%');
      seed('SKR03', '1780', 'Umsatzsteuer nicht fällig 19%');
      seed('SKR03', '8400', 'Erlöse 19% USt');
      seed('SKR03', '1576', 'Vorsteuer 19%');
      seed('SKR03', '4900', 'Sonstige betriebliche Aufwendungen');
      seed('SKR03', '0480', 'Geringwertige Wirtschaftsgüter');
      seed('SKR04', '1800', 'Bank');
      seed('SKR04', '1600', 'Kasse');
      seed('SKR04', '1200', 'Forderungen aus Lieferungen und Leistungen');
      seed('SKR04', '3300', 'Verbindlichkeiten aus Lieferungen und Leistungen');
      seed('SKR04', '3806', 'Umsatzsteuer 19%');
      seed('SKR04', '3810', 'Umsatzsteuer nicht fällig 19%');
      seed('SKR04', '4400', 'Erlöse 19% USt');
      seed('SKR04', '1406', 'Vorsteuer 19%');
      seed('SKR04', '6300', 'Sonstige betriebliche Aufwendungen');
      seed('SKR04', '0670', 'Geringwertige Wirtschaftsgüter');

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
      const { from, to, accountNumbers, limit = 500, offset = 0 } = args as IpcArgs<'pro:listJournalEntries'>;
      let rows = [...mockJournalEntries];
      if (from) rows = rows.filter((row) => row.postingDate >= from);
      if (to) rows = rows.filter((row) => row.postingDate <= to);
      if (accountNumbers?.length) {
        rows = rows.filter((row) => row.lines.some((line) => accountNumbers.includes(line.accountNumber)));
      }
      return rows.slice(offset, offset + limit) as IpcResult<K>;
    }

    case 'pro:getJournalEntryById': {
      const { entryId } = args as IpcArgs<'pro:getJournalEntryById'>;
      return (mockJournalEntries.find((row) => row.id === entryId) ?? null) as IpcResult<K>;
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

    case 'pro:listAssets':
      return structuredClone(mockAssets) as IpcResult<K>;

    case 'pro:upsertAsset': {
      const { asset } = args as IpcArgs<'pro:upsertAsset'>;
      const next: IpcResult<'pro:upsertAsset'> = {
        ...asset,
        id: asset.id ?? `asset-${Date.now()}`,
        residualValue: asset.acquisitionCost,
        annualDepreciation: asset.acquisitionCost,
        nextDepreciation: `${asset.activationDate.slice(0, 4)}-12-31`,
      };
      const index = mockAssets.findIndex((row) => row.id === next.id);
      if (index === -1) mockAssets.push(next);
      else mockAssets[index] = next;
      return structuredClone(next) as IpcResult<K>;
    }

    case 'pro:getDepreciationSchedule': {
      const { assetId } = args as IpcArgs<'pro:getDepreciationSchedule'>;
      return structuredClone(mockAssetSchedules.get(assetId) ?? []) as IpcResult<K>;
    }

    case 'pro:runDepreciation':
      throw new Error('Depreciation posting is unavailable in the mock backend');

    case 'pro:disposeAsset': {
      const { assetId, disposalDate, proceeds } = args as IpcArgs<'pro:disposeAsset'>;
      const asset = mockAssets.find((row) => row.id === assetId);
      if (!asset) throw new Error('Asset not found');
      asset.status = proceeds > 0 ? 'verkauft' : 'stillgelegt';
      asset.disposalDate = disposalDate;
      asset.disposalProceeds = proceeds;
      return { asset, residualBookValue: asset.residualValue, gainLoss: proceeds - asset.residualValue, journalEntryId: `mock-disposal:${assetId}` } as IpcResult<K>;
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

    case 'pro:getAccountingPolicy':
      return getMockAccountingPolicy() as IpcResult<K>;

    case 'pro:setAccountingPolicy': {
      const payload = args as IpcArgs<'pro:setAccountingPolicy'>;
      if (payload.activeChart !== getMockActiveChart() && mockJournalEntries.some((entry) => entry.status === 'posted')) {
        throw new Error('ACCOUNTING_CHART_LOCKED: Der Kontenrahmen kann nach einer gebuchten Journalbuchung nicht mehr geändert werden.');
      }
      mockAccountingPolicyChart = payload.activeChart;
      mockAccountingVatMethod = payload.vatMethod;
      mockAccountingPolicyUpdatedAt = new Date().toISOString();
      ensureMockAccountingMappings();
      return getMockAccountingPolicy() as IpcResult<K>;
    }

    case 'pro:listAccountingAccountMappings': {
      const { chart } = args as IpcArgs<'pro:listAccountingAccountMappings'>;
      ensureMockAccountingMappings();
      return mockAccountingAccountMappings
        .filter((row) => (chart ? row.chart === chart : true))
        .sort((a, b) => (a.chart === b.chart ? a.role.localeCompare(b.role) : a.chart.localeCompare(b.chart))) as IpcResult<K>;
    }

    case 'pro:upsertAccountingAccountMapping': {
      const payload = args as IpcArgs<'pro:upsertAccountingAccountMapping'>;
      ensureMockAccountingMappings();
      const chartHasAccounts = mockLedgerAccounts.some((row) => row.chart === payload.chart);
      if (chartHasAccounts && !mockLedgerAccounts.some((row) => row.chart === payload.chart && row.accountNumber === payload.accountNumber)) {
        throw new Error(`UNKNOWN_ACCOUNT:${payload.accountNumber}`);
      }
      const index = mockAccountingAccountMappings.findIndex((row) => row.chart === payload.chart && row.role === payload.role);
      const next: MockAccountingAccountMapping = {
        id: payload.id ?? (index >= 0 ? mockAccountingAccountMappings[index]!.id : `${MOCK_TENANT_ID}-${payload.chart}-${payload.role}`),
        tenantId: MOCK_TENANT_ID,
        chart: payload.chart,
        role: payload.role,
        accountNumber: payload.accountNumber,
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) mockAccountingAccountMappings[index] = next;
      else mockAccountingAccountMappings.push(next);
      return next as IpcResult<K>;
    }

    case 'pro:listVendors':
      return [...mockVendors].sort((a, b) => a.name.localeCompare(b.name)) as IpcResult<K>;

    case 'pro:upsertVendor': {
      const payload = args as IpcArgs<'pro:upsertVendor'>;
      const timestamp = new Date().toISOString();
      const index = mockVendors.findIndex((row) => row.id === payload.vendor.id);
      const next: MockVendor = {
        ...(index >= 0 ? mockVendors[index]! : { tenantId: MOCK_TENANT_ID, createdAt: timestamp }),
        ...payload.vendor,
        tenantId: MOCK_TENANT_ID,
        updatedAt: timestamp,
      };
      if (index >= 0) mockVendors[index] = next;
      else mockVendors.push(next);
      return next as IpcResult<K>;
    }

    case 'pro:listIncomingInvoices':
      return [...mockIncomingInvoices].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate)) as IpcResult<K>;

    case 'pro:upsertIncomingInvoice': {
      const payload = args as IpcArgs<'pro:upsertIncomingInvoice'>;
      const invoice = payload.invoice;
      if (Math.abs(invoice.grossAmount - invoice.netAmount - invoice.taxAmount) > 0.01 || invoice.grossAmount < 0 || invoice.netAmount < 0 || invoice.taxAmount < 0) {
        throw new Error('INVALID_INCOMING_TOTALS: Brutto muss Netto plus Steuer entsprechen.');
      }
      if (!mockVendors.some((vendor) => vendor.id === invoice.vendorId)) {
        throw new Error('VENDOR_TENANT_MISMATCH: Der Kreditor ist nicht bekannt.');
      }
      const index = mockIncomingInvoices.findIndex((row) => row.id === invoice.id);
      const existing = index >= 0 ? mockIncomingInvoices[index]! : undefined;
      if (existing?.accountingStatus === 'posted') {
        throw new Error('POSTED_DOCUMENT_IMMUTABLE: Gebuchte Eingangsrechnungen können nicht mehr geändert werden.');
      }
      const timestamp = new Date().toISOString();
      const next: MockIncomingInvoice = {
        ...invoice,
        tenantId: MOCK_TENANT_ID,
        lines: invoice.lines.map((line, position) => ({ ...line, incomingInvoiceId: invoice.id, position })),
        accountingStatus: invoice.accountingStatus ?? existing?.accountingStatus ?? 'unposted',
        accountingSnapshot: existing?.accountingSnapshot,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (index >= 0) mockIncomingInvoices[index] = next;
      else mockIncomingInvoices.push(next);
      return next as IpcResult<K>;
    }

    case 'pro:listIncomingInvoiceDocuments': {
      const { invoiceId } = args as IpcArgs<'pro:listIncomingInvoiceDocuments'>;
      return mockIncomingInvoiceDocuments
        .filter((document) => document.incomingInvoiceId === invoiceId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)) as IpcResult<K>;
    }

    case 'pro:uploadIncomingInvoiceDocument': {
      const payload = args as IpcArgs<'pro:uploadIncomingInvoiceDocument'>;
      if (!getMockIncomingInvoice(payload.invoiceId)) throw new Error('Incoming invoice not found');
      const timestamp = new Date().toISOString();
      const document: MockIncomingInvoiceDocument = {
        id: `incoming-document-${mockIncomingInvoiceDocuments.length + 1}-${Math.random().toString(36).slice(2)}`,
        tenantId: MOCK_TENANT_ID,
        incomingInvoiceId: payload.invoiceId,
        originalFilename: payload.originalFilename,
        mimeType: payload.mimeType,
        byteLength: mockBase64ByteLength(payload.data),
        sha256: mockDigest(payload.data),
        reviewStatus: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      mockIncomingInvoiceDocumentData.set(document.id, payload.data);
      mockIncomingInvoiceDocuments.push(document);
      return document as IpcResult<K>;
    }

    case 'pro:downloadIncomingInvoiceDocument': {
      const { documentId } = args as IpcArgs<'pro:downloadIncomingInvoiceDocument'>;
      const document = mockIncomingInvoiceDocuments.find((row) => row.id === documentId);
      if (!document) throw new Error('Incoming invoice document not found');
      return {
        document,
        data: mockIncomingInvoiceDocumentData.get(documentId) ?? mockBase64('mock-dokument'),
      } as IpcResult<K>;
    }

    case 'pro:reviewIncomingInvoiceDocument': {
      const payload = args as IpcArgs<'pro:reviewIncomingInvoiceDocument'>;
      const document = mockIncomingInvoiceDocuments.find((row) => row.id === payload.documentId);
      if (!document) throw new Error('Incoming invoice document not found');
      document.reviewStatus = payload.reviewStatus;
      document.updatedAt = new Date().toISOString();
      return document as IpcResult<K>;
    }

    case 'pro:previewIncomingInvoiceAccounting': {
      const { invoiceId } = args as IpcArgs<'pro:previewIncomingInvoiceAccounting'>;
      return getMockInvoiceAccountingPreview('incoming_invoice', invoiceId) as IpcResult<K>;
    }

    case 'pro:postIncomingInvoiceAccounting': {
      const payload = args as IpcArgs<'pro:postIncomingInvoiceAccounting'>;
      const preview = getMockInvoiceAccountingPreview('incoming_invoice', payload.invoiceId);
      if (preview.status === 'unresolved') return preview as IpcResult<K>;
      const invoice = getMockIncomingInvoice(payload.invoiceId)!;
      const snapshot = postMockDocumentAccounting({
        documentType: 'incoming_invoice',
        documentId: invoice.id,
        documentNumber: invoice.number,
        documentDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        partyType: 'creditor',
        partyId: invoice.vendorId,
        amounts: { netAmount: invoice.netAmount, taxAmount: invoice.taxAmount, grossAmount: invoice.grossAmount },
      });
      invoice.accountingStatus = 'posted';
      invoice.accountingSnapshot = snapshot;
      invoice.updatedAt = new Date().toISOString();
      return { ...preview, status: 'ready' as const, snapshot, issues: [] } as IpcResult<K>;
    }

    case 'pro:previewOutgoingInvoiceAccounting': {
      const { invoiceId } = args as IpcArgs<'pro:previewOutgoingInvoiceAccounting'>;
      return getMockInvoiceAccountingPreview('outgoing_invoice', invoiceId) as IpcResult<K>;
    }

    case 'pro:postOutgoingInvoiceAccounting': {
      const payload = args as IpcArgs<'pro:postOutgoingInvoiceAccounting'>;
      const preview = getMockInvoiceAccountingPreview('outgoing_invoice', payload.invoiceId);
      if (preview.status === 'unresolved') return preview as IpcResult<K>;
      const invoice = getMockInvoiceById(payload.invoiceId)!;
      const grossAmount = round2(Number(invoice.amount) || 0);
      const netAmount = round2(grossAmount / 1.19);
      const snapshot = postMockDocumentAccounting({
        documentType: 'outgoing_invoice',
        documentId: invoice.id,
        documentNumber: invoice.number,
        documentDate: invoice.date,
        dueDate: invoice.dueDate,
        partyType: 'debtor',
        partyId: invoice.clientId ?? invoice.id,
        amounts: { netAmount, taxAmount: round2(grossAmount - netAmount), grossAmount },
      });
      mockOutgoingAccountingStatus.set(invoice.id, 'posted');
      return { ...preview, status: 'ready' as const, snapshot, issues: [] } as IpcResult<K>;
    }

    case 'pro:listOpenItems':
      return [...mockOpenItems].sort((a, b) => a.dueDate.localeCompare(b.dueDate)) as IpcResult<K>;

    case 'pro:allocateOpenItemPayment': {
      const { payment: input } = args as IpcArgs<'pro:allocateOpenItemPayment'>;
      const payment = input.paymentId
        ? mockOpenItemPayments.find((row) => row.id === input.paymentId)
        : mockOpenItemPayments.find((row) => row.sourceType === input.sourceType && row.sourceId === input.sourceId);
      if (input.paymentId && !payment) throw new Error('PAYMENT_NOT_FOUND: Die Zahlung ist nicht vorhanden.');
      if (payment && !input.paymentId) {
        const matching = payment.partyType === input.partyType
          && payment.amount === round2(input.amount)
          && payment.paymentDate === input.paymentDate
          && payment.bankAccountNumber === input.bankAccountNumber;
        if (!matching) throw new Error('PAYMENT_SOURCE_MISMATCH: Zur Quelle existiert bereits eine abweichende Zahlung.');
        return payment as IpcResult<K>;
      }
      const next: MockOpenItemPayment = payment ?? {
        id: `open-item-payment-${mockOpenItemPayments.length + 1}-${Math.random().toString(36).slice(2)}`,
        tenantId: MOCK_TENANT_ID,
        partyType: input.partyType,
        partyId: input.partyId,
        paymentDate: input.paymentDate,
        amount: round2(input.amount),
        bankAccountNumber: input.bankAccountNumber,
        method: input.method,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        allocatedAmount: 0,
        residualAmount: round2(input.amount),
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      const requested = round2(input.allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
      if (requested > next.residualAmount + 0.01) {
        throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL: Die Zuordnung übersteigt den offenen Betrag der Zahlung.');
      }
      mockOpenItemAllocationEvents.add(input.allocationEventId);
      applyMockPaymentAllocations(next, input.allocations);
      if (!payment) {
        const mapping = getMockAccountingMappings(getMockActiveChart());
        const entry = mockCreateJournalEntry({
          postingDate: input.paymentDate,
          bookingText: `Zahlung ${input.partyType === 'debtor' ? 'Debitor' : 'Kreditor'}`,
          reference: `${input.sourceType}:${input.sourceId}`,
          lines: input.partyType === 'debtor'
            ? [
              { accountNumber: input.bankAccountNumber, debitAmount: next.amount, creditAmount: 0, memo: 'Zahlungseingang' },
              { accountNumber: mapping.accounts_receivable, debitAmount: 0, creditAmount: next.amount, memo: 'Forderungsausgleich' },
            ]
            : [
              { accountNumber: mapping.accounts_payable, debitAmount: next.amount, creditAmount: 0, memo: 'Verbindlichkeitsausgleich' },
              { accountNumber: input.bankAccountNumber, debitAmount: 0, creditAmount: next.amount, memo: 'Zahlungsausgang' },
            ],
        });
        next.journalEntryId = entry.id;
        mockOpenItemPayments.unshift(next);
        if (input.sourceType === 'bank_transaction') {
          const openItem = input.allocations.map((allocation) => getMockOpenItem(allocation.openItemId)).find(Boolean);
          for (const account of accounts) {
            const transaction = account.transactions.find((row) => row.id === input.sourceId);
            if (!transaction) continue;
            transaction.status = 'booked';
            if (openItem && openItem.sourceType === 'outgoing_invoice') transaction.linkedInvoiceId = openItem.sourceId;
            break;
          }
        }
      }
      return next as IpcResult<K>;
    }

    case 'pro:allocateRemainingPayment': {
      const payload = args as IpcArgs<'pro:allocateRemainingPayment'>;
      const payment = mockOpenItemPayments.find((row) => row.id === payload.paymentId);
      if (!payment) throw new Error('PAYMENT_NOT_FOUND: Die Zahlung ist nicht vorhanden.');
      if (mockOpenItemAllocationEvents.has(payload.allocationEventId)) return payment as IpcResult<K>;
      const requested = round2(payload.allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
      if (requested > payment.residualAmount + 0.01) {
        throw new Error('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL: Die Zuordnung übersteigt den Restbetrag der Zahlung.');
      }
      mockOpenItemAllocationEvents.add(payload.allocationEventId);
      applyMockPaymentAllocations(payment, payload.allocations);
      return payment as IpcResult<K>;
    }

    case 'pro:reverseDocumentAccounting': {
      const payload = args as IpcArgs<'pro:reverseDocumentAccounting'>;
      const status = payload.documentType === 'incoming_invoice'
        ? getMockIncomingInvoice(payload.documentId)?.accountingStatus
        : getMockOutgoingAccountingStatus(payload.documentId);
      if (status !== 'posted') throw new Error('DOCUMENT_NOT_POSTED: Nur gebuchte Belege können storniert werden.');
      const entryId = mockPostedDocumentEntries.get(`${payload.documentType}:${payload.documentId}`);
      const entry = entryId ? mockJournalEntries.find((row) => row.id === entryId) : undefined;
      if (!entry) throw new Error('DOCUMENT_NOT_POSTED: Zum Beleg liegt keine Journalbuchung vor.');
      if (entry.status === 'reversed') throw new Error('DOCUMENT_ALREADY_REVERSED: Der Beleg wurde bereits storniert.');
      const reversal = mockCreateJournalEntry({
        postingDate: payload.postingDate ?? new Date().toISOString().slice(0, 10),
        documentDate: entry.documentDate,
        bookingText: `Storno: ${entry.bookingText}`,
        reference: payload.reason,
        lines: entry.lines.map((line) => ({
          accountNumber: line.accountNumber,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          memo: line.memo,
        })),
      });
      entry.status = 'reversed';
      entry.reversedEntryId = reversal.id;
      if (payload.documentType === 'incoming_invoice') {
        const invoice = getMockIncomingInvoice(payload.documentId);
        if (invoice) {
          invoice.accountingStatus = 'reversed';
          invoice.status = 'cancelled';
          invoice.updatedAt = new Date().toISOString();
        }
      } else {
        mockOutgoingAccountingStatus.set(payload.documentId, 'reversed');
      }
      for (const item of mockOpenItems) {
        if (item.sourceType !== payload.documentType || item.sourceId !== payload.documentId) continue;
        item.status = 'unresolved';
        item.residualAmount = 0;
        item.updatedAt = new Date().toISOString();
      }
      return { ok: true, reversalEntryId: reversal.id } as IpcResult<K>;
    }

    case 'pro:previewAccountingBackfill': {
      const chart = getMockActiveChart();
      const policy = getMockAccountingPolicy();
      const candidates: IpcResult<'pro:previewAccountingBackfill'>['candidates'] = [];
      for (const invoice of invoices) {
        if (invoice.status === 'draft' || invoice.status === 'cancelled') continue;
        if (getMockOutgoingAccountingStatus(invoice.id) !== 'unposted') continue;
        const grossAmount = round2(Number(invoice.amount) || 0);
        const preview = getMockInvoiceAccountingPreview('outgoing_invoice', invoice.id);
        candidates.push({
          sourceType: 'outgoing_invoice',
          sourceId: invoice.id,
          status: preview.status,
          reason: preview.reason,
          sourceVersion: mockDigest({ documentId: invoice.id, number: invoice.number, grossAmount }),
          snapshot: preview.snapshot,
        });
      }
      for (const invoice of mockIncomingInvoices) {
        if (invoice.status === 'draft' || invoice.status === 'cancelled') continue;
        if (invoice.accountingStatus !== 'unposted') continue;
        const preview = getMockInvoiceAccountingPreview('incoming_invoice', invoice.id);
        candidates.push({
          sourceType: 'incoming_invoice',
          sourceId: invoice.id,
          status: preview.status,
          reason: preview.reason,
          sourceVersion: mockDigest({ documentId: invoice.id, number: invoice.number, grossAmount: invoice.grossAmount }),
          snapshot: preview.snapshot,
        });
      }
      for (const transaction of getAllTransactions()) {
        candidates.push({
          sourceType: 'legacy_transaction',
          sourceId: transaction.id,
          status: 'unresolved',
          reason: 'Bankumsatz erfordert eine explizite Konten- und Nachweisprüfung.',
          sourceVersion: mockDigest({ transactionId: transaction.id, date: transaction.date, amount: transaction.amount }),
          snapshot: { id: transaction.id, counterparty: transaction.counterparty, amount: transaction.amount },
        });
      }
      const confirmationHash = mockDigest({ chart, vatMethod: policy.vatMethod, candidates });
      const runId = `backfill-run-${mockBackfillRuns.size + 1}-${Math.random().toString(36).slice(2)}`;
      mockBackfillRuns.set(runId, { confirmationHash, status: 'preview', candidates });
      return {
        runId,
        status: 'preview',
        candidates,
        readyCount: candidates.filter((candidate) => candidate.status === 'ready').length,
        unresolvedCount: candidates.filter((candidate) => candidate.status === 'unresolved').length,
        confirmationHash,
      } as IpcResult<K>;
    }

    case 'pro:confirmAccountingBackfill': {
      const payload = args as IpcArgs<'pro:confirmAccountingBackfill'>;
      const run = mockBackfillRuns.get(payload.runId);
      if (!run) throw new Error('BACKFILL_RUN_NOT_FOUND: Der Nachbuchungslauf ist nicht vorhanden.');
      if (run.status === 'completed' && run.result) return run.result as IpcResult<K>;
      if (run.confirmationHash !== payload.confirmationHash) {
        throw new Error('BACKFILL_CONFIRMATION_HASH_MISMATCH: Der Bestätigungshash passt nicht zum Vorschau-Lauf.');
      }
      let postedCount = 0;
      let unresolvedCount = 0;
      for (const candidate of run.candidates) {
        if (candidate.status !== 'ready') {
          unresolvedCount += 1;
          continue;
        }
        if (candidate.sourceType === 'incoming_invoice') {
          const invoice = getMockIncomingInvoice(candidate.sourceId);
          if (!invoice) {
            unresolvedCount += 1;
            continue;
          }
          const snapshot = postMockDocumentAccounting({
            documentType: 'incoming_invoice',
            documentId: invoice.id,
            documentNumber: invoice.number,
            documentDate: invoice.invoiceDate,
            dueDate: invoice.dueDate,
            partyType: 'creditor',
            partyId: invoice.vendorId,
            amounts: { netAmount: invoice.netAmount, taxAmount: invoice.taxAmount, grossAmount: invoice.grossAmount },
          });
          invoice.accountingStatus = 'posted';
          invoice.accountingSnapshot = snapshot;
          invoice.updatedAt = new Date().toISOString();
          postedCount += 1;
          continue;
        }
        const invoice = getMockInvoiceById(candidate.sourceId);
        if (!invoice) {
          unresolvedCount += 1;
          continue;
        }
        const grossAmount = round2(Number(invoice.amount) || 0);
        const netAmount = round2(grossAmount / 1.19);
        postMockDocumentAccounting({
          documentType: 'outgoing_invoice',
          documentId: invoice.id,
          documentNumber: invoice.number,
          documentDate: invoice.date,
          dueDate: invoice.dueDate,
          partyType: 'debtor',
          partyId: invoice.clientId ?? invoice.id,
          amounts: { netAmount, taxAmount: round2(grossAmount - netAmount), grossAmount },
        });
        mockOutgoingAccountingStatus.set(invoice.id, 'posted');
        postedCount += 1;
      }
      const result: IpcResult<'pro:confirmAccountingBackfill'> = {
        runId: payload.runId,
        postedCount,
        unresolvedCount,
        status: 'completed',
      };
      mockBackfillRuns.set(payload.runId, { ...run, status: 'completed', result });
      return result as IpcResult<K>;
    }

    case 'pro:postAccountingSource': {
      const { source } = args as IpcArgs<'pro:postAccountingSource'>;
      const idempotencyKey = `${source.sourceType}:${source.sourceId}:${source.sourceRevision}`;
      const existingRun = mockAccountingSourceRuns.find((run) => run.idempotencyKey === idempotencyKey);
      if (existingRun) return { status: 'duplicate', sourceRun: existingRun, errors: [], idempotencyKey } as IpcResult<K>;
      const debit = round2(source.lines.reduce((sum, line) => sum + line.debitAmount, 0));
      const credit = round2(source.lines.reduce((sum, line) => sum + line.creditAmount, 0));
      const errors: IpcResult<'pro:postAccountingSource'>['errors'] = [];
      if (!source.lines.length) {
        errors.push({ code: 'INVALID_AMOUNT', message: 'Mindestens eine Journalzeile ist erforderlich.', field: 'source.lines', blocking: true });
      } else if (Math.abs(debit - credit) > 0.005) {
        errors.push({ code: 'UNBALANCED_ENTRY', message: 'Soll und Haben müssen centgenau übereinstimmen.', field: 'source.lines', blocking: true });
      }
      if (errors.length) {
        const run = mockRecordSourceRun({
          idempotencyKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          source,
          status: 'rejected',
          result: { status: 'rejected', errors },
        });
        return { status: 'rejected', sourceRun: run, errors, idempotencyKey } as IpcResult<K>;
      }
      const entry = mockCreateJournalEntry({
        postingDate: source.postingDate,
        documentDate: source.effectiveDate,
        bookingText: source.bookingText,
        reference: source.reference ?? idempotencyKey,
        lines: source.lines,
      });
      const run = mockRecordSourceRun({
        idempotencyKey,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        source,
        fact: { ...source, lines: source.lines },
        status: 'posted',
        result: { status: 'posted', entryId: entry.id },
        journalEntryId: entry.id,
      });
      return {
        status: 'posted',
        sourceRun: run,
        command: { kind: 'standalone', entry },
        errors: [],
        idempotencyKey,
      } as IpcResult<K>;
    }

    case 'pro:postAccountingCommand': {
      const payload = args as IpcArgs<'pro:postAccountingCommand'>;
      const source = payload.source;
      const idempotencyKey = `${source.sourceType}:${source.sourceId}:${source.sourceRevision}:${payload.kind}`;
      const existingRun = mockAccountingSourceRuns.find((run) => run.idempotencyKey === idempotencyKey);
      if (existingRun) return { status: 'duplicate', sourceRun: existingRun, errors: [], idempotencyKey } as IpcResult<K>;
      const domainFacts = payload.domainFacts && typeof payload.domainFacts === 'object' && !Array.isArray(payload.domainFacts)
        ? payload.domainFacts as Record<string, unknown>
        : {};
      const outcome = mockCommandOutcome(payload.kind, domainFacts);
      if (outcome.status === 'rejected') {
        const run = mockRecordSourceRun({
          idempotencyKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          source,
          status: 'rejected',
          result: { status: 'rejected', kind: payload.kind, ...outcome.result },
        });
        return { status: 'rejected', sourceRun: run, errors: outcome.errors, idempotencyKey } as IpcResult<K>;
      }
      if (outcome.status === 'noop') {
        const run = mockRecordSourceRun({
          idempotencyKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          source,
          status: 'noop',
          result: { status: 'noop', kind: payload.kind, ...outcome.result },
        });
        return { status: 'noop', sourceRun: run, errors: [], idempotencyKey } as IpcResult<K>;
      }
      const entry = mockCreateJournalEntry({
        postingDate: source.postingDate,
        documentDate: source.effectiveDate,
        bookingText: source.bookingText,
        reference: source.reference ?? idempotencyKey,
        lines: outcome.lines,
      });
      const run = mockRecordSourceRun({
        idempotencyKey,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        source,
        fact: { ...source, lines: outcome.lines },
        status: 'posted',
        result: { status: 'posted', kind: payload.kind, ...outcome.result },
        journalEntryId: entry.id,
      });
      return {
        status: 'posted',
        sourceRun: run,
        command: { kind: payload.kind, entry },
        errors: [],
        idempotencyKey,
      } as IpcResult<K>;
    }

    case 'pro:listAccountingSourceRuns':
      return [...mockAccountingSourceRuns]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) as IpcResult<K>;

    case 'pro:getAccountingSourceRun': {
      const { id } = args as IpcArgs<'pro:getAccountingSourceRun'>;
      return (mockAccountingSourceRuns.find((run) => run.id === id) ?? null) as IpcResult<K>;
    }

    case 'pro:getReportingReport': {
      const payload = args as IpcArgs<'pro:getReportingReport'>;
      return await buildMockReportingReport(payload.kind, payload) as IpcResult<K>;
    }

    case 'pro:listReportSnapshots': {
      const { reportType } = args as IpcArgs<'pro:listReportSnapshots'>;
      return [...mockReportSnapshots]
        .filter((row) => (reportType ? row.reportType === reportType : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) as IpcResult<K>;
    }

    case 'pro:saveReportSnapshot': {
      const payload = args as IpcArgs<'pro:saveReportSnapshot'>;
      const createdAt = new Date().toISOString();
      const snapshot: MockReportSnapshot = {
        id: `report-snapshot-${mockReportSnapshots.length + 1}-${Math.random().toString(36).slice(2)}`,
        reportType: payload.reportType,
        args: payload.args ?? {},
        payload: payload.payload,
        createdAt,
        sourceHash: mockDigest({ reportType: payload.reportType, args: payload.args ?? {}, createdAt }),
      };
      mockReportSnapshots.unshift(snapshot);
      return structuredClone(snapshot) as IpcResult<K>;
    }

    case 'pro:getReportMappingHealth': {
      const payload = args as IpcArgs<'pro:getReportMappingHealth'>;
      const statement = payload.statement ?? 'management-guv';
      const balances = await invoke(
        'pro:getLedgerBalances',
        (payload.asOfDate ? { asOfDate: payload.asOfDate } : {}) as IpcArgs<'pro:getLedgerBalances'>,
      );
      return {
        chart: payload.chart ?? getMockActiveChart(),
        unmapped: balances
          .map((balance) => balance.accountNumber)
          .filter((accountNumber) => !mockReportAccountIsCovered(accountNumber))
          .map((accountNumber) => ({ accountNumber, statement })),
      } as IpcResult<K>;
    }

    case 'pro:listReportMappingPositions': {
      const { statement } = args as IpcArgs<'pro:listReportMappingPositions'>;
      return mockReportCatalog[statement].map((entry) => ({
        key: entry.key,
        label: entry.label,
        kind: entry.kind,
        ...(entry.side ? { side: entry.side } : {}),
      })) as IpcResult<K>;
    }

    case 'pro:upsertReportMappingOverride': {
      const payload = args as IpcArgs<'pro:upsertReportMappingOverride'>;
      const catalogEntry = mockReportCatalog[payload.statement].find((entry) => entry.key === payload.position);
      if (!catalogEntry) throw new Error(`REPORT_MAPPING_POSITION_NOT_ALLOWED:${payload.position}`);
      if (payload.side && catalogEntry.side && payload.side !== catalogEntry.side) {
        throw new Error('REPORT_MAPPING_SIDE_INVALID: Die Seite gehört nicht zur gewählten Position.');
      }
      const index = mockReportMappingOverrides.findIndex(
        (row) => row.chart === payload.chart && row.accountNumber === payload.accountNumber
          && row.statement === payload.statement && row.asOfDate === payload.asOfDate,
      );
      const next = {
        chart: payload.chart,
        asOfDate: payload.asOfDate,
        accountNumber: payload.accountNumber,
        statement: payload.statement,
        position: payload.position,
        label: payload.label,
        side: payload.side,
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) mockReportMappingOverrides[index] = next;
      else mockReportMappingOverrides.push(next);
      return next as IpcResult<K>;
    }

    case 'pro:getOpenRouterVlmConfig':
      return {
        configured: true,
        model: 'google/gemini-3.7-flash',
        models: ['google/gemini-3.7-flash', 'openai/gpt-4o-mini'],
        maxDocumentBytes: 10 * 1024 * 1024,
        timeoutMs: 45_000,
      } as IpcResult<K>;

    case 'pro:analyzeTransactionDocument': {
      const payload = args as IpcArgs<'pro:analyzeTransactionDocument'>;
      const transaction = payload.transaction;
      const grossAmount = round2(Math.abs(transaction.amount));
      const netAmount = round2(grossAmount / 1.19);
      const taxAmount = round2(grossAmount - netAmount);
      const startedAt = new Date().toISOString();
      return {
        extraction: {
          documentType: 'invoice',
          issuer: transaction.counterparty || null,
          recipient: null,
          invoiceNumber: null,
          invoiceDate: transaction.date,
          servicePeriod: null,
          dueDate: null,
          currency: transaction.currency,
          netAmount,
          taxAmount,
          grossAmount,
          vatBreakdown: [{ rate: 19, netAmount, taxAmount }],
          iban: null,
          paymentReference: transaction.purpose || null,
          suggestedAccountNumber: transaction.suggestedAccountNumber ?? null,
          suggestedTaxCase: 'DE_STD_19',
          matchAssessment: {
            amountMatches: true,
            dateMatches: true,
            partyMatches: Boolean(transaction.counterparty),
            referenceMatches: Boolean(transaction.purpose),
            notes: ['Mock-Analyse: Werte stammen aus der Banktransaktion.'],
          },
          warnings: ['Mock-VLM: keine echte Dokumentenanalyse, kein OCR-Nachweis.'],
          evidence: [
            { field: 'counterparty', value: transaction.counterparty, page: 1, confidence: 0.6, quote: 'Mock-Beleg' },
            { field: 'grossAmount', value: grossAmount.toFixed(2), page: 1, confidence: 0.6 },
          ],
        },
        deterministicChecks: {
          amountMatches: true,
          currencyMatches: true,
          expectedAmount: grossAmount,
          extractedAmount: grossAmount,
          expectedCurrency: transaction.currency,
          extractedCurrency: transaction.currency,
        },
        metadata: {
          model: payload.model ?? 'google/gemini-3.7-flash',
          provider: 'mock',
          requestId: null,
          request: { method: 'POST' as const, endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
          timing: { startedAt, completedAt: new Date().toISOString(), durationMs: 1 },
          documentSha256: mockDigest(payload.document.data),
        },
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

export const createLiteMockInvoke = (): LiteIpcInvoke =>
  createMockInvoke('lite') as unknown as LiteIpcInvoke;

export const createProMockInvoke = () => createMockInvoke('pro');
