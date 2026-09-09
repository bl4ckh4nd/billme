import { z } from 'zod';
import { isSupportedEurTaxYear, SUPPORTED_EUR_TAX_YEARS } from '@billme/accounting-shared';
import { createBillmeApi, type BillmeApi, type IpcInvoke } from '@billme/desktop-contracts/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts/contract';
import { taxFilingRoutes } from '@billme/desktop-contracts/taxFiling';
import type { EmbeddedConnection } from '@billme/desktop-contracts/embeddedConnection';
import {
  accountSchema,
  appSettingsSchema as desktopAppSettingsSchema,
  articleSchema,
  eurRuleSchema,
  listTemplatesParamsSchema,
  projectSchema,
  setActiveTemplatePayloadSchema,
  templateKindSchema,
  templateSchema,
  transactionSchema as desktopTransactionSchema,
  upsertAccountPayloadSchema,
  upsertArticlePayloadSchema,
  upsertTemplatePayloadSchema,
} from '@billme/desktop-contracts/schemas';
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
} from '@billme/desktop-data/billingDocumentMapping';
import { isNativeElectronRoute, isServerOwnedRoute } from './serverRouteClassification';

type ServerClientPayload = z.output<typeof serverClientSchema>;
type ServerInvoicePayload = z.output<typeof serverInvoiceSchema>;
type ServerRecurringProfilePayload = z.output<typeof serverRecurringProfileSchema>;
type DesktopAppSettings = z.output<typeof desktopAppSettingsSchema>;

export type LiteHttpAuth =
  | { mode: 'bearer'; token: string }
  | { mode: 'embedded'; token: string };

export type LiteHttpBillmeApi = BillmeApi & {
  validateVatId: (args: { countryCode: string; vatNumber: string }) => Promise<z.output<typeof vatValidationResultSchema>>;
};

export type LiteHttpApiOptions = {
  baseUrl?: string;
  auth?: LiteHttpAuth;
  embeddedConnectionResolver?: () => Promise<EmbeddedConnection | null>;
  fallback?: IpcInvoke;
  onAuthFailure?: () => void;
  /** Test seam for asserting fail-closed behavior on unknown contract keys. */
  onInvoke?: (invoke: IpcInvoke) => void;
  fetch?: typeof globalThis.fetch;
};

type DesktopClient = IpcResult<'clients:list'>[number];
type DesktopRecurringProfile = IpcResult<'recurring:list'>[number];
type HttpQuery = Record<string, string | number | boolean | null | undefined>;

const PRODUCT_PREFIX = '/api/v1/lite';
const LITE_SCOPE = createSingleTenantScope('default', 'lite');
const CLIENT_MUTATION_REASON = 'Updated in Billme Lite web shell';
const CLIENT_DELETE_REASON = 'Deleted in Billme Lite web shell';
const RECURRING_MUTATION_REASON = 'Updated recurring profile in Billme Lite web shell';
const RECURRING_DELETE_REASON = 'Deleted recurring profile in Billme Lite web shell';
const TRANSACTION_LINK_REASON = 'Zahlung automatisch mit Rechnung verknüpft';
const TRANSACTION_UNLINK_REASON = 'Zahlungsverknüpfung aufgehoben';
const EUR_RULE_MUTATION_REASON = 'EÜR-Klassifikationsregel gespeichert';
const EUR_RULE_DELETE_REASON = 'EÜR-Klassifikationsregel gelöscht';

const HTTP_ROUTE_KEYS = new Set<IpcRouteKey>([
  'invoices:list', 'invoices:upsert', 'invoices:delete',
  'offers:list', 'offers:upsert', 'offers:delete',
  'clients:list', 'clients:upsert', 'clients:delete',
  'projects:list', 'projects:get', 'projects:upsert', 'projects:archive',
  'articles:list', 'articles:upsert', 'articles:delete',
  'accounts:list', 'accounts:upsert', 'accounts:delete',
  'templates:list', 'templates:active', 'templates:upsert', 'templates:delete', 'templates:setActive',
  'taxFiling:getStatus', 'taxFiling:listRecords', 'taxFiling:installCertificate', 'taxFiling:removeCertificate', 'taxFiling:validate', 'taxFiling:export', 'taxFiling:submit',
  'recurring:list', 'recurring:upsert', 'recurring:delete',
  'settings:get', 'settings:set',
  'numbers:reserve', 'numbers:release', 'numbers:finalize',
  'documents:createFromClient', 'documents:convertOfferToInvoice', 'documents:chainCreate', 'documents:chainList',
  'eur:getReport', 'eur:listItems', 'eur:upsertClassification', 'eur:exportCsv',
  'audit:verify', 'audit:exportCsv', 'eur:listRules', 'eur:upsertRule', 'eur:deleteRule',
  'portal:health', 'portal:publishOffer', 'portal:publishInvoice', 'portal:syncOfferStatus',
  'portal:createCustomerAccessLink', 'portal:rotateCustomerAccessLink',
  'email:send', 'email:testConfig', 'dunning:manualRun', 'dunning:getInvoiceStatus',
  'recurring:manualRun',
]);

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

