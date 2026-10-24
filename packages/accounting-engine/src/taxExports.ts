import { createHash } from 'node:crypto';
import {
  type EBilanzArtifact,
  type OssArtifact,
  type OssRow,
  type ReportSnapshot,
  type TaxCatalogProvenance,
  type TaxExportEntry,
  type TaxExportErrorCode,
  type TaxExportLine,
  type TaxExportPeriod,
  type TaxExportPreparation,
  type TaxReportSnapshotBinding,
  type UstvaArtifact,
  type UstvaComputation,
  type UstvaKennzahlCatalog,
  type UstvaRow,
  type UstvaSource,
  USTVA_LABELS,
  USTVA_TAX_KZ,
  ustvaContributions,
  type UnternehmensregisterArtifact,
  type ZmArtifact,
  type ZmRow,
} from '@billme/accounting-shared';
import { stableTaxFilingStringify } from './taxFiling.js';

export class TaxExportError extends Error {
  readonly code: TaxExportErrorCode;

  constructor(code: TaxExportErrorCode, message: string) {
    super(message);
    this.name = 'TaxExportError';
    this.code = code;
  }
}

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK',
]);

const PREPARATION_CATALOG: TaxCatalogProvenance = {
  id: 'ebilanzen-6.9-preparation',
  taxYear: 2025,
  version: '6.9-preparation',
  source: 'provider-catalog-unavailable',
  sourceHash: '0'.repeat(64),
  official: false,
};
/** UStVA/ZM/OSS run from 2025 on. Kennzahlen exist for the forms up to USTVA_LATEST_FORM_YEAR; a later year uses that form, marked provisional. */
const FIRST_TAX_YEAR = 2025;
export const USTVA_LATEST_FORM_YEAR = 2026;

/** Metadata for preparation only. This is not an official provider catalog. */
export const EBILANZ_6_9_PREPARATION_CATALOG = PREPARATION_CATALOG;

const cents = (value: number | undefined, field: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TaxExportError('MISSING_EVIDENCE', `${field} is required`);
  return Math.round(number * 100);
};
const amount = (value: number): number => value / 100;

const artifactHash = (value: unknown): string =>
  createHash('sha256').update(stableTaxFilingStringify(value)).digest('hex');

