import { describe, expect, it, vi } from 'vitest';
import { normalizeVatId, validateVatId } from './vatValidation';

describe('vat validation', () => {
  it('normalizes country prefixes and whitespace', () => {
    expect(normalizeVatId({ countryCode: ' de ', vatNumber: 'DE 123 456 789' })).toEqual({
      country: 'DE',
      normalizedVatId: 'DE123456789',
      localVatNumber: '123456789',
    });
  });

  it('returns the VIES result and sends only the local number', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ countryCode: 'AT', vatNumber: 'U12345678' });
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    });
    const result = await validateVatId(
      { countryCode: 'AT', vatNumber: 'AT U12345678' },
      { fetchImpl, now: () => '2026-08-06T12:00:00.000Z' },
    );
    expect(result).toEqual({ status: 'valid', normalizedVatId: 'ATU12345678', checkedAt: '2026-08-06T12:00:00.000Z' });
  });

  it('maps VIES invalid responses and upstream failures to deterministic statuses', async () => {
    const invalid = await validateVatId(
      { countryCode: 'DE', vatNumber: 'DE123456789' },
      { fetchImpl: async () => new Response(JSON.stringify({ valid: false }), { status: 200 }) },
    );
    expect(invalid.status).toBe('invalid');

    const unavailable = await validateVatId(
      { countryCode: 'DE', vatNumber: 'DE123456789' },
      { fetchImpl: async () => new Response('', { status: 503 }) },
    );
    expect(unavailable.status).toBe('unavailable');
  });

  it('aborts a VIES timeout and returns unavailable', async () => {
    const fetchImpl = async (_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
    });
    const result = await validateVatId(
      { countryCode: 'DE', vatNumber: 'DE123456789' },
      { fetchImpl, timeoutMs: 1 },
    );
    expect(result.status).toBe('unavailable');
  });

  it('does not call VIES for non-EU countries', async () => {
    const fetchImpl = vi.fn();
    await expect(validateVatId({ countryCode: 'CH', vatNumber: 'CHE-123.456.789 MWST' }, { fetchImpl })).resolves.toMatchObject({ status: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
