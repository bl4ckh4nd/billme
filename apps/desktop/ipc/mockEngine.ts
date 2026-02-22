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
  if (!projects.some((p) => p.clientId === c.id && p.name === 'Allgemein' && !p.archivedAt)) {
    projects.push({
      id: `p_${Math.random().toString(36).slice(2)}`,
      clientId: c.id,
      code: 'PRJ-2026-001',
      name: 'Allgemein',
      status: 'active',
      budget: 0,
      startDate: new Date().toISOString().split('T')[0],
    });
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
  kind: 'invoice' | 'offer' | 'customer';
  number: string;
  counterValue: number;
  status: 'reserved' | 'released' | 'finalized';
  documentId: string | null;
};
const numberReservations = new Map<string, NumberReservation>();

const formatDocumentNumber = (
  kind: 'invoice' | 'offer' | 'customer',
  counterValue: number,
): string => {
  const prefixTemplate =
    kind === 'invoice'
      ? settings.numbers.invoicePrefix
      : kind === 'offer'
        ? settings.numbers.offerPrefix
        : settings.numbers.customerPrefix;
  const prefix = prefixTemplate.replace(/%Y/g, String(new Date().getFullYear()));
  const padLength = Math.max(
    1,
    Math.floor(
      kind === 'customer'
        ? settings.numbers.customerNumberLength || 4
        : settings.numbers.numberLength || 3,
    ),
  );
  return `${prefix}${String(counterValue).padStart(padLength, '0')}`;
};

const reserveNumber = (
  kind: 'invoice' | 'offer' | 'customer',
): { reservationId: string; number: string } => {
  const counterValue = Math.max(
    1,
    kind === 'invoice'
      ? settings.numbers.nextInvoiceNumber
      : kind === 'offer'
        ? settings.numbers.nextOfferNumber
        : settings.numbers.nextCustomerNumber,
  );
  const number = formatDocumentNumber(kind, counterValue);
  if (kind === 'invoice') {
    settings.numbers.nextInvoiceNumber = counterValue + 1;
  } else if (kind === 'offer') {
    settings.numbers.nextOfferNumber = counterValue + 1;
  } else {
    settings.numbers.nextCustomerNumber = counterValue + 1;
  }

  const reservationId = Math.random().toString(36).slice(2);
  numberReservations.set(reservationId, {
    id: reservationId,
    kind,
    number,
    counterValue,
    status: 'reserved',
    documentId: null,
  });

  return { reservationId, number };
};

const releaseNumber = (reservationId: string): { ok: true } => {
  const reservation = numberReservations.get(reservationId);
  if (!reservation || reservation.status !== 'reserved') {
    return { ok: true };
  }

  if (reservation.kind === 'invoice') {
    if (settings.numbers.nextInvoiceNumber === reservation.counterValue + 1) {
      settings.numbers.nextInvoiceNumber = Math.max(1, reservation.counterValue);
    }
  } else if (reservation.kind === 'offer') {
    if (settings.numbers.nextOfferNumber === reservation.counterValue + 1) {
      settings.numbers.nextOfferNumber = Math.max(1, reservation.counterValue);
    }
  } else if (settings.numbers.nextCustomerNumber === reservation.counterValue + 1) {
    settings.numbers.nextCustomerNumber = Math.max(1, reservation.counterValue);
  }

  reservation.status = 'released';
  return { ok: true };
};

const finalizeNumber = (reservationId: string, documentId: string): { ok: true } => {
  const reservation = numberReservations.get(reservationId);
  if (!reservation || reservation.status === 'finalized') {
    return { ok: true };
  }
  if (reservation.status !== 'reserved') {
    throw new Error(`Cannot finalize reservation in status "${reservation.status}"`);
  }
  reservation.status = 'finalized';
  reservation.documentId = documentId;
  return { ok: true };
};

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
      const trimmedCustomerNumber = normalized.customerNumber?.trim();
      if (trimmedCustomerNumber) {
        const conflict = clients.find(
          (c) => c.id !== normalized.id && c.customerNumber === trimmedCustomerNumber,
        );
        if (conflict) {
          throw new Error('Kundennummer bereits vergeben');
        }
        normalized.customerNumber = trimmedCustomerNumber;
      } else {
        const reservation = reserveNumber('customer');
        normalized.customerNumber = reservation.number;
        finalizeNumber(reservation.reservationId, normalized.id);
      }

      const idx = clients.findIndex((c) => c.id === normalized.id);
      if (idx >= 0) clients[idx] = normalized;
      else clients.unshift(normalized);
      return structuredClone(normalized) as IpcResult<K>;
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

      const defaultProject =
        projects.find((p) => p.clientId === clientId && p.name === 'Allgemein' && !p.archivedAt) ??
        (() => {
          const p: Project = {
            id: Math.random().toString(36).substr(2, 9),
            clientId,
            code: 'PRJ-2026-001',
            name: 'Allgemein',
            status: 'active',
            budget: 0,
            startDate: new Date().toISOString().split('T')[0],
          };
          projects.unshift(p);
          return p;
        })();

      const today = new Date().toISOString().split('T')[0];
      const billingAddress =
        (client.addresses ?? []).find((a: any) => a.isDefaultBilling) ??
        (client.addresses ?? [])[0] ??
        null;
      const shippingAddress =
        (client.addresses ?? []).find((a: any) => a.isDefaultShipping) ?? billingAddress ?? null;
      const billingEmail =
        (client.emails ?? []).find((e: any) => e.isDefaultBilling) ??
        (client.emails ?? []).find((e: any) => e.isDefaultGeneral) ??
        (client.emails ?? [])[0] ??
        null;
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
        date: today,
        dueDate: kind === 'offer' ? today : '',
        amount: 0,
        status: 'draft',
        items: [],
        payments: [],
        history: [],
      };

      return structuredClone(doc) as IpcResult<K>;
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
