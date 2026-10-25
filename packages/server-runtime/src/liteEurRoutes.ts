import type { FastifyInstance } from 'fastify';
import { buildDatevBuchungsstapelCsv, type DatevBuchungsstapelRow } from '@billme/accounting-engine/datev-export';
import { isSupportedEurTaxYear } from '@billme/accounting-shared';
import { datevSettingsSchema } from '@billme/desktop-contracts-pro/schemas';
import { getCatalogForYear } from '@billme/desktop-services/eurCatalog';
import { DATEV_MONEY_ACCOUNTS, DATEV_PRIVATE_ACCOUNTS, DATEV_TRANSIT_ACCOUNT, datevAccountFor } from '@billme/desktop-services/eur/datevAccountMap';
import { filterEurListItems } from '@billme/server-core';
import { createPostgresProAccountingRepository, getServerEurReport, getServerSettings, listServerEurAnnexFacts, periodClosedMessage, listServerEurCashFacts, listServerEurCashItems, saveServerEurAnnexFact, saveServerEurCashFact, saveServerEurClassificationFact, type ServerEurCashItem } from '@billme/server-data';
import { z } from 'zod';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSessionFor, requireSession } from './runtimeContext.js';

const eurTaxYear = z.number().int().refine(isSupportedEurTaxYear, 'Unsupported EÜR year');
const eurSplitSchema = z.object({ amountNet: z.number().finite().nonnegative(), deductibility: z.enum(['deductible', 'non-deductible']), lineId: z.string().trim().min(1).optional(), reason: z.string().trim().min(1) });

export const liteEurReportQuerySchema = z.object({
  taxYear: z.coerce.number().int().refine(isSupportedEurTaxYear, 'Unsupported EÜR year').optional(), from: z.string().optional(), to: z.string().optional(),
}).superRefine((value, ctx) => {
  const year = value.taxYear ?? 2025;
  if (value.taxYear === undefined && ((value.from && !value.from.startsWith('2025-')) || (value.to && !value.to.startsWith('2025-')))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxYear'], message: 'taxYear is required after 2025' });
  if (value.from !== undefined && value.from !== `${year}-01-01`) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: `EÜR requires ${year}-01-01.` });
  if (value.to !== undefined && value.to !== `${year}-12-31`) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `EÜR requires ${year}-12-31.` });
}).transform((value) => ({ ...(value.taxYear === undefined ? {} : { taxYear: value.taxYear }), from: value.from ?? `${value.taxYear ?? 2025}-01-01`, to: value.to ?? `${value.taxYear ?? 2025}-12-31` }));

export const liteEurClassificationBodySchema = z.object({
  sourceType: z.enum(['transaction', 'invoice', 'manual']),
  sourceId: z.string().trim().min(1),
  taxYear: eurTaxYear,
  eurLineId: z.string().trim().min(1).optional(),
  excluded: z.boolean().default(false),
  vatMode: z.enum(['none', 'default']).default('none'),
  vatRate: z.number().min(0).max(100).optional(),
  note: z.string().max(1000).optional(),
  /** Privatentnahme, Privateinlage or Geldtransit: neutral, instead of an EÜR line. */
  kind: z.enum(['private-withdrawal', 'private-contribution', 'transit']).optional(),
  /** Aufteilung of the net amount (e.g. Bewirtung 70 % abziehbar, 30 % nicht abziehbar); the parts add up to the net. */
  splits: z.array(eurSplitSchema).min(2).max(10).optional(),
  reason: z.string().trim().min(1),
});
export const liteEurCashFactBodySchema = z.object({
  sourceType: z.enum(['transaction', 'invoice', 'manual']), sourceId: z.string().trim().min(1), taxYear: eurTaxYear, kind: z.enum(['income', 'expense', 'private-withdrawal', 'private-contribution', 'pass-through', 'transit']), amountNet: z.number().finite().nonnegative(), flowType: z.enum(['income', 'expense']).optional(), eurLineId: z.string().trim().min(1).optional(), splits: z.array(z.object({ amountNet: z.number().finite().nonnegative(), deductibility: z.enum(['deductible', 'non-deductible']).optional(), classification: z.enum(['deductible', 'non-deductible']).optional(), deductible: z.boolean().optional(), lineId: z.string().trim().min(1).optional(), reason: z.string().trim().min(1), auditId: z.string().trim().min(1).optional() })).optional(), idempotencyKey: z.string().trim().min(1).optional(), reason: z.string().trim().min(1),
});
export const liteEurAnnexFactBodySchema = z.object({ taxYear: eurTaxYear, annex: z.string().trim().min(1), lineId: z.string().trim().min(1), amount: z.number().finite(), sourceId: z.string().trim().min(1).optional(), date: z.string().optional(), idempotencyKey: z.string().trim().min(1).optional(), reason: z.string().trim().min(1) });

