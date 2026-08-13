import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EUR_CATALOG_MANIFEST_2026,
  assertEurElsterReady,
  getCatalogForYear,
  getCatalogManifestForYear,
} from './eurCatalog.js';
import { calculateEurAnnexFacts, getEurAnnexCatalog } from './eur/annexCatalog.js';

test('2026 EÜR catalog is versioned, printable, and provenance-stable', () => {
  const first = getCatalogForYear(2026);
  const second = getCatalogForYear(2026);
  assert.equal(first.length, 107);
  assert.equal(first[0]?.year, 2026);
  assert.deepEqual(first, second);
  assert.deepEqual(getCatalogManifestForYear(2026), EUR_CATALOG_MANIFEST_2026);
  assert.equal(EUR_CATALOG_MANIFEST_2026.delivery, 'print-form-only');
  assert.equal(EUR_CATALOG_MANIFEST_2026.elsterReady, false);
  assert.throws(() => assertEurElsterReady(EUR_CATALOG_MANIFEST_2026), /EUR_ELSTER_CATALOG_UNAVAILABLE/);
});

test('2026 AVEÜR and SZ catalogs calculate supplied facts and fail closed for unsupported years', () => {
  const annex = getEurAnnexCatalog(2026, 'AVEÜR');
  const input = annex.lines.find((line) => line.kind === 'input');
  assert.ok(input);
  const result = calculateEurAnnexFacts(2026, 'AVEÜR', [{ lineId: input.id, amount: 12.34, sourceId: 'cash-1' }], { requiredLineIds: [input.id] });
  assert.equal(result.values[input.id], 12.34);
  assert.throws(() => getEurAnnexCatalog(2027, 'SZ'), /EUR_ANNEX_CATALOG_UNAVAILABLE:2027/);
});

test('SZ totals use supplied derived facts and fail closed when a required fact is absent', () => {
  const catalog = getEurAnnexCatalog(2026, 'SZ');
  const facts = catalog.lines.filter((line) => line.kind !== 'computed').map((line) => ({ lineId: line.id, amount: 1 }));
  facts.push({ lineId: 'SZ_2026_L25', amount: 0.1 });
  const result = calculateEurAnnexFacts(2026, 'SZ', facts);
  assert.equal(result.values.SZ_2026_L11, 4);
  assert.equal(result.values.SZ_2026_L30, 0.1);
  assert.throws(() => calculateEurAnnexFacts(2026, 'SZ', facts.filter((fact) => fact.lineId !== 'SZ_2026_L25')), /Incomplete EÜR annex facts/);
});
