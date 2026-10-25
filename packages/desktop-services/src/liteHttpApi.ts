import { z } from 'zod';
import { isSupportedEurTaxYear } from '@billme/accounting-shared';
import { createBillmeApi, type BillmeApi, type IpcInvoke } from '@billme/desktop-contracts/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts/contract';
import type { EmbeddedConnection } from '@billme/desktop-contracts/embeddedConnection';
import { eurRuleSchema } from '@billme/desktop-contracts/schemas';
import { vatValidationResultSchema } from '@billme/server-core';
import { isNativeElectronRoute, isServerOwnedRoute } from './serverRouteClassification';
import { createSharedHttpInvoke, isSharedHttpRoute, type HttpParser, type HttpQuery } from './sharedHttpRoutes';

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
  downloadFile?: (blob: Blob, fileName: string) => void;
};

const PRODUCT_PREFIX = '/api/v1/lite';
const EUR_RULE_MUTATION_REASON = 'EÜR-Klassifikationsregel gespeichert';
const EUR_RULE_DELETE_REASON = 'EÜR-Klassifikationsregel gelöscht';

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

const parseResult = <K extends IpcRouteKey>(key: K, value: unknown): IpcResult<K> => {
  return ipcRoutes[key].result.parse(value) as IpcResult<K>;
};

const parseResponseError = (status: number, payload: unknown): Error => {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return new Error(payload.message);
  }
  return new Error(`Anfrage fehlgeschlagen (HTTP ${status}).`);
};

const eurTaxYearSchema = z.number().int().refine(isSupportedEurTaxYear, 'Unsupported EÜR year');

const serverEurClassificationSchema = z.object({
  id: z.string(),
  sourceType: z.enum(['transaction', 'invoice', 'manual']),
  sourceId: z.string(),
  taxYear: eurTaxYearSchema,
  eurLineId: z.string().optional(),
  excluded: z.boolean(),
  vatMode: z.enum(['none', 'default']),
  vatRate: z.number().optional(),
  note: z.string().optional(),
  kind: z.enum(['private-withdrawal', 'private-contribution', 'transit']).optional(),
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
  unclassified: z.object({ incomeCount: z.number().int(), incomeAmount: z.number(), expenseCount: z.number().int(), expenseAmount: z.number() }).optional(),
  warnings: z.array(z.string()),
  catalog: z.object({ id: z.string(), title: z.string().optional(), version: z.string(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), delivery: z.enum(['print-form-only', 'elster-ready']), elsterReady: z.boolean(), provisional: z.boolean().optional() }),
});

