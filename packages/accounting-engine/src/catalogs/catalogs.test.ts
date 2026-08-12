import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublicReportCatalogs } from './publicReportCatalogs';
import { loadPrivateDatevArtifact } from './datevArtifact';
import { getEurAnnexCatalog, validateEurAnnexCatalog } from '../../../desktop-services/src/eur/annexCatalog';

test('public report catalogs have provenance and no private account mapping', () => {
  const catalogs = getPublicReportCatalogs(2025);
  assert.equal(catalogs.length, 6);
  assert.deepEqual(
    catalogs.map((catalog) => catalog.id),
    ['hgb-bilanz-micro-2025', 'hgb-bilanz-small-2025', 'hgb-gkv-micro-2025', 'hgb-gkv-small-2025', 'bwa01-micro-2025', 'bwa01-small-2025'],
  );
  for (const catalog of catalogs) {
    assert.match(catalog.provenance.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(catalog.mappingStatus, 'public-structure-only');
    assert.ok(catalog.positions.every((position) => !('accountNumber' in position)));
  }
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
