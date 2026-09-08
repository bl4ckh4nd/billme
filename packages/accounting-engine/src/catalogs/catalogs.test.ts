import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getManagementReportCatalogs,
  getPublicReportCatalogs,
  getPublicReportCatalogsIncludingUnverified,
  PUBLIC_BWA01_MICRO_2021,
} from './publicReportCatalogs';
import { loadPrivateDatevArtifact } from './datevArtifact';
import { getEurAnnexCatalog, validateEurAnnexCatalog } from '../../../desktop-services/src/eur/annexCatalog';
import { assertEurElsterReady, EUR_CATALOG_MANIFEST_2025, getCatalogForYear } from '../../../desktop-services/src/eurCatalog';
import { listReportMappingPositions } from '../reportMappingCatalog';

test('public report catalogs have provenance and no private account mapping', () => {
  const catalogs = getPublicReportCatalogs(2025);
  assert.equal(catalogs.length, 6);
  assert.deepEqual(
    catalogs.map((catalog) => catalog.id),
    [
      'hgb-bilanz-micro-2025',
      'hgb-bilanz-small-2025',
      'hgb-gkv-micro-2025',
      'hgb-gkv-small-2025',
      'bwa01-micro-2021',
      'bwa01-small-2021',
    ],
  );
  for (const catalog of catalogs) {
    assert.equal(catalog.provenance.sourceHashStatus, 'verified');
    assert.match(catalog.provenance.sourceSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(catalog.mappingStatus, 'public-structure-only');
    assert.ok(catalog.positions.every((position) => !('accountNumber' in position)));
  }
});

test('HGB balance scopes expose only statutory minimum detail', () => {
  const catalogs = getPublicReportCatalogs(2025);
  const micro = catalogs.find((catalog) => catalog.id === 'hgb-bilanz-micro-2025');
  const small = catalogs.find((catalog) => catalog.id === 'hgb-bilanz-small-2025');
  assert.deepEqual(micro?.positions.map((position) => position.key), [
    'assets.non-current', 'assets.current', 'assets.prepaid', 'assets.deferred-tax', 'assets.offset',
    'equity', 'provisions', 'liabilities', 'liabilities.prepaid', 'liabilities.deferred-tax',
  ]);
  assert.deepEqual(small?.positions.map((position) => position.key), [
    'assets.non-current', 'assets.non-current.intangible', 'assets.non-current.tangible', 'assets.non-current.financial',
    'assets.current', 'assets.current.inventory', 'assets.current.receivables', 'assets.current.securities', 'assets.current.cash',
    'assets.prepaid', 'assets.deferred-tax', 'assets.offset', 'equity', 'equity.subscribed', 'equity.capital-reserve',
    'equity.revenue-reserves', 'equity.profit-loss-forward', 'equity.result', 'provisions', 'liabilities', 'liabilities.prepaid', 'liabilities.deferred-tax',
  ]);
  assert.ok(!small?.positions.some((position) => position.key.includes('assets.current.securities.own')));
  assert.ok(!small?.positions.some((position) => position.key === 'assets.loss'));
});

test('report mapping positions derive balance side for every micro position', () => {
  const positions = listReportMappingPositions('hgb-bilanz', 'micro', '2025-12-31');
  assert.equal(positions.length, 10);
  assert.ok(positions.every((position) => position.side));
  assert.deepEqual(positions.map((position) => position.side), [
    'asset', 'asset', 'asset', 'asset', 'asset',
    'liability', 'liability', 'liability', 'liability', 'liability',
  ]);
});

test('report mapping positions require a supported catalog year', () => {
  assert.throws(() => listReportMappingPositions('hgb-bilanz', 'micro', ''), /REPORT_MAPPING_DATE_INVALID/);
  assert.equal(listReportMappingPositions('hgb-bilanz', 'micro', '2026-03-31').length, 10);
  assert.throws(() => listReportMappingPositions('hgb-bilanz', 'micro', '2027-01-01'), /PUBLIC_REPORT_CATALOG_UNAVAILABLE:2027/);
});

test('BWA01 ordered keys match the verified GründerZeiten 23 source', () => {
  const expected = [
    'revenue', 'total-output', 'material-expense', 'gross-profit', 'special-operating-income', 'operating-gross-profit',
    'personnel-expense', 'space-expense', 'operating-tax', 'insurance', 'special-cost', 'vehicle-expense', 'advertising-travel',
    'cost-of-goods-out', 'depreciation', 'maintenance', 'other-operating-expense', 'total-costs', 'operating-result', 'interest-expense',
    'other-neutral-expense', 'neutral-expense', 'interest-income', 'other-neutral-income', 'imputed-cost-offset', 'neutral-income',
    'result-before-tax', 'income-tax', 'preliminary-result',
  ];
  assert.deepEqual(PUBLIC_BWA01_MICRO_2021.positions.map((position) => position.key), expected);
  assert.equal(PUBLIC_BWA01_MICRO_2021.provenance.version, 'BMWi-GründerZeiten-23-2021-01');
  assert.equal(PUBLIC_BWA01_MICRO_2021.provenance.sourceHashStatus, 'verified');
  assert.equal(PUBLIC_BWA01_MICRO_2021.provenance.sourceSha256, '28976588a6a429db8b6c457c07225dae55e10d271ffc1ae37d6d25fc60b60163');
  assert.equal(getPublicReportCatalogs(2025).filter((catalog) => catalog.kind === 'bwa01').length, 2);
  assert.equal(getPublicReportCatalogsIncludingUnverified(2025).filter((catalog) => catalog.kind === 'bwa01').length, 2);
});

test('2026 report catalogs are explicit, verified snapshots', () => {
  const catalogs = [...getPublicReportCatalogs(2026), ...getManagementReportCatalogs(2026)];
  assert.equal(catalogs.length, 8);
  for (const catalog of catalogs) {
    assert.match(catalog.id, /2026$/);
    assert.equal(catalog.provenance.validFrom, '2026-01-01');
    assert.equal(catalog.provenance.validTo, '2026-12-31');
    assert.match(catalog.provenance.version, /2026/);
    assert.equal(catalog.provenance.sourceHashStatus, 'verified');
    assert.match(catalog.provenance.sourceSha256 ?? '', /^[a-f0-9]{64}$/);
  }
  assert.throws(() => getPublicReportCatalogs(2027), /PUBLIC_REPORT_CATALOG_UNAVAILABLE:2027/);
  assert.throws(() => getManagementReportCatalogs(2027), /PUBLIC_REPORT_CATALOG_UNAVAILABLE:2027/);
});

test('EÜR 2025 exposes sole-proprietor AVEÜR and SZ DAGs', () => {
  const aveur = getEurAnnexCatalog(2025, 'AVEÜR');
  const sz = getEurAnnexCatalog(2025, 'SZ');
  assert.equal(aveur.scope, 'de-sole-proprietor');
  assert.equal(sz.scope, 'de-sole-proprietor');
  assert.ok(aveur.lines.some((line) => line.kennziffer === '606'));
  assert.ok(sz.lines.some((line) => line.kennziffer === '271' || line.id.endsWith('_L30')));
  assert.doesNotThrow(() => validateEurAnnexCatalog(aveur));
});

test('EÜR 2025 models general and supplementary form paths without claiming ELSTER readiness', () => {
  const lines = getCatalogForYear(2025);
  assert.ok(lines.some((line) => line.lineNumber === 1 && line.providerPath === 'general'));
  assert.deepEqual(
    lines.filter((line) => line.lineNumber !== undefined && line.lineNumber >= 99 && line.lineNumber <= 107).map((line) => line.lineNumber),
    [99, 100, 101, 102, 103, 104, 105, 106, 107, 107],
  );
  assert.ok(lines.some((line) => line.kennziffer === '120' && (line.providerPath === undefined || line.providerPath === 'main')));
  assert.ok(lines.some((line) => line.kennziffer === '120' && line.providerPath === 'supplementary-reserves-release'));
  assert.equal(EUR_CATALOG_MANIFEST_2025.delivery, 'print-form-only');
  assert.equal(EUR_CATALOG_MANIFEST_2025.elsterReady, false);
  assert.throws(() => assertEurElsterReady(), /EUR_ELSTER_CATALOG_UNAVAILABLE/);
});

test('missing or tampered DATEV private artifacts fail closed', async () => {
  await assert.rejects(loadPrivateDatevArtifact({}), /DATEV_PRIVATE_ARTIFACT_UNAVAILABLE/);
  const root = await mkdtemp(join(tmpdir(), 'billme-datev-catalog-'));
  try {
    const artifactPath = join(root, 'skr.sqlite');
    const manifestPath = join(root, 'manifest.json');
    const bytes = Buffer.from('private fixture is test-only');
    await writeFile(artifactPath, bytes);
    await writeFile(manifestPath, JSON.stringify({
      id: 'test-private-datev',
      title: 'Test private artifact',
      vendor: 'DATEV',
      format: 'sqlite',
      version: 'test',
      validFrom: '2025-01-01',
      validTo: '2025-12-31',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      licenseNotice: 'Test-only private artifact',
      privateArtifact: true,
    }));
    const loaded = await loadPrivateDatevArtifact({ manifestPath, artifactPath });
    assert.equal(loaded.contentSha256, createHash('sha256').update(bytes).digest('hex'));
    await writeFile(artifactPath, 'tampered');
    await assert.rejects(loadPrivateDatevArtifact({ manifestPath, artifactPath }), /DATEV_PRIVATE_ARTIFACT_HASH_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