const serverEurItemSchema = z.object({
  sourceType: z.enum(['transaction', 'invoice', 'manual']),
  sourceId: z.string(),
  date: z.string(),
  taxYear: z.number().int().optional(),
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
  suggestedKind: z.enum(['transit', 'private-withdrawal', 'private-contribution']).optional(),
  kind: z.enum(['income', 'expense', 'private-withdrawal', 'private-contribution', 'pass-through', 'transit']).optional(),
  transitHint: z.string().optional(),
  splits: z.array(z.object({ amountNet: z.number(), deductibility: z.enum(['deductible', 'non-deductible']).optional(), lineId: z.string().optional(), reason: z.string().optional() })).optional(),
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
  downloadFile,
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

  const requestJson = async <T>(
    method: string,
    path: string,
    schema: HttpParser<T>,
    body?: unknown,
    query?: HttpQuery,
  ): Promise<T> => {
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

  const requestText = async (path: string): Promise<string> => {
    const connection = await resolveHttpConnection();
    if (!connection) throw new Error('Der lokale Billme-Server ist noch nicht verfügbar.');
    const authHeaders: Record<string, string> = connection.auth.mode === 'embedded'
      ? { 'x-billme-local-token': connection.auth.token }
      : { authorization: `Bearer ${connection.auth.token}` };
    const response = await fetchImpl(`${normalizeBaseUrl(connection.baseUrl)}${path}`, { method: 'GET', headers: authHeaders });
    const payload = await response.text();
    if (response.status === 401) onAuthFailure?.();
    if (!response.ok) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(payload); } catch { /* keep text fallback */ }
      throw parseResponseError(response.status, parsed ?? payload);
    }
    return payload;
  };

  const sharedInvoke = createSharedHttpInvoke({
    product: 'lite',
    routes: ipcRoutes,
    reasons: {
      clientUpsert: 'Updated in Billme Lite web shell',
      clientDelete: 'Deleted in Billme Lite web shell',
      recurringUpsert: 'Updated recurring profile in Billme Lite web shell',
      recurringDelete: 'Deleted recurring profile in Billme Lite web shell',
    },
    transport: { requestJson, requestText },
  });

  const invoke = async <K extends IpcRouteKey>(key: K, rawArgs: IpcArgs<K>): Promise<IpcResult<K>> => {
    if (!Object.prototype.hasOwnProperty.call(ipcRoutes, key)) {
      throw new Error(`Die Lite-HTTP-Laufzeit unterstützt die IPC-Route ${String(key)} nicht.`);
    }
    const args = ipcRoutes[key].args.parse(rawArgs) as IpcArgs<K>;
    if (downloadFile && (key === 'pdf:export' || key === 'eur:exportPdf')) {
      const connection = await resolveHttpConnection();
      if (!connection) throw new Error('Der Billme-Server ist noch nicht verfügbar.');
      const pdf = args as IpcArgs<'pdf:export'>;
      const eur = args as IpcArgs<'eur:exportPdf'>;
      const path = key === 'pdf:export'
        ? `${PRODUCT_PREFIX}/documents/${pdf.kind}/${encodeURIComponent(pdf.id)}/pdf${pdf.level ? `?level=${pdf.level}` : ''}`
        : `${PRODUCT_PREFIX}/reports/eur/pdf?taxYear=${eurReportQuery(eur).taxYear}`;
      const response = await fetchImpl(`${normalizeBaseUrl(connection.baseUrl)}${path}`, { headers: connection.auth.mode === 'embedded' ? { 'x-billme-local-token': connection.auth.token } : { authorization: `Bearer ${connection.auth.token}` } });
      if (response.status === 401) onAuthFailure?.();
      if (!response.ok) throw parseResponseError(response.status, await response.json().catch(() => null));
      const blob = await response.blob();
      if (await blob.slice(0, 5).text() !== '%PDF-') throw new Error('Der Server hat keine gültige PDF-Datei geliefert.');
      const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
      let fileName = key === 'pdf:export' ? `${pdf.kind}-${pdf.id}.pdf` : `anlage-euer-${eur.taxYear}.pdf`;
      if (encodedName) { try { fileName = decodeURIComponent(encodedName).replace(/[\\/\x00-\x1f]/g, '_'); } catch { /* use fallback name */ } }
      downloadFile(blob, fileName);
      return parseResult(key, { path: fileName });
    }

    if (embeddedConnectionResolver && isServerOwnedRoute(key)) {
      const connection = await resolveHttpConnection();
      if (!connection) {
        if (fallback) return fallback(key, args);
        throw new Error('Der lokale Billme-Server ist noch nicht verfügbar.');
      }
    }

    if (isSharedHttpRoute(key)) return sharedInvoke(key, args) as Promise<IpcResult<K>>;

    switch (key) {
      case 'transactions:setRecurring': {
        const parsed = args as IpcArgs<'transactions:setRecurring'>;
        return requestJson('POST', `${PRODUCT_PREFIX}/transactions/${encodeURIComponent(parsed.transactionId)}/recurring`, z.object({ success: z.literal(true) }), {
          recurring: parsed.recurring,
          reason: parsed.recurring ? 'Als regelmäßig wiederkehrend markiert (10-Tage-Regel, § 11 EStG)' : 'Markierung regelmäßig wiederkehrend entfernt',
        }) as Promise<IpcResult<K>>;
      }
      case 'eur:getReport': {
        const parsed = args as IpcArgs<'eur:getReport'>;
        const query = eurReportQuery(parsed);
        return mapEurReport(await requestJson('GET', `${PRODUCT_PREFIX}/reports/eur`, serverEurReportSchema, undefined, query), query) as IpcResult<K>;
      }
      case 'eur:listItems': {
        const parsed = args as IpcArgs<'eur:listItems'>;
        const query = { ...eurReportQuery(parsed), status: parsed.status, flowType: parsed.flowType, sourceType: parsed.sourceType, search: parsed.search, accountId: parsed.accountId, onlyUnclassified: parsed.onlyUnclassified, limit: parsed.limit, offset: parsed.offset };
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
