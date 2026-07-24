import { beforeEach, describe, expect, it, vi } from 'vitest';

const { suggestByKeywordsMock } = vi.hoisted(() => ({
  suggestByKeywordsMock: vi.fn(),
}));

vi.mock('@billme/finance-intelligence', () => ({
  suggestEurCodeByKeywords: suggestByKeywordsMock,
}));

import { resolveEurCodeToLine, suggestEurLine } from './eurSuggestion';

const lines = [
  { id: 'line-112', kennziffer: '112' },
  { id: 'line-280', kennziffer: '280' },
  { id: 'line-nocode', kennziffer: '' },
] as any[];

describe('eurSuggestion', () => {
  beforeEach(() => {
    suggestByKeywordsMock.mockReset();
  });

  it('returns empty suggestion when classifier has no code', () => {
    suggestByKeywordsMock.mockReturnValue({});

    const result = suggestEurLine(
      { flowType: 'expense', counterparty: 'Hoster GmbH', purpose: 'Server' },
      lines as any,
    );

    expect(result).toEqual({});
  });

  it('maps classifier code to EUR line id', () => {
    suggestByKeywordsMock.mockReturnValue({ code: '280', reason: 'keyword:hosting' });

    const result = suggestEurLine(
      { flowType: 'expense', counterparty: 'Hoster GmbH', purpose: 'Server' },
      lines as any,
    );

    expect(result).toEqual({ lineId: 'line-280', reason: 'keyword:hosting' });
  });

  it('uses fallback reason when classifier omitted reason', () => {
    suggestByKeywordsMock.mockReturnValue({ code: '112' });

    const result = suggestEurLine(
      { flowType: 'income', counterparty: 'Acme', purpose: 'Consulting' },
      lines as any,
    );

    expect(result).toEqual({ lineId: 'line-112', reason: 'Keyword-Vorschlag' });
  });

  it('returns undefined reason when code does not exist in line catalog', () => {
    suggestByKeywordsMock.mockReturnValue({ code: '999', reason: 'not-found' });

    const result = suggestEurLine(
      { flowType: 'expense', counterparty: 'Vendor', purpose: 'Other' },
      lines as any,
    );

    expect(result).toEqual({ lineId: undefined, reason: undefined });
  });

  it('resolves explicit EUR code to line id', () => {
    expect(resolveEurCodeToLine('280', 'manual', lines as any)).toEqual({
      lineId: 'line-280',
      reason: 'manual',
    });
  });

  it('returns undefined reason for unresolved explicit code', () => {
    expect(resolveEurCodeToLine('777', 'manual', lines as any)).toEqual({
      lineId: undefined,
      reason: undefined,
    });
  });
});