const eurTaxYearSchema = z.union([
  z.literal(SUPPORTED_EUR_TAX_YEARS[0]),
  z.literal(SUPPORTED_EUR_TAX_YEARS[1]),
]);

const serverEurClassificationSchema = z.object({
  id: z.string(),
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string(),
  taxYear: eurTaxYearSchema,
  eurLineId: z.string().optional(),
  excluded: z.boolean(),
  vatMode: z.enum(['none', 'default']),
  vatRate: z.number().optional(),
  note: z.string().optional(),
  updatedAt: z.string(),
});

const serverEurReportSchema = z.object({
  taxYear: eurTaxYearSchema,
  from: z.string(),
  to: z.string(),
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
  accountId: z.string().optional(),
  linkedViaInvoice: z.boolean().optional(),
  counterparty: z.string(),
  purpose: z.string(),
  vatWarning: z.string().optional(),
  suggestedLineId: z.string().optional(),
  suggestionReason: z.string().optional(),
  suggestionLayer: z.enum(['rule', 'counterparty', 'bayes', 'keyword']).optional(),
  classification: serverEurClassificationSchema.optional(),
  line: z.object({
    id: z.string(),
    taxYear: z.number().int(),
    kennziffer: z.string().optional(),
    label: z.string(),
    kind: z.enum(['income', 'expense', 'computed']),
    exportable: z.boolean(),
    sortOrder: z.number().int(),
    computedFromIds: z.array(z.string()),
    sourceVersion: z.string(),
  }).optional(),
});

const serverTransactionSchema = desktopTransactionSchema.extend({ accountId: z.string() });
const serverTransactionMatchesSchema = z.object({
  transaction: serverTransactionSchema,
  suggestions: z.array(z.object({
    invoice: serverInvoiceSchema,
    confidence: z.enum(['high', 'medium', 'low']),
    matchReasons: z.array(z.string()),
    amountDiff: z.number(),
  })),
});

const eurReportQuery = (args: { taxYear: number; from?: string; to?: string }): { taxYear: number; from: string; to: string } => {
  if (!isSupportedEurTaxYear(args.taxYear)) throw new RangeError(`EUR_CATALOG_UNAVAILABLE:${args.taxYear}`);
  const from = args.from ?? `${args.taxYear}-01-01`;
  const to = args.to ?? `${args.taxYear}-12-31`;
  if (from !== `${args.taxYear}-01-01` || to !== `${args.taxYear}-12-31`) {
    throw new RangeError(`EUR_RANGE_${args.taxYear}_REQUIRED`);
  }
  return { taxYear: args.taxYear, from, to };
};

