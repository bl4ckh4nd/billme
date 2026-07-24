import type {
  BillingLineItem,
  InvoiceTaxModeDefinition,
  InvoiceTaxMeta,
  InvoiceTaxMode,
  InvoiceTaxSnapshot,
} from '../domain/foundations.js';

export type TaxSettingsShape = {
  legal: {
    smallBusinessRule?: boolean;
    defaultVatRate?: number;
  };
};

export type TaxableDocumentInput = {
  items?: BillingLineItem[];
  taxMode?: InvoiceTaxMode;
  taxMeta?: InvoiceTaxMeta;
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * `Number(x) || 0` lets Infinity and -Infinity through because they are truthy,
 * which poisons every downstream total. Money must always be a finite number.
 */
const toFiniteNumber = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
};

export const DEFAULT_TAX_MODE: InvoiceTaxMode = 'standard_vat';

export const INVOICE_TAX_MODE_DEFINITIONS: InvoiceTaxModeDefinition[] = [
  {
    mode: 'standard_vat',
    label: 'Regelbesteuerung',
    description: 'Umsatzsteuer wird mit dem Standardsteuersatz berechnet.',
    einvoiceCategoryCode: 'S',
  },
  {
    mode: 'small_business_19_ustg',
    label: 'Kleinunternehmer (§19 UStG)',
    description: 'Kein USt-Ausweis wegen Kleinunternehmerregelung.',
    legalReference: '§ 19 UStG',
    einvoiceCategoryCode: 'E',
    requiresExemptionReason: true,
    forceZeroVat: true,
  },
  {
    mode: 'reverse_charge_13b',
    label: 'Reverse Charge (§13b UStG)',
    description: 'Steuerschuldnerschaft des Leistungsempfängers.',
    legalReference: '§ 13b UStG',
    einvoiceCategoryCode: 'AE',
    requiresBuyerVatId: true,
    requiresExemptionReason: true,
    forceZeroVat: true,
  },
  {
    mode: 'intra_eu_supply_6a',
    label: 'Innergemeinschaftliche Lieferung',
    description: 'Steuerfreie innergemeinschaftliche Lieferung.',
    legalReference: '§ 6a UStG',
    einvoiceCategoryCode: 'E',
    requiresBuyerVatId: true,
    requiresExemptionReason: true,
    forceZeroVat: true,
  },
  {
    mode: 'intra_eu_service_reverse_charge',
    label: 'EU-Leistung Reverse Charge',
    description: 'B2B-Leistung innerhalb EU (Reverse Charge).',
    legalReference: 'Art. 196 MwStSystRL',
    einvoiceCategoryCode: 'AE',
    requiresBuyerVatId: true,
    requiresExemptionReason: true,
    forceZeroVat: true,
  },
  {
    mode: 'export_third_country',
    label: 'Drittlandsausfuhr',
    description: 'Lieferung/Leistung ins Drittland.',
    legalReference: '§ 4 Nr. 1a UStG',
    einvoiceCategoryCode: 'E',
    requiresExemptionReason: true,
    forceZeroVat: true,
  },
  {
    mode: 'vat_exempt_4_ustg',
    label: 'Steuerfrei (§4 UStG)',
    description: 'Umsatzsteuerbefreiung nach §4 UStG.',
    legalReference: '§ 4 UStG',
    einvoiceCategoryCode: 'E',
    requiresExemptionReason: true,
    forceZeroVat: true,
  },
  {
    mode: 'non_taxable_outside_scope',
    label: 'Nicht steuerbar',
    description: 'Umsatz liegt außerhalb des Anwendungsbereichs der USt.',
    einvoiceCategoryCode: 'O',
    requiresExemptionReason: true,
    forceZeroVat: true,
  },
];

const TAX_MODE_MAP = new Map(INVOICE_TAX_MODE_DEFINITIONS.map((item) => [item.mode, item]));

export const getInvoiceTaxModeDefinition = (mode: InvoiceTaxMode): InvoiceTaxModeDefinition =>
  TAX_MODE_MAP.get(mode) ?? TAX_MODE_MAP.get(DEFAULT_TAX_MODE)!;

export const getDefaultTaxRate = (settings: TaxSettingsShape): number =>
  Math.max(0, toFiniteNumber(settings.legal.defaultVatRate));

/**
 * EN 16931 requires a reason whenever VAT is not charged. Every zero-rated mode
 * therefore needs a legal sentence; an explicit override always wins.
 */
export const getInvoiceTaxExemptionReason = (
  mode: InvoiceTaxMode,
  taxMeta?: InvoiceTaxMeta,
): string | undefined => {
  if (taxMeta?.exemptionReasonOverride?.trim()) return taxMeta.exemptionReasonOverride.trim();
  switch (mode) {
    case 'small_business_19_ustg':
      return 'Kleinunternehmerregelung nach §19 UStG';
    case 'reverse_charge_13b':
      return 'Steuerschuldnerschaft des Leistungsempfängers (§13b UStG)';
    case 'intra_eu_supply_6a':
      return 'Steuerfreie innergemeinschaftliche Lieferung (§6a UStG)';
    case 'intra_eu_service_reverse_charge':
      return 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)';
    case 'export_third_country':
      return 'Steuerfreie Ausfuhrlieferung';
    case 'vat_exempt_4_ustg':
      return 'Steuerfreie Leistung nach §4 UStG';
    case 'non_taxable_outside_scope':
      return 'Nicht steuerbarer Umsatz';
    default:
      return undefined;
  }
};

export const resolveInvoiceTaxMode = (
  taxMode: InvoiceTaxMode | undefined,
  settings: TaxSettingsShape,
): InvoiceTaxMode => {
  if (taxMode && TAX_MODE_MAP.has(taxMode)) return taxMode;
  if (settings.legal.smallBusinessRule) return 'small_business_19_ustg';
  return DEFAULT_TAX_MODE;
};

export const calculateInvoiceTaxSnapshot = (
  input: TaxableDocumentInput,
  settings: TaxSettingsShape,
): InvoiceTaxSnapshot => {
  const resolvedTaxMode = resolveInvoiceTaxMode(input.taxMode, settings);
  const definition = getInvoiceTaxModeDefinition(resolvedTaxMode);
  const defaultRate = definition.forceZeroVat ? 0 : getDefaultTaxRate(settings);
  const netByRate = new Map<number, number>();
  for (const item of input.items ?? []) {
    const rate = definition.forceZeroVat
      ? 0
      : item.taxRate === undefined || item.taxRate === null
        ? defaultRate
        : Math.max(0, toFiniteNumber(item.taxRate));
    netByRate.set(rate, (netByRate.get(rate) ?? 0) + toFiniteNumber(item.total));
  }
  const vatBreakdown = [...netByRate.entries()].map(([rate, net]) => ({
    rate,
    netAmount: round2(net),
    vatAmount: round2(net * rate / 100),
  }));
  const netAmount = round2(vatBreakdown.reduce((sum, entry) => sum + entry.netAmount, 0));
  const vatAmount = round2(vatBreakdown.reduce((sum, entry) => sum + entry.vatAmount, 0));
  const vatRateApplied = vatBreakdown.length === 1 ? vatBreakdown[0]!.rate : defaultRate;

  return {
    vatRateApplied,
    vatAmount,
    netAmount,
    grossAmount: round2(netAmount + vatAmount),
    einvoiceCategoryCode: definition.einvoiceCategoryCode,
    label: definition.label,
    vatBreakdown,
  };
};
