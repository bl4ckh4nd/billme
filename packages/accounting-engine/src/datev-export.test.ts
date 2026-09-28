import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDatevBuchungsstapelCsv, validateDatevRows } from './datev-export.js';

describe('datevExport', () => {
  it('validates mandatory DATEV row fields', () => {
    assert.doesNotThrow(() =>
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
    );
  });

  it('rejects malformed rows', () => {
    assert.throws(() =>
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
      /Validierung fehlgeschlagen/,
    );
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

    assert.equal(Buffer.isBuffer(buf), true);
    assert.equal(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    const text = new TextDecoder('windows-1252').decode(buf);
    const lines = text.split('\r\n');
    assert.ok(lines[0]!.includes('"EXTF";700;21;"Buchungsstapel";13;'));
    assert.equal(lines[1]!.split(';').length, 125);
    assert.equal(lines[2]!.split(';')[9], '0303');
    assert.equal(lines[2]!.endsWith('\r\n'), false);
    assert.equal(text.endsWith('\r\n'), true);
  });

  it('supports explicit UTF-8 with BOM', () => {
    const buf = buildDatevBuchungsstapelCsv([], { ...options, encoding: 'utf8-bom' });
    assert.equal(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), true);
  });

  it('rejects truncation, invalid BU keys, and the 100,000th row', () => {
    const row = { date: '2026-03-03', belegfeld1: '1001', buchungstext: 'x', konto: '1200', gegenkonto: '8400', umsatz: 1 };
    assert.throws(() => buildDatevBuchungsstapelCsv([{ ...row, buchungstext: 'x'.repeat(61) }], options));
    assert.throws(() => buildDatevBuchungsstapelCsv([{ ...row, buSchluessel: '1' }], options));
    assert.throws(() => buildDatevBuchungsstapelCsv(Array.from({ length: 100_000 }, () => row), options), /99999/);
  });

  it('quotes text and doubles embedded quotes without accepting controls', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: '1001/2026', buchungstext: 'Kunde "A"', konto: '1200', gegenkonto: '8400', umsatz: 1,
    }], options);
    const text = new TextDecoder('windows-1252').decode(buf);
    assert.ok(text.includes('"1001/2026"'));
    assert.ok(text.includes('"Kunde ""A"""'));
    assert.throws(() => buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: '1001', buchungstext: 'bad\ntext', konto: '1200', gegenkonto: '8400', umsatz: 1,
    }], options));
  });

  it('writes EU and §13b facts at the official field positions and accepts one-digit-longer person accounts', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: '1001', buchungstext: 'EU-Leistung', konto: '10000', gegenkonto: '8400',
      buSchluessel: '0094', euLandUstId: 'FR12345678901', euSteuersatz: 20, sachverhaltLl: '13', umsatz: 1,
    }], options);
    const row = new TextDecoder('windows-1252').decode(buf).split('\r\n')[2]!.split(';');
    assert.equal(row.length, 125);
    assert.equal(row[8], '"0094"');
    assert.equal(row[39], '"FR12345678901"');
    assert.equal(row[40], '20,00');
    assert.equal(row[42], '13');
    for (const buSchluessel of ['0041', '0042', '0043']) {
      assert.doesNotThrow(() => buildDatevBuchungsstapelCsv([{
        date: '2026-03-03', belegfeld1: '1001', buchungstext: 'BU', konto: '1200', gegenkonto: '8400', buSchluessel, umsatz: 1,
      }], options));
    }
  });

  it('formats a one-digit EU rate with the required two integer digits and allows OSS without a VAT ID', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: 'OSS-1', buchungstext: 'OSS', konto: '8400', gegenkonto: '1200',
      euLandUstId: 'FR', euSteuersatz: 7, umsatz: 1,
    }], options);
    const row = new TextDecoder('windows-1252').decode(buf).split('\r\n')[2]!.split(';');
    assert.equal(row[39], '"FR"');
    assert.equal(row[40], '07,00');
    assert.equal(row[42], '');
  });

  it('keeps triangular EU evidence with BU 42 in the same official columns', () => {
    const buf = buildDatevBuchungsstapelCsv([{
      date: '2026-03-03', belegfeld1: 'TRI-1', buchungstext: 'Dreieck', konto: '8400', gegenkonto: '1200',
      buSchluessel: '0042', euLandUstId: 'NL123456789B01', euSteuersatz: 21, umsatz: 1,
    }], options);
    const row = new TextDecoder('windows-1252').decode(buf).split('\r\n')[2]!.split(';');
    assert.equal(row[8], '"0042"');
    assert.equal(row[39], '"NL123456789B01"');
    assert.equal(row[40], '21,00');
    assert.equal(row[42], '');
  });

  it('rejects a document date outside the declared fiscal year', () => {
    assert.throws(() => buildDatevBuchungsstapelCsv([{
      date: '2025-12-31', belegfeld1: '1001', buchungstext: 'boundary', konto: '1200', gegenkonto: '8400', umsatz: 1,
    }], options), /Wirtschaftsjahres/);
  });
});
