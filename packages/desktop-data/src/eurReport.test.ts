import { describe, expect, it } from 'vitest';
import { buildEurCsv } from './eurReport';
import { getCatalogForYear, getCatalogManifestForYear, validateEurLineCatalog } from '@billme/desktop-services/eurCatalog';

describe('eurCatalog validation', () => {
  it('rejects duplicate ids', () => {
    expect(() =>
      validateEurLineCatalog([
        { year: 2025, id: 'A', kennziffer: '111', label: 'A', kind: 'income', exportable: true },
        { year: 2025, id: 'A', kennziffer: '112', label: 'B', kind: 'income', exportable: true },
      ]),
    ).toThrow();
  });

  it('rejects computed cycles', () => {
    expect(() =>
      validateEurLineCatalog([
        { year: 2025, id: 'A', kennziffer: '111', label: 'A', kind: 'computed', exportable: true, computedFromIds: ['B'] },
        { year: 2025, id: 'B', kennziffer: '112', label: 'B', kind: 'computed', exportable: true, computedFromIds: ['A'] },
      ]),
    ).toThrow();
  });

  it('loads 2025 catalog entries', () => {
    const lines = getCatalogForYear(2025);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.id === 'E2025_KZ111')).toBe(true);
  });

  it('loads supported 2026 catalog entries with provenance', () => {
    const lines = getCatalogForYear(2026);
    expect(lines).toHaveLength(107);
    expect(lines[0]).toMatchObject({ year: 2026, id: 'E2026_GENERAL_001' });

    expect(getCatalogManifestForYear(2026)).toMatchObject({
      id: 'anlage-euer-2026',
      version: 'BMF-2026-2026-08-14',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      delivery: 'print-form-only',
      elsterReady: false,
      sha256: '50d6c8c8d8c5fb7cab8c26f6255e7776f9bac6beac29562ccf3c741cb9d92f18',
    });
  });
});

describe('eurReport CSV export', () => {
  it('builds UTF-8 BOM CSV with exportable lines', () => {
    const csv = buildEurCsv({
      taxYear: 2025,
      from: '2025-01-01',
      to: '2025-12-31',
      rows: [
        {
          lineId: 'E2025_KZ111',
          kennziffer: '111',
          label: 'Betriebseinnahmen',
          kind: 'income',
          exportable: true,
          total: 100,
          sortOrder: 1,
        },
        {
          lineId: 'E2025_X',
          kennziffer: '999',
          label: 'Hidden',
          kind: 'computed',
          exportable: false,
          total: 200,
          sortOrder: 2,
        },
      ],
      summary: {
        incomeTotal: 100,
        expenseTotal: 0,
        surplus: 100,
      },
      unclassifiedCount: 0,
      warnings: [],
      catalog: {
        id: 'anlage-euer-2025',
        version: 'BMF-2025-2025-08-29',
        sourceHash: 'b'.repeat(64),
        delivery: 'print-form-only',
        elsterReady: false,
      },
    });

    expect(csv.startsWith('\uFEFFKennziffer;Bezeichnung;Betrag')).toBe(true);
    expect(csv).toContain('111;Betriebseinnahmen;100,00');
    expect(csv).not.toContain('Hidden');
  });
});
