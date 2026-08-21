import { z } from 'zod';
import { createBillmeApi, type BillmeApi } from '@billme/desktop-contracts/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts/contract';
import { appSettingsSchema as desktopAppSettingsSchema } from '@billme/desktop-contracts/schemas';
import {
  clientSchema as serverClientSchema,
  createSingleTenantScope,
  invoiceSchema as serverInvoiceSchema,
  offerSchema as serverOfferSchema,
  recurringProfileSchema as serverRecurringProfileSchema,
  vatValidationResultSchema,
} from '@billme/server-core';
import {
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  formatAddressMultiline,
} from '@billme/server-core/services';
import {
  toDomainInvoice,
  toDomainOffer,
  toLegacyInvoice,
  toLegacyOffer,
} from '@billme/desktop-data/billingDomainCompat';

type ServerClientPayload = z.output<typeof serverClientSchema>;
type ServerInvoicePayload = z.output<typeof serverInvoiceSchema>;
type ServerOfferPayload = z.output<typeof serverOfferSchema>;
type ServerRecurringProfilePayload = z.output<typeof serverRecurringProfileSchema>;
type DesktopAppSettings = z.output<typeof desktopAppSettingsSchema>;

type LiteWebApiOptions = {
  baseUrl: string;
  token: string;
  onAuthFailure?: () => void;
  onRequestClose?: () => void;
};

export type LiteWebBillmeApi = BillmeApi & {
  validateVatId: (args: { countryCode: string; vatNumber: string }) => Promise<z.output<typeof vatValidationResultSchema>>;
};

type DesktopClient = IpcResult<'clients:list'>[number];
type DesktopRecurringProfile = IpcResult<'recurring:list'>[number];

const PRODUCT_PREFIX = '/api/v1/lite';
const LITE_SCOPE = createSingleTenantScope('default', 'lite');
const CLIENT_MUTATION_REASON = 'Updated in Billme Lite web shell';
const CLIENT_DELETE_REASON = 'Deleted in Billme Lite web shell';
const RECURRING_MUTATION_REASON = 'Updated recurring profile in Billme Lite web shell';
const RECURRING_DELETE_REASON = 'Deleted recurring profile in Billme Lite web shell';
const UNSUPPORTED_MESSAGE = 'Diese Funktion ist in Billme Lite im Browser noch nicht verfügbar.';

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');
const toIsoDate = (value: Date): string => value.toISOString().split('T')[0] ?? value.toISOString();

const addDays = (value: string, days: number): string => {
  if (!days) {
    return value;
  }
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return toIsoDate(next);
};

const parseResult = <K extends IpcRouteKey>(key: K, value: unknown): IpcResult<K> => {
  return ipcRoutes[key].result.parse(value) as IpcResult<K>;
};

const parseResponseError = (status: number, payload: unknown): Error => {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return new Error(payload.message);
  }
  return new Error(`Anfrage fehlgeschlagen (HTTP ${status}).`);
};

const toDesktopClient = (client: ServerClientPayload): DesktopClient => ({
  id: client.id,
  customerNumber: client.customerNumber,
  company: client.company,
  contactPerson: client.contactPerson,
  email: client.email,
  phone: client.phone,
  address: client.address,
  status: client.status,
  avatar: client.avatar,
  tags: client.tags,
  notes: client.notes,
  addresses: client.addresses,
  emails: client.emails,
  projects: client.projects,
  activities: client.activities,
});

const toDesktopRecurringProfile = (profile: ServerRecurringProfilePayload): DesktopRecurringProfile => ({
  id: profile.id,
  clientId: profile.clientId,
  active: profile.active,
  name: profile.name,
  interval: profile.interval,
  nextRun: profile.nextRun,
  lastRun: profile.lastRun,
  endDate: profile.endDate,
  amount: profile.amount,
  items: profile.items,
});

