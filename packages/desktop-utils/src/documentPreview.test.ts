import { describe, expect, it } from 'vitest';
import { getPreviewElements } from './documentPreview';

const table = {
  id: 'items',
  type: 'TABLE',
  label: 'items_table',
  x: 0,
  y: 0,
  style: { width: 640, height: 200 },
  tableData: { columns: [{ id: 'desc', label: 'Beschreibung', width: 400, visible: true, align: 'left' as const }] },
};

const settings = {
  legal: { countryCode: 'DE', defaultVatRate: 19 },
  company: { name: 'Billme', street: '', zip: '', city: '' },
  finance: { vatId: '' },
} as never;

describe('getPreviewElements', () => {
  it('renders resolver subtotals with group scope and running reset', () => {
    const [preview] = getPreviewElements({
      number: 'RE-1', date: '2026-08-07', dueDate: '2026-08-21', client: 'Kunde', clientEmail: '',
      items: [
        { kind: 'group', description: 'Bauabschnitt 1', quantity: 0, price: 0, total: 0 },
        { kind: 'item', description: 'Fläche', quantity: 2, price: 50, total: 100, unit: 'm²' },
        { kind: 'summary', description: 'Abschnittssumme', quantity: 0, price: 0, total: 0, summaryScope: 'group', summaryMetric: 'amount' },
        { kind: 'item', description: 'Montage', quantity: 1, price: 10, total: 10, unit: 'Std.' },
        { kind: 'summary', description: 'Laufende Summe', quantity: 0, price: 0, total: 0, summaryScope: 'running', summaryMetric: 'amount' },
        { kind: 'summary', description: 'Mengen', quantity: 0, price: 0, total: 0, summaryScope: 'running', summaryMetric: 'quantity' },
      ],
    }, [table], settings);
    const rows = preview?.tableData?.rows ?? [];
    expect(rows[2]?.cells?.[4]).toContain('100,00');
    expect(rows[4]?.cells?.[4]).toContain('110,00');
    expect(rows[5]?.cells?.[4]).toBe('');
  });
});
