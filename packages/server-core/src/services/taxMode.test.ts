import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TAX_MODE,
  INVOICE_TAX_MODE_DEFINITIONS,
  calculateInvoiceTaxSnapshot,
  getDachVatRates,
  recommendInvoiceTaxMode,
  getDefaultTaxRate,
  getInvoiceTaxExemptionReason,
  getInvoiceTaxModeDefinition,
  resolveInvoiceTaxMode,
  type TaxSettingsShape,
} from './taxMode.js';
import type { InvoiceTaxMode } from '../domain/foundations.js';

const settings = (overrides: Partial<TaxSettingsShape['legal']> = {}): TaxSettingsShape => ({
  legal: { smallBusinessRule: false, defaultVatRate: 19, ...overrides },
});

const items = (...totals: number[]) =>
  totals.map((total, index) => ({ id: `i${index}`, total }) as never);

// The EN 16931 category code per mode is the contract every edition must honour.
// Lite and Pro both render ZUGFeRD XML from this table, so a change here is a
// conformance change, not a refactor.
const EXPECTED: Array<{ mode: InvoiceTaxMode; code: string; zeroVat: boolean }> = [
  { mode: 'standard_vat', code: 'S', zeroVat: false },
  { mode: 'small_business_19_ustg', code: 'E', zeroVat: true },
  { mode: 'reverse_charge_13b', code: 'AE', zeroVat: true },
  { mode: 'intra_eu_supply_6a', code: 'K', zeroVat: true },
  { mode: 'intra_eu_service_reverse_charge', code: 'AE', zeroVat: true },
  { mode: 'export_third_country', code: 'G', zeroVat: true },
  { mode: 'vat_exempt_4_ustg', code: 'E', zeroVat: true },
  { mode: 'non_taxable_outside_scope', code: 'O', zeroVat: true },
];

test('exposes exactly the eight supported tax modes', () => {
  assert.equal(INVOICE_TAX_MODE_DEFINITIONS.length, EXPECTED.length);
  assert.deepEqual(
    INVOICE_TAX_MODE_DEFINITIONS.map((it) => it.mode).sort(),
    EXPECTED.map((it) => it.mode).sort(),
  );
});

test('every mode maps to its EN 16931 category code', () => {
  for (const { mode, code } of EXPECTED) {
    assert.equal(getInvoiceTaxModeDefinition(mode).einvoiceCategoryCode, code, `mode ${mode}`);
  }
});

test('only standard_vat charges VAT', () => {
  for (const { mode, zeroVat } of EXPECTED) {
    assert.equal(
      Boolean(getInvoiceTaxModeDefinition(mode).forceZeroVat),
      zeroVat,
      `forceZeroVat for ${mode}`,
    );
  }
});

test('resolve prefers an explicit mode over the small-business setting', () => {
  assert.equal(
    resolveInvoiceTaxMode('reverse_charge_13b', settings({ smallBusinessRule: true })),
    'reverse_charge_13b',
  );
});

test('resolve falls back to small business, then to the default', () => {
  assert.equal(
    resolveInvoiceTaxMode(undefined, settings({ smallBusinessRule: true })),
    'small_business_19_ustg',
  );
  assert.equal(resolveInvoiceTaxMode(undefined, settings()), DEFAULT_TAX_MODE);
});

test('an unknown mode falls back instead of throwing', () => {
  assert.equal(resolveInvoiceTaxMode('bogus' as InvoiceTaxMode, settings()), DEFAULT_TAX_MODE);
});

test('standard_vat applies the default rate', () => {
  const snapshot = calculateInvoiceTaxSnapshot({ taxMode: 'standard_vat', items: items(100) }, settings());
  assert.equal(snapshot.netAmount, 100);
  assert.equal(snapshot.vatAmount, 19);
  assert.equal(snapshot.grossAmount, 119);
  assert.equal(snapshot.einvoiceCategoryCode, 'S');
});

test('every zero-VAT mode yields gross === net', () => {
  for (const { mode, zeroVat } of EXPECTED) {
    if (!zeroVat) continue;
    const snapshot = calculateInvoiceTaxSnapshot({ taxMode: mode, items: items(100, 50) }, settings());
    assert.equal(snapshot.vatAmount, 0, `vat for ${mode}`);
    assert.equal(snapshot.netAmount, 150, `net for ${mode}`);
    assert.equal(snapshot.grossAmount, 150, `gross for ${mode}`);
  }
});