const buildDraftFromClient = async (
  kind: 'invoice' | 'offer',
  client: ServerClientPayload,
  settings: DesktopAppSettings | null,
  reserveNumber: () => Promise<{ reservationId: string; number: string }>,
): Promise<IpcResult<'documents:createFromClient'>> => {
  const billingAddress = chooseDefaultBillingAddress(client.addresses);
  const shippingAddress = client.addresses.find((address) => address.isDefaultShipping) ?? billingAddress ?? null;
  const billingEmail = chooseDefaultBillingEmail(client.emails);
  const activeProject =
    client.projects.find((project) => project.name === 'Allgemein' && project.status !== 'archived')
    ?? client.projects.find((project) => project.status !== 'archived')
    ?? client.projects[0];
  const reservation = await reserveNumber();
  const today = toIsoDate(new Date());

  return parseResult('documents:createFromClient', {
    id: crypto.randomUUID(),
    clientId: client.id,
    clientNumber: client.customerNumber,
    projectId: activeProject?.id,
    number: reservation.number,
    numberReservationId: reservation.reservationId,
    client: client.company,
    clientEmail: billingEmail?.email ?? client.email,
    clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : client.address,
    billingAddressJson: billingAddress ?? undefined,
    shippingAddressJson: shippingAddress ?? undefined,
    date: today,
    dueDate: kind === 'offer' ? today : addDays(today, settings?.legal.paymentTermsDays ?? 0),
    amount: 0,
    status: 'draft',
    items: [],
    payments: [],
    history: [],
  });
};

const serverEurReportSchema = z.object({
  taxYear: z.literal(2025),
  from: z.literal('2025-01-01'),
  to: z.literal('2025-12-31'),
  rows: z.array(z.object({
    id: z.string(),
    kennziffer: z.string().optional(),
    providerPath: z.string().optional(),
    label: z.string(),
    kind: z.enum(['income', 'expense', 'computed']),
    exportable: z.boolean(),
    sortOrder: z.number().int(),
    computedFromIds: z.array(z.string()).optional(),
    computedTerms: z.array(z.object({ id: z.string(), sign: z.union([z.literal(1), z.literal(-1)]) })).optional(),
    total: z.number(),
  })),
  summary: z.object({ incomeTotal: z.number(), expenseTotal: z.number(), surplus: z.number() }),
  unclassifiedCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  catalog: z.object({ id: z.string(), version: z.string(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), delivery: z.enum(['print-form-only', 'elster-ready']), elsterReady: z.boolean() }),
});

const serverEurItemSchema = z.object({
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string(),
  date: z.string(),
  amountGross: z.number(),
  amountNet: z.number(),
  flowType: z.enum(['income', 'expense']),
  counterparty: z.string(),
  purpose: z.string(),
  vatWarning: z.string().optional(),
  classification: z.object({
    id: z.string(), sourceType: z.enum(['transaction', 'invoice']), sourceId: z.string(), taxYear: z.literal(2025),
    eurLineId: z.string().optional(), excluded: z.boolean(), vatMode: z.enum(['none', 'default']), vatRate: z.number().optional(), note: z.string().optional(), updatedAt: z.string(),
  }).optional(),
});

const mapEurReport = (input: unknown): IpcResult<'eur:getReport'> => {
  const report = serverEurReportSchema.parse(input);
  return parseResult('eur:getReport', {
    ...report,
    rows: report.rows.map(({ id, ...row }) => ({ ...row, lineId: id })),
  });
};

const mapEurCsv = (report: IpcResult<'eur:getReport'>): string => {
  const escape = (value: string): string => value.includes(';') || value.includes('"') || value.includes('\n') ? `"${value.replaceAll('"', '""')}"` : value;
  const format = (value: number): string => (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2).replace('.', ',');
  const rows = report.rows.filter((row) => row.exportable).map((row) => [row.kennziffer ?? '', escape(row.label), format(row.total)].join(';'));
  return `\uFEFF${['Kennziffer;Bezeichnung;Betrag', ...rows].join('\n')}`;
};

