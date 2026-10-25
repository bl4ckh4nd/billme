// Format checks for the master data that lands on every invoice (§14 UStG): postcode, USt-IdNr., BIC.
// Forms show the sentence at the field; the server routes refuse the same values with 400.
// Each function returns undefined for an empty value: whether a field is required is the caller's rule.

/** ISO country code for the usual ways a country is written in an address ("DE", "Deutschland", "Österreich"). */
export const addressCountryCode = (country: string | undefined): string => {
  const value = (country ?? '').trim().toUpperCase();
  if (!value || value === 'DEUTSCHLAND' || value === 'GERMANY' || value === 'D') return 'DE';
  if (value === 'ÖSTERREICH' || value === 'OESTERREICH' || value === 'AUSTRIA') return 'AT';
  if (value === 'SCHWEIZ' || value === 'SWITZERLAND') return 'CH';
  return value;
};

/** Postcode rule for Germany, Austria and Switzerland; other countries are free-form. */
export const zipError = (zip: string, country?: string): string | undefined => {
  const value = zip.trim();
  if (!value) return undefined;
  const code = addressCountryCode(country);
  if (code === 'DE' && !/^\d{5}$/.test(value)) return 'Eine deutsche PLZ hat fünf Ziffern, z. B. 10115.';
  if ((code === 'AT' || code === 'CH') && !/^\d{4}$/.test(value)) return `Eine PLZ in ${code === 'AT' ? 'Österreich' : 'der Schweiz'} hat vier Ziffern.`;
  return undefined;
};

/** USt-IdNr. as stored: without spaces, dots or dashes, upper case. */
const compactVatId = (value: string): string => value.replace(/[\s.-]+/g, '').toUpperCase();

// EU member states (Greece uses EL), XI for Northern Ireland; the part after the prefix per state.
const VAT_ID_PATTERNS: Record<string, RegExp> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DE: /^\d{9}$/,
  DK: /^\d{8}$/, EE: /^\d{9}$/, EL: /^\d{9}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^\d{8}$/, FR: /^[A-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/, HU: /^\d{8}$/, IE: /^\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/, IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/, LV: /^\d{11}$/, MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/, RO: /^\d{2,10}$/,
  SE: /^\d{12}$/, SI: /^\d{8}$/, SK: /^\d{10}$/, XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** Why a USt-IdNr. cannot be right: EU prefix plus the length of that state (DE: DE + 9 digits). */
export const vatIdError = (value: string): string | undefined => {
  const vatId = compactVatId(value);
  if (!vatId) return undefined;
  const prefix = vatId.slice(0, 2);
  const pattern = VAT_ID_PATTERNS[prefix];
  if (!pattern) return 'Die USt-IdNr. beginnt mit dem Ländercode eines EU-Staats, z. B. DE123456789.';
  if (!pattern.test(vatId.slice(2))) {
    return prefix === 'DE'
      ? 'Eine deutsche USt-IdNr. ist DE plus 9 Ziffern, z. B. DE123456789.'
      : `Die USt-IdNr. hat nicht das Format für ${prefix}. Bitte auf Tippfehler prüfen.`;
  }
  return undefined;
};

/** BIC (ISO 9362): 8 or 11 characters. */
export const bicError = (value: string): string | undefined => {
  const bic = value.replace(/\s+/g, '').toUpperCase();
  if (!bic) return undefined;
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) ? undefined : 'Die BIC hat 8 oder 11 Zeichen, z. B. COBADEFFXXX.';
};

type SettingsMasterdata = {
  company: { zip: string };
  finance: { vatId: string; bic: string };
  legal: { countryCode?: string };
};

// A value stored before these checks existed stays saveable, so saving another section never fails on it.
const changed = <T>(after: T, before: T | undefined, pick: (value: T) => string | undefined) =>
  before === undefined || (pick(after) ?? '') !== (pick(before) ?? '');

/** First reason the settings master data cannot go on an invoice, as a German sentence; undefined when it can. */
export const settingsMasterdataError = (after: SettingsMasterdata, before?: SettingsMasterdata): string | undefined => {
  const checks: Array<[(s: SettingsMasterdata) => string, (value: string) => string | undefined]> = [
    // Only a German seat is checked: the company address has no country field of its own.
    [(s) => s.company.zip, (value) => ((after.legal.countryCode ?? 'DE') === 'DE' ? zipError(value, 'DE') : undefined)],
    [(s) => s.finance.vatId, vatIdError],
    [(s) => s.finance.bic, bicError],
  ];
  for (const [pick, check] of checks) {
    if (!changed(after, before, pick)) continue;
    const error = check(pick(after));
    if (error) return error;
  }
  return undefined;
};

type ClientMasterdata = {
  addresses?: Array<{ zip: string; country?: string }>;
  taxProfile?: { vatId?: string };
};

/** First reason a client's PLZ or USt-IdNr. cannot be right; unchanged stored values pass. */
export const clientMasterdataError = (after: ClientMasterdata, before?: ClientMasterdata | null): string | undefined => {
  const storedZips = new Set((before?.addresses ?? []).map((address) => `${address.zip}|${address.country ?? ''}`));
  for (const address of after.addresses ?? []) {
    if (storedZips.has(`${address.zip}|${address.country ?? ''}`)) continue;
    const error = zipError(address.zip, address.country);
    if (error) return error;
  }
  const vatId = after.taxProfile?.vatId ?? '';
  return vatId !== (before?.taxProfile?.vatId ?? '') ? vatIdError(vatId) : undefined;
};
