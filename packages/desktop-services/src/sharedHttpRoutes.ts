import { z } from 'zod';
import type { ContractRouteMap } from '@billme/desktop-contracts/api-factory';
import type { IpcArgs, IpcResult, IpcRouteKey } from '@billme/desktop-contracts/contract';
import {
  clientSchema as serverClientSchema,
  createSingleTenantScope,
  invoiceSchema as serverInvoiceSchema,
  offerSchema as serverOfferSchema,
  recurringProfileSchema as serverRecurringProfileSchema,
  type ServerProduct,
} from '@billme/server-core';
import {
  chooseDefaultBillingAddress,
  chooseDefaultBillingEmail,
  formatAddressMultiline,
} from '@billme/server-core/services';
import { documentRenderContextSchema } from '@billme/desktop-contracts/schemas';
import { serverRenderDocumentSchema, toDesktopRenderContext } from './documentRenderContext';
import { toDomainInvoice, toDomainOffer, toLegacyInvoice, toLegacyOffer } from './billingDomainMappers';

export type HttpParser<T> = { parse: (input: unknown) => T };
export type HttpQuery = Record<string, string | number | boolean | null | undefined>;

/** Product-owned transport: base URL, auth headers, error mapping and retry/fallback policy stay with the caller. */
export type SharedHttpTransport = {
  requestJson: <T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    parser: HttpParser<T>,
    body?: unknown,
    query?: HttpQuery,
  ) => Promise<T>;
  requestText: (path: string) => Promise<string>;
};

/** Audit reasons are persisted and shown in the document history, so each product keeps its own wording. */
export type SharedHttpReasons = {
  clientUpsert: string;
  clientDelete: string;
  recurringUpsert: string;
  recurringDelete: string;
};

export type SharedHttpOptions = {
  product: ServerProduct;
  /** The product's contract; results are parsed against it so Pro-only fields survive. */
  routes: ContractRouteMap;
  reasons: SharedHttpReasons;
  transport: SharedHttpTransport;
};

const TRANSACTION_LINK_REASON = 'Zahlung automatisch mit Rechnung verknüpft';
const TRANSACTION_UNLINK_REASON = 'Zahlungsverknüpfung aufgehoben';

const SHARED_HTTP_ROUTE_KEYS = new Set<string>([
  'vat:getReport', 'vat:exportCsv', 'vat:exportPdf', 'einvoice:parse', 'documents:exportXRechnung', 'eur:exportDatev',
  'cash:listEntries', 'cash:listReceipts', 'cash:saveEntry', 'cash:saveReceipt', 'cash:deleteEntry', 'cash:matchEntry', 'cash:unmatchEntry', 'cash:listClosedPeriods', 'cash:closePeriod', 'cash:listFiles', 'cash:uploadFile', 'cash:downloadFile',
  'invoices:list', 'invoices:upsert', 'invoices:delete', 'invoices:savePayment', 'invoices:removePayment',
  'offers:list', 'offers:upsert', 'offers:delete',
  'clients:list', 'clients:upsert', 'clients:delete',
  'projects:list', 'projects:get', 'projects:upsert', 'projects:archive',
  'articles:list', 'articles:upsert', 'articles:delete',
  'accounts:list', 'accounts:upsert', 'accounts:delete',
  'documentTemplates:list', 'documentTemplates:upsert', 'documentTemplates:delete',
  'documentTemplates:getDefaults', 'documentTemplates:setDefault', 'documents:renderContext',
  'taxFiling:getStatus', 'taxFiling:listRecords', 'taxFiling:installCertificate', 'taxFiling:removeCertificate',
  'taxFiling:validate', 'taxFiling:export', 'taxFiling:submit',
  'recurring:list', 'recurring:upsert', 'recurring:delete', 'recurring:manualRun',
  'settings:get', 'settings:set',
  'numbers:reserve', 'numbers:release', 'numbers:finalize',
  'documents:createFromClient', 'documents:convertOfferToInvoice',
  'documents:chainCreate', 'documents:chainIssue', 'documents:chainList',
  'audit:verify', 'audit:exportCsv',
  'portal:health', 'portal:publishOffer', 'portal:publishInvoice', 'portal:syncOfferStatus',
  'portal:createCustomerAccessLink', 'portal:rotateCustomerAccessLink',
  'email:send', 'email:testConfig', 'dunning:manualRun', 'dunning:getInvoiceStatus', 'dunning:listDeliveries', 'dunning:resolveDelivery',
  'transactions:list', 'transactions:findMatches', 'transactions:link', 'transactions:unlink',
  'finance:importPreview', 'finance:importCommit', 'finance:listImportBatches',
  'finance:getImportBatchDetails', 'finance:rollbackImportBatch',
  'cliAccess:pending', 'cliAccess:decide', 'cliAccess:list', 'cliAccess:revoke',
  'team:list', 'team:invite', 'team:revokeInvitation', 'team:changeRole', 'team:remove',
]);

