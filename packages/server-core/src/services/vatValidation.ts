import { z } from 'zod';

export const vatValidationStatusSchema = z.enum(['valid', 'invalid', 'unavailable']);

export const vatValidationResultSchema = z.object({
  status: vatValidationStatusSchema,
  normalizedVatId: z.string(),
  checkedAt: z.string(),
});

export type VatValidationResult = z.infer<typeof vatValidationResultSchema>;

export type VatValidationInput = {
  countryCode: string;
  vatNumber: string;
};

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const EU_VAT_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'GR',
  'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

export const normalizeVatId = ({ countryCode, vatNumber }: VatValidationInput) => {
  const country = countryCode.trim().toUpperCase();
  const normalizedVatId = vatNumber.replace(/\s+/g, '').toUpperCase();
  const localVatNumber = normalizedVatId.startsWith(country)
    ? normalizedVatId.slice(country.length)
    : normalizedVatId;
  return { country, normalizedVatId, localVatNumber };
};

/**
 * Validates an EU VAT ID through VIES. The server owns this call so browser and
 * desktop clients never depend on VIES CORS behavior or its transient uptime.
 */
export const validateVatId = async (
  input: VatValidationInput,
  options: { fetchImpl?: Fetcher; timeoutMs?: number; now?: () => string } = {},
): Promise<VatValidationResult> => {
  const { country, normalizedVatId, localVatNumber } = normalizeVatId(input);
  const checkedAt = options.now?.() ?? new Date().toISOString();
  if (!EU_VAT_COUNTRIES.has(country)) {
    return { status: 'unavailable', normalizedVatId, checkedAt };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await (options.fetchImpl ?? fetch)('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ countryCode: country, vatNumber: localVatNumber }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'unavailable', normalizedVatId, checkedAt };
    }
    const payload = await response.json() as { valid?: boolean };
    return { status: payload.valid === true ? 'valid' : 'invalid', normalizedVatId, checkedAt };
  } catch {
    return { status: 'unavailable', normalizedVatId, checkedAt };
  } finally {
    clearTimeout(timeout);
  }
};
