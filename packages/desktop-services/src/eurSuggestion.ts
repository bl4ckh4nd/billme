import { suggestEurCodeByKeywords } from '@billme/finance-intelligence';

type EurLine = {
  id: string;
  kennziffer?: string;
};

export interface EurSuggestion {
  lineId?: string;
  reason?: string;
  /** A neutral kind instead of a line (income tax paid from the business account is a Privatentnahme). */
  kind?: 'private-withdrawal' | 'private-contribution';
}

export const suggestEurLine = (
  params: {
    flowType: 'income' | 'expense';
    counterparty: string;
    purpose: string;
  },
  lines: EurLine[],
): EurSuggestion => {
  const byKz = new Map<string, string>();

  for (const line of lines) {
    if (line.kennziffer) byKz.set(line.kennziffer, line.id);
  }

  const hit = (code: string, reason: string): EurSuggestion => {
    const lineId = byKz.get(code);
    return { lineId, reason: lineId ? reason : undefined };
  };

  const keywordSuggestion = suggestEurCodeByKeywords({
    flowType: params.flowType,
    text: `${params.counterparty} ${params.purpose}`,
  });

  if (keywordSuggestion.kind) return { kind: keywordSuggestion.kind, reason: keywordSuggestion.reason };
  if (!keywordSuggestion.code) {
    return keywordSuggestion.reason ? { reason: keywordSuggestion.reason } : {};
  }

  return hit(keywordSuggestion.code, keywordSuggestion.reason ?? 'Keyword-Vorschlag');
};

export const resolveEurCodeToLine = (
  code: string,
  reason: string,
  lines: EurLine[],
): EurSuggestion => {
  const byKz = new Map<string, string>();
  for (const line of lines) {
    if (line.kennziffer) byKz.set(line.kennziffer, line.id);
  }
  const lineId = byKz.get(code);
  return { lineId, reason: lineId ? reason : undefined };
};