export const isSharedHttpRoute = (key: string): boolean => SHARED_HTTP_ROUTE_KEYS.has(key);

type ServerClient = z.output<typeof serverClientSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const serverRenderContextSchema = documentRenderContextSchema.extend({ document: serverRenderDocumentSchema });
const reservationSchema = z.object({ reservationId: z.string().min(1), number: z.string().min(1) });
const serverTransactionMatchesSchema = z.object({
  // The transaction shape is product-specific and checked by the route result below.
  transaction: z.unknown(),
  suggestions: z.array(z.object({
    invoice: serverInvoiceSchema,
    confidence: z.enum(['high', 'medium', 'low']),
    matchReasons: z.array(z.string()),
    amountDiff: z.number(),
  })),
});

const toIsoDate = (value: Date): string => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

const addDays = (value: string, days: number): string => {
  if (!days) return value;
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return toIsoDate(next);
};

const chainEndpoint = (operation: IpcArgs<'documents:chainCreate'>['operation']): string => {
  switch (operation) {
    case 'order_confirmation': return 'order-confirmations';
    case 'delivery_note': return 'delivery-notes';
    case 'settlement_invoice': return 'settlement-invoices';
    case 'correction': return 'corrections';
    default: return 'revisions';
  }
};

const buildDraftFromClient = (
  kind: 'invoice' | 'offer',
  client: ServerClient,
  paymentTermsDays: number,
  reservation: { reservationId: string; number: string },
) => {
  const billingAddress = chooseDefaultBillingAddress(client.addresses);
  const shippingAddress = client.addresses.find((address) => address.isDefaultShipping) ?? billingAddress ?? null;
  const billingEmail = chooseDefaultBillingEmail(client.emails);
  const activeProject =
    client.projects.find((project) => project.name === 'Allgemein' && project.status !== 'archived')
    ?? client.projects.find((project) => project.status !== 'archived')
    ?? client.projects[0];
  const today = toIsoDate(new Date());
  return {
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
    ...(client.taxProfile?.buyerReference ? { taxMeta: { buyerReference: client.taxProfile.buyerReference } } : {}),
    date: today,
    dueDate: kind === 'offer' ? today : addDays(today, paymentTermsDays),
    amount: 0,
    status: 'draft',
    items: [],
    payments: [],
    history: [],
  };
};

/**
 * Serves the routes Lite and Pro share over `/api/v1/{product}`. Callers pass
 * arguments already parsed against their own contract.
 */
