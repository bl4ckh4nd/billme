import { z } from 'zod';
import {
  authResponseSchema, authUserSchema, bootstrapRequestSchema, bootstrapStatusSchema,
  capabilitiesResponseSchema, clientSchema, healthResponseSchema, invoiceSchema,
  loginRequestSchema, offerSchema, recurringProfileSchema, serverProductSchema, serverRoleSchema,
} from '@billme/server-core';
import {
  accountSchema, appSettingsSchema, articleSchema, setActiveTemplatePayloadSchema,
  setSettingsPayloadSchema, templateKindSchema, templateSchema, upsertAccountPayloadSchema,
  upsertArticlePayloadSchema, upsertTemplatePayloadSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { createBillmeApi, type BillmeApi, type IpcInvoke } from '@billme/desktop-contracts-pro/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts-pro/contract';
import { taxFilingRoutes } from '@billme/desktop-contracts/taxFiling';
import type { EmbeddedConnection } from '@billme/desktop-contracts/embeddedConnection';
import { chooseDefaultBillingAddress, chooseDefaultBillingEmail, formatAddressMultiline } from '@billme/server-core/services';
import { createBillingScope, toDomainInvoice, toDomainOffer, toLegacyInvoice, toLegacyOffer } from '@billme/desktop-data/billingDomainCompat';
import { isNativeElectronRoute, isServerOwnedRoute } from './serverRouteClassification';

type Parser<T> = { parse: (input: unknown) => T } | ((input: unknown) => T);
type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | null | undefined;
type RequestOptions<T> = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, QueryValue>; parser?: Parser<T> };
const PRO_PRODUCT_QUERY = { product: 'pro' as const };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const parseWith = <T>(parser: Parser<T>, input: unknown): T => typeof parser === 'function' ? parser(input) : parser.parse(input);
const parseArray = <T>(parser: Parser<T>): Parser<T[]> => (input) => {
  if (!Array.isArray(input)) throw new Error('Die Serverantwort enthält keine Liste.');
  return input.map((item) => parseWith(parser, item));
};
const authSessionInfoParser = (input: unknown) => {
  if (!isRecord(input)) throw new Error('Die Serverantwort enthält keine Sitzungsdaten.');
  return {
    user: authUserSchema.parse(input.user),
    tenantId: typeof input.tenantId === 'string' ? input.tenantId : '',
    product: serverProductSchema.parse(input.product),
    role: serverRoleSchema.parse(input.role),
  };
};
const buildUrl = (baseUrl: string, path: string, query?: Record<string, QueryValue>): string => {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
};

export type ProWebClientConfig = {
  baseUrl: string;
  getToken?: () => string | null;
  embeddedConnectionResolver?: () => Promise<EmbeddedConnection | null>;
  fetch?: typeof globalThis.fetch;
};
export class ProEmbeddedConnectionUnavailableError extends Error {
  readonly code = 'PRO_EMBEDDED_CONNECTION_UNAVAILABLE' as const;
  constructor() {
    super('Der eingebettete Pro-Server ist nicht verfügbar.');
    this.name = 'ProEmbeddedConnectionUnavailableError';
  }
}

