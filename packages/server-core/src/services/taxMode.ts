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
    countryCode?: string;
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
    einvoiceCategoryCode: 'K',
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
    einvoiceCategoryCode: 'G',
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
 * Small, offline DACH rate catalog used for suggestions and the editor's rate
 * picker. It is intentionally not a full EU product classification table;
 * callers can still enter a document-specific rate override.
 */
export const DACH_VAT_RATES: Readonly<Record<'DE' | 'AT' | 'CH', readonly number[]>> = {
  DE: [19, 7],
  AT: [20, 10, 13, 4.9],
  CH: [8.1, 2.6, 3.8],
};

export const getDachVatRates = (countryCode: string | undefined, fallback = 19): number[] => {
  const country = countryCode?.trim().toUpperCase() as keyof typeof DACH_VAT_RATES;
  const rates = DACH_VAT_RATES[country];
  return rates ? [...rates] : [Math.max(0, toFiniteNumber(fallback))];
};

export type TaxRecommendationInput = {
  sellerCountryCode?: string;
  buyerCountryCode?: string;
  buyerType?: 'business' | 'consumer';
  buyerVatId?: string;
  sellerVatId?: string;
  supplyType?: 'goods' | 'service';
};

export type TaxRecommendation = {
  mode: InvoiceTaxMode;
  reason: string;
  requiresConfirmation: true;
};

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Suggests a rule only. The caller must display and explicitly confirm it. */
export const recommendInvoiceTaxMode = (input: TaxRecommendationInput): TaxRecommendation => {
  const seller = input.sellerCountryCode?.trim().toUpperCase();
  const buyer = input.buyerCountryCode?.trim().toUpperCase();
  const crossBorder = Boolean(seller && buyer && seller !== buyer);
  const hasIds = Boolean(input.sellerVatId?.trim() && input.buyerVatId?.trim());
  if (crossBorder && input.buyerType === 'business' && hasIds && seller && buyer && EU_COUNTRIES.has(seller) && EU_COUNTRIES.has(buyer)) {
    return input.supplyType === 'goods'
      ? { mode: 'intra_eu_supply_6a', reason: 'Innergemeinschaftliche Warenlieferung zwischen Unternehmen.', requiresConfirmation: true }
      : { mode: 'intra_eu_service_reverse_charge', reason: 'Grenzüberschreitende B2B-Leistung innerhalb der EU.', requiresConfirmation: true };
  }
  if (crossBorder && seller && buyer && EU_COUNTRIES.has(seller) && !EU_COUNTRIES.has(buyer)) {
    return input.supplyType === 'goods'
      ? { mode: 'export_third_country', reason: 'Warenlieferung in ein Drittland; Ausfuhrnachweis erforderlich.', requiresConfirmation: true }
      : { mode: 'non_taxable_outside_scope', reason: 'Leistungsort liegt voraussichtlich außerhalb der EU.', requiresConfirmation: true };
  }
  return { mode: 'standard_vat', reason: 'Inlandssachverhalt oder unvollständige Empfängerdaten.', requiresConfirmation: true };
};

/**
 * EN 16931 requires a reason whenever VAT is not charged. Every zero-rated mode
 * therefore needs a legal sentence; an explicit override always wins.
 */
export const getInvoiceTaxExemptionReason = (
  mode: InvoiceTaxMode,
  taxMeta?: InvoiceTaxMeta,
): string | undefined => {
  if (taxMeta?.exemptionReasonOverride?.trim()) return taxMeta.exemptionReasonOverride.trim();
  const country = taxMeta?.sellerCountryCode?.trim().toUpperCase() ?? 'DE';
  switch (mode) {
    case 'small_business_19_ustg':
      return country === 'CH' ? 'Keine MWST wegen Kleinunternehmen' : country === 'AT' ? 'Kleinunternehmerregelung nach UStG' : 'Kleinunternehmerregelung nach §19 UStG';
    case 'reverse_charge_13b':
      return country === 'CH'
        ? 'Bezugsteuer durch den Leistungsempfänger (Reverse Charge)'
        : country === 'AT'
          ? 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)'
          : 'Steuerschuldnerschaft des Leistungsempfängers (§13b UStG)';
    case 'intra_eu_supply_6a':
      return 'Steuerfreie innergemeinschaftliche Lieferung';
    case 'intra_eu_service_reverse_charge':
      return 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)';
    case 'export_third_country':
      return country === 'CH' ? 'Steuerfreie Ausfuhrlieferung nach Schweizer MWST-Recht' : 'Steuerfreie Ausfuhrlieferung';
    case 'vat_exempt_4_ustg':
      return country === 'CH' ? 'Steuerfreie Leistung nach Schweizer MWST-Recht' : country === 'AT' ? 'Steuerfreie Leistung nach österreichischem UStG' : 'Steuerfreie Leistung nach §4 UStG';
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
  const defaultRate = definition.forceZeroVat
    ? 0
    : Math.max(0, toFiniteNumber(input.taxMeta?.defaultVatRate ?? getDefaultTaxRate(settings)));
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
    taxNotice: getInvoiceTaxExemptionReason(resolvedTaxMode, input.taxMeta),
    taxRuleConfirmed: input.taxMeta?.taxRuleConfirmed,
  };
};
