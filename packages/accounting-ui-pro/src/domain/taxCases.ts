import type { TaxCaseKey } from '../types';

export interface UiTaxCaseOption {
  key: TaxCaseKey;
  label: string;
  defaultRate: number;
  legacyTaxCode?: 'USt19' | 'USt7' | 'VSt19' | 'VSt7';
  requiresCounterpartyVatId: boolean;
  requiresCountry: boolean;
  requiresEvidence: boolean;
}

export const TAX_CASE_OPTIONS: UiTaxCaseOption[] = [
  {
    key: 'DE_STD_19',
    label: 'Inland steuerpflichtig 19%',
    defaultRate: 19,
    legacyTaxCode: 'USt19',
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: false,
  },
  {
    key: 'DE_STD_7',
    label: 'Inland steuerpflichtig 7%',
    defaultRate: 7,
    legacyTaxCode: 'USt7',
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: false,
  },
  {
    key: 'DE_ZERO_EXEMPT',
    label: 'Inland steuerfrei / nicht steuerbar',
    defaultRate: 0,
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: true,
  },
  {
    key: 'DE_KU19',
    label: 'Kleinunternehmer §19 UStG',
    defaultRate: 0,
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: true,
  },
  {
    key: 'DE_RC_13B_DOMESTIC',
    label: 'Reverse Charge §13b Inland',
    defaultRate: 19,
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: true,
  },
  {
    key: 'EU_B2C_OSS',
    label: 'EU B2C OSS (One-Stop-Shop)',
    defaultRate: 19,
    requiresCounterpartyVatId: false,
    requiresCountry: true,
    requiresEvidence: true,
  },
  {
    key: 'DE_MARGIN_25A',
    label: 'Differenzbesteuerung §25a UStG',
    defaultRate: 0,
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: true,
  },
  {
    key: 'DE_BAUABZUG_48',
    label: 'Bauabzugsteuer §48 EStG',
    defaultRate: 0,
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: true,
  },
  {
    key: 'DE_TRIANGULAR_25B',
    label: 'Innergemeinschaftliches Dreiecksgeschäft §25b',
    defaultRate: 0,
    requiresCounterpartyVatId: true,
    requiresCountry: true,
    requiresEvidence: true,
  },
  {
    key: 'EU_B2B_SERVICE_RC',
    label: 'EU B2B Dienstleistung RC',
    defaultRate: 19,
    requiresCounterpartyVatId: true,
    requiresCountry: true,
    requiresEvidence: true,
  },
  {
    key: 'EU_IGL_GOODS_0',
    label: 'Innergemeinschaftliche Lieferung 0%',
    defaultRate: 0,
    requiresCounterpartyVatId: true,
    requiresCountry: true,
    requiresEvidence: true,
  },
  {
    key: 'EU_IGE_GOODS_RC',
    label: 'Innergemeinschaftlicher Erwerb RC',
    defaultRate: 19,
    requiresCounterpartyVatId: true,
    requiresCountry: true,
    requiresEvidence: true,
  },
  {
    key: 'NON_EU_EXPORT_0',
    label: 'Ausfuhrlieferung Drittland 0%',
    defaultRate: 0,
    requiresCounterpartyVatId: false,
    requiresCountry: true,
    requiresEvidence: true,
  },
  {
    key: 'NON_EU_SERVICE_RC',
    label: 'Drittland Dienstleistungsbezug RC',
    defaultRate: 19,
    requiresCounterpartyVatId: false,
    requiresCountry: true,
    requiresEvidence: true,
  },
  {
    key: 'NON_EU_SERVICE_OUTSIDE_SCOPE',
    label: 'Drittland sonstige Leistung, im Inland nicht steuerbar',
    defaultRate: 0,
    requiresCounterpartyVatId: false,
    requiresCountry: true,
    requiresEvidence: true,
  },
];

const TAX_CASE_BY_KEY = new Map(TAX_CASE_OPTIONS.map((item) => [item.key, item]));

export const findTaxCaseOption = (value?: string): UiTaxCaseOption | undefined => {
  const normalized = normalizeTaxCaseKey(value);
  return normalized ? TAX_CASE_BY_KEY.get(normalized) : undefined;
};

export const normalizeTaxCaseKey = (value?: string): TaxCaseKey | undefined => {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (raw === 'USt19' || raw === 'VSt19') return 'DE_STD_19';
  if (raw === 'USt7' || raw === 'VSt7') return 'DE_STD_7';
  const upper = raw.toUpperCase();
  return TAX_CASE_BY_KEY.has(upper as TaxCaseKey) ? (upper as TaxCaseKey) : undefined;
};

export const toLegacyTaxCode = (taxCaseKey?: TaxCaseKey): string | undefined => {
  if (!taxCaseKey) return undefined;
  if (taxCaseKey === 'DE_STD_19') return 'USt19';
  if (taxCaseKey === 'DE_STD_7') return 'USt7';
  return taxCaseKey;
};
