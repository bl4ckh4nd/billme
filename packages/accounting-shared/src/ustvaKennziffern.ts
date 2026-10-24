import type { TaxCaseKey } from './accounting';

/**
 * UStVA Kennzahlen (Vordruck USt 1 A 2025/2026). One table for Lite (by tax mode) and Pro (by tax case, mapped
 * onto the same modes below), so both products put a sale or a purchase into the same Kennzahl.
 */
export const USTVA_LABELS: Record<string, string> = {
  '81': 'Umsätze 19 %', '86': 'Umsätze 7 %', '87': 'Steuerpflichtige Umsätze zum Steuersatz von 0 % (§ 12 Abs. 3 UStG)',
  '41': 'Innergemeinschaftliche Lieferungen', '43': 'Ausfuhr und weitere steuerfreie Umsätze mit Vorsteuerabzug',
  '48': 'Steuerfreie Umsätze ohne Vorsteuerabzug', '60': 'Umsätze mit Steuerschuld des Leistungsempfängers',
  '21': 'Nicht steuerbare EU-Dienstleistungen', '45': 'Übrige nicht steuerbare Umsätze',
  '89': 'Innergemeinschaftlicher Erwerb 19 %', '93': 'Innergemeinschaftlicher Erwerb 7 %',
  '90': 'Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 0 %',
  '46': 'EU-Dienstleistung: eigene Steuerschuld (§ 13b)', '84': 'Andere Leistungen: eigene Steuerschuld (§ 13b)',
  '66': 'Vorsteuer aus inländischen Rechnungen', '61': 'Vorsteuer aus innergemeinschaftlichem Erwerb', '62': 'Einfuhrumsatzsteuer',
  '67': 'Vorsteuer aus § 13b', '39': 'Abzug der Sondervorauszahlung', '83': 'Verbleibende Umsatzsteuer-Vorauszahlung / Überschuss',
};
/** Kennzahlen whose tax stands in a second Kennzahl next to the basis. */
export const USTVA_TAX_KZ: Record<string, string> = { '46': '47', '84': '85' };

export type UstvaOutgoingTaxMode = 'standard_vat' | 'small_business_19_ustg' | 'reverse_charge_13b' | 'intra_eu_supply_6a' | 'intra_eu_service_reverse_charge' | 'export_third_country' | 'vat_exempt_4_ustg' | 'non_taxable_outside_scope';
export type UstvaReceiptTaxMode = 'domestic' | 'reverse_charge' | 'eu_service' | 'intra_eu_acquisition' | 'import' | 'exempt' | 'small_business';

/** Sales without German VAT: an information Kennzahl with the basis only. */
export const OUTGOING_TAX_MODE_KZ = { reverse_charge_13b: '60', intra_eu_supply_6a: '41', intra_eu_service_reverse_charge: '21', export_third_country: '43', vat_exempt_4_ustg: '48', non_taxable_outside_scope: '45' } as const;
/** A standard-rated sale. */
export const outputRateKz = (rate: number): string => rate === 19 ? '81' : rate === 7 ? '86' : '87';
export const SELF_ASSESSED_RECEIPT_MODES: readonly UstvaReceiptTaxMode[] = ['reverse_charge', 'eu_service', 'intra_eu_acquisition'];
/** The tax a buyer owes itself on a purchase (§ 13b, innergemeinschaftlicher Erwerb). */
export const selfAssessedKz = (mode: UstvaReceiptTaxMode, rate: number): string => mode === 'eu_service' ? '46' : mode === 'reverse_charge' ? '84' : rate === 19 ? '89' : rate === 7 ? '93' : '90';
/** The Vorsteuer of a purchase. */
export const inputTaxKz = (mode: UstvaReceiptTaxMode): string => mode === 'import' ? '62' : mode === 'intra_eu_acquisition' ? '61' : mode === 'reverse_charge' || mode === 'eu_service' ? '67' : '66';

/** Pro tax case → the Lite mode of a sale (inverse of the issuing path's mode → case). */
export const TAX_CASE_OUTGOING_MODE: Partial<Record<TaxCaseKey, UstvaOutgoingTaxMode>> = {
  DE_STD_19: 'standard_vat', DE_STD_7: 'standard_vat', DE_KU19: 'small_business_19_ustg', DE_ZERO_EXEMPT: 'vat_exempt_4_ustg',
  DE_RC_13B_DOMESTIC: 'reverse_charge_13b', EU_IGL_GOODS_0: 'intra_eu_supply_6a', EU_B2B_SERVICE_RC: 'intra_eu_service_reverse_charge',
  NON_EU_EXPORT_0: 'export_third_country', NON_EU_SERVICE_OUTSIDE_SCOPE: 'non_taxable_outside_scope',
};
/** Pro tax case → the Lite mode of a purchase. These are also the only tax cases an incoming invoice may carry. */
export const TAX_CASE_RECEIPT_MODE: Partial<Record<TaxCaseKey, UstvaReceiptTaxMode>> = {
  DE_STD_19: 'domestic', DE_STD_7: 'domestic', DE_ZERO_EXEMPT: 'exempt', DE_KU19: 'small_business',
  DE_RC_13B_DOMESTIC: 'reverse_charge', NON_EU_SERVICE_RC: 'reverse_charge', EU_B2B_SERVICE_RC: 'eu_service', EU_IGE_GOODS_RC: 'intra_eu_acquisition',
};
/** Purchases where the buyer owes the VAT and deducts it as Vorsteuer in the same posting. */
export const isSelfAssessedPurchase = (taxCaseKey: string | undefined): boolean => {
  const mode = TAX_CASE_RECEIPT_MODE[taxCaseKey as TaxCaseKey];
  return Boolean(mode && SELF_ASSESSED_RECEIPT_MODES.includes(mode));
};

export type UstvaContribution = { kennziffer: string; direction: 'output' | 'input' | 'information'; basis: number; tax: number };
/**
 * What one tax-keyed ledger line adds to the UStVA. `null`: the case has no Kennzahl (e.g. § 25a, § 25b, § 48 EStG);
 * the caller reports it instead of dropping it. An empty list: the case belongs in no Kennzahl (Kleinunternehmer,
 * steuerfreier Einkauf, OSS sales, which are declared in the OSS return).
 */
export const ustvaContributions = (taxCaseKey: string, direction: 'output' | 'input', rate: number, basis: number, tax: number): UstvaContribution[] | null => {
  if (direction === 'output') {
    if (taxCaseKey === 'EU_B2C_OSS') return [];
    const mode = TAX_CASE_OUTGOING_MODE[taxCaseKey as TaxCaseKey];
    if (!mode) return null;
    if (mode === 'small_business_19_ustg') return [];
    if (mode === 'standard_vat') return [{ kennziffer: outputRateKz(rate), direction: 'output', basis, tax }];
    return [{ kennziffer: OUTGOING_TAX_MODE_KZ[mode], direction: 'information', basis, tax: 0 }];
  }
  const mode = TAX_CASE_RECEIPT_MODE[taxCaseKey as TaxCaseKey];
  if (!mode) return null;
  if (mode === 'exempt' || mode === 'small_business') return [];
  const input: UstvaContribution = { kennziffer: inputTaxKz(mode), direction: 'input', basis, tax };
  return SELF_ASSESSED_RECEIPT_MODES.includes(mode) ? [{ kennziffer: selfAssessedKz(mode, rate), direction: 'output', basis, tax }, input] : [input];
};
