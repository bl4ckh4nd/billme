import { describe, expect, it } from 'vitest';
import { buildDatevBuchungsstapelCsv, validateDatevRows } from './datevExport';

describe('datevExport', () => {
  it('validates mandatory DATEV row fields', () => {
    expect(() =>
      validateDatevRows([
        {
          date: '2026-03-03',
          belegfeld1: '1001',
          buchungstext: 'Eingang Rechnung 1001',
          konto: '1200',
          gegenkonto: '8400',
          umsatz: 100,
        },
      ]),
    ).not.toThrow();
  });

  it('rejects malformed rows', () => {
    expect(() =>
      validateDatevRows([
        {
          date: '03.03.2026',
          belegfeld1: '',
          buchungstext: '',
          konto: '12',
          gegenkonto: 'x',
          umsatz: 0,
        },
      ]),
    ).toThrow(/Validierung fehlgeschlagen/);
  });

  const options = {
    consultantNumber: '1001',
    clientNumber: '1',
    fiscalYearStart: '2026-01-01',
    accountLength: 4,
    chart: 'SKR03' as const,
    from: '2026-03-01',
    to: '2026-03-31',
  };

  it('builds DATEV format 13 with 125 fields, CP1252, and CRLF', () => {
    const buf = buildDatevBuchungsstapelCsv([
      {
        date: '2026-03-03',
        belegfeld1: '1001',
        buchungstext: 'Eingang Rechnung 1001',
        konto: '1200',
        gegenkonto: '8400',
        umsatz: 100,
      },
    ], options);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const text = new TextDecoder('windows-1252').decode(buf);
    const lines = text.split('\r\n');
    expect(lines[0]).toContain('"EXTF";700;21;"Buchungsstapel";13;');
    expect(lines[1]!.split(';')).toHaveLength(125);
    expect(lines[2]!.split(';')[9]).toBe('0303');
    expect(lines[2]!.endsWith('\r\n')).toBe(false);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('supports explicit UTF-8 with BOM', () => {
    const buf = buildDatevBuchungsstapelCsv([], { ...options, encoding: 'utf8-bom' });
    expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
  });

  it('rejects truncation, invalid BU keys, and the 100,000th row', () => {
    const row = { date: '2026-03-03', belegfeld1: '1001', buchungstext: 'x', konto: '1200', gegenkonto: '8400', umsatz: 1 };
    expect(() => buildDatevBuchungsstapelCsv([{ ...row, buchungstext: 'x'.repeat(61) }], options)).toThrow();
    expect(() => buildDatevBuchungsstapelCsv([{ ...row, buSchluessel: '1' }], options)).toThrow();
    expect(() => buildDatevBuchungsstapelCsv(Array.from({ length: 100_000 }, () => row), options)).toThrow(/99999/);
  });

  it('quotes text and doubles embedded quotes without accepting controls', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: '1001/2026', buchungstext: 'Kunde "A"', konto: '1200', gegenkonto: '8400', umsatz: 1,
    }], options);
    const text = new TextDecoder('windows-1252').decode(buf);
    expect(text).toContain('"1001/2026"');
    expect(text).toContain('"Kunde ""A"""');
    expect(() => buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: '1001', buchungstext: 'bad\ntext', konto: '1200', gegenkonto: '8400', umsatz: 1,
    }], options)).toThrow();
  });

  it('writes EU and §13b facts at the official field positions and accepts one-digit-longer person accounts', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: '1001', buchungstext: 'EU-Leistung', konto: '10000', gegenkonto: '8400',
      buSchluessel: '0094', euLandUstId: 'FR12345678901', euSteuersatz: 20, sachverhaltLl: '13', umsatz: 1,
    }], options);
    const row = new TextDecoder('windows-1252').decode(buf).split('\r\n')[2]!.split(';');
    expect(row).toHaveLength(125);
    expect(row[8]).toBe('"0094"');
    expect(row[39]).toBe('"FR12345678901"');
    expect(row[40]).toBe('20,00');
    expect(row[42]).toBe('13');
    for (const buSchluessel of ['0041', '0042', '0043']) {
      expect(() => buildDatevBuchungsstapelCsv([{
        date: '2026-03-03', belegfeld1: '1001', buchungstext: 'BU', konto: '1200', gegenkonto: '8400', buSchluessel, umsatz: 1,
      }], options)).not.toThrow();
    }
  });

  it('formats a one-digit EU rate with the required two integer digits and allows OSS without a VAT ID', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: 'OSS-1', buchungstext: 'OSS', konto: '8400', gegenkonto: '1200',
      euLandUstId: 'FR', euSteuersatz: 7, umsatz: 1,
    }], options);
    const row = new TextDecoder('windows-1252').decode(buf).split('\r\n')[2]!.split(';');
    expect(row[39]).toBe('"FR"');
    expect(row[40]).toBe('07,00');
    expect(row[42]).toBe('');
  });

  it('keeps triangular EU evidence with BU 42 in the same official columns', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: 'TRI-1', buchungstext: 'Dreieck', konto: '8400', gegenkonto: '1200',
      buSchluessel: '0042', euLandUstId: 'NL123456789B01', euSteuersatz: 21, umsatz: 1,
    }], options);
    const row = new TextDecoder('windows-1252').decode(buf).split('\r\n')[2]!.split(';');
    expect(row[8]).toBe('"0042"');
    expect(row[39]).toBe('"NL123456789B01"');
    expect(row[40]).toBe('21,00');
    expect(row[42]).toBe('');
  });

  it('rejects a document date outside the declared fiscal year', () => {
    expect(() => buildDatevBuchungsstapelCsv([{
      date: '2025-12-31', belegfeld1: '1001', buchungstext: 'boundary', konto: '1200', gegenkonto: '8400', umsatz: 1,
    }], options)).toThrow(/Wirtschaftsjahres/);
  });
});