const mapEurError = (error: unknown): never => {
  if (!(error instanceof Error)) throw error;
  if (error.message === 'EUR_PROFILE_REQUIRED') throw new ApiError(409, 'EÜR ist nur für ein Einzelunternehmen mit Gewinnermittlung EÜR verfügbar.');
  if (error.message === 'EUR_RANGE_2025_REQUIRED' || error.message === 'EUR_RANGE_2026_REQUIRED') throw new ApiError(400, 'EÜR verwendet ausschließlich vollständige Kalenderjahre.');
  if (error.message === 'EUR_SERVER_REPORT_UNAVAILABLE') throw new ApiError(503, 'Native EÜR-Daten sind derzeit nicht verfügbar.');
  if (error.message === 'EUR_SOURCE_NOT_FOUND') throw new ApiError(400, 'Die EÜR-Cash-Quelle ist im gewählten Kalenderzeitraum nicht vorhanden.');
  if (error.message === 'EUR_FACT_IDEMPOTENCY_CONFLICT') throw new ApiError(409, error.message);
  if (error.message === 'LITE_PERIOD_CLOSED') throw new ApiError(409, periodClosedMessage((error as Error & { period?: string }).period ?? ''));
  if (error.message === 'EUR_TRANSIT_NOT_CLASSIFIABLE') throw new ApiError(400, 'Eine mit dem Bankumsatz abgeglichene Bareinzahlung oder Barabhebung ist Geldtransit und keine Einnahme oder Ausgabe. Bitte zuerst den Abgleich aufheben.');
  if (error.message === 'EUR_GIFT_NO_INPUT_VAT') throw new ApiError(400, 'Für Geschenke über 50 € ist keine Vorsteuer abziehbar (§ 15 Abs. 1a UStG). Bitte ohne Umsatzsteuer zuordnen.');
  if (error.message === 'EUR_SPLIT_ALLOCATION_MISMATCH') throw new ApiError(400, 'Die Teile ergeben nicht den Nettobetrag der Zahlung.');
  if (error.message === 'EUR_SPLIT_NON_DEDUCTIBLE_LINE') throw new ApiError(400, 'Ein nicht abziehbarer Teil gehört in eine Spalte „nicht abziehbar“ (z. B. Kz 165), nicht auf eine abziehbare Zeile.');
  if (error.message === 'EUR_NEUTRAL_KIND_FLOW_MISMATCH') throw new ApiError(400, 'Eine Privatentnahme ist ein Abgang, eine Privateinlage ein Zugang.');
  if (/^EUR_(FACT|SPLIT|ANNEX|NEUTRAL)|^EUR_LINE_|^EUR_COMPUTED/.test(error.message)) throw new ApiError(400, error.message);
  throw error;
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, 'Ungültiges Datum.');
export const liteDatevExportQuerySchema = z.object({ from: isoDate, to: isoDate });