export const createProWebClient = ({
  baseUrl, getToken, embeddedConnectionResolver, fetch: requestFetch = globalThis.fetch,
}: ProWebClientConfig) => {
  const resolveRequestTarget = async (): Promise<{ baseUrl: string; headers: HeadersInit }> => {
    if (embeddedConnectionResolver) {
      const connection = await embeddedConnectionResolver();
      if (!connection) throw new ProEmbeddedConnectionUnavailableError();
      return { baseUrl: connection.baseUrl, headers: { 'x-billme-local-token': connection.token } };
    }
    const token = getToken?.();
    return { baseUrl, headers: token ? { authorization: `Bearer ${token}` } : {} };
  };
  const requestJson = async <T>(options: RequestOptions<T>, path: string): Promise<T> => {
    if (!requestFetch) throw new Error('Keine Fetch-Implementierung verfügbar.');
    const target = await resolveRequestTarget();
    const headers = new Headers(target.headers);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await requestFetch(buildUrl(target.baseUrl, path, options.query), {
      method: options.method ?? 'GET', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.message === 'string'
        ? payload.message : `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return options.parser ? parseWith(options.parser, payload) : payload as T;
  };
  const billingScope = createBillingScope('pro');
  const toServerInvoicePayload = (invoice: IpcResult<'invoices:upsert'>) => {
    const { tenantId: _tenantId, ...payload } = toDomainInvoice(billingScope, invoice);
    return payload;
  };
  const toServerOfferPayload = (offer: IpcResult<'offers:upsert'>) => {
    const { tenantId: _tenantId, ...payload } = toDomainOffer(billingScope, offer);
    return payload;
  };
  const getSettings = () => requestJson({
    parser: (input) => input === null ? null : appSettingsSchema.parse(input),
  }, '/api/v1/pro/settings');
  const reserveNumber = (kind: 'invoice' | 'offer' | 'customer') => requestJson({
    method: 'POST', body: ipcRoutes['numbers:reserve'].args.parse({ kind }),
    parser: ipcRoutes['numbers:reserve'].result,
  }, '/api/v1/pro/numbers/reserve');
  const releaseNumber = (reservationId: string) => requestJson({
    method: 'POST', body: ipcRoutes['numbers:release'].args.parse({ reservationId }),
    parser: ipcRoutes['numbers:release'].result,
  }, '/api/v1/pro/numbers/release');
  const buildDraftFromClient = async (kind: 'invoice' | 'offer', client: z.output<typeof clientSchema>): Promise<IpcResult<'documents:createFromClient'>> => {
    const settings = await getSettings();
    const reservation = await reserveNumber(kind);
    const billingAddress = chooseDefaultBillingAddress(client.addresses);
    const shippingAddress = client.addresses.find((address) => address.isDefaultShipping) ?? billingAddress ?? null;
    const billingEmail = chooseDefaultBillingEmail(client.emails);
    const activeProject = client.projects.find((project) => project.name === 'Allgemein' && project.status !== 'archived')
      ?? client.projects.find((project) => project.status !== 'archived') ?? client.projects[0];
    const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
    const dueDate = new Date(today);
    dueDate.setDate(dueDate.getDate() + (kind === 'offer' ? 0 : settings?.legal.paymentTermsDays ?? 0));
    return ipcRoutes['documents:createFromClient'].result.parse({
      id: crypto.randomUUID(), clientId: client.id, clientNumber: client.customerNumber, projectId: activeProject?.id,
      number: reservation.number, numberReservationId: reservation.reservationId, client: client.company,
      clientEmail: billingEmail?.email ?? client.email, clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : client.address,
      billingAddressJson: billingAddress ?? undefined, shippingAddressJson: shippingAddress ?? undefined, date: today,
      dueDate: dueDate.toISOString().split('T')[0] ?? today, amount: 0, status: 'draft', items: [], payments: [], history: [],
    });
  };

  const client = {
    getHealth: () => requestJson({ parser: healthResponseSchema }, '/health'),
    getCapabilities: () => requestJson({ parser: capabilitiesResponseSchema }, '/api/v1/meta/capabilities'),
    getBootstrapStatus: () => requestJson({ parser: bootstrapStatusSchema, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/bootstrap/status'),
    bootstrap: (input: unknown) => requestJson({ method: 'POST', body: bootstrapRequestSchema.parse(input), parser: authResponseSchema, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/bootstrap'),
    login: (input: unknown) => requestJson({ method: 'POST', body: loginRequestSchema.parse(input), parser: authResponseSchema, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/login'),
    getSessionInfo: () => requestJson({ parser: authSessionInfoParser, query: PRO_PRODUCT_QUERY }, '/api/v1/auth/me'),

    getTaxFilingStatus: () => requestJson({ parser: taxFilingRoutes['taxFiling:getStatus'].result }, '/api/v1/pro/tax-filing/status'),
    listTaxFilingRecords: () => requestJson({ parser: taxFilingRoutes['taxFiling:listRecords'].result }, '/api/v1/pro/tax-filing/records'),
    installTaxFilingCertificate: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:installCertificate'].args.parse(input), parser: taxFilingRoutes['taxFiling:installCertificate'].result }, '/api/v1/pro/tax-filing/certificates'),
    removeTaxFilingCertificate: (id: string) => requestJson({ method: 'DELETE', parser: taxFilingRoutes['taxFiling:removeCertificate'].result }, `/api/v1/pro/tax-filing/certificates/${encodeURIComponent(id)}`),
    validateTaxFiling: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:validate'].args.parse(input), parser: taxFilingRoutes['taxFiling:validate'].result }, '/api/v1/pro/tax-filing/validate'),
    exportTaxFiling: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:export'].args.parse(input), parser: taxFilingRoutes['taxFiling:export'].result }, '/api/v1/pro/tax-filing/export'),
    submitTaxFiling: (input: unknown) => requestJson({ method: 'POST', body: taxFilingRoutes['taxFiling:submit'].args.parse(input), parser: taxFilingRoutes['taxFiling:submit'].result }, '/api/v1/pro/tax-filing/submit'),

    listClients: () => requestJson({ parser: parseArray(clientSchema) }, '/api/v1/pro/clients'),
    saveClient: (input: unknown) => requestJson({ method: 'POST', body: { reason: 'Kunde gespeichert', client: ipcRoutes['clients:upsert'].args.parse({ client: input }).client }, parser: clientSchema }, '/api/v1/pro/clients'),
    deleteClient: (id: string, reason = 'Kunde gelöscht') => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/clients/${encodeURIComponent(id)}`),
    listInvoices: () => requestJson({ parser: parseArray(invoiceSchema) }, '/api/v1/pro/invoices'),
    saveInvoice: (input: unknown, reason: string) => {
      const parsed = ipcRoutes['invoices:upsert'].args.parse({ reason, invoice: input });
      return requestJson({ method: 'POST', body: { reason, invoice: toServerInvoicePayload(parsed.invoice) }, parser: invoiceSchema }, '/api/v1/pro/invoices');
    },
    deleteInvoice: (id: string, reason: string) => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/invoices/${encodeURIComponent(id)}`),
    listOffers: () => requestJson({ parser: parseArray(offerSchema) }, '/api/v1/pro/offers'),
    saveOffer: (input: unknown, reason: string) => {
      const parsed = ipcRoutes['offers:upsert'].args.parse({ reason, offer: input });
      return requestJson({ method: 'POST', body: { reason, offer: toServerOfferPayload(parsed.offer) }, parser: offerSchema }, '/api/v1/pro/offers');
    },
    deleteOffer: (id: string, reason: string) => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/offers/${encodeURIComponent(id)}`),
    listRecurringProfiles: () => requestJson({ parser: parseArray(recurringProfileSchema) }, '/api/v1/pro/recurring'),
    saveRecurringProfile: (profile: unknown, reason = 'Wiederkehrendes Profil gespeichert') => {
      const parsed = ipcRoutes['recurring:upsert'].args.parse({ profile });
      return requestJson({ method: 'POST', body: { reason, profile: parsed.profile }, parser: recurringProfileSchema }, '/api/v1/pro/recurring');
    },
    deleteRecurringProfile: (id: string, reason = 'Wiederkehrendes Profil gelöscht') => requestJson({ method: 'DELETE', body: { reason }, parser: (input) => input }, `/api/v1/pro/recurring/${encodeURIComponent(id)}`),
    getSettings,
    saveSettings: (settings: unknown) => requestJson({ method: 'PUT', body: setSettingsPayloadSchema.parse({ settings }), parser: (input) => input }, '/api/v1/pro/settings'),
    reserveNumber,
    releaseNumber,
    finalizeNumber: (reservationId: string, documentId: string) => requestJson({ method: 'POST', body: ipcRoutes['numbers:finalize'].args.parse({ reservationId, documentId }), parser: ipcRoutes['numbers:finalize'].result }, '/api/v1/pro/numbers/finalize'),
    createDocumentFromClient: async (input: unknown) => {
      const parsed = ipcRoutes['documents:createFromClient'].args.parse(input);
      const found = await requestJson({ parser: (value) => clientSchema.nullable().parse(value) }, `/api/v1/pro/clients/${encodeURIComponent(parsed.clientId)}`);
      if (!found) throw new Error('Kunde nicht gefunden.');
      return buildDraftFromClient(parsed.kind, found);
    },
    convertOfferToInvoice: async (input: unknown) => {
      const parsed = ipcRoutes['documents:convertOfferToInvoice'].args.parse(input);
      const offer = await requestJson({ parser: (value) => offerSchema.nullable().parse(value) }, `/api/v1/pro/offers/${encodeURIComponent(parsed.offerId)}`);
      if (!offer) throw new Error('Angebot nicht gefunden.');
      const settings = await getSettings();
      const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
      const reservation = await reserveNumber('invoice');
      try {
        const legacyOffer = toLegacyOffer(offer);
        const dueDate = new Date(today);
        dueDate.setDate(dueDate.getDate() + (settings?.legal.paymentTermsDays ?? 0));
        const created = toDomainInvoice(billingScope, {
          ...legacyOffer, id: crypto.randomUUID(), number: reservation.number, date: today,
          dueDate: dueDate.toISOString().split('T')[0] ?? today, status: 'draft',
          history: [{ date: today, action: `Erstellt aus Angebot ${offer.number}` }, ...(offer.history ?? [])],
        });
        const { tenantId: _tenantId, ...invoice } = created;
        const saved = await requestJson({ method: 'POST', body: { reason: `Converted from offer ${offer.number}`, invoice }, parser: invoiceSchema }, '/api/v1/pro/invoices');
        await client.finalizeNumber(reservation.reservationId, saved.id);
        return toLegacyInvoice(saved);
      } catch (error) {
        await releaseNumber(reservation.reservationId).catch(() => undefined);
        throw error;
      }
    },

    listArticles: () => requestJson({ parser: parseArray(articleSchema) }, '/api/v1/pro/articles'),
    saveArticle: (article: unknown) => requestJson({ method: 'POST', body: upsertArticlePayloadSchema.parse({ article }), parser: articleSchema }, '/api/v1/pro/articles'),
    deleteArticle: (id: string) => requestJson({ method: 'DELETE', parser: (input) => input }, `/api/v1/pro/articles/${encodeURIComponent(id)}`),
    listAccounts: () => requestJson({ parser: parseArray(accountSchema) }, '/api/v1/pro/accounts'),
    saveAccount: (account: unknown) => requestJson({ method: 'POST', body: upsertAccountPayloadSchema.parse({ account }), parser: accountSchema }, '/api/v1/pro/accounts'),
    deleteAccount: (id: string) => requestJson({ method: 'DELETE', parser: (input) => input }, `/api/v1/pro/accounts/${encodeURIComponent(id)}`),
    listTemplates: (kind?: 'invoice' | 'offer') => requestJson({ parser: parseArray(templateSchema), query: kind ? { kind } : undefined }, '/api/v1/pro/templates'),
    getActiveTemplate: (kind: 'invoice' | 'offer') => requestJson({ parser: (input) => input === null ? null : templateSchema.parse(input) }, `/api/v1/pro/templates/active/${templateKindSchema.parse(kind)}`),
    saveTemplate: (template: unknown) => requestJson({ method: 'POST', body: upsertTemplatePayloadSchema.parse({ template }), parser: templateSchema }, '/api/v1/pro/templates'),
    deleteTemplate: (id: string) => requestJson({ method: 'DELETE', parser: (input) => input }, `/api/v1/pro/templates/${encodeURIComponent(id)}`),
    setActiveTemplate: (input: unknown) => requestJson({ method: 'PUT', body: setActiveTemplatePayloadSchema.parse(input), parser: (input) => input }, '/api/v1/pro/templates/active'),
  };
  return client;
};

