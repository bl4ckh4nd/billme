import type { EurLine } from '../db/eurCatalogRepo';

export interface EurSuggestion {
  lineId?: string;
  reason?: string;
}

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss');

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

export const suggestEurLine = (
  params: {
    flowType: 'income' | 'expense';
    counterparty: string;
    purpose: string;
  },
  lines: EurLine[],
): EurSuggestion => {
  const text = normalize(`${params.counterparty} ${params.purpose}`);
  const byKz = new Map<string, string>();

  for (const line of lines) {
    if (line.kennziffer) byKz.set(line.kennziffer, line.id);
  }

  const hit = (kz: string, reason: string): EurSuggestion => {
    const lineId = byKz.get(kz);
    return { lineId, reason: lineId ? reason : undefined };
  };

  if (params.flowType === 'income') {
    if (includesAny(text, ['steuererstattung', 'erstattung umsatzsteuer'])) {
      return hit('141', 'Steuererstattung erkannt');
    }
    if (includesAny(text, ['umsatzsteuer', 'ust'])) {
      return hit('140', 'USt-Hinweis erkannt');
    }
    return hit('112', 'Standard Betriebseinnahme');
  }

  if (includesAny(text, ['miete', 'pacht', 'cowork'])) return hit('150', 'Miete/Pacht erkannt');
  if (includesAny(text, ['telefon', 'internet', 'hosting', 'domain'])) return hit('280', 'Telekommunikation erkannt');
  if (includesAny(text, ['software', 'saas', 'lizenz', 'cloud'])) return hit('228', 'EDV-Kosten erkannt');
  if (includesAny(text, ['steuerberater', 'buchhaltung', 'anwalt', 'rechtsanwalt'])) return hit('194', 'Beratungsleistung erkannt');
  if (includesAny(text, ['google ads', 'facebook ads', 'werbung', 'marketing'])) return hit('224', 'Werbung/Marketing erkannt');
  if (includesAny(text, ['hotel', 'reise', 'bahn', 'flug'])) return hit('221', 'Reisekosten erkannt');
  if (includesAny(text, ['kfz', 'tank', 'diesel', 'parken'])) return hit('146', 'Kfz/Fahrtkosten erkannt');
  if (includesAny(text, ['versicherung', 'beitrag', 'gebuehr', 'gebuhr'])) return hit('223', 'Gebuehren/Versicherungen erkannt');
  if (includesAny(text, ['zins', 'kredit'])) return hit('234', 'Zinsen erkannt');
  if (includesAny(text, ['vorsteuer'])) return hit('185', 'Vorsteuer erkannt');

  return hit('183', 'Sonstige Betriebsausgabe als Fallback');
};
