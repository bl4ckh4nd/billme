import { describe, expect, it } from 'vitest';
import { MOCK_SETTINGS } from '../data/mockData';
import { formatDocumentNumber } from './numberingRepo';

describe('numberingRepo.formatDocumentNumber', () => {
  it('formats invoice number with year token and zero padding', () => {
    const settings = {
      ...MOCK_SETTINGS,
      numbers: {
        ...MOCK_SETTINGS.numbers,
        invoicePrefix: 'RE-%Y-',
        numberLength: 4,
      },
    };
    const now = new Date('2026-01-03T00:00:00.000Z');
    const number = formatDocumentNumber(settings as any, 'invoice', 7, now);
    expect(number).toBe('RE-2026-0007');
  });

  it('formats offer number with same padding rules', () => {
    const settings = {
      ...MOCK_SETTINGS,
      numbers: {
        ...MOCK_SETTINGS.numbers,
        offerPrefix: 'ANG-%Y-',
        numberLength: 3,
      },
    };
    const now = new Date('2026-12-31T00:00:00.000Z');
    const number = formatDocumentNumber(settings as any, 'offer', 42, now);
    expect(number).toBe('ANG-2026-042');
  });

  it('formats customer number with dedicated customer length', () => {
    const settings = {
      ...MOCK_SETTINGS,
      numbers: {
        ...MOCK_SETTINGS.numbers,
        customerPrefix: 'KD-%Y-',
        customerNumberLength: 5,
      },
    };
    const now = new Date('2026-12-31T00:00:00.000Z');
    const number = formatDocumentNumber(settings as any, 'customer', 42, now);
    expect(number).toBe('KD-2026-00042');
  });

  it('falls back to safe counter when counter is invalid', () => {
    const settings = {
      ...MOCK_SETTINGS,
      numbers: {
        ...MOCK_SETTINGS.numbers,
        invoicePrefix: 'RE-%Y-',
        numberLength: 4,
      },
    };
    const now = new Date('2026-01-03T00:00:00.000Z');
    const number = formatDocumentNumber(settings as any, 'invoice', Number.NaN, now);
    expect(number).toBe('RE-2026-0001');
  });
});