export type ProWebClient = ReturnType<typeof createProWebClient>;
export type ProHttpApiOptions = ProWebClientConfig & { fallback?: IpcInvoke; onInvoke?: (invoke: IpcInvoke) => void };
export type ProHttpBillmeApi = BillmeApi;

export const createProHttpBillmeApi = ({ fallback, onInvoke, ...clientConfig }: ProHttpApiOptions): ProHttpBillmeApi => {
  const client = createProWebClient(clientConfig);
  const embeddedConnectionResolver = clientConfig.embeddedConnectionResolver;
  const invoke: IpcInvoke = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    if (!Object.prototype.hasOwnProperty.call(ipcRoutes, key)) throw new Error(`Die Pro-HTTP-Laufzeit unterstützt die IPC-Route ${String(key)} nicht.`);
    if (embeddedConnectionResolver && isServerOwnedRoute(key)) {
      const connection = await embeddedConnectionResolver();
      if (!connection) {
        if (fallback) return fallback(key, args);
        throw new ProEmbeddedConnectionUnavailableError();
      }
    }
    switch (key) {
      case 'taxFiling:getStatus': return ipcRoutes[key].result.parse(await client.getTaxFilingStatus()) as IpcResult<K>;
      case 'taxFiling:listRecords': return ipcRoutes[key].result.parse(await client.listTaxFilingRecords()) as IpcResult<K>;
      case 'taxFiling:installCertificate': {
        const parsed = ipcRoutes['taxFiling:installCertificate'].args.parse(args) as IpcArgs<'taxFiling:installCertificate'>;
        return ipcRoutes[key].result.parse(await client.installTaxFilingCertificate(parsed)) as IpcResult<K>;
      }
      case 'taxFiling:removeCertificate': {
        const parsed = ipcRoutes['taxFiling:removeCertificate'].args.parse(args) as IpcArgs<'taxFiling:removeCertificate'>;
        return ipcRoutes[key].result.parse(await client.removeTaxFilingCertificate(parsed.id)) as IpcResult<K>;
      }
      case 'taxFiling:validate': return ipcRoutes[key].result.parse(await client.validateTaxFiling(ipcRoutes['taxFiling:validate'].args.parse(args) as IpcArgs<'taxFiling:validate'>)) as IpcResult<K>;
      case 'taxFiling:export': return ipcRoutes[key].result.parse(await client.exportTaxFiling(ipcRoutes['taxFiling:export'].args.parse(args) as IpcArgs<'taxFiling:export'>)) as IpcResult<K>;
      case 'taxFiling:submit': return ipcRoutes[key].result.parse(await client.submitTaxFiling(ipcRoutes['taxFiling:submit'].args.parse(args) as IpcArgs<'taxFiling:submit'>)) as IpcResult<K>;
      case 'invoices:list': return ipcRoutes[key].result.parse((await client.listInvoices()).map(toLegacyInvoice)) as IpcResult<K>;
      case 'invoices:upsert': {
        const parsed = ipcRoutes['invoices:upsert'].args.parse(args) as IpcArgs<'invoices:upsert'>;
        return ipcRoutes[key].result.parse(toLegacyInvoice(await client.saveInvoice(parsed.invoice, parsed.reason))) as IpcResult<K>;
      }
      case 'invoices:delete': {
        const parsed = ipcRoutes['invoices:delete'].args.parse(args) as IpcArgs<'invoices:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteInvoice(parsed.id, parsed.reason)) as IpcResult<K>;
      }
      case 'offers:list': return ipcRoutes[key].result.parse((await client.listOffers()).map(toLegacyOffer)) as IpcResult<K>;
      case 'offers:upsert': {
        const parsed = ipcRoutes['offers:upsert'].args.parse(args) as IpcArgs<'offers:upsert'>;
        return ipcRoutes[key].result.parse(toLegacyOffer(await client.saveOffer(parsed.offer, parsed.reason))) as IpcResult<K>;
      }
      case 'offers:delete': {
        const parsed = ipcRoutes['offers:delete'].args.parse(args) as IpcArgs<'offers:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteOffer(parsed.id, parsed.reason)) as IpcResult<K>;
      }
      case 'clients:list': return ipcRoutes[key].result.parse(await client.listClients()) as IpcResult<K>;
      case 'clients:upsert': {
        const parsed = ipcRoutes['clients:upsert'].args.parse(args) as IpcArgs<'clients:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveClient(parsed.client)) as IpcResult<K>;
      }
      case 'clients:delete': {
        const parsed = ipcRoutes['clients:delete'].args.parse(args) as IpcArgs<'clients:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteClient(parsed.id)) as IpcResult<K>;
      }
      case 'recurring:list': return ipcRoutes[key].result.parse(await client.listRecurringProfiles()) as IpcResult<K>;
      case 'recurring:upsert': {
        const parsed = ipcRoutes['recurring:upsert'].args.parse(args) as IpcArgs<'recurring:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveRecurringProfile(parsed.profile)) as IpcResult<K>;
      }
      case 'recurring:delete': {
        const parsed = ipcRoutes['recurring:delete'].args.parse(args) as IpcArgs<'recurring:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteRecurringProfile(parsed.id)) as IpcResult<K>;
      }
      case 'settings:get': return ipcRoutes[key].result.parse(await client.getSettings()) as IpcResult<K>;
      case 'settings:set': {
        const parsed = ipcRoutes['settings:set'].args.parse(args) as IpcArgs<'settings:set'>;
        return ipcRoutes[key].result.parse(await client.saveSettings(parsed.settings)) as IpcResult<K>;
      }
      case 'numbers:reserve': {
        const parsed = ipcRoutes['numbers:reserve'].args.parse(args) as IpcArgs<'numbers:reserve'>;
        return ipcRoutes[key].result.parse(await client.reserveNumber(parsed.kind)) as IpcResult<K>;
      }
      case 'numbers:release': {
        const parsed = ipcRoutes['numbers:release'].args.parse(args) as IpcArgs<'numbers:release'>;
        return ipcRoutes[key].result.parse(await client.releaseNumber(parsed.reservationId)) as IpcResult<K>;
      }
      case 'numbers:finalize': {
        const parsed = ipcRoutes['numbers:finalize'].args.parse(args) as IpcArgs<'numbers:finalize'>;
        return ipcRoutes[key].result.parse(await client.finalizeNumber(parsed.reservationId, parsed.documentId)) as IpcResult<K>;
      }
      case 'documents:createFromClient': return ipcRoutes[key].result.parse(await client.createDocumentFromClient(args)) as IpcResult<K>;
      case 'documents:convertOfferToInvoice': return ipcRoutes[key].result.parse(await client.convertOfferToInvoice(args)) as IpcResult<K>;
      case 'articles:list': return ipcRoutes[key].result.parse(await client.listArticles()) as IpcResult<K>;
      case 'articles:upsert': {
        const parsed = ipcRoutes['articles:upsert'].args.parse(args) as IpcArgs<'articles:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveArticle(parsed.article)) as IpcResult<K>;
      }
      case 'articles:delete': {
        const parsed = ipcRoutes['articles:delete'].args.parse(args) as IpcArgs<'articles:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteArticle(parsed.id)) as IpcResult<K>;
      }
      case 'accounts:list': return ipcRoutes[key].result.parse(await client.listAccounts()) as IpcResult<K>;
      case 'accounts:upsert': {
        const parsed = ipcRoutes['accounts:upsert'].args.parse(args) as IpcArgs<'accounts:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveAccount(parsed.account)) as IpcResult<K>;
      }
      case 'accounts:delete': {
        const parsed = ipcRoutes['accounts:delete'].args.parse(args) as IpcArgs<'accounts:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteAccount(parsed.id)) as IpcResult<K>;
      }
      case 'templates:list': {
        const parsed = ipcRoutes['templates:list'].args.parse(args) as IpcArgs<'templates:list'>;
        return ipcRoutes[key].result.parse(await client.listTemplates(parsed.kind)) as IpcResult<K>;
      }
      case 'templates:active': {
        const parsed = ipcRoutes['templates:active'].args.parse(args) as IpcArgs<'templates:active'>;
        return ipcRoutes[key].result.parse(await client.getActiveTemplate(parsed.kind)) as IpcResult<K>;
      }
      case 'templates:upsert': {
        const parsed = ipcRoutes['templates:upsert'].args.parse(args) as IpcArgs<'templates:upsert'>;
        return ipcRoutes[key].result.parse(await client.saveTemplate(parsed.template)) as IpcResult<K>;
      }
      case 'templates:delete': {
        const parsed = ipcRoutes['templates:delete'].args.parse(args) as IpcArgs<'templates:delete'>;
        return ipcRoutes[key].result.parse(await client.deleteTemplate(parsed.id)) as IpcResult<K>;
      }
      case 'templates:setActive': return ipcRoutes[key].result.parse(await client.setActiveTemplate(args)) as IpcResult<K>;
      default:
        if (fallback && isNativeElectronRoute(key)) return fallback(key, args);
        throw new Error(`Die Pro-HTTP-Laufzeit unterstützt die IPC-Route ${String(key)} nicht.`);
    }
  };
  onInvoke?.(invoke);
  return createBillmeApi(invoke);
};
