import type { TaxCaseDefinition, TaxCaseKey } from './accounting';

export type DatevTaxEvidence = {
  buyerCountryCode?: string;
  buyerVatId?: string;
  destinationVatRate?: number;
  datevSachverhaltLl?: string;
  datevEvidenceType?: string;
  datevEvidenceReference?: string;
};

export const datevDestinationCases = new Set<TaxCaseKey>([
  'EU_B2C_OSS',
  'DE_TRIANGULAR_25B',
  'EU_B2B_SERVICE_RC',
  'EU_IGL_GOODS_0',
  'EU_IGE_GOODS_RC',
]);

export const datevSachverhaltCases = new Set<TaxCaseKey>([
  'DE_RC_13B_DOMESTIC',
  'EU_B2B_SERVICE_RC',
  'EU_IGE_GOODS_RC',
  'NON_EU_SERVICE_RC',
]);

export const normalizeDatevTaxEvidence = (value: DatevTaxEvidence): DatevTaxEvidence => ({
  buyerCountryCode: value.buyerCountryCode?.trim().toUpperCase() || undefined,
  buyerVatId: value.buyerVatId?.trim().toUpperCase() || undefined,
  destinationVatRate: value.destinationVatRate,
  datevSachverhaltLl: value.datevSachverhaltLl ?? (value.datevEvidenceReference && /^[1-9]\d{0,2}$/.test(value.datevEvidenceReference) ? value.datevEvidenceReference : undefined),
  datevEvidenceType: value.datevEvidenceType?.trim() || undefined,
  datevEvidenceReference: value.datevEvidenceReference?.trim() || undefined,
});

export const validateDatevTaxEvidence = (
  taxCase: Pick<TaxCaseDefinition, 'key' | 'requiresCountry' | 'requiresCounterpartyVatId' | 'requiresEvidence'>,
  evidence: DatevTaxEvidence,
): { code: string; message: string }[] => {
  const value = normalizeDatevTaxEvidence(evidence);
  const issues: { code: string; message: string }[] = [];
  if (taxCase.requiresCountry && !value.buyerCountryCode?.match(/^[A-Z]{2}$/)) issues.push({ code: 'MISSING_TAX_COUNTRY', message: `Ländercode fehlt für Steuerfall ${taxCase.key}.` });
  if (taxCase.requiresCounterpartyVatId && !value.buyerVatId?.match(/^[A-Z0-9]+$/)) issues.push({ code: 'MISSING_COUNTERPARTY_VAT_ID', message: `USt-IdNr. fehlt für Steuerfall ${taxCase.key}.` });
  if (taxCase.requiresEvidence && (!value.datevEvidenceType || !value.datevEvidenceReference)) issues.push({ code: 'MISSING_TAX_EVIDENCE', message: `Steuernachweis fehlt für Steuerfall ${taxCase.key}.` });
  if (datevDestinationCases.has(taxCase.key) && (!Number.isFinite(value.destinationVatRate) || value.destinationVatRate! < 0 || value.destinationVatRate! >= 100)) issues.push({ code: 'MISSING_DESTINATION_VAT_RATE', message: `EU-Bestimmungsland-Steuersatz fehlt für Steuerfall ${taxCase.key}.` });
  if (datevSachverhaltCases.has(taxCase.key) && !value.datevSachverhaltLl) issues.push({ code: 'MISSING_DATEV_SACHVERHALT', message: `DATEV Sachverhalt L+L fehlt für Steuerfall ${taxCase.key}.` });
  return issues;
};
