import { z } from 'zod';
import { createBillmeApi, type BillmeApi } from '@billme/desktop-contracts/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts/contract';
import {
  appSettingsSchema as desktopAppSettingsSchema,
  templateSchema as desktopTemplateSchema,
} from '@billme/desktop-contracts/schemas';
import {
  clientSchema as serverClientSchema,
  createSingleTenantScope,
  invoiceSchema as serverInvoiceSchema,
  offerSchema as serverOfferSchema,
  recurringProfileSchema as serverRecurringProfileSchema,
} from '@billme/server-core';
import {
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  calculateInvoiceTaxSnapshot,
  ensureDefaultProjectForClient,
  formatAddressMultiline,
  resolveInvoiceTaxMode,
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
type DesktopTemplate = IpcResult<'templates:list'>[number];

type LiteWebApiOptions = {
  baseUrl: string;
  token: string;
  onAuthFailure?: () => void;
  onRequestClose?: () => void;
};

type DesktopClient = IpcResult<'clients:list'>[number];
type DesktopRecurringProfile = IpcResult<'recurring:list'>[number];

const PRODUCT_PREFIX = '/api/v1/lite';
const LITE_SCOPE = createSingleTenantScope('default', 'lite');
const CLIENT_MUTATION_REASON = 'Updated in Billme Lite';
const CLIENT_DELETE_REASON = 'Deleted in Billme Lite';
const RECURRING_MUTATION_REASON = 'Updated recurring profile in Billme Lite';
const RECURRING_DELETE_REASON = 'Deleted recurring profile in Billme Lite';
const UNSUPPORTED_MESSAGE = 'Not available in Billme Lite yet.';

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
  return new Error(`Request failed with status ${status}`);
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

const toDesktopTemplate = (template: {
  id: string;
  kind: 'invoice' | 'offer';
  name: string;
  createdAt: string;
  updatedAt: string;
  elements?: unknown;
}): DesktopTemplate =>
  desktopTemplateSchema.parse({
    id: template.id,
    kind: template.kind,
    name: template.name,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    elements: template.elements,
  });

const buildPrintUrl = (kind: 'invoice' | 'offer' | 'eur', params: Record<string, string>): string => {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('__print', '1');
  url.searchParams.set('__autoprint', '1');
  url.searchParams.set('kind', kind);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
};

const buildDraftFromClient = async (
  kind: 'invoice' | 'offer',
  client: ServerClientPayload,
  settings: DesktopAppSettings | null,
  reserveNumber: () => Promise<{ reservationId: string; number: string }>,
  ensureDefaultProject: (client: ServerClientPayload) => Promise<ServerClientPayload['projects'][number]>,
): Promise<IpcResult<'documents:createFromClient'>> => {
  const billingAddress = chooseDefaultBillingAddress(client.addresses);
  const shippingAddress = client.addresses.find((address) => address.isDefaultShipping) ?? billingAddress ?? null;
  const billingEmail = chooseDefaultBillingEmail(client.emails);
  const defaultProject = await ensureDefaultProject(client);
  const reservation = await reserveNumber();
  const today = toIsoDate(new Date());
  const taxSettings = settings ? { legal: settings.legal } : { legal: {} };
  const taxMode = resolveInvoiceTaxMode(undefined, taxSettings);

  const draft = parseResult('documents:createFromClient', {
    id: crypto.randomUUID(),
    clientId: client.id,
    clientNumber: client.customerNumber,
    projectId: defaultProject.id,
    number: reservation.number,
    numberReservationId: reservation.reservationId,
    client: client.company,
    clientEmail: billingEmail?.email ?? '',
    clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : '',
    billingAddressJson: billingAddress ?? undefined,
    shippingAddressJson: shippingAddress ?? undefined,
    taxMode,
    date: today,
    dueDate: kind === 'offer' ? today : '',
    amount: 0,
    status: 'draft',
    items: [],
    payments: [],
    history: [],
  });

  const taxSnapshot = calculateInvoiceTaxSnapshot(
    {
      items: draft.items,
      taxMode,
      taxMeta: draft.taxMeta,
    },
    taxSettings,
  );

  return parseResult('documents:createFromClient', {
    ...draft,
    taxMode,
    taxSnapshot,
    amount: taxSnapshot.grossAmount,
  });
};

const buildEmptyEurReport = (args: IpcArgs<'eur:getReport'>): IpcResult<'eur:getReport'> => {
  const from = args.from ?? `${args.taxYear}-01-01`;
  const to = args.to ?? `${args.taxYear}-12-31`;
  return parseResult('eur:getReport', {
    taxYear: args.taxYear,
    from,
    to,
    rows: [],
    summary: {
      incomeTotal: 0,
      expenseTotal: 0,
      surplus: 0,
    },
    unclassifiedCount: 0,
    warnings: [UNSUPPORTED_MESSAGE],
  });
};

export const createLiteWebBillmeApi = ({ baseUrl, token, onAuthFailure, onRequestClose }: LiteWebApiOptions): BillmeApi => {
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

  const ensureClientDefaultProject = async (initialClient: ServerClientPayload) => {
    let client = initialClient;
    const { project } = await ensureDefaultProjectForClient(
      {
        tx: {
          inTransaction<TResult>(work: () => TResult): TResult {
            return work();
          },
        },
        getActiveDefaultProjectForClient: (clientId) => {
          if (client.id !== clientId) {
            return null;
          }
          return client.projects.find((project) => project.name === 'Allgemein' && project.status !== 'archived') ?? null;
        },
        listProjectCodesByPrefix: async (prefix) => {
          const clients = await requestJson('GET', `${PRODUCT_PREFIX}/clients`, z.array(serverClientSchema));
          return clients.flatMap((entry) =>
            entry.projects
              .map((project) => project.code)
              .filter((code): code is string => typeof code === 'string' && code.startsWith(prefix)),
          );
        },
        saveProject: async (project) => {
          client = await requestJson('POST', `${PRODUCT_PREFIX}/clients`, serverClientSchema, {
            reason: CLIENT_MUTATION_REASON,
            client: {
              ...client,
              projects: [...client.projects.filter((entry) => entry.id !== project.id), project],
            },
          });
          return client.projects.find((entry) => entry.id === project.id) ?? project;
        },
      },
      {
        clientId: initialClient.id,
        createProjectId: () => crypto.randomUUID(),
      },
    );
    return project;
  };

  const requestSettings = async (): Promise<DesktopAppSettings | null> => {
    return requestJson('GET', `${PRODUCT_PREFIX}/settings`, desktopAppSettingsSchema.nullable());
  };

  const requestTemplates = async (kind?: 'invoice' | 'offer'): Promise<DesktopTemplate[]> => {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    const templateRecordSchema = z.object({
      id: z.string().min(1),
      kind: z.enum(['invoice', 'offer']),
      name: z.string().min(1),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
      elements: z.unknown(),
    });
    const rows = await requestJson('GET', `${PRODUCT_PREFIX}/templates${query}`, z.array(templateRecordSchema));
    return rows.map(toDesktopTemplate);
  };

  const requestActiveTemplate = async (kind: 'invoice' | 'offer'): Promise<DesktopTemplate | null> => {
    const templateRecordSchema = z.object({
      id: z.string().min(1),
      kind: z.enum(['invoice', 'offer']),
      name: z.string().min(1),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
      elements: z.unknown(),
    });
    const row = await requestJson(
      'GET',
      `${PRODUCT_PREFIX}/templates/active/${encodeURIComponent(kind)}`,
      templateRecordSchema.nullable(),
    );
    return row ? toDesktopTemplate(row) : null;
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
          throw new Error('Client not found');
        }
        const settings = await requestSettings();
        return buildDraftFromClient(parsed.kind, client, settings, () => reserveDocumentNumber(parsed.kind), ensureClientDefaultProject);
      }
      case 'documents:convertOfferToInvoice': {
        const parsed = args as IpcArgs<'documents:convertOfferToInvoice'>;
        const offer = await requestNullableOffer(parsed.offerId);
        if (!offer) {
          throw new Error('Offer not found');
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
      case 'templates:list': {
        const parsed = args as IpcArgs<'templates:list'>;
        return parseResult(key, await requestTemplates(parsed.kind));
      }
      case 'templates:active': {
        const parsed = args as IpcArgs<'templates:active'>;
        return parseResult(key, await requestActiveTemplate(parsed.kind));
      }
      case 'audit:verify':
        return unsupported();
      case 'audit:exportCsv':
        return unsupported();
      case 'pdf:export': {
        const parsed = args as IpcArgs<'pdf:export'>;
        return parseResult(key, { path: buildPrintUrl(parsed.kind, { id: parsed.id }) });
      }
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
      case 'shell:openPath': {
        const parsed = args as IpcArgs<'shell:openPath'>;
        if (/^(blob:|data:|https?:)/.test(parsed.path)) {
          window.open(parsed.path, '_blank', 'noopener,noreferrer');
        }
        return parseResult(key, { ok: true as const });
      }
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
        return buildEmptyEurReport(args as IpcArgs<'eur:getReport'>) as IpcResult<K>;
      case 'eur:listItems':
        return parseResult(key, []);
      case 'eur:upsertClassification':
      case 'eur:upsertRule':
      case 'eur:deleteRule':
        return unsupported();
      case 'eur:exportCsv':
        return parseResult(key, '');
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
        return unsupported('Secure secret storage is not available in Billme Lite.');
      case 'secrets:delete':
        return unsupported('Secure secret storage is not available in Billme Lite.');
      case 'secrets:has':
        return parseResult(key, false);
      case 'db:backup':
      case 'db:restore':
        return unsupported();
      case 'email:send':
      case 'email:testConfig':
        return parseResult(key, {
          success: false,
          error: 'Email sending is not available in Billme Lite yet.',
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
          error: 'Manual dunning runs are not available in Billme Lite yet.',
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
          error: 'Manual recurring runs are not available in Billme Lite yet.',
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
      case 'templates:upsert': {
        const parsed = args as IpcArgs<'templates:upsert'>;
        const templateRecordSchema = z.object({
          id: z.string().min(1),
          kind: z.enum(['invoice', 'offer']),
          name: z.string().min(1),
          createdAt: z.string().min(1),
          updatedAt: z.string().min(1),
          elements: z.unknown(),
        });
        const saved = await requestJson(
          'POST',
          `${PRODUCT_PREFIX}/templates`,
          templateRecordSchema,
          { template: parsed.template },
        );
        return parseResult(key, toDesktopTemplate(saved));
      }
      case 'templates:delete':
        return unsupported();
      case 'templates:setActive': {
        const parsed = args as IpcArgs<'templates:setActive'>;
        const result = await requestJson(
          'PUT',
          `${PRODUCT_PREFIX}/templates/active`,
          z.object({ ok: z.literal(true) }),
          { kind: parsed.kind, templateId: parsed.templateId },
        );
        return parseResult(key, result);
      }
      default:
        return unsupported();
    }
  };

  return createBillmeApi(invoke);
};
