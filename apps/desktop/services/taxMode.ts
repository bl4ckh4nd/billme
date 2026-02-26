import type {
  AppSettings,
  Invoice,
  InvoiceTaxMeta,
  InvoiceTaxMode,
  InvoiceTaxModeDefinition,
  InvoiceTaxSnapshot,
} from '../types';

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

const TAX_MODE_MAP = new Map(INVOICE_TAX_MODE_DEFINITIONS.map((it) => [it.mode, it]));

export const getInvoiceTaxModeDefinition = (mode: InvoiceTaxMode): InvoiceTaxModeDefinition =>
  TAX_MODE_MAP.get(mode) ?? TAX_MODE_MAP.get(DEFAULT_TAX_MODE)!;

export const resolveInvoiceTaxMode = (
  taxMode: InvoiceTaxMode | undefined,
  settings?: Pick<AppSettings, 'legal'>,
): InvoiceTaxMode => {
  if (taxMode && TAX_MODE_MAP.has(taxMode)) return taxMode;
  if (settings?.legal.smallBusinessRule) return 'small_business_19_ustg';
  return DEFAULT_TAX_MODE;
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const toNumber = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
};

export const getDefaultTaxRate = (settings: Pick<AppSettings, 'legal'>): number =>
  Math.max(0, toNumber(settings.legal.defaultVatRate));

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

export const calculateInvoiceTaxSnapshot = (
  invoice: Pick<Invoice, 'items' | 'taxMode' | 'taxMeta'>,
  settings: Pick<AppSettings, 'legal'>,
): InvoiceTaxSnapshot => {
  const taxMode = resolveInvoiceTaxMode(invoice.taxMode, settings);
  const definition = getInvoiceTaxModeDefinition(taxMode);
  const netAmount = round2((invoice.items ?? []).reduce((sum, item) => sum + toNumber(item.total), 0));
  const vatRateApplied = definition.forceZeroVat ? 0 : getDefaultTaxRate(settings);
  const vatAmount = round2(netAmount * (vatRateApplied / 100));
  const grossAmount = round2(netAmount + vatAmount);
  return {
    vatRateApplied,
    vatAmount,
    netAmount,
    grossAmount,
    einvoiceCategoryCode: definition.einvoiceCategoryCode,
    label: definition.label,
  };
};
