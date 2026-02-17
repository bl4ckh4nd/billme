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
} from '../types';
import { createBillmeApi } from './api';
import type { IpcArgs, IpcResult, IpcRouteKey } from './contract';
import {
  MOCK_ACCOUNTS,
  MOCK_ARTICLES,
  MOCK_CLIENTS,
  MOCK_INVOICES,
  MOCK_RECURRING_PROFILES,
  MOCK_SETTINGS,
} from '../data/mockData';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '../constants';
import { formatAddressMultiline } from '../utils/formatters';

const invoices: Invoice[] = structuredClone(MOCK_INVOICES);
const clients: Client[] = structuredClone(MOCK_CLIENTS);
const articles: Article[] = structuredClone(MOCK_ARTICLES);
const accounts: Account[] = structuredClone(MOCK_ACCOUNTS);
const recurringProfiles: RecurringProfile[] = structuredClone(MOCK_RECURRING_PROFILES);
let settings: AppSettings = structuredClone(MOCK_SETTINGS);

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

    case 'secrets:get':
      return null as IpcResult<K>;
    case 'secrets:set':
      return undefined as IpcResult<K>;
    case 'secrets:delete':
      return false as IpcResult<K>;

    case 'db:backup':
    case 'db:restore':
    case 'shell:openPath':
    case 'shell:openExportsDir':
    case 'shell:openExternal':
    case 'dialog:pickCsv':
    case 'finance:importPreview':
    case 'finance:importCommit':
      throw new Error('Backup/restore only available in Electron runtime');

    case 'window:minimize':
      return { ok: true } as IpcResult<K>;
    case 'window:toggleMaximize':
      mockIsMaximized = !mockIsMaximized;
      return { ok: true } as IpcResult<K>;
    case 'window:close':
      return { ok: true } as IpcResult<K>;
    case 'window:isMaximized':
      return { isMaximized: mockIsMaximized } as IpcResult<K>;

    default:
      throw new Error(`Unsupported IPC route in mock backend: ${String(key)}`);
  }
};

export const mockBackendApi = createBillmeApi(invoke);
