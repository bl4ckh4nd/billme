import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDatevTaxEvidence, validateDatevTaxEvidence } from './datevTaxEvidence';

const ossCase = { key: 'EU_B2C_OSS' as const, requiresCountry: true, requiresCounterpartyVatId: false, requiresEvidence: true };
const ossEvidence = { buyerCountryCode: 'AT', datevEvidenceType: 'invoice', datevEvidenceReference: 'oss-proof-1' };

test('OSS verlangt den Bestimmungsland-Steuersatz', () => {
  assert.deepEqual(validateDatevTaxEvidence(ossCase, ossEvidence).map((item) => item.code), ['MISSING_DESTINATION_VAT_RATE']);
  assert.deepEqual(validateDatevTaxEvidence(ossCase, { ...ossEvidence, destinationVatRate: 20 }), []);
  assert.deepEqual(validateDatevTaxEvidence(ossCase, { ...ossEvidence, destinationVatRate: 0 }), []);
});

test('OSS weist unsinnige Bestimmungsland-Steuersätze ab', () => {
  for (const destinationVatRate of [-1, 100, Number.NaN]) {
    assert.deepEqual(
      validateDatevTaxEvidence(ossCase, { ...ossEvidence, destinationVatRate }).map((item) => item.code),
      ['MISSING_DESTINATION_VAT_RATE'],
      String(destinationVatRate),
    );
  }
});

test('Ländercode, USt-IdNr. und Nachweis werden nur bei entsprechender Steuerfall-Definition verlangt', () => {
  const strict = { key: 'EU_IGL_GOODS_0' as const, requiresCountry: true, requiresCounterpartyVatId: true, requiresEvidence: true };
  assert.deepEqual(
    validateDatevTaxEvidence(strict, { destinationVatRate: 0 }).map((item) => item.code),
    ['MISSING_TAX_COUNTRY', 'MISSING_COUNTERPARTY_VAT_ID', 'MISSING_TAX_EVIDENCE'],
  );
  assert.deepEqual(validateDatevTaxEvidence({ ...strict, key: 'DE_STD_19' as const, requiresCountry: false, requiresCounterpartyVatId: false, requiresEvidence: false }, {}), []);
});

test('Sachverhalt L+L wird bei Reverse-Charge-Fällen verlangt und aus numerischer Nachweisreferenz abgeleitet', () => {
  const rc = { key: 'DE_RC_13B_DOMESTIC' as const, requiresCountry: false, requiresCounterpartyVatId: false, requiresEvidence: true };
  const evidence = { datevEvidenceType: 'reverse_charge', datevEvidenceReference: 'beleg-7' };
  assert.deepEqual(validateDatevTaxEvidence(rc, evidence).map((item) => item.code), ['MISSING_DATEV_SACHVERHALT']);
  assert.deepEqual(validateDatevTaxEvidence(rc, { ...evidence, datevEvidenceReference: '13' }), []);
  assert.deepEqual(validateDatevTaxEvidence(rc, { ...evidence, datevSachverhaltLl: '13' }), []);
});

test('normalizeDatevTaxEvidence trimmt und normiert Land und USt-IdNr.', () => {
  assert.deepEqual(
    normalizeDatevTaxEvidence({ buyerCountryCode: ' at ', buyerVatId: ' atu12345678 ', datevEvidenceType: ' invoice ', datevEvidenceReference: ' r1 ' }),
    { buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', destinationVatRate: undefined, datevSachverhaltLl: undefined, datevEvidenceType: 'invoice', datevEvidenceReference: 'r1' },
  );
});
