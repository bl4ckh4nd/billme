import { describe, expect, it } from 'vitest';
import { buildEurCsv } from './eurReport';
import { getCatalogForYear, validateEurLineCatalog } from './eurCatalog';

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
    });

    expect(csv.startsWith('\uFEFFKennziffer;Bezeichnung;Betrag')).toBe(true);
    expect(csv).toContain('111;Betriebseinnahmen;100,00');
    expect(csv).not.toContain('Hidden');
  });
});