const mapEurReport = (input: unknown, expected: { taxYear: number; from: string; to: string }): IpcResult<'eur:getReport'> => {
  const report = serverEurReportSchema.parse(input);
  if (report.taxYear !== expected.taxYear || report.from !== expected.from || report.to !== expected.to) {
    throw new Error(`EÜR-Antwort gehört nicht zum angeforderten Steuerjahr ${expected.taxYear}.`);
  }
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

export const createLiteHttpBillmeApi = ({
  baseUrl,
  auth,
  embeddedConnectionResolver,
  fallback,
  onAuthFailure,
  onInvoke,
  fetch: fetchImpl = globalThis.fetch,
}: LiteHttpApiOptions): LiteHttpBillmeApi => {
  if (!fetchImpl) {
    throw new Error('Für den Lite-HTTP-Client ist keine Fetch-Implementierung verfügbar.');
  }
  if (!embeddedConnectionResolver && (!baseUrl || !auth)) {
    throw new Error('Für den Lite-HTTP-Client fehlen Base-URL und Authentifizierung.');
  }

  const resolveHttpConnection = async (): Promise<{ baseUrl: string; auth: LiteHttpAuth } | null> => {
    if (embeddedConnectionResolver) {
      const connection = await embeddedConnectionResolver();
      return connection
        ? { baseUrl: connection.baseUrl, auth: { mode: 'embedded', token: connection.token } }
        : null;
    }
    return { baseUrl: baseUrl!, auth: auth! };
  };

  const requestJson = async <TSchema extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: TSchema,
    body?: unknown,
    query?: HttpQuery,
  ): Promise<z.output<TSchema>> => {
    const connection = await resolveHttpConnection();
    if (!connection) {
      throw new Error('Der lokale Billme-Server ist noch nicht verfügbar.');
    }
    const authHeaders: Record<string, string> = connection.auth.mode === 'embedded'
      ? { 'x-billme-local-token': connection.auth.token }
      : { authorization: `Bearer ${connection.auth.token}` };
    const queryString = query
      ? Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&')
      : '';
    const targetUrl = `${normalizeBaseUrl(connection.baseUrl)}${path}${queryString ? `${path.includes('?') ? '&' : '?'}${queryString}` : ''}`;
    const hasBody = body !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase());
    const requestInit: RequestInit = {
      method,
      headers: {
        ...authHeaders,
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
    };
    if (hasBody) {
      requestInit.body = JSON.stringify(body);
    }
    const response = await fetchImpl(targetUrl, requestInit);

    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      onAuthFailure?.();
    }
    if (!response.ok) {
      throw parseResponseError(response.status, payload);
    }
    return schema.parse(payload);
  };

  const requestText = async (method: string, path: string): Promise<string> => {
    const connection = await resolveHttpConnection();
    if (!connection) throw new Error('Der lokale Billme-Server ist noch nicht verfügbar.');
    const authHeaders: Record<string, string> = connection.auth.mode === 'embedded'
      ? { 'x-billme-local-token': connection.auth.token }
      : { authorization: `Bearer ${connection.auth.token}` };
    const response = await fetchImpl(`${normalizeBaseUrl(connection.baseUrl)}${path}`, { method, headers: authHeaders });
    const payload = await response.text();
    if (response.status === 401) onAuthFailure?.();
    if (!response.ok) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(payload); } catch { /* keep text fallback */ }
      throw parseResponseError(response.status, parsed ?? payload);
    }
    return payload;
  };

  const requestNullableClient = async (id: string): Promise<ServerClientPayload | null> => {
    return requestJson('GET', `${PRODUCT_PREFIX}/clients/${encodeURIComponent(id)}`, serverClientSchema.nullable());
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

  const invoke = async <K extends IpcRouteKey>(key: K, rawArgs: IpcArgs<K>): Promise<IpcResult<K>> => {
    if (!Object.prototype.hasOwnProperty.call(ipcRoutes, key)) {
      throw new Error(`Die Lite-HTTP-Laufzeit unterstützt die IPC-Route ${String(key)} nicht.`);
    }
    const args = ipcRoutes[key].args.parse(rawArgs) as IpcArgs<K>;

    if (embeddedConnectionResolver && isServerOwnedRoute(key)) {
      const connection = await resolveHttpConnection();
      if (!connection) {
        if (fallback) return fallback(key, args);
        throw new Error('Der lokale Billme-Server ist noch nicht verfügbar.');
      }
    }

    switch (key) {
      case 'invoices:list': {
        const invoices = await requestJson('GET', `${PRODUCT_PREFIX}/invoices`, z.array(serverInvoiceSchema));
        return parseResult(key, invoices.map((invoice) => toLegacyInvoice(invoice)));
      }
      case 'invoices:upsert': {
        const parsed = args as IpcArgs<'invoices:upsert'>;
        const { tenantId: _tenantId, ...invoice } = toDomainInvoice(LITE_SCOPE, parsed.invoice);
        const saved = await requestJson('POST', `${PRODUCT_PREFIX}/invoices`, serverInvoiceSchema, { reason: parsed.reason, invoice });
        return parseResult(key, toLegacyInvoice(saved));
      }
      case 'invoices:delete': {
        const parsed = args as IpcArgs<'invoices:delete'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/invoices/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }), { reason: parsed.reason });
        return parseResult(key, result);
      }
      case 'offers:list': {
        const offers = await requestJson('GET', `${PRODUCT_PREFIX}/offers`, z.array(serverOfferSchema));
        return parseResult(key, offers.map((offer) => toLegacyOffer(offer)));
      }
      case 'offers:upsert': {
        const parsed = args as IpcArgs<'offers:upsert'>;
        const { tenantId: _tenantId, ...offer } = toDomainOffer(LITE_SCOPE, parsed.offer);
        const saved = await requestJson('POST', `${PRODUCT_PREFIX}/offers`, serverOfferSchema, { reason: parsed.reason, offer });
        return parseResult(key, toLegacyOffer(saved));
      }
      case 'offers:delete': {
        const parsed = args as IpcArgs<'offers:delete'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/offers/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }), { reason: parsed.reason });
        return parseResult(key, result);
      }
      case 'clients:list': {
        const clients = await requestJson('GET', `${PRODUCT_PREFIX}/clients`, z.array(serverClientSchema));
        return parseResult(key, clients.map((client) => toDesktopClient(client)));
      }
      case 'clients:upsert': {
        const parsed = args as IpcArgs<'clients:upsert'>;
        const saved = await requestJson('POST', `${PRODUCT_PREFIX}/clients`, serverClientSchema, { reason: CLIENT_MUTATION_REASON, client: parsed.client });
        return parseResult(key, toDesktopClient(saved));
      }
      case 'clients:delete': {
        const parsed = args as IpcArgs<'clients:delete'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/clients/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }), { reason: CLIENT_DELETE_REASON });
        return parseResult(key, result);
      }
      case 'projects:list': {
        const parsed = args as IpcArgs<'projects:list'>;
        const query = new URLSearchParams();
        if (parsed.clientId) query.set('clientId', parsed.clientId);
        if (parsed.includeArchived !== undefined) query.set('includeArchived', String(parsed.includeArchived));
        const suffix = query.toString() ? `?${query.toString()}` : '';
        const projects = await requestJson('GET', `${PRODUCT_PREFIX}/projects${suffix}`, z.array(projectSchema));
        return parseResult(key, projects);
      }
      case 'projects:get': {
        const parsed = args as IpcArgs<'projects:get'>;
        const project = await requestJson('GET', `${PRODUCT_PREFIX}/projects/${encodeURIComponent(parsed.id)}`, projectSchema.nullable());
        return parseResult(key, project);
      }
      case 'projects:upsert': {
        const parsed = args as IpcArgs<'projects:upsert'>;
        const project = await requestJson('POST', `${PRODUCT_PREFIX}/projects`, projectSchema, {
          reason: parsed.reason,
          project: parsed.project,
        });
        return parseResult(key, project);
      }
      case 'projects:archive': {
        const parsed = args as IpcArgs<'projects:archive'>;
        const project = await requestJson('POST', `${PRODUCT_PREFIX}/projects/${encodeURIComponent(parsed.id)}/archive`, projectSchema, {
          reason: parsed.reason,
        });
        return parseResult(key, project);
      }
      case 'articles:list': {
        const articles = await requestJson('GET', `${PRODUCT_PREFIX}/articles`, z.array(articleSchema));
        return parseResult(key, articles);
      }
      case 'articles:upsert': {
        const parsed = args as IpcArgs<'articles:upsert'>;
        const article = await requestJson('POST', `${PRODUCT_PREFIX}/articles`, articleSchema, upsertArticlePayloadSchema.parse({ article: parsed.article }));
        return parseResult(key, article);
      }
      case 'articles:delete': {
        const parsed = args as IpcArgs<'articles:delete'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/articles/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }));
        return parseResult(key, result);
      }
      case 'accounts:list': {
        const accounts = await requestJson('GET', `${PRODUCT_PREFIX}/accounts`, z.array(accountSchema));
        return parseResult(key, accounts);
      }
      case 'accounts:upsert': {
        const parsed = args as IpcArgs<'accounts:upsert'>;
        const account = await requestJson('POST', `${PRODUCT_PREFIX}/accounts`, accountSchema, upsertAccountPayloadSchema.parse({ account: parsed.account }));
        return parseResult(key, account);
      }
      case 'accounts:delete': {
        const parsed = args as IpcArgs<'accounts:delete'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/accounts/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }));
        return parseResult(key, result);
      }
      case 'templates:list': {
        const parsed = args as IpcArgs<'templates:list'>;
        const query = listTemplatesParamsSchema.parse(parsed);
        const suffix = query.kind ? `?kind=${encodeURIComponent(query.kind)}` : '';
        const templates = await requestJson('GET', `${PRODUCT_PREFIX}/templates${suffix}`, z.array(templateSchema));
        return parseResult(key, templates);
      }
      case 'templates:active': {
        const parsed = args as IpcArgs<'templates:active'>;
        const kind = templateKindSchema.parse(parsed.kind);
        const template = await requestJson('GET', `${PRODUCT_PREFIX}/templates/active/${encodeURIComponent(kind)}`, templateSchema.nullable());
        return parseResult(key, template);
      }
      case 'templates:upsert': {
        const parsed = args as IpcArgs<'templates:upsert'>;
        const template = await requestJson('POST', `${PRODUCT_PREFIX}/templates`, templateSchema, upsertTemplatePayloadSchema.parse({ template: parsed.template }));
        return parseResult(key, template);
      }
      case 'templates:delete': {
        const parsed = args as IpcArgs<'templates:delete'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/templates/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }));
        return parseResult(key, result);
      }
      case 'templates:setActive': {
        const parsed = args as IpcArgs<'templates:setActive'>;
        const result = await requestJson('PUT', `${PRODUCT_PREFIX}/templates/active`, z.object({ ok: z.literal(true) }), setActiveTemplatePayloadSchema.parse(parsed));
        return parseResult(key, result);
      }
      case 'taxFiling:getStatus': {
        const result = await requestJson('GET', `${PRODUCT_PREFIX}/tax-filing/status`, taxFilingRoutes['taxFiling:getStatus'].result);
        return parseResult(key, result);
      }
      case 'taxFiling:listRecords': {
        const result = await requestJson('GET', `${PRODUCT_PREFIX}/tax-filing/records`, taxFilingRoutes['taxFiling:listRecords'].result);
        return parseResult(key, result);
      }
      case 'taxFiling:installCertificate': {
        const parsed = args as IpcArgs<'taxFiling:installCertificate'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/tax-filing/certificates`, taxFilingRoutes['taxFiling:installCertificate'].result, parsed);
        return parseResult(key, result);
      }
      case 'taxFiling:removeCertificate': {
        const parsed = args as IpcArgs<'taxFiling:removeCertificate'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/tax-filing/certificates/${encodeURIComponent(parsed.id)}`, taxFilingRoutes['taxFiling:removeCertificate'].result);
        return parseResult(key, result);
      }
      case 'taxFiling:validate': {
        const parsed = args as IpcArgs<'taxFiling:validate'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/tax-filing/validate`, taxFilingRoutes['taxFiling:validate'].result, parsed);
        return parseResult(key, result);
      }
      case 'taxFiling:export': {
        const parsed = args as IpcArgs<'taxFiling:export'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/tax-filing/export`, taxFilingRoutes['taxFiling:export'].result, parsed);
        return parseResult(key, result);
      }
      case 'taxFiling:submit': {
        const parsed = args as IpcArgs<'taxFiling:submit'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/tax-filing/submit`, taxFilingRoutes['taxFiling:submit'].result, parsed);
        return parseResult(key, result);
      }
      case 'recurring:list': {
        const profiles = await requestJson('GET', `${PRODUCT_PREFIX}/recurring`, z.array(serverRecurringProfileSchema));
        return parseResult(key, profiles.map((profile) => toDesktopRecurringProfile(profile)));
      }
      case 'recurring:upsert': {
        const parsed = args as IpcArgs<'recurring:upsert'>;
        const saved = await requestJson('POST', `${PRODUCT_PREFIX}/recurring`, serverRecurringProfileSchema, { reason: RECURRING_MUTATION_REASON, profile: parsed.profile });
        return parseResult(key, toDesktopRecurringProfile(saved));
      }
      case 'recurring:delete': {
        const parsed = args as IpcArgs<'recurring:delete'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/recurring/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }), { reason: RECURRING_DELETE_REASON });
        return parseResult(key, result);
      }
      case 'settings:get':
        return parseResult(key, await requestSettings());
      case 'settings:set': {
        const parsed = args as IpcArgs<'settings:set'>;
        const result = await requestJson('PUT', `${PRODUCT_PREFIX}/settings`, z.object({ ok: z.literal(true) }), { settings: parsed.settings });
        return parseResult(key, result);
      }
      case 'numbers:reserve': {
        const parsed = args as IpcArgs<'numbers:reserve'>;
        return parseResult(key, await reserveDocumentNumber(parsed.kind));
      }
      case 'numbers:release': {
        const parsed = args as IpcArgs<'numbers:release'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/numbers/release`, z.object({ ok: z.literal(true) }), { reservationId: parsed.reservationId });
        return parseResult(key, result);
      }
      case 'numbers:finalize': {
        const parsed = args as IpcArgs<'numbers:finalize'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/numbers/finalize`, z.object({ ok: z.literal(true) }), { reservationId: parsed.reservationId, documentId: parsed.documentId });
        return parseResult(key, result);
      }
      case 'documents:createFromClient': {
        const parsed = args as IpcArgs<'documents:createFromClient'>;
        const client = await requestNullableClient(parsed.clientId);
        if (!client) throw new Error('Kunde nicht gefunden.');
        return buildDraftFromClient(parsed.kind, client, await requestSettings(), () => reserveDocumentNumber(parsed.kind));
      }
      case 'documents:convertOfferToInvoice': {
        const parsed = args as IpcArgs<'documents:convertOfferToInvoice'>;
        const saved = await requestJson('POST', `${PRODUCT_PREFIX}/documents/convert-offer`, serverInvoiceSchema, {
          offerId: parsed.offerId, invoiceId: crypto.randomUUID(),
        });
        return parseResult(key, toLegacyInvoice(saved));
      }
      case 'documents:chainCreate': {
        const parsed = args as IpcArgs<'documents:chainCreate'>;
        const endpoint = parsed.operation === 'order_confirmation'
          ? 'order-confirmations'
          : parsed.operation === 'delivery_note'
            ? 'delivery-notes'
            : parsed.operation === 'settlement_invoice'
              ? 'settlement-invoices'
              : parsed.operation === 'correction'
                ? 'corrections'
                : 'revisions';
        const { operation: _operation, ...body } = parsed;
        const saved = await requestJson('POST', `${PRODUCT_PREFIX}/document-chain/${endpoint}`, serverInvoiceSchema, body);
        return parseResult(key, toLegacyInvoice(saved));
      }
      case 'documents:chainList': {
        const parsed = args as IpcArgs<'documents:chainList'>;
        const documents = await requestJson('GET', `${PRODUCT_PREFIX}/document-chain/${encodeURIComponent(parsed.rootDocumentId)}`, z.array(serverInvoiceSchema));
        return parseResult(key, documents.map((document) => toLegacyInvoice(document)));
      }
      case 'eur:getReport': {
        const parsed = args as IpcArgs<'eur:getReport'>;
        const query = eurReportQuery(parsed);
        return mapEurReport(await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur`, serverEurReportSchema, undefined, query), query) as IpcResult<K>;
      }
      case 'eur:listItems': {
        const parsed = args as IpcArgs<'eur:listItems'>;
        const query = eurReportQuery(parsed);
        const items = await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur/items`, z.array(serverEurItemSchema), undefined, query);
        if (items.some((item) => item.classification && item.classification.taxYear !== query.taxYear)) {
          throw new Error(`EÜR-Klassifikation gehört nicht zum angeforderten Steuerjahr ${query.taxYear}.`);
        }
        return parseResult(key, items);
      }
      case 'eur:upsertClassification': {
        const parsed = args as IpcArgs<'eur:upsertClassification'>;
        if (!isSupportedEurTaxYear(parsed.taxYear)) throw new RangeError(`EUR_CATALOG_UNAVAILABLE:${parsed.taxYear}`);
        const saved = await requestJson('PUT', `${PRODUCT_PREFIX}/reports/eur/classifications`, serverEurClassificationSchema, parsed);
        if (saved.taxYear !== parsed.taxYear) {
          throw new Error(`EÜR-Klassifikation gehört nicht zum angeforderten Steuerjahr ${parsed.taxYear}.`);
        }
        return parseResult(key, saved);
      }
      case 'eur:exportCsv': {
        const parsed = args as IpcArgs<'eur:exportCsv'>;
        const query = eurReportQuery(parsed);
        const report = mapEurReport(await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur`, serverEurReportSchema, undefined, query), query);
        return parseResult(key, mapEurCsv(report));
      }
      case 'audit:verify': {
        const result = await requestJson('GET', `${PRODUCT_PREFIX}/audit/verify`, z.object({
          ok: z.boolean(), errors: z.array(z.object({ sequence: z.number(), message: z.string() })), count: z.number(), headHash: z.string().nullable(),
        }));
        return parseResult(key, result);
      }
      case 'audit:exportCsv':
        return parseResult(key, await requestText('GET', `${PRODUCT_PREFIX}/audit/export.csv`));
      case 'eur:listRules': {
        const parsed = args as IpcArgs<'eur:listRules'>;
        const rules = await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur/rules?taxYear=${encodeURIComponent(String(parsed.taxYear))}`, z.array(eurRuleSchema));
        return parseResult(key, rules);
      }
      case 'eur:upsertRule': {
        const parsed = args as IpcArgs<'eur:upsertRule'>;
        const rule = await requestJson('POST', `${PRODUCT_PREFIX}/reports/eur/rules`, eurRuleSchema, { ...parsed, reason: EUR_RULE_MUTATION_REASON });
        return parseResult(key, rule);
      }
      case 'eur:deleteRule': {
        const parsed = args as IpcArgs<'eur:deleteRule'>;
        const result = await requestJson('DELETE', `${PRODUCT_PREFIX}/reports/eur/rules/${encodeURIComponent(parsed.id)}`, z.object({ ok: z.literal(true) }), { reason: EUR_RULE_DELETE_REASON });
        return parseResult(key, result);
      }
      case 'portal:health': {
        const parsed = args as IpcArgs<'portal:health'>;
        return parseResult(key, await requestJson(
          'GET',
          `${PRODUCT_PREFIX}/portal/health?baseUrl=${encodeURIComponent(parsed.baseUrl)}`,
          ipcRoutes[key].result,
        ));
      }
      case 'portal:publishOffer': {
        const parsed = args as IpcArgs<'portal:publishOffer'>;
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/portal/publish-offer`, ipcRoutes[key].result, parsed));
      }
      case 'portal:publishInvoice': {
        const parsed = args as IpcArgs<'portal:publishInvoice'>;
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/portal/publish-invoice`, ipcRoutes[key].result, parsed));
      }
      case 'portal:syncOfferStatus': {
        const parsed = args as IpcArgs<'portal:syncOfferStatus'>;
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/portal/sync-offer-status`, ipcRoutes[key].result, parsed));
      }
      case 'portal:createCustomerAccessLink': {
        const parsed = args as IpcArgs<'portal:createCustomerAccessLink'>;
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/portal/customer-access-link`, ipcRoutes[key].result, parsed));
      }
      case 'portal:rotateCustomerAccessLink': {
        const parsed = args as IpcArgs<'portal:rotateCustomerAccessLink'>;
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/portal/customer-access-link/rotate`, ipcRoutes[key].result, parsed));
      }
      case 'email:send': {
        const parsed = args as IpcArgs<'email:send'>;
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/email/send`, ipcRoutes[key].result, parsed));
      }
      case 'email:testConfig': {
        const parsed = args as IpcArgs<'email:testConfig'>;
        // Provider credentials are server-side only. Never forward optional
        // desktop keychain values through the browser/HTTP boundary.
        const { smtpPassword: _smtpPassword, resendApiKey: _resendApiKey, ...serverConfig } = parsed;
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/email/test-config`, ipcRoutes[key].result, serverConfig));
      }
      case 'dunning:manualRun': {
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/dunning/manual-run`, ipcRoutes[key].result));
      }
      case 'dunning:getInvoiceStatus': {
        const parsed = args as IpcArgs<'dunning:getInvoiceStatus'>;
        return parseResult(key, await requestJson('GET', `${PRODUCT_PREFIX}/dunning/invoices/${encodeURIComponent(parsed.invoiceId)}/status`, ipcRoutes[key].result));
      }
      case 'recurring:manualRun': {
        return parseResult(key, await requestJson('POST', `${PRODUCT_PREFIX}/recurring/manual-run`, ipcRoutes[key].result));
      }
      case 'transactions:list': {
        const parsed = args as IpcArgs<'transactions:list'>;
        const query = new URLSearchParams();
        if (parsed.accountId) query.set('accountId', parsed.accountId);
        if (parsed.type) query.set('type', parsed.type);
        if (parsed.linkedOnly !== undefined) query.set('linkedOnly', String(parsed.linkedOnly));
        if (parsed.unlinkedOnly !== undefined) query.set('unlinkedOnly', String(parsed.unlinkedOnly));
        const suffix = query.toString() ? `?${query.toString()}` : '';
        const transactions = await requestJson('GET', `${PRODUCT_PREFIX}/transactions${suffix}`, z.array(serverTransactionSchema));
        return parseResult(key, transactions);
      }
      case 'transactions:findMatches': {
        const parsed = args as IpcArgs<'transactions:findMatches'>;
        const matches = await requestJson('GET', `${PRODUCT_PREFIX}/transactions/${encodeURIComponent(parsed.transactionId)}/matches`, serverTransactionMatchesSchema);
        return parseResult(key, {
          transaction: matches.transaction,
          suggestions: matches.suggestions.map((suggestion) => ({ ...suggestion, invoice: toLegacyInvoice(suggestion.invoice) })),
        });
      }
      case 'transactions:link': {
        const parsed = args as IpcArgs<'transactions:link'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/transactions/${encodeURIComponent(parsed.transactionId)}/link`, z.object({ success: z.literal(true), invoice: serverInvoiceSchema }), {
          invoiceId: parsed.invoiceId,
          reason: TRANSACTION_LINK_REASON,
        });
        return parseResult(key, { success: result.success, invoice: toLegacyInvoice(result.invoice) });
      }
      case 'transactions:unlink': {
        const parsed = args as IpcArgs<'transactions:unlink'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/transactions/${encodeURIComponent(parsed.transactionId)}/unlink`, z.object({ success: z.literal(true) }), {
          reason: TRANSACTION_UNLINK_REASON,
        });
        return parseResult(key, result);
      }
      case 'finance:importPreview': {
        const parsed = args as IpcArgs<'finance:importPreview'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/finance/import/preview`, ipcRoutes[key].result, parsed);
        return parseResult(key, result);
      }
      case 'finance:importCommit': {
        const parsed = args as IpcArgs<'finance:importCommit'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/finance/import/commit`, ipcRoutes[key].result, parsed);
        return parseResult(key, result);
      }
      case 'finance:listImportBatches': {
        const parsed = args as IpcArgs<'finance:listImportBatches'>;
        const query = new URLSearchParams();
        if (parsed.accountId) query.set('accountId', parsed.accountId);
        if (parsed.limit !== undefined) query.set('limit', String(parsed.limit));
        const suffix = query.toString() ? `?${query.toString()}` : '';
        const result = await requestJson('GET', `${PRODUCT_PREFIX}/finance/import-batches${suffix}`, ipcRoutes[key].result);
        return parseResult(key, result);
      }
      case 'finance:getImportBatchDetails': {
        const parsed = args as IpcArgs<'finance:getImportBatchDetails'>;
        const result = await requestJson('GET', `${PRODUCT_PREFIX}/finance/import-batches/${encodeURIComponent(parsed.batchId)}`, ipcRoutes[key].result);
        return parseResult(key, result);
      }
      case 'finance:rollbackImportBatch': {
        const parsed = args as IpcArgs<'finance:rollbackImportBatch'>;
        const result = await requestJson('POST', `${PRODUCT_PREFIX}/finance/import-batches/${encodeURIComponent(parsed.batchId)}/rollback`, ipcRoutes[key].result, { reason: parsed.reason });
        return parseResult(key, result);
      }
      default:
        // Native OS routes are the only routes that may remain on Electron
        // IPC. Persisted/server-owned routes must fail closed when a route is
        // not implemented by this HTTP adapter; otherwise SQLite could become
        // a second, silent source of truth.
        if (fallback && isNativeElectronRoute(key)) return fallback(key, args);
        throw new Error('Diese Funktion ist im Lite-HTTP-Client nicht verfügbar.');
    }
  };

  onInvoke?.(invoke);
  const api = createBillmeApi(invoke);
  return Object.assign(api, {
    validateVatId: async (args: { countryCode: string; vatNumber: string }) => {
      return requestJson('POST', `${PRODUCT_PREFIX}/tax/validate-vat-id`, vatValidationResultSchema, args);
    },
  });
};