const assertIsoDate = (value: string, field = 'date'): void => {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    throw new TaxExportError('INVALID_PERIOD', `${field} must use YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== value) throw new TaxExportError('INVALID_PERIOD', `${field} is not a calendar date`);
};

const periodBounds = (input: TaxExportPeriod): { period: string; year: number; from: string; to: string } => {
  const period = input.period.trim();
  let match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (input.year !== undefined && input.year !== year) throw new TaxExportError('UNSUPPORTED_YEAR', 'Period year does not match the requested year');
    return { period, year, from: `${year}-${match[2]}-01`, to: `${year}-${match[2]}-${String(lastDay).padStart(2, '0')}` };
  }
  match = /^(\d{4})-Q([1-4])$/.exec(period);
  if (match) {
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    if (input.year !== undefined && input.year !== year) throw new TaxExportError('UNSUPPORTED_YEAR', 'Period year does not match the requested year');
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    return {
      period,
      year,
      from: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      to: `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  match = /^(\d{4})$/.exec(period);
  if (match) {
    const year = Number(match[1]);
    if (input.year !== undefined && input.year !== year) throw new TaxExportError('UNSUPPORTED_YEAR', 'Period year does not match the requested year');
    return { period, year, from: `${year}-01-01`, to: `${year}-12-31` };
  }
  throw new TaxExportError('UNSUPPORTED_PERIOD', 'Period must use YYYY-MM, YYYY-Q1..Q4, or YYYY');
};

const assertSupportedYear = (year: number, kind: string): void => {
  if (year < FIRST_TAX_YEAR || year > 2100) throw new TaxExportError('UNSUPPORTED_YEAR', `${kind} preparation does not support ${year}`);
};

const inPeriod = (date: string, bounds: ReturnType<typeof periodBounds>): boolean => {
  assertIsoDate(date, 'postingDate');
  return date >= bounds.from && date <= bounds.to;
};

const assertProvenance = (catalog: TaxCatalogProvenance): void => {
  if (!catalog.id.trim() || !catalog.version.trim() || !catalog.source.trim() || !/^[a-f0-9]{64}$/i.test(catalog.sourceHash) || !Number.isInteger(catalog.taxYear)) {
    throw new TaxExportError('CATALOG_PROVENANCE_INVALID', 'Tax catalog provenance is incomplete');
  }
};

const assertRate = (rate: number | undefined): number => {
  const value = Number(rate);
  if (!Number.isFinite(value) || value < 0 || value >= 100 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) {
    throw new TaxExportError('INVALID_RATE', 'Tax rate must be between 0 and 99.99 percent');
  }
  return value;
};

const country = (value: string | undefined): string => {
  const normalized = value?.trim().toUpperCase() ?? '';
  if (!EU_COUNTRIES.has(normalized)) throw new TaxExportError('INVALID_COUNTRY', `Invalid EU country code: ${value ?? ''}`);
  return normalized;
};

const vatId = (value: string | undefined, countryCode: string): string => {
  const normalized = value?.trim().toUpperCase() ?? '';
  const prefixes = countryCode === 'GR' ? ['GR', 'EL'] : [countryCode];
  if (!/^[A-Z]{2}[A-Z0-9]{2,14}$/.test(normalized) || !prefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new TaxExportError('INVALID_VAT_ID', `VAT ID does not match ${countryCode}`);
  }
  return normalized;
};

const evidence = (line: TaxExportLine): void => {
  if (!line.evidenceType?.trim() || !line.evidenceReference?.trim()) {
    throw new TaxExportError('MISSING_EVIDENCE', 'EU tax export requires evidence type and reference');
  }
};

const base = <T extends TaxExportPreparation['kind']>(kind: T, period: TaxExportPeriod, source: unknown, extra: Record<string, unknown>) => ({
  kind,
  period,
  status: 'prepared' as const,
  submissionReady: false as const,
  operation: 'preparation' as const,
  exportable: true as const,
  providerValidation: 'unavailable' as const,
  sourceHash: artifactHash(source),
  warnings: ['Preparation/export only; official provider validation and submission are unavailable.'],
  ...extra,
});

/** The Kennzahlen catalogue of a tax year: the form of that year, from 2027 on the latest form (provisional). */
export const ustvaCatalogFor = (taxYear: number): UstvaKennzahlCatalog => {
  assertSupportedYear(taxYear, 'UStVA');
  const formYear = Math.min(taxYear, USTVA_LATEST_FORM_YEAR);
  const provisional = taxYear > USTVA_LATEST_FORM_YEAR;
  const entries = Object.entries(USTVA_LABELS).sort(([a], [b]) => Number(a) - Number(b));
  return {
    id: `ustva-kennzahlen-${formYear}`, taxYear, formYear, version: `USt 1 A ${formYear}`,
    source: 'BMF, Vordruckmuster USt 1 A (Umsatzsteuer-Voranmeldung) 2025/2026: Kennzahlen',
    sourceHash: artifactHash({ formYear, entries, taxKz: USTVA_TAX_KZ }), official: !provisional, provisional,
    label: provisional ? `UStVA-Kennzahlen ${formYear} (vorläufig für ${taxYear})` : `UStVA-Kennzahlen ${formYear}`,
  };
};

const STANDARD_RATE: Record<string, number> = { DE_STD_19: 19, DE_STD_7: 7 };

/**
 * The UStVA of a period from tax-keyed journal lines: each line goes into the Kennzahl of its tax case and
 * direction (the table shared with Lite, accounting-shared ustvaKennziffern.ts). A self-assessed purchase adds
 * its basis and tax to 46/84/89/93 and the same tax to 67/61. Kz 83 = output tax − input tax.
 */
export const computeUstva = (input: { from: string; to: string; entries: readonly TaxExportEntry[] }): UstvaComputation => {
  const totals = new Map<string, { row: UstvaRow; net: number; tax: number }>();
  const sources: UstvaSource[] = [];
  const issues: UstvaComputation['issues'] = [];
  for (const entry of input.entries) {
    assertIsoDate(entry.postingDate, 'postingDate');
    if (entry.postingDate < input.from || entry.postingDate > input.to) continue;
    for (const line of entry.lines) {
      if (!line.taxCaseKey) continue;
      // Under Ist the invoice's basis line only marks the case; the tax arises with the payment (payment_vat).
      if (line.netAmount === undefined && line.taxAmount === undefined) continue;
      const key = line.taxCaseKey;
      const direction = line.direction ?? 'output';
      const rate = STANDARD_RATE[key] ?? Number(line.taxRate ?? 0);
      const net = Math.round(Number(line.netAmount ?? 0) * 100);
      const tax = Math.round(Number(line.taxAmount ?? 0) * 100);
      const parts = ustvaContributions(key, direction, rate, net, tax);
      // Unknown keys (a tenant's own tax case) and cases without a Kennzahl are reported, never dropped silently.
      if (!parts) {
        if (!issues.some((item) => item.taxCaseKey === key && item.entryId === entry.entryId)) issues.push({ code: 'USTVA_KENNZAHL_MISSING', taxCaseKey: key, entryId: entry.entryId, message: `Steuerfall ${key} hat keine UStVA-Kennzahl in dieser Vorbereitung; bitte manuell prüfen.` });
        continue;
      }
      for (const part of parts) {
        const mapKey = `${part.kennziffer}:${part.direction}`;
        const current = totals.get(mapKey) ?? { row: { kennziffer: part.kennziffer, ...(USTVA_TAX_KZ[part.kennziffer] ? { taxKennziffer: USTVA_TAX_KZ[part.kennziffer] } : {}), label: USTVA_LABELS[part.kennziffer] ?? part.kennziffer, direction: part.direction, netAmount: 0, taxAmount: 0, lineCount: 0, taxCaseKeys: [] }, net: 0, tax: 0 };
        current.net += part.basis; current.tax += part.tax; current.row.lineCount += 1;
        if (!current.row.taxCaseKeys.includes(key)) current.row.taxCaseKeys.push(key);
        totals.set(mapKey, current);
        sources.push({ kennziffer: part.kennziffer, direction: part.direction, entryId: entry.entryId, entryNumber: entry.entryNumber, postingDate: entry.postingDate, reference: entry.reference, sourceType: entry.sourceType, taxCaseKey: key, netAmount: amount(part.basis), taxAmount: amount(part.tax) });
      }
    }
  }
  const rows = [...totals.values()].sort((a, b) => Number(a.row.kennziffer) - Number(b.row.kennziffer) || a.row.direction.localeCompare(b.row.direction)).map(({ row, net, tax }) => ({ ...row, taxCaseKeys: [...row.taxCaseKeys].sort(), netAmount: amount(net), taxAmount: amount(tax) }));
  const output = [...totals.values()].filter(({ row }) => row.direction === 'output').reduce((sum, { tax }) => sum + tax, 0);
  const inputTax = [...totals.values()].filter(({ row }) => row.direction === 'input').reduce((sum, { tax }) => sum + tax, 0);
  if (rows.length) rows.push({ kennziffer: '83', label: USTVA_LABELS['83']!, direction: 'total', netAmount: 0, taxAmount: amount(output - inputTax), lineCount: 0, taxCaseKeys: [] });
  return { rows, sources, issues, outputTaxAmount: amount(output), inputTaxAmount: amount(inputTax), payableAmount: amount(output - inputTax) };
};

export type PrepareUstvaInput = {
  period: string | TaxExportPeriod;
  entries: readonly TaxExportEntry[];
};

/** Build an auditable UStVA preparation artifact with the Kennzahlen of the form; never a submission payload. */
export const prepareUstva = (input: PrepareUstvaInput): UstvaArtifact => {
  const period = typeof input.period === 'string' ? { period: input.period } : input.period;
  const bounds = periodBounds(period);
  const catalog = ustvaCatalogFor(bounds.year);
  const computed = computeUstva({ from: bounds.from, to: bounds.to, entries: input.entries });
  // A frozen return must not leave out amounts silently: the live view shows the issue, preparing refuses it.
  if (computed.issues.length) throw new TaxExportError('USTVA_KENNZAHL_MISSING', [...new Set(computed.issues.map((issue) => issue.message))].join(' '));
  const artifact = base('ustva', bounds, { period: bounds.period, catalog, rows: computed.rows }, { catalog, ...computed }) as UstvaArtifact;
  if (catalog.provisional) artifact.warnings.push(`Für ${bounds.year} gibt es in Billme noch keinen eigenen Vordruck; verwendet werden die Kennzahlen ${catalog.formYear}.`);
  return artifact;
};

export type AggregateTaxInput = {
  period: string | TaxExportPeriod;
  entries: readonly TaxExportEntry[];
};

const periodForAggregate = (period: AggregateTaxInput['period']): ReturnType<typeof periodBounds> => periodBounds(typeof period === 'string' ? { period } : period);

/** Aggregate valid EU B2B supplies for the Zusammenfassende Meldung. */
export const aggregateZm = (input: AggregateTaxInput): ZmArtifact => {
  const bounds = periodForAggregate(input.period);
  assertSupportedYear(bounds.year, 'ZM');
  const totals = new Map<string, { row: ZmRow; net: number }>();
  for (const entry of input.entries) {
    if (!inPeriod(entry.postingDate, bounds)) continue;
    for (const line of entry.lines) {
      if (!line.taxCaseKey) continue;
      const key = line.taxCaseKey;
      if (key !== 'EU_IGL_GOODS_0' && key !== 'EU_B2B_SERVICE_RC') continue;
      // The ZM lists the own sales; an EU purchase of the same tax case is not one.
      if (line.direction === 'input') continue;
      const countryCode = country(line.countryCode);
      const id = vatId(line.counterpartyVatId, countryCode);
      evidence(line);
      const net = cents(line.netAmount, 'netAmount');
      const mapKey = `${key}:${id}`;
      const current = totals.get(mapKey) ?? { row: { taxCaseKey: key, kind: key === 'EU_IGL_GOODS_0' ? 'lieferung' as const : 'sonstige_leistung' as const, countryCode, counterpartyVatId: id, netAmount: 0, lineCount: 0 }, net: 0 };
      current.net += net;
      current.row.lineCount += 1;
      totals.set(mapKey, current);
    }
  }
  const rows = [...totals.values()].sort((a, b) => a.row.counterpartyVatId.localeCompare(b.row.counterpartyVatId) || a.row.taxCaseKey.localeCompare(b.row.taxCaseKey)).map(({ row, net }) => ({ ...row, netAmount: amount(net) }));
  return base('zm', bounds, { period: bounds.period, rows }, { rows }) as ZmArtifact;
};

/** Aggregate EU B2C OSS supplies by destination and destination VAT rate. */
export const aggregateOss = (input: AggregateTaxInput): OssArtifact => {
  const bounds = periodForAggregate(input.period);
  assertSupportedYear(bounds.year, 'OSS');
  const totals = new Map<string, { countryCode: string; taxRate: number; net: number; tax: number; count: number }>();
  for (const entry of input.entries) {
    if (!inPeriod(entry.postingDate, bounds)) continue;
    for (const line of entry.lines) {
      if (!line.taxCaseKey) continue;
      const key = line.taxCaseKey;
      if (key !== 'EU_B2C_OSS') continue;
      if (line.direction === 'input') continue;
      const countryCode = country(line.countryCode);
      const taxRate = assertRate(line.taxRate);
      const net = cents(line.netAmount, 'netAmount');
      const tax = cents(line.taxAmount ?? 0, 'taxAmount');
      const mapKey = `${countryCode}:${taxRate.toFixed(2)}`;
      const current = totals.get(mapKey) ?? { countryCode, taxRate, net: 0, tax: 0, count: 0 };
      current.net += net;
      current.tax += tax;
      current.count += 1;
      totals.set(mapKey, current);
    }
  }
  const rows: OssRow[] = [...totals.values()].sort((a, b) => a.countryCode.localeCompare(b.countryCode) || a.taxRate - b.taxRate).map((row) => ({ countryCode: row.countryCode, taxRate: row.taxRate, netAmount: amount(row.net), taxAmount: amount(row.tax), lineCount: row.count }));
  return base('oss', bounds, { period: bounds.period, rows }, { rows }) as OssArtifact;
};

type SnapshotInput = TaxReportSnapshotBinding | { id: string; sourceHash: string; snapshot?: ReportSnapshot };

const snapshotBinding = (input: SnapshotInput | undefined): TaxReportSnapshotBinding => {
  const value = input as Partial<TaxReportSnapshotBinding> & { id?: string; sourceHash?: string } | undefined;
  const id = value?.reportSnapshotId ?? value?.id;
  const hash = value?.sourceSnapshotHash ?? value?.sourceHash;
  if (!id?.trim() || !hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new TaxExportError('REPORT_SNAPSHOT_REQUIRED', 'Immutable report snapshot id and SHA-256 are required');
  return { reportSnapshotId: id, sourceSnapshotHash: hash, ...(value?.snapshot ? { snapshot: value.snapshot } : {}) };
};

const reportPeriod = (period: string | TaxExportPeriod): ReturnType<typeof periodBounds> => periodBounds(typeof period === 'string' ? { period } : period);

export type PrepareEBilanzInput = {
  period?: string | TaxExportPeriod;
  taxYear?: number;
  reportSnapshot: SnapshotInput;
  taxonomy: string;
  facts: readonly Record<string, unknown>[];
  catalog?: TaxCatalogProvenance;
};

export const prepareEBilanz = (input: PrepareEBilanzInput): EBilanzArtifact => {
  const bounds = reportPeriod(input.period ?? String(input.taxYear ?? ''));
  if (bounds.year !== PREPARATION_CATALOG.taxYear) throw new TaxExportError('UNSUPPORTED_YEAR', `E-Bilanz preparation does not support ${bounds.year}`);
  if (input.taxonomy !== '6.9') throw new TaxExportError('TAXONOMY_MISMATCH', 'Only E-Bilanz taxonomy 6.9 preparation is supported');
  const reportSnapshot = snapshotBinding(input.reportSnapshot);
  const catalog = input.catalog ?? PREPARATION_CATALOG;
  assertProvenance(catalog);
  const source = { period: bounds.period, taxonomy: input.taxonomy, facts: input.facts, reportSnapshot };
  return base('e_bilanz', bounds, source, { taxonomy: '6.9', facts: input.facts, reportSnapshot, catalog }) as EBilanzArtifact;
};

export type PrepareUnternehmensregisterInput = {
  period?: string | TaxExportPeriod;
  taxYear?: number;
  reportSnapshot: SnapshotInput;
  companyName: string;
  registerNumber: string;
};

export const prepareUnternehmensregister = (input: PrepareUnternehmensregisterInput): UnternehmensregisterArtifact => {
  const bounds = reportPeriod(input.period ?? String(input.taxYear ?? ''));
  if (bounds.year !== PREPARATION_CATALOG.taxYear) throw new TaxExportError('UNSUPPORTED_YEAR', `Unternehmensregister preparation does not support ${bounds.year}`);
  if (!input.companyName.trim() || !input.registerNumber.trim()) throw new TaxExportError('REPORT_SNAPSHOT_REQUIRED', 'Company and register identity are required');
  const reportSnapshot = snapshotBinding(input.reportSnapshot);
  const source = { period: bounds.period, companyName: input.companyName.trim(), registerNumber: input.registerNumber.trim(), reportSnapshot };
  return base('unternehmensregister', bounds, source, { companyName: input.companyName.trim(), registerNumber: input.registerNumber.trim(), reportSnapshot }) as UnternehmensregisterArtifact;
};

/** Provider validation is intentionally fail-closed; this package only prepares/exports. */
export const validateTaxExportProvider = (): never => {
  throw new TaxExportError('PROVIDER_CATALOG_UNAVAILABLE', 'Official provider catalog/adapter is unavailable; preparation is not submission-ready');
};

export const prepareUStVA = prepareUstva;
export const prepareUstVa = prepareUstva;
export const prepareUSTVA = prepareUstva;
export const prepareZM = aggregateZm;
export const prepareZm = aggregateZm;
export const prepareOSS = aggregateOss;
export const prepareOss = aggregateOss;
export const prepareEBilanzArtifact = prepareEBilanz;
export const prepareUnternehmensregisterArtifact = prepareUnternehmensregister;
