import { describe, expect, it } from 'vitest';
import { buildZugferdXml } from './zugferdXml';
import type { NormalizedEinvoice } from './normalizeInvoiceForEinvoice';

const fixture: NormalizedEinvoice = {
  invoiceNumber: 'RE-2026-001',
  issueDate: '2026-02-15',
  dueDate: '2026-02-22',
  currency: 'EUR',
  seller: {
    name: 'Billme GmbH',
    street: 'Hauptstr. 1',
    city: 'Berlin',
    postalCode: '10115',
    countryCode: 'DE',
    vatId: 'DE123456789',
  },
  buyer: {
    name: 'Kunde GmbH',
    street: 'Kundenweg 5',
    city: 'Hamburg',
    postalCode: '20095',
    countryCode: 'DE',
  },
  buyerVatId: 'ATU12345678',
  lines: [
    {
      lineId: '1',
      name: 'Leistung',
      quantity: 1,
      unitCode: 'C62',
      netUnitPrice: 100,
      netLineTotal: 100,
      taxRate: 19,
      taxCategoryCode: 'S',
      lineKind: 'item',
    },
  ],
  totals: {
    lineNetTotal: 100,
    taxTotal: 19,
    grandTotal: 119,
  },
};

describe('buildZugferdXml', () => {
  it('creates CII XML with expected key fields', () => {
    const xml = buildZugferdXml(fixture);
    expect(xml).toContain('<rsm:CrossIndustryInvoice');
    expect(xml).toContain('<ram:ID>RE-2026-001</ram:ID>');
    expect(xml).toContain('<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>');
    expect(xml).toContain('<ram:GrandTotalAmount>119.00</ram:GrandTotalAmount>');
    expect(xml).toContain('<ram:Name>Billme GmbH</ram:Name>');
    expect(xml).toContain('<ram:Name>Kunde GmbH</ram:Name>');
    expect(xml).toContain('ATU12345678');
  });

  it('serializes optional rows as an explicit zero-value line with its notice', () => {
    const xml = buildZugferdXml({
      ...fixture,
      lines: [
        {
          ...fixture.lines[0]!,
          lineId: '1',
          lineKind: 'optional',
          name: 'Premium Support (Optional: nur bei Beauftragung)',
          netUnitPrice: 0,
          netLineTotal: 0,
        },
      ],
      totals: { lineNetTotal: 0, taxTotal: 0, grandTotal: 0 },
    });
    expect(xml).toContain('<ram:Name>Premium Support (Optional: nur bei Beauftragung)</ram:Name>');
    expect(xml).toContain('<ram:ChargeAmount>0.00</ram:ChargeAmount>');
    expect(xml).toContain('<ram:LineTotalAmount>0.00</ram:LineTotalAmount>');
    expect((xml.match(/<ram:IncludedSupplyChainTradeLineItem>/g) ?? [])).toHaveLength(1);
  });
});
