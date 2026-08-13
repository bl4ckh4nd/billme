import type { TaxCaseDefinition } from './accounting';

/** Shipped tax catalog. Database rows are projections, never tenant-owned truth. */
export const CANONICAL_TAX_CASES: readonly TaxCaseDefinition[] = [
  ['DE_STD_19', 'Inland steuerpflichtig 19%', 'standard_vat', 19, false, false, false],
  ['DE_STD_7', 'Inland steuerpflichtig 7%', 'standard_vat', 7, false, false, false],
  ['DE_ZERO_EXEMPT', 'Inland steuerfrei / nicht steuerbar', 'exempt', 0, false, false, true],
  ['DE_KU19', 'Kleinunternehmer §19 UStG', 'exempt', 0, false, false, true],
  ['DE_RC_13B_DOMESTIC', 'Reverse Charge §13b Inland', 'reverse_charge', 19, false, false, true],
  ['EU_B2C_OSS', 'EU B2C OSS (One-Stop-Shop)', 'standard_vat', 19, false, true, true],
  ['DE_MARGIN_25A', 'Differenzbesteuerung §25a UStG', 'exempt', 0, false, false, true],
  ['DE_BAUABZUG_48', 'Bauabzugsteuer §48 EStG', 'exempt', 0, false, false, true],
  ['DE_TRIANGULAR_25B', 'Innergemeinschaftliches Dreiecksgeschäft §25b', 'zero_rate', 0, true, true, true],
  ['EU_B2B_SERVICE_RC', 'EU B2B Dienstleistung RC', 'reverse_charge', 19, true, true, true],
  ['EU_IGL_GOODS_0', 'Innergemeinschaftliche Lieferung 0%', 'zero_rate', 0, true, true, true],
  ['EU_IGE_GOODS_RC', 'Innergemeinschaftlicher Erwerb RC', 'reverse_charge', 19, true, true, true],
  ['NON_EU_EXPORT_0', 'Ausfuhrlieferung Drittland 0%', 'zero_rate', 0, false, true, true],
  ['NON_EU_SERVICE_RC', 'Drittland Dienstleistungsbezug RC', 'reverse_charge', 19, false, true, true],
].map(([key, label, mechanism, defaultRate, requiresCounterpartyVatId, requiresCountry, requiresEvidence]) => ({
  key,
  label,
  mechanism,
  defaultRate,
  requiresCounterpartyVatId,
  requiresCountry,
  requiresEvidence,
  active: true,
})) as readonly TaxCaseDefinition[];
