import { includesAny, normalizeGermanText } from './text';

export interface KeywordSuggestion {
  code?: string;
  reason?: string;
  /** Not an EÜR line at all: income tax, Soli and church tax paid from the business account are private. */
  kind?: 'private-withdrawal' | 'private-contribution' | 'transit';
}

export interface KeywordSuggestionInput {
  flowType: 'income' | 'expense';
  text: string;
}

export const suggestEurCodeByKeywords = (input: KeywordSuggestionInput): KeywordSuggestion => {
  const text = normalizeGermanText(input.text);

  const hit = (code: string, reason: string): KeywordSuggestion => ({ code, reason });

  // Tax payments. "ust" only as a word of its own: inside August or Zustellung it is no tax.
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const vat = includesAny(text, ['umsatzsteuer', 'ust-va', 'ustva', 'ust-vorauszahlung', 'ust-voranmeldung', 'voranmeldung']) || words.has('ust');
  const privateTax = includesAny(text, ['einkommensteuer', 'einkommenssteuer', 'solidaritaetszuschlag', 'kirchensteuer']) || words.has('est') || words.has('soli');
  const taxOffice = text.includes('finanzamt');

  // Cash moved between the bank and the till is a Geldtransit, never income or expense.
  if (includesAny(text, ['bareinzahlung', 'barauszahlung', 'barabhebung', 'geldautomat', 'bargeldauszahlung'])) {
    return { kind: 'transit', reason: 'Bargeld zwischen Bank und Kasse: Geldtransit' };
  }

  if (input.flowType === 'income') {
    // Money back from the Finanzamt for VAT is Kz 141; collected VAT on sales (Kz 140) is split off the sale itself.
    if (vat && (taxOffice || text.includes('erstattung'))) return hit('141', 'Umsatzsteuer-Erstattung vom Finanzamt erkannt');
    if (privateTax) return { kind: 'private-contribution', reason: 'Erstattung privater Steuern (Einkommensteuer, Soli, Kirchensteuer): keine Betriebseinnahme, Privateinlage' };
    if (taxOffice) return { reason: 'Zahlung vom Finanzamt: Steuerart bitte prüfen' };
    if (text.includes('privateinlage') || words.has('einlage')) return { kind: 'private-contribution', reason: 'Privateinlage erkannt' };
    return hit('112', 'Standard Betriebseinnahme');
  }

  if (privateTax) return { kind: 'private-withdrawal', reason: 'Einkommensteuer, Soli oder Kirchensteuer: private Steuer, Privatentnahme' };
  if (vat && !includesAny(text, ['vorsteuer'])) return hit('186', 'Umsatzsteuer-Zahlung an das Finanzamt erkannt');
  if (taxOffice) return { reason: 'Zahlung an das Finanzamt: Steuerart bitte prüfen' };

  // A returned direct debit takes back a customer payment: linked to the invoice it is a negative payment, no expense.
  if (includesAny(text, ['ruecklastschrift', 'rueckbuchung lastschrift'])) {
    return { reason: 'Rücklastschrift: mit „Zahlung zurücknehmen“ der Rechnung zuordnen; das nimmt die Zahlung zurück und öffnet die Rechnung wieder. Keine Ausgabe buchen.' };
  }
  if (text.includes('privatentnahme') || words.has('privat')) return { kind: 'private-withdrawal', reason: 'Privatentnahme erkannt' };
  if (includesAny(text, ['bewirtung', 'geschaeftsessen', 'restaurant'])) return hit('175', 'Bewirtung erkannt (70 % abziehbar, 30 % nicht abziehbar)');
  if (includesAny(text, ['miete', 'pacht', 'cowork'])) return hit('150', 'Miete/Pacht erkannt');
  if (includesAny(text, ['telefon', 'internet', 'hosting', 'domain'])) return hit('280', 'Telekommunikation erkannt');
  if (includesAny(text, ['software', 'saas', 'lizenz', 'cloud'])) return hit('228', 'EDV-Kosten erkannt');
  if (includesAny(text, ['steuerberater', 'buchhaltung', 'anwalt', 'rechtsanwalt'])) return hit('194', 'Beratungsleistung erkannt');
  if (includesAny(text, ['google ads', 'facebook ads', 'werbung', 'marketing'])) return hit('224', 'Werbung/Marketing erkannt');
  if (includesAny(text, ['hotel', 'reise', 'bahn', 'flug'])) return hit('221', 'Reisekosten erkannt');
  if (includesAny(text, ['kfz', 'tank', 'diesel', 'parken'])) return hit('146', 'Kfz/Fahrtkosten erkannt');
  // Bank, PayPal and Stripe fees are Nebenkosten des Geldverkehrs, which the Anlage EÜR counts under the other expenses.
  if (includesAny(text, ['nebenkosten des geldverkehrs', 'kontofuehrung', 'transaktionsgebuehr'])) return hit('183', 'Nebenkosten des Geldverkehrs erkannt');
  if (includesAny(text, ['versicherung', 'beitrag', 'gebuehr'])) return hit('223', 'Gebuehren/Versicherungen erkannt');
  if (includesAny(text, ['zins', 'kredit'])) return hit('234', 'Zinsen erkannt');
  if (includesAny(text, ['vorsteuer'])) return hit('185', 'Vorsteuer erkannt');

  return hit('183', 'Sonstige Betriebsausgabe als Fallback');
};