export const createLiteWebBillmeApi = ({ baseUrl, token, onAuthFailure, onRequestClose }: LiteWebApiOptions): LiteWebBillmeApi => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  const requestJson = async <TSchema extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: TSchema,
    body?: unknown,
  ): Promise<z.output<TSchema>> => {
    const response = await fetch(`${normalizedBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      onAuthFailure?.();
    }
    if (!response.ok) {
      throw parseResponseError(response.status, payload);
    }
    return schema.parse(payload);
  };

  const requestNullableClient = async (id: string): Promise<ServerClientPayload | null> => {
    return requestJson('GET', `${PRODUCT_PREFIX}/clients/${encodeURIComponent(id)}`, serverClientSchema.nullable());
  };

  const requestNullableOffer = async (id: string): Promise<ServerOfferPayload | null> => {
    return requestJson('GET', `${PRODUCT_PREFIX}/offers/${encodeURIComponent(id)}`, serverOfferSchema.nullable());
  };

  const requestSettings = async (): Promise<DesktopAppSettings | null> => {
    return requestJson('GET', `${PRODUCT_PREFIX}/settings`, desktopAppSettingsSchema.nullable());
  };

  const reserveDocumentNumber = async (kind: 'invoice' | 'offer' | 'customer') => {
    return requestJson(
      'POST',
      `${PRODUCT_PREFIX}/numbers/reserve`,
      z.object({ reservationId: z.string().min(1), number: z.string().min(1) }),
      { kind },
    );
  };

  const unsupported = (detail?: string): never => {
    throw new Error(detail ?? UNSUPPORTED_MESSAGE);
  };

  const invoke = async <K extends IpcRouteKey>(key: K, rawArgs: IpcArgs<K>): Promise<IpcResult<K>> => {
    const args = ipcRoutes[key].args.parse(rawArgs) as IpcArgs<K>;

    switch (key) {
      case 'invoices:list': {
        const invoices = await requestJson('GET', `${PRODUCT_PREFIX}/invoices`, z.array(serverInvoiceSchema));
        return parseResult(key, invoices.map((invoice) => toLegacyInvoice(invoice)));
      }
      case 'invoices:upsert': {
        const parsed = args as IpcArgs<'invoices:upsert'>;
        const { tenantId: _tenantId, ...invoice } = toDomainInvoice(LITE_SCOPE, parsed.invoice);
        const saved = await requestJson(
          'POST',
          `${PRODUCT_PREFIX}/invoices`,
          serverInvoiceSchema,
          { reason: parsed.reason, invoice },
        );
        return parseResult(key, toLegacyInvoice(saved));
      }
      case 'invoices:delete': {
        const parsed = args as IpcArgs<'invoices:delete'>;
        const result = await requestJson(
          'DELETE',
          `${PRODUCT_PREFIX}/invoices/${encodeURIComponent(parsed.id)}`,
          z.object({ ok: z.literal(true) }),
          { reason: parsed.reason },
        );
        return parseResult(key, result);
      }
      case 'offers:list': {
        const offers = await requestJson('GET', `${PRODUCT_PREFIX}/offers`, z.array(serverOfferSchema));
        return parseResult(key, offers.map((offer) => toLegacyOffer(offer)));
      }
      case 'offers:upsert': {
        const parsed = args as IpcArgs<'offers:upsert'>;
        const { tenantId: _tenantId, ...offer } = toDomainOffer(LITE_SCOPE, parsed.offer);
        const saved = await requestJson(
          'POST',
          `${PRODUCT_PREFIX}/offers`,
          serverOfferSchema,
          { reason: parsed.reason, offer },
        );
        return parseResult(key, toLegacyOffer(saved));
      }
      case 'offers:delete': {
        const parsed = args as IpcArgs<'offers:delete'>;
        const result = await requestJson(
          'DELETE',
          `${PRODUCT_PREFIX}/offers/${encodeURIComponent(parsed.id)}`,
          z.object({ ok: z.literal(true) }),
          { reason: parsed.reason },
        );
        return parseResult(key, result);
      }
      case 'clients:list': {
        const clients = await requestJson('GET', `${PRODUCT_PREFIX}/clients`, z.array(serverClientSchema));
        return parseResult(key, clients.map((client) => toDesktopClient(client)));
      }
      case 'clients:upsert': {
        const parsed = args as IpcArgs<'clients:upsert'>;
        const saved = await requestJson(
          'POST',
          `${PRODUCT_PREFIX}/clients`,
          serverClientSchema,
          { reason: CLIENT_MUTATION_REASON, client: parsed.client },
        );
        return parseResult(key, toDesktopClient(saved));
      }
      case 'clients:delete': {
        const parsed = args as IpcArgs<'clients:delete'>;
        const result = await requestJson(
          'DELETE',
          `${PRODUCT_PREFIX}/clients/${encodeURIComponent(parsed.id)}`,
          z.object({ ok: z.literal(true) }),
          { reason: CLIENT_DELETE_REASON },
        );
        return parseResult(key, result);
      }
      case 'recurring:list': {
        const profiles = await requestJson('GET', `${PRODUCT_PREFIX}/recurring`, z.array(serverRecurringProfileSchema));
        return parseResult(key, profiles.map((profile) => toDesktopRecurringProfile(profile)));
      }
      case 'recurring:upsert': {
        const parsed = args as IpcArgs<'recurring:upsert'>;
        const saved = await requestJson(
          'POST',
          `${PRODUCT_PREFIX}/recurring`,
          serverRecurringProfileSchema,
          { reason: RECURRING_MUTATION_REASON, profile: parsed.profile },
        );
        return parseResult(key, toDesktopRecurringProfile(saved));
      }
      case 'recurring:delete': {
        const parsed = args as IpcArgs<'recurring:delete'>;
        const result = await requestJson(
          'DELETE',
          `${PRODUCT_PREFIX}/recurring/${encodeURIComponent(parsed.id)}`,
          z.object({ ok: z.literal(true) }),
          { reason: RECURRING_DELETE_REASON },
        );
        return parseResult(key, result);
      }
      case 'settings:get': {
        const settings = await requestSettings();
        return parseResult(key, settings);
      }
      case 'settings:set': {
        const parsed = args as IpcArgs<'settings:set'>;
        const result = await requestJson(
          'PUT',
          `${PRODUCT_PREFIX}/settings`,
          z.object({ ok: z.literal(true) }),
          { settings: parsed.settings },
        );
        return parseResult(key, result);
      }
      case 'numbers:reserve': {
        const parsed = args as IpcArgs<'numbers:reserve'>;
        const reservation = await reserveDocumentNumber(parsed.kind);
        return parseResult(key, reservation);
      }
      case 'numbers:release': {
        const parsed = args as IpcArgs<'numbers:release'>;
        const result = await requestJson(
          'POST',
          `${PRODUCT_PREFIX}/numbers/release`,
          z.object({ ok: z.literal(true) }),
          { reservationId: parsed.reservationId },
        );
        return parseResult(key, result);
      }
      case 'numbers:finalize': {
        const parsed = args as IpcArgs<'numbers:finalize'>;
        const result = await requestJson(
          'POST',
          `${PRODUCT_PREFIX}/numbers/finalize`,
          z.object({ ok: z.literal(true) }),
          { reservationId: parsed.reservationId, documentId: parsed.documentId },
        );
        return parseResult(key, result);
      }
      case 'documents:createFromClient': {
        const parsed = args as IpcArgs<'documents:createFromClient'>;
        const client = await requestNullableClient(parsed.clientId);
        if (!client) {
          throw new Error('Kunde nicht gefunden.');
        }
        const settings = await requestSettings();
        return buildDraftFromClient(parsed.kind, client, settings, () => reserveDocumentNumber(parsed.kind));
      }
      case 'documents:convertOfferToInvoice': {
        const parsed = args as IpcArgs<'documents:convertOfferToInvoice'>;
        const offer = await requestNullableOffer(parsed.offerId);
        if (!offer) {
          throw new Error('Angebot nicht gefunden.');
        }
        const settings = await requestSettings();
        const today = toIsoDate(new Date());
        const reservation = await reserveDocumentNumber('invoice');
        try {
          const createdInvoice = await requestJson(
            'POST',
            `${PRODUCT_PREFIX}/invoices`,
            serverInvoiceSchema,
            {
              reason: `Converted from offer ${offer.number}`,
              invoice: {
                kind: 'invoice' as const,
                id: crypto.randomUUID(),
                clientId: offer.clientId,
                clientNumber: offer.clientNumber,
                projectId: offer.projectId,
                number: reservation.number,
                client: offer.client,
                clientEmail: offer.clientEmail,
                clientAddress: offer.clientAddress,
                billingAddress: offer.billingAddress,
                shippingAddress: offer.shippingAddress,
                date: today,
                dueDate: addDays(today, settings?.legal.paymentTermsDays ?? 0),
                servicePeriod: offer.validUntil,
                amount: offer.amount,
                status: 'draft' as const,
                dunningLevel: 0,
                items: offer.items,
                payments: [],
                history: [
                  {
                    date: today,
                    action: `Erstellt aus Angebot ${offer.number}`,
                  },
                  ...(offer.history ?? []),
                ],
              },
            },
          );
          await requestJson(
            'POST',
            `${PRODUCT_PREFIX}/numbers/finalize`,
            z.object({ ok: z.literal(true) }),
            { reservationId: reservation.reservationId, documentId: createdInvoice.id },
          );
          return parseResult(key, toLegacyInvoice(createdInvoice));
        } catch (error) {
          await requestJson(
            'POST',
            `${PRODUCT_PREFIX}/numbers/release`,
            z.object({ ok: z.literal(true) }),
            { reservationId: reservation.reservationId },
          ).catch(() => undefined);
          throw error;
        }
      }
      case 'projects:list':
        return parseResult(key, []);
      case 'projects:get':
        return parseResult(key, null);
      case 'articles:list':
        return parseResult(key, []);
      case 'accounts:list':
        return parseResult(key, []);
      case 'templates:list':
        return parseResult(key, []);
      case 'templates:active':
        return parseResult(key, null);
      case 'audit:verify':
        return unsupported();
      case 'audit:exportCsv':
        return unsupported();
      case 'pdf:export':
        return unsupported('Der PDF-Export ist in Billme Lite im Browser noch nicht verfügbar.');
      case 'window:minimize':
        return parseResult(key, { ok: true as const });
      case 'window:toggleMaximize': {
        if (document.fullscreenElement) {
          await document.exitFullscreen().catch(() => undefined);
        } else if (typeof document.documentElement.requestFullscreen === 'function') {
          await document.documentElement.requestFullscreen().catch(() => undefined);
        }
        return parseResult(key, { ok: true as const });
      }
      case 'window:close':
        onRequestClose?.();
        return parseResult(key, { ok: true as const });
      case 'window:isMaximized':
        return parseResult(key, { isMaximized: Boolean(document.fullscreenElement) });
      case 'shell:openPath':
        return parseResult(key, { ok: true as const });
      case 'shell:openExportsDir':
        return parseResult(key, { ok: true as const });
      case 'shell:openExternal': {
        const parsed = args as IpcArgs<'shell:openExternal'>;
        window.open(parsed.url, '_blank', 'noopener,noreferrer');
        return parseResult(key, { ok: true as const });
      }
      case 'dialog:pickCsv':
        return parseResult(key, { path: null });
      case 'finance:importPreview':
      case 'finance:importCommit':
        return unsupported();
      case 'finance:listImportBatches':
        return parseResult(key, []);
      case 'finance:getImportBatchDetails':
      case 'finance:rollbackImportBatch':
        return unsupported();
      case 'eur:getReport':
        if ((args as IpcArgs<'eur:getReport'>).taxYear !== 2025) throw new Error('EÜR unterstützt ausschließlich das Steuerjahr 2025.');
        return mapEurReport(await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur`, serverEurReportSchema, {
          from: (args as IpcArgs<'eur:getReport'>).from ?? '2025-01-01',
          to: (args as IpcArgs<'eur:getReport'>).to ?? '2025-12-31',
        })) as IpcResult<K>;
      case 'eur:listItems': {
        const parsed = args as IpcArgs<'eur:listItems'>;
        if (parsed.taxYear !== 2025) throw new Error('EÜR unterstützt ausschließlich das Steuerjahr 2025.');
        const items = await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur/items`, z.array(serverEurItemSchema), {
          from: parsed.from ?? '2025-01-01',
          to: parsed.to ?? '2025-12-31',
        });
        return parseResult(key, items);
      }
      case 'eur:upsertClassification': {
        const parsed = args as IpcArgs<'eur:upsertClassification'>;
        if (parsed.taxYear !== 2025) throw new Error('EÜR unterstützt ausschließlich das Steuerjahr 2025.');
        const saved = await requestJson('PUT', `${PRODUCT_PREFIX}/reports/eur/classifications`, z.object({
          id: z.string(), sourceType: z.enum(['transaction', 'invoice']), sourceId: z.string(), taxYear: z.literal(2025), eurLineId: z.string().optional(), excluded: z.boolean(), vatMode: z.enum(['none', 'default']), vatRate: z.number().optional(), note: z.string().optional(), updatedAt: z.string(),
        }), parsed);
        return parseResult(key, saved);
      }
      case 'eur:upsertRule':
      case 'eur:deleteRule':
        return unsupported('Klassifizierungsregeln sind im Lite-Web derzeit nicht verfügbar.');
      case 'eur:exportCsv': {
        const parsed = args as IpcArgs<'eur:exportCsv'>;
        if (parsed.taxYear !== 2025) throw new Error('EÜR unterstützt ausschließlich das Steuerjahr 2025.');
        const report = mapEurReport(await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur`, serverEurReportSchema, {
          from: parsed.from ?? '2025-01-01',
          to: parsed.to ?? '2025-12-31',
        }));
        return parseResult(key, mapEurCsv(report));
      }
      case 'eur:exportPdf':
        return unsupported();
      case 'eur:listRules':
        return parseResult(key, []);
      case 'portal:health': {
        const parsed = args as IpcArgs<'portal:health'>;
        const target = normalizeBaseUrl(parsed.baseUrl);
        const response = await fetch(`${target}/health`).catch(() => null);
        let payload: unknown = null;
        if (response) {
          payload = await response.json().catch(() => null);
        }
        return parseResult(key, {
          ok: Boolean(response?.ok && payload && typeof payload === 'object' && 'ok' in payload ? payload.ok : response?.ok),
          ts:
            payload && typeof payload === 'object' && 'ts' in payload && typeof payload.ts === 'string'
              ? payload.ts
              : new Date().toISOString(),
        });
      }
      case 'portal:publishOffer':
      case 'portal:publishInvoice':
      case 'portal:syncOfferStatus':
      case 'portal:createCustomerAccessLink':
      case 'portal:rotateCustomerAccessLink':
        return unsupported();
      case 'secrets:get':
        return parseResult(key, null);
      case 'secrets:set':
        return unsupported('Die sichere Ablage von Zugangsdaten ist in Billme Lite im Browser nicht verfügbar.');
      case 'secrets:delete':
        return unsupported('Die sichere Ablage von Zugangsdaten ist in Billme Lite im Browser nicht verfügbar.');
      case 'secrets:has':
        return parseResult(key, false);
      case 'db:backup':
      case 'db:restore':
        return unsupported();
      case 'email:send':
      case 'email:testConfig':
        return parseResult(key, {
          success: false,
          error: 'Der E-Mail-Versand ist in Billme Lite im Browser noch nicht verfügbar.',
        });
      case 'transactions:list':
        return parseResult(key, []);
      case 'transactions:findMatches':
      case 'transactions:link':
      case 'transactions:unlink':
        return unsupported();
      case 'dunning:manualRun':
        return parseResult(key, {
          success: false,
          error: 'Mahnläufe können in Billme Lite im Browser noch nicht manuell gestartet werden.',
        });
      case 'dunning:getInvoiceStatus':
        return parseResult(key, {
          currentLevel: 0,
          daysOverdue: 0,
          totalFeesApplied: 0,
          history: [],
        });
      case 'recurring:manualRun':
        return parseResult(key, {
          success: false,
          error: 'Wiederkehrende Rechnungen können in Billme Lite im Browser noch nicht manuell gestartet werden.',
        });
      case 'updater:getStatus':
        return parseResult(key, { status: 'idle' });
      case 'updater:downloadUpdate':
      case 'updater:quitAndInstall':
        return parseResult(key, { ok: true as const });
      case 'projects:upsert':
      case 'projects:archive':
      case 'articles:upsert':
      case 'articles:delete':
      case 'accounts:upsert':
      case 'accounts:delete':
      case 'templates:upsert':
      case 'templates:delete':
      case 'templates:setActive':
        return unsupported();
      default:
        return unsupported();
    }
  };

  const api = createBillmeApi(invoke);
  return Object.assign(api, {
    validateVatId: (args: { countryCode: string; vatNumber: string }) => requestJson(
      'POST',
      `${PRODUCT_PREFIX}/tax/validate-vat-id`,
      vatValidationResultSchema,
      args,
    ),
  });
};