export const createSharedHttpInvoke = ({ product, routes, reasons, transport }: SharedHttpOptions) => {
  const prefix = `/api/v1/${product}`;
  const scope = createSingleTenantScope('default', product);
  const { requestJson, requestText } = transport;
  const resultOf = (key: string): HttpParser<unknown> => routes[key]!.result;
  const reserveNumber = (kind: 'invoice' | 'offer' | 'customer') =>
    requestJson('POST', `${prefix}/numbers/reserve`, reservationSchema, { kind });
  const getSettings = () => requestJson('GET', `${prefix}/settings`, resultOf('settings:get'));

  const run = async (key: IpcRouteKey, args: unknown): Promise<unknown> => {
    switch (key) {
      case 'vat:getReport':
      case 'vat:exportCsv':
      case 'vat:exportPdf': {
        const parsed = args as IpcArgs<'vat:getReport'>;
        const endpoint = key === 'vat:getReport' ? '' : key === 'vat:exportPdf' ? '/export/pdf' : '/export/csv';
        return requestJson('GET', `${prefix}/reports/vat${endpoint}?from=${encodeURIComponent(parsed.from)}&to=${encodeURIComponent(parsed.to)}`, resultOf(key));
      }
      case 'eur:exportDatev': {
        // Lite only: Pro exports DATEV from its ledger (`/accounting/datev/export.csv`).
        const parsed = args as IpcArgs<'eur:exportDatev'>;
        return requestJson('GET', `${prefix}/eur/datev.csv`, resultOf(key), undefined, { from: parsed.from, to: parsed.to });
      }
      case 'einvoice:parse': return requestJson('POST', `${prefix}/einvoice/parse`, resultOf(key), args);
      case 'documents:exportXRechnung':
        return requestJson('GET', `${prefix}/documents/invoice/${encodeURIComponent((args as IpcArgs<'documents:exportXRechnung'>).id)}/xrechnung`, resultOf(key));
      case 'cash:listEntries': return requestJson('GET', `${prefix}/cash/entries`, resultOf(key));
      case 'cash:listReceipts': return requestJson('GET', `${prefix}/cash/receipts`, resultOf(key));
      case 'cash:listClosedPeriods': return requestJson('GET', `${prefix}/cash/periods`, resultOf(key));
      case 'cash:closePeriod': return requestJson('POST', `${prefix}/cash/periods/close`, resultOf(key), args);
      case 'cash:saveEntry': return requestJson('POST', `${prefix}/cash/entries`, resultOf(key), args);
      case 'cash:saveReceipt': return requestJson('POST', `${prefix}/cash/receipts`, resultOf(key), args);
      case 'cash:deleteEntry': {
        const parsed = args as IpcArgs<'cash:deleteEntry'>;
        return requestJson('DELETE', `${prefix}/cash/entries/${encodeURIComponent(parsed.id)}`, resultOf(key), parsed);
      }
      case 'cash:matchEntry':
      case 'cash:unmatchEntry': {
        const parsed = args as IpcArgs<'cash:matchEntry'>;
        return requestJson('POST', `${prefix}/cash/entries/${encodeURIComponent(parsed.id)}/${key === 'cash:matchEntry' ? 'match' : 'unmatch'}`, resultOf(key), parsed);
      }
      case 'cash:listFiles':
      case 'cash:uploadFile': {
        const parsed = args as IpcArgs<'cash:uploadFile'>;
        return requestJson(key === 'cash:listFiles' ? 'GET' : 'POST', `${prefix}/cash/receipts/${encodeURIComponent(parsed.receiptId)}/files`, resultOf(key), key === 'cash:uploadFile' ? parsed : undefined);
      }
      case 'cash:downloadFile': {
        const parsed = args as IpcArgs<'cash:downloadFile'>;
        return requestJson('GET', `${prefix}/cash/files/${encodeURIComponent(parsed.id)}`, resultOf(key));
      }
      case 'invoices:list': {
        const invoices = await requestJson('GET', `${prefix}/invoices`, z.array(serverInvoiceSchema));
        return invoices.map((invoice) => toLegacyInvoice(invoice));
      }
      case 'invoices:upsert': {
        const parsed = args as IpcArgs<'invoices:upsert'>;
        const { tenantId: _tenantId, ...invoice } = toDomainInvoice(scope, parsed.invoice);
        return toLegacyInvoice(await requestJson('POST', `${prefix}/invoices`, serverInvoiceSchema, { reason: parsed.reason, invoice, reservationId: parsed.invoice.numberReservationId }));
      }
      case 'invoices:delete': {
        const parsed = args as IpcArgs<'invoices:delete'>;
        return requestJson('DELETE', `${prefix}/invoices/${encodeURIComponent(parsed.id)}`, okSchema, { reason: parsed.reason });
      }
      case 'invoices:savePayment': {
        const parsed = args as IpcArgs<'invoices:savePayment'>;
        return toLegacyInvoice(await requestJson('POST', `${prefix}/invoices/${encodeURIComponent(parsed.invoiceId)}/payments`, serverInvoiceSchema, parsed));
      }
      case 'invoices:removePayment': {
        const parsed = args as IpcArgs<'invoices:removePayment'>;
        return toLegacyInvoice(await requestJson('POST', `${prefix}/invoices/${encodeURIComponent(parsed.invoiceId)}/payments/${encodeURIComponent(parsed.expectedPayment.id)}/reverse`, serverInvoiceSchema, parsed));
      }
      case 'offers:list': {
        const offers = await requestJson('GET', `${prefix}/offers`, z.array(serverOfferSchema));
        return offers.map((offer) => toLegacyOffer(offer));
      }
      case 'offers:upsert': {
        const parsed = args as IpcArgs<'offers:upsert'>;
        const { tenantId: _tenantId, ...offer } = toDomainOffer(scope, parsed.offer);
        return toLegacyOffer(await requestJson('POST', `${prefix}/offers`, serverOfferSchema, { reason: parsed.reason, offer, reservationId: parsed.offer.numberReservationId }));
      }
      case 'offers:delete': {
        const parsed = args as IpcArgs<'offers:delete'>;
        return requestJson('DELETE', `${prefix}/offers/${encodeURIComponent(parsed.id)}`, okSchema, { reason: parsed.reason });
      }
      case 'clients:list':
        return requestJson('GET', `${prefix}/clients`, z.array(serverClientSchema));
      case 'clients:upsert': {
        const parsed = args as IpcArgs<'clients:upsert'>;
        return requestJson('POST', `${prefix}/clients`, serverClientSchema, { reason: parsed.reason ?? reasons.clientUpsert, client: parsed.client });
      }
      case 'clients:delete': {
        const parsed = args as IpcArgs<'clients:delete'>;
        return requestJson('DELETE', `${prefix}/clients/${encodeURIComponent(parsed.id)}`, okSchema, { reason: reasons.clientDelete });
      }
      case 'projects:list': {
        const parsed = args as IpcArgs<'projects:list'>;
        return requestJson('GET', `${prefix}/projects`, resultOf(key), undefined, {
          clientId: parsed.clientId,
          includeArchived: parsed.includeArchived,
        });
      }
      case 'projects:get': {
        const parsed = args as IpcArgs<'projects:get'>;
        return requestJson('GET', `${prefix}/projects/${encodeURIComponent(parsed.id)}`, resultOf(key));
      }
      case 'projects:upsert': {
        const parsed = args as IpcArgs<'projects:upsert'>;
        return requestJson('POST', `${prefix}/projects`, resultOf(key), { reason: parsed.reason, project: parsed.project });
      }
      case 'projects:archive': {
        const parsed = args as IpcArgs<'projects:archive'>;
        return requestJson('POST', `${prefix}/projects/${encodeURIComponent(parsed.id)}/archive`, resultOf(key), { reason: parsed.reason });
      }
      case 'articles:list':
        return requestJson('GET', `${prefix}/articles`, resultOf(key));
      case 'articles:upsert': {
        const parsed = args as IpcArgs<'articles:upsert'>;
        return requestJson('POST', `${prefix}/articles`, resultOf(key), { article: parsed.article });
      }
      case 'articles:delete': {
        const parsed = args as IpcArgs<'articles:delete'>;
        return requestJson('DELETE', `${prefix}/articles/${encodeURIComponent(parsed.id)}`, okSchema);
      }
      case 'accounts:list':
        return requestJson('GET', `${prefix}/accounts`, resultOf(key));
      case 'accounts:upsert': {
        const parsed = args as IpcArgs<'accounts:upsert'>;
        return requestJson('POST', `${prefix}/accounts`, resultOf(key), { account: parsed.account });
      }
      case 'accounts:delete': {
        const parsed = args as IpcArgs<'accounts:delete'>;
        return requestJson('DELETE', `${prefix}/accounts/${encodeURIComponent(parsed.id)}`, okSchema);
      }
      case 'documentTemplates:list': {
        const parsed = args as IpcArgs<'documentTemplates:list'>;
        return requestJson('GET', `${prefix}/document-templates`, resultOf(key), undefined, { kind: parsed?.kind });
      }
      case 'documentTemplates:upsert': {
        const parsed = args as IpcArgs<'documentTemplates:upsert'>;
        return requestJson('POST', `${prefix}/document-templates`, resultOf(key), { template: parsed.template });
      }
      case 'documentTemplates:delete': {
        const parsed = args as IpcArgs<'documentTemplates:delete'>;
        return requestJson('DELETE', `${prefix}/document-templates/${encodeURIComponent(parsed.id)}`, okSchema);
      }
      case 'documentTemplates:getDefaults':
        return requestJson('GET', `${prefix}/document-templates/defaults`, resultOf(key));
      case 'documentTemplates:setDefault':
        return requestJson('PUT', `${prefix}/document-templates/defaults`, okSchema, args);
      case 'cliAccess:pending':
        return requestJson('GET', `${prefix}/cli-access/pending`, resultOf(key), undefined, { code: (args as IpcArgs<'cliAccess:pending'>).code });
      case 'cliAccess:decide':
        return requestJson('POST', `${prefix}/cli-access/decide`, okSchema, args);
      case 'cliAccess:list':
        return requestJson('GET', `${prefix}/cli-access/tokens`, resultOf(key));
      case 'cliAccess:revoke':
        return requestJson('DELETE', `${prefix}/cli-access/tokens/${encodeURIComponent((args as IpcArgs<'cliAccess:revoke'>).id)}`, okSchema);
      case 'team:list':
        return requestJson('GET', `${prefix}/team`, resultOf(key));
      case 'team:invite':
        return requestJson('POST', `${prefix}/team/invitations`, resultOf(key), args);
      case 'team:revokeInvitation':
        return requestJson('DELETE', `${prefix}/team/invitations/${encodeURIComponent((args as IpcArgs<'team:revokeInvitation'>).id)}`, okSchema);
      case 'team:changeRole': {
        const { userId, role } = args as IpcArgs<'team:changeRole'>;
        return requestJson('PUT', `${prefix}/team/members/${encodeURIComponent(userId)}`, okSchema, { role });
      }
      case 'team:remove':
        return requestJson('DELETE', `${prefix}/team/members/${encodeURIComponent((args as IpcArgs<'team:remove'>).userId)}`, okSchema);
      case 'documents:renderContext': {
        const parsed = args as IpcArgs<'documents:renderContext'>;
        const context = await requestJson(
          'GET',
          `${prefix}/documents/${parsed.kind}/${encodeURIComponent(parsed.id)}/render-context`,
          serverRenderContextSchema,
          undefined,
          { level: parsed.level },
        );
        return toDesktopRenderContext(context);
      }
      case 'taxFiling:getStatus':
        return requestJson('GET', `${prefix}/tax-filing/status`, resultOf(key));
      case 'taxFiling:listRecords':
        return requestJson('GET', `${prefix}/tax-filing/records`, resultOf(key));
      case 'taxFiling:installCertificate':
        return requestJson('POST', `${prefix}/tax-filing/certificates`, resultOf(key), args);
      case 'taxFiling:removeCertificate': {
        const parsed = args as IpcArgs<'taxFiling:removeCertificate'>;
        return requestJson('DELETE', `${prefix}/tax-filing/certificates/${encodeURIComponent(parsed.id)}`, resultOf(key));
      }
      case 'taxFiling:validate':
        return requestJson('POST', `${prefix}/tax-filing/validate`, resultOf(key), args);
      case 'taxFiling:export':
        return requestJson('POST', `${prefix}/tax-filing/export`, resultOf(key), args);
      case 'taxFiling:submit':
        return requestJson('POST', `${prefix}/tax-filing/submit`, resultOf(key), args);
      case 'recurring:list':
        return requestJson('GET', `${prefix}/recurring`, z.array(serverRecurringProfileSchema));
      case 'recurring:upsert': {
        const parsed = args as IpcArgs<'recurring:upsert'>;
        return requestJson('POST', `${prefix}/recurring`, serverRecurringProfileSchema, { reason: reasons.recurringUpsert, profile: parsed.profile });
      }
      case 'recurring:delete': {
        const parsed = args as IpcArgs<'recurring:delete'>;
        return requestJson('DELETE', `${prefix}/recurring/${encodeURIComponent(parsed.id)}`, okSchema, { reason: reasons.recurringDelete });
      }
      case 'recurring:manualRun': {
        const parsed = args as IpcArgs<'recurring:manualRun'>;
        return requestJson('POST', `${prefix}/recurring/manual-run`, resultOf(key), parsed?.profileId ? { profileId: parsed.profileId } : undefined);
      }
      case 'settings:get':
        return getSettings();
      case 'settings:set': {
        const parsed = args as IpcArgs<'settings:set'>;
        return requestJson('PUT', `${prefix}/settings`, okSchema, { settings: parsed.settings });
      }
      case 'numbers:reserve':
        return reserveNumber((args as IpcArgs<'numbers:reserve'>).kind);
      case 'numbers:release': {
        const parsed = args as IpcArgs<'numbers:release'>;
        return requestJson('POST', `${prefix}/numbers/release`, okSchema, { reservationId: parsed.reservationId });
      }
      case 'numbers:finalize': {
        const parsed = args as IpcArgs<'numbers:finalize'>;
        return requestJson('POST', `${prefix}/numbers/finalize`, okSchema, { reservationId: parsed.reservationId, documentId: parsed.documentId });
      }
      case 'documents:createFromClient': {
        const parsed = args as IpcArgs<'documents:createFromClient'>;
        const client = await requestJson('GET', `${prefix}/clients/${encodeURIComponent(parsed.clientId)}`, serverClientSchema.nullable());
        if (!client) throw new Error('Kunde nicht gefunden.');
        const settings = await getSettings() as IpcResult<'settings:get'>;
        return buildDraftFromClient(parsed.kind, client, settings?.legal.paymentTermsDays ?? 0, await reserveNumber(parsed.kind));
      }
      case 'documents:convertOfferToInvoice': {
        const parsed = args as IpcArgs<'documents:convertOfferToInvoice'>;
        const saved = await requestJson('POST', `${prefix}/documents/convert-offer`, serverInvoiceSchema, {
          offerId: parsed.offerId, invoiceId: crypto.randomUUID(),
        });
        return toLegacyInvoice(saved);
      }
      case 'documents:chainCreate': {
        const { operation, ...body } = args as IpcArgs<'documents:chainCreate'>;
        return toLegacyInvoice(await requestJson('POST', `${prefix}/document-chain/${chainEndpoint(operation)}`, serverInvoiceSchema, body));
      }
      case 'documents:chainIssue':
        return toLegacyInvoice(await requestJson('POST', `${prefix}/document-chain/issue`, serverInvoiceSchema, args));
      case 'documents:chainList': {
        const parsed = args as IpcArgs<'documents:chainList'>;
        const documents = await requestJson('GET', `${prefix}/document-chain/${encodeURIComponent(parsed.rootDocumentId)}`, z.array(serverInvoiceSchema));
        return documents.map((document) => toLegacyInvoice(document));
      }
      case 'audit:verify':
        return requestJson('GET', `${prefix}/audit/verify`, resultOf(key));
      case 'audit:exportCsv':
        return requestText(`${prefix}/audit/export.csv`);
      case 'portal:health': {
        const parsed = args as IpcArgs<'portal:health'>;
        return requestJson('GET', `${prefix}/portal/health`, resultOf(key), undefined, { baseUrl: parsed.baseUrl });
      }
      case 'portal:publishOffer':
        return requestJson('POST', `${prefix}/portal/publish-offer`, resultOf(key), args);
      case 'portal:publishInvoice':
        return requestJson('POST', `${prefix}/portal/publish-invoice`, resultOf(key), args);
      case 'portal:syncOfferStatus':
        return requestJson('POST', `${prefix}/portal/sync-offer-status`, resultOf(key), args);
      case 'portal:createCustomerAccessLink':
        return requestJson('POST', `${prefix}/portal/customer-access-link`, resultOf(key), args);
      case 'portal:rotateCustomerAccessLink':
        return requestJson('POST', `${prefix}/portal/customer-access-link/rotate`, resultOf(key), args);
      case 'email:send':
        return requestJson('POST', `${prefix}/email/send`, resultOf(key), args);
      case 'email:testConfig': {
        // Provider credentials are server-side only. Never forward optional
        // desktop keychain values through the browser/HTTP boundary.
        const { smtpPassword: _smtpPassword, resendApiKey: _resendApiKey, ...serverConfig } = args as IpcArgs<'email:testConfig'>;
        return requestJson('POST', `${prefix}/email/test-config`, resultOf(key), serverConfig);
      }
      case 'dunning:listDeliveries': return requestJson('GET', `${prefix}/dunning/deliveries`, resultOf(key));
      case 'dunning:resolveDelivery': return requestJson('POST', `${prefix}/dunning/deliveries/resolve`, resultOf(key), args);
      case 'dunning:manualRun':
        return requestJson('POST', `${prefix}/dunning/manual-run`, resultOf(key));
      case 'dunning:getInvoiceStatus': {
        const parsed = args as IpcArgs<'dunning:getInvoiceStatus'>;
        return requestJson('GET', `${prefix}/dunning/invoices/${encodeURIComponent(parsed.invoiceId)}/status`, resultOf(key));
      }
      case 'transactions:list': {
        const parsed = args as IpcArgs<'transactions:list'>;
        return requestJson('GET', `${prefix}/transactions`, resultOf(key), undefined, {
          accountId: parsed.accountId,
          type: parsed.type,
          linkedOnly: parsed.linkedOnly,
          unlinkedOnly: parsed.unlinkedOnly,
        });
      }
      case 'transactions:findMatches': {
        const parsed = args as IpcArgs<'transactions:findMatches'>;
        const matches = await requestJson('GET', `${prefix}/transactions/${encodeURIComponent(parsed.transactionId)}/matches`, serverTransactionMatchesSchema);
        return {
          transaction: matches.transaction,
          suggestions: matches.suggestions.map((suggestion) => ({ ...suggestion, invoice: toLegacyInvoice(suggestion.invoice) })),
        };
      }
      case 'transactions:link': {
        const parsed = args as IpcArgs<'transactions:link'>;
        const result = await requestJson(
          'POST',
          `${prefix}/transactions/${encodeURIComponent(parsed.transactionId)}/link`,
          z.object({ success: z.literal(true), invoice: serverInvoiceSchema }),
          { invoiceId: parsed.invoiceId, appliedAmountCents: parsed.appliedAmountCents, reason: TRANSACTION_LINK_REASON },
        );
        return { success: result.success, invoice: toLegacyInvoice(result.invoice) };
      }
      case 'transactions:unlink': {
        const parsed = args as IpcArgs<'transactions:unlink'>;
        return requestJson('POST', `${prefix}/transactions/${encodeURIComponent(parsed.transactionId)}/unlink`, z.object({ success: z.literal(true) }), {
          reason: TRANSACTION_UNLINK_REASON,
        });
      }
      case 'finance:importPreview':
        return requestJson('POST', `${prefix}/finance/import/preview`, resultOf(key), args);
      case 'finance:importCommit':
        return requestJson('POST', `${prefix}/finance/import/commit`, resultOf(key), args);
      case 'finance:listImportBatches': {
        const parsed = args as IpcArgs<'finance:listImportBatches'>;
        return requestJson('GET', `${prefix}/finance/import-batches`, resultOf(key), undefined, { accountId: parsed.accountId, limit: parsed.limit });
      }
      case 'finance:getImportBatchDetails': {
        const parsed = args as IpcArgs<'finance:getImportBatchDetails'>;
        return requestJson('GET', `${prefix}/finance/import-batches/${encodeURIComponent(parsed.batchId)}`, resultOf(key));
      }
      case 'finance:rollbackImportBatch': {
        const parsed = args as IpcArgs<'finance:rollbackImportBatch'>;
        return requestJson('POST', `${prefix}/finance/import-batches/${encodeURIComponent(parsed.batchId)}/rollback`, resultOf(key), { reason: parsed.reason });
      }
      default:
        throw new Error(`Route ${key} wird nicht gemeinsam über HTTP bedient.`);
    }
  };

  return async (key: string, args: unknown): Promise<unknown> =>
    routes[key]!.result.parse(await run(key as IpcRouteKey, args));
};