// CP1252 printable range; anything else in a free text becomes '?' so one emoji cannot fail the whole file.
const CP1252_TEXT = /[^\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;
const datevText = (value: string, max: number): string => value.replace(/\s+/g, ' ').replace(CP1252_TEXT, '?').trim().slice(0, max);
// A document number in a free text: letters, a separator and digits (RE-2026-204, B-4711, 0815-2026-17).
const DOCUMENT_NUMBER = /\b(?:[A-Za-z]{1,6}[-/]?)?\d{2,}(?:[-/]\d+)+\b|\b[A-Za-z]{1,6}[-/]?\d{3,}\b/;
/** Belegfeld 1: the invoice or receipt number, else a number in the purpose; empty rather than an internal id. */
const datevReference = (item: ServerEurCashItem): string => {
  const invoiceNumber = item.sourceType === 'invoice' ? /^Rechnung (\S+)/.exec(item.purpose)?.[1] : undefined;
  const inPurpose = DOCUMENT_NUMBER.exec(item.purpose)?.[0];
  // An IBAN in the purpose (DE02 1203 …) looks like a number but is an account, not a document.
  const reference = invoiceNumber ?? item.documentNumber ?? (inPurpose && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/.test(inPurpose) ? inPurpose : '');
  return reference.replace(/[^A-Za-z0-9_$&%*+\-/]/g, '-').slice(0, 36);
};
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** The VAT rate behind a gross EÜR item: the classification's rate, else gross/net; null when that is no 0/7/19 %. */
const itemVatRate = (item: ServerEurCashItem): number | null => {
  if (item.classification?.vatMode === 'default' && item.classification.vatRate !== undefined) return item.classification.vatRate;
  const gross = Math.abs(item.amountGross);
  const net = Math.abs(item.amountNet);
  if (net <= 0 || gross - net < 0.005) return 0;
  const rate = (gross / net - 1) * 100;
  return [19, 7].find((candidate) => Math.abs(candidate - rate) < 0.6) ?? null;
};

type DatevRowError = { sourceType: ServerEurCashItem['sourceType']; sourceId: string; date: string; amount: number; counterparty: string; message: string };

/**
 * EÜR cash items → DATEV rows. Konto is the bank account (Lite only knows bank lines; a manual entry
 * without a matched bank line has no known Geldkonto and is listed as an error instead of guessing
 * Kasse), Gegenkonto the account for the Kennziffer, because DATEV applies the BU-Schlüssel to the
 * Gegenkonto. S/H is from the Geldkonto's side: income S, expense H.
 * Privatentnahme/-einlage go to the private accounts and Geldtransit to the transit account, so the
 * bank account still matches the statement; a cash entry matched to the bank in the other direction
 * (Barabhebung/Bareinzahlung) is one row bank against Kasse. Durchlaufende Posten stay out, and an item
 * excluded before Privat/Geldtransit existed is listed as an error.
 */
const buildLiteDatevRows = (items: ServerEurCashItem[], args: { taxYear: number; from: string; to: string; chart: 'SKR03' | 'SKR04'; accountLength: number }) => {
  const kennziffer = new Map(getCatalogForYear(args.taxYear).map((line) => [line.id, line.kennziffer?.trim() || undefined]));
  const pad = (account: string) => account.padEnd(args.accountLength, '0');
  const rows: DatevBuchungsstapelRow[] = [];
  const errors: DatevRowError[] = [];
  for (const item of items) {
    const amount = round2(Math.abs(item.amountGross));
    const fail = (message: string) => errors.push({ sourceType: item.sourceType, sourceId: item.sourceId, date: item.date, amount, counterparty: item.counterparty, message });
    if (item.kind === 'pass-through' || amount === 0) continue;
    if (item.date < args.from || item.date > args.to) {
      // ponytail: a payment moved by the § 11 EStG 10-Tage-Regel has its Belegdatum in the neighbouring year,
      // outside this DATEV fiscal year; list it instead of dropping it. Replace once the advisor asks for an Abgrenzung booking.
      if ((item.date < args.from && args.from.endsWith('-01-01')) || (item.date > args.to && args.to.endsWith('-12-31'))) fail('Zahlung liegt außerhalb des Wirtschaftsjahres (10-Tage-Regel, § 11 EStG); bitte manuell buchen.');
      continue;
    }
    const neutral = item.kind === 'transit' || item.kind === 'private-withdrawal' || item.kind === 'private-contribution';
    // The money account: the bank of a matched line; for a manual entry without one its Zahlungsart decides.
    let money: { SKR03: string; SKR04: string } = DATEV_MONEY_ACCOUNTS.bank;
    if (item.sourceType === 'manual' && !item.accountId) {
      if (item.paymentMethod === 'bank') { fail('Als Bankzahlung erfasst, aber noch nicht mit dem Bankumsatz abgeglichen. Bitte abgleichen.'); continue; }
      if (!item.paymentMethod) { fail('Zahlungsart fehlt: Bank oder Kasse unbekannt. Bitte die Zahlungsart in der Buchung nachtragen oder mit dem Bankumsatz abgleichen.'); continue; }
      if (item.paymentMethod === 'non_cash' && neutral) { fail('Eine Buchung ohne Geldfluss kann keine Privatentnahme, Einlage oder Geldtransit sein.'); continue; }
      // Bar goes through the Kasse; a booking without money (Pauschale, Privatanteil) against the private account, never Kasse or Bank.
      money = item.paymentMethod === 'cash' ? DATEV_MONEY_ACCOUNTS.cash : DATEV_PRIVATE_ACCOUNTS[item.flowType === 'expense' ? 'contribution' : 'withdrawal'];
    }
    const base = { date: item.date, belegfeld1: datevReference(item), buchungstext: datevText(`${item.counterparty} ${item.purpose}`, 60), konto: pad(money[args.chart]), umsatz: amount };
    if (neutral) {
      // A matched Barabhebung/Bareinzahlung: the bank moves the other way than the cash entry, straight against Kasse.
      const bankIncome = item.sourceType === 'manual' && item.kind === 'transit' ? item.flowType === 'expense' : item.flowType === 'income';
      const gegen = item.kind === 'transit' ? (item.sourceType === 'manual' ? DATEV_MONEY_ACCOUNTS.cash : DATEV_TRANSIT_ACCOUNT) : DATEV_PRIVATE_ACCOUNTS[item.kind === 'private-withdrawal' ? 'withdrawal' : 'contribution'];
      rows.push({ ...base, gegenkonto: pad(gegen[args.chart]), sollHabenKennzeichen: bankIncome ? 'S' : 'H' });
      continue;
    }
    if (item.classification?.excluded) { fail('Ausgeschlossen ohne Art: Privat oder Geldtransit? Bitte neu zuordnen.'); continue; }
    const lineId = item.classification?.eurLineId;
    if (!lineId) { fail('Noch keiner EÜR-Kategorie zugeordnet.'); continue; }
    const rate = itemVatRate(item);
    if (rate === null) { fail('Steuersatz nicht eindeutig (weder 0, 7 noch 19 %).'); continue; }
    // A split (Bewirtung 70/30) is one row per part; the gross is shared in the ratio of the net parts, the last part takes the cents.
    const parts = (item.splits?.length ?? 0) > 1 ? item.splits! : [{ amountNet: 1, lineId }];
    const netTotal = parts.reduce((sum, part) => sum + Math.abs(part.amountNet), 0);
    const choices = parts.map((part) => datevAccountFor(kennziffer.get(part.lineId ?? lineId), rate, item.flowType, args.chart));
    const failed = choices.find((choice): choice is { error: string } => 'error' in choice);
    if (failed || netTotal <= 0) { fail(failed?.error ?? 'Aufteilung ohne Betrag.'); continue; }
    let rest = amount;
    choices.forEach((choice, index) => {
      if ('error' in choice) return;
      const umsatz = index === choices.length - 1 ? round2(rest) : round2(amount * Math.abs(parts[index]!.amountNet) / netTotal);
      rest -= umsatz;
      if (umsatz > 0) rows.push({ ...base, umsatz, gegenkonto: pad(choice.account), sollHabenKennzeichen: item.flowType === 'income' ? 'S' : 'H', buSchluessel: choice.buKey });
    });
  }
  return { rows, errors };
};

export const registerLiteEurRoutes = (app: FastifyInstance): void => {
  const prefix = '/api/v1/lite/reports/eur';

  typedRoute(app, {
    method: 'GET',
    url: '/api/v1/lite/eur/datev.csv',
    query: liteDatevExportQuerySchema,
    async handler({ request, query }) {
      const session = await requireSession(app, 'lite', request.headers.authorization);
      if (query.from > query.to) throw new ApiError(400, 'Der Zeitraum beginnt nach seinem Ende.');
      const taxYear = Number(query.from.slice(0, 4));
      if (query.to.slice(0, 4) !== query.from.slice(0, 4)) throw new ApiError(422, 'Ein DATEV-Buchungsstapel darf nur ein Wirtschaftsjahr enthalten. Bitte einen Zeitraum innerhalb eines Jahres wählen.');
      if (!isSupportedEurTaxYear(taxYear)) throw new ApiError(400, `Für ${taxYear} gibt es noch keine Anlage EÜR.`);
      const db = requireDatabase(app);
      const stored = await getServerSettings(db, session.scope.tenantId);
      const datev = datevSettingsSchema.safeParse(stored ? (JSON.parse(stored.settingsJson) as { datev?: unknown }).datev : undefined);
      if (!datev.success) throw new ApiError(422, 'Für den DATEV-Export fehlen Beraternummer und Mandantennummer. Bitte unter Einstellungen → Finanzen eintragen.');
      let items: ServerEurCashItem[];
      try {
        items = await listServerEurCashItems(db, session.scope, { taxYear, product: 'lite' });
      } catch (error) {
        return mapEurError(error);
      }
      const { rows, errors } = buildLiteDatevRows(items, { taxYear, from: query.from, to: query.to, chart: datev.data.chart, accountLength: datev.data.accountLength });
      let content: Buffer;
      try {
        content = buildDatevBuchungsstapelCsv(rows, {
          consultantNumber: datev.data.consultantNumber,
          clientNumber: datev.data.clientNumber,
          fiscalYearStart: `${taxYear}-01-01`,
          accountLength: datev.data.accountLength,
          chart: datev.data.chart,
          from: query.from,
          to: query.to,
          periodScope: 'fiscal-year',
          createdAt: new Date(),
          stackName: `EÜR ${query.from} bis ${query.to}`.slice(0, 30),
        });
      } catch (error) {
        throw new ApiError(422, error instanceof Error ? error.message : 'DATEV-Export fehlgeschlagen.');
      }
      return {
        fileName: `EXTF_Buchungsstapel_${query.from}_${query.to}.csv`,
        mimeType: 'text/csv' as const,
        contentBase64: content.toString('base64'),
        rowCount: rows.length,
        errors,
      };
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: prefix,
    query: liteEurReportQuerySchema,
    async handler({ request, query }) {
      const session = await requireSession(app, 'lite', request.headers.authorization);
      try {
        return await getServerEurReport(requireDatabase(app), session.scope, { ...query, product: 'lite' });
      } catch (error) {
        return mapEurError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/items`,
    query: liteEurReportQuerySchema.and(z.object({
      sourceType: z.enum(['transaction', 'invoice', 'manual']).optional(), flowType: z.enum(['income', 'expense']).optional(),
      status: z.enum(['all', 'unclassified', 'classified', 'excluded']).optional(), search: z.string().optional(), accountId: z.string().optional(),
      onlyUnclassified: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().positive().max(1000).optional(), offset: z.coerce.number().int().nonnegative().optional(),
    })),
    async handler({ request, query }) {
      const session = await requireSession(app, 'lite', request.headers.authorization);
      try {
        const items = await listServerEurCashItems(requireDatabase(app), session.scope, { ...query, product: 'lite' });
        return filterEurListItems(items, { ...query, onlyUnclassified: query.onlyUnclassified === 'true' });
      } catch (error) {
        return mapEurError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/classifications`,
    body: liteEurClassificationBodySchema,
    async handler({ request, body }) {
      const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization, 'EÜR-Klassifikation benötigt die Rolle owner, admin oder accountant.');
      // Without the rate the report could only book the gross amount and no Vorsteuer.
      if (body.vatMode === 'default' && body.vatRate === undefined && !body.excluded && !body.kind) throw new ApiError(400, 'Bitte den Umsatzsteuersatz angeben (z. B. 19 oder 7 %) oder „Ohne Umsatzsteuer“ wählen.');
      try {
        const input = {
          sourceType: body.sourceType,
          sourceId: body.sourceId,
          taxYear: body.taxYear,
          eurLineId: body.eurLineId,
          excluded: body.excluded,
          vatMode: body.vatMode,
          vatRate: body.vatRate,
          note: body.note,
          kind: body.kind,
          splits: body.splits,
          product: 'lite' as const,
          mutation: createMutationContext(session, body.reason),
        };
        return await saveServerEurClassificationFact(requireDatabase(app), session.scope, input);
      } catch (error) {
        return mapEurError(error);
      }
    },
  });

  typedRoute(app, { method: 'POST', url: `${prefix}/facts/cash`, body: liteEurCashFactBodySchema, async handler({ request, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization, 'EÜR-Fakten benötigen die Rolle owner, admin oder accountant.');
    try {
      return await saveServerEurCashFact(requireDatabase(app), session.scope, { ...body, product: 'lite', mutation: createMutationContext(session, body.reason) });
    } catch (error) {
      return mapEurError(error);
    }
  }});
  typedRoute(app, { method: 'POST', url: `${prefix}/facts/annex`, body: liteEurAnnexFactBodySchema, async handler({ request, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization, 'EÜR-Fakten benötigen die Rolle owner, admin oder accountant.');
    try {
      return await saveServerEurAnnexFact(requireDatabase(app), session.scope, { ...body, mutation: createMutationContext(session, body.reason) });
    } catch (error) {
      return mapEurError(error);
    }
  }});
  typedRoute(app, { method: 'GET', url: `${prefix}/facts/cash`, query: z.object({ taxYear: z.coerce.number().int().refine((year) => year === 2025 || year === 2026) }), async handler({ request, query }) {
    const session = await requireSession(app, 'lite', request.headers.authorization);
    return listServerEurCashFacts(requireDatabase(app), session.scope, query.taxYear);
  }});
  typedRoute(app, { method: 'GET', url: `${prefix}/facts/annex`, query: z.object({ taxYear: z.coerce.number().int().refine((year) => year === 2025 || year === 2026), annex: z.string().trim().min(1).optional() }), async handler({ request, query }) {
    const session = await requireSession(app, 'lite', request.headers.authorization);
    return listServerEurAnnexFacts(requireDatabase(app), session.scope, query.taxYear, query.annex);
  }});
};