test('reverse charge stays zero-rated even when line items carry a rate', () => {
  const snapshot = calculateInvoiceTaxSnapshot(
    {
      taxMode: 'reverse_charge_13b',
      items: [{ id: 'a', total: 1000, taxRate: 19 } as never],
    },
    settings(),
  );
  assert.equal(snapshot.vatAmount, 0);
  assert.equal(snapshot.grossAmount, 1000);
  assert.equal(snapshot.einvoiceCategoryCode, 'AE');
});

test('mixed line rates are broken down per rate', () => {
  const snapshot = calculateInvoiceTaxSnapshot(
    {
      taxMode: 'standard_vat',
      items: [
        { id: 'a', total: 100, taxRate: 19 } as never,
        { id: 'b', total: 100, taxRate: 7 } as never,
      ],
    },
    settings(),
  );
  assert.equal(snapshot.netAmount, 200);
  assert.equal(snapshot.vatAmount, 26);
  assert.equal(snapshot.vatBreakdown?.length, 2);
});

test('rounding stays at two decimals', () => {
  const snapshot = calculateInvoiceTaxSnapshot(
    { taxMode: 'standard_vat', items: items(0.015) },
    settings({ defaultVatRate: 19 }),
  );
  assert.equal(snapshot.netAmount, 0.02);
  assert.equal(snapshot.grossAmount, round2Check(snapshot.netAmount + snapshot.vatAmount));
});

function round2Check(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

test('non-finite money never leaks into a total', () => {
  const snapshot = calculateInvoiceTaxSnapshot(
    {
      taxMode: 'standard_vat',
      items: [
        { id: 'a', total: Number.POSITIVE_INFINITY } as never,
        { id: 'b', total: Number.NaN } as never,
        { id: 'c', total: 100, taxRate: Number.POSITIVE_INFINITY } as never,
      ],
    },
    settings(),
  );
  assert.ok(Number.isFinite(snapshot.netAmount), 'netAmount must be finite');
  assert.ok(Number.isFinite(snapshot.vatAmount), 'vatAmount must be finite');
  assert.ok(Number.isFinite(snapshot.grossAmount), 'grossAmount must be finite');
});

test('the default tax rate never goes negative', () => {
  assert.equal(getDefaultTaxRate(settings({ defaultVatRate: 19 })), 19);
  assert.equal(getDefaultTaxRate(settings({ defaultVatRate: -5 })), 0);
  assert.equal(getDefaultTaxRate(settings({ defaultVatRate: undefined })), 0);
});

test('every zero-rated mode carries a legal exemption reason', () => {
  for (const { mode, zeroVat } of EXPECTED) {
    const reason = getInvoiceTaxExemptionReason(mode);
    if (zeroVat) assert.ok(reason && reason.length > 0, `missing exemption reason for ${mode}`);
    else assert.equal(reason, undefined, `standard rate must not carry a reason`);
  }
});

test('an explicit exemption reason overrides the legal default', () => {
  assert.equal(
    getInvoiceTaxExemptionReason('reverse_charge_13b', { exemptionReasonOverride: ' Eigene Begründung ' }),
    'Eigene Begründung',
  );
});

test('tax notice avoids German statute citations for AT and CH sellers', () => {
  assert.equal(
    getInvoiceTaxExemptionReason('reverse_charge_13b', { sellerCountryCode: 'AT' }),
    'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)',
  );
  assert.match(getInvoiceTaxExemptionReason('reverse_charge_13b', { sellerCountryCode: 'CH' }) ?? '', /Bezugsteuer/);
});

test('DACH rate catalog exposes country defaults without adding EU automation', () => {
  assert.deepEqual(getDachVatRates('DE'), [19, 7]);
  assert.deepEqual(getDachVatRates('AT'), [20, 10, 13, 4.9]);
  assert.deepEqual(getDachVatRates('CH'), [8.1, 2.6, 3.8]);
});

test('cross-border recommendation is explicit and never silently applied', () => {
  const recommendation = recommendInvoiceTaxMode({
    sellerCountryCode: 'DE',
    buyerCountryCode: 'AT',
    buyerType: 'business',
    sellerVatId: 'DE123456789',
    buyerVatId: 'ATU12345678',
  });
  assert.equal(recommendation.mode, 'intra_eu_service_reverse_charge');
  assert.equal(recommendation.requiresConfirmation, true);
});

test('document rate override takes precedence over company default', () => {
  const snapshot = calculateInvoiceTaxSnapshot({
    taxMode: 'standard_vat',
    taxMeta: { defaultVatRate: 20 },
    items: items(100),
  }, settings({ defaultVatRate: 19 }));
  assert.equal(snapshot.vatAmount, 20);
});
