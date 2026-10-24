const categoryNames: Record<string, string> = {
  '111': 'Einnahmen als Kleinunternehmer', '112': 'Einnahmen mit Umsatzsteuer', '103': 'Steuerfreie Einnahmen',
  '100': 'Waren und Material', '110': 'Fremdleistungen', '120': 'Personal', '150': 'Miete und Geschäftsräume',
  '280': 'Telefon und Internet', '221': 'Reisen und Übernachtung', '281': 'Weiterbildung', '194': 'Steuerberatung und Buchführung',
  '223': 'Versicherungen und Beiträge', '228': 'Software und IT', '229': 'Arbeitsmittel', '224': 'Werbung',
  '227': 'Versand und Verpackung', '183': 'Sonstige Betriebsausgaben', '175': 'Bewirtung (abziehbarer Anteil, 70 %)',
  '165': 'Bewirtung (nicht abziehbarer Anteil, 30 %)', '174': 'Geschenke bis 50 €', '164': 'Geschenke über 50 € (ohne Vorsteuer)',
  '185': 'Gezahlte Vorsteuer', '186': 'Umsatzsteuer an das Finanzamt',
  '140': 'Vereinnahmte Umsatzsteuer', '141': 'Umsatzsteuer vom Finanzamt', '132': 'Geringwertige Wirtschaftsgüter',
  '130': 'Abschreibung (AfA) auf bewegliche Wirtschaftsgüter', '131': 'Abschreibung (AfA) auf Software und Rechte',
  '163': 'Homeoffice-Tagespauschale', '171': 'Verpflegungsmehraufwand',
  '106': 'Privatanteil Auto', '108': 'Privatanteil Telefon und sonstige Entnahmen',
};

/** Lite: a manual booking without money (no Kasse, no Bank) is one of these. The amount is entered by the user. */
export const nonCashPresets = [
  { code: '163', flowType: 'expense', purpose: 'Homeoffice-Tagespauschale', hint: '6 € je Tag in der häuslichen Wohnung, höchstens 1.260 € im Jahr.' },
  { code: '171', flowType: 'expense', purpose: 'Verpflegungsmehraufwand', hint: '14 € ab 8 Stunden Abwesenheit, 28 € für volle Tage.' },
  { code: '130', flowType: 'expense', purpose: 'Abschreibung (AfA)', hint: 'Jahresbetrag aus der Anlagenliste.' },
  { code: '106', flowType: 'income', purpose: 'Privatanteil Auto', hint: 'Privatnutzung des Betriebsfahrzeugs, z. B. 1-%-Regel.' },
  { code: '108', flowType: 'income', purpose: 'Privatanteil Telefon', hint: 'Privater Anteil an betrieblich bezahlten Telefonkosten.' },
] as const;
export const simpleEurCategoryLabel = (line: { kennziffer?: string; label: string }) => categoryNames[line.kennziffer ?? ''] ?? line.label;
export const isSimpleEurCategory = (line: { kennziffer?: string }) => Boolean(categoryNames[line.kennziffer ?? '']);

/** Lite: what a payment is when it is neither income nor expense. None of them counts in the EÜR or the VAT. */
export type NeutralEurKind = 'private-withdrawal' | 'private-contribution' | 'transit';
export const neutralEurKindLabels: Record<NeutralEurKind, string> = {
  'private-withdrawal': 'Privatentnahme',
  'private-contribution': 'Privateinlage',
  transit: 'Geldtransit (Umbuchung zwischen eigenen Konten)',
};
export const neutralEurKindNotes: Record<NeutralEurKind, string> = {
  'private-withdrawal': 'Privatentnahme: Geld für private Zwecke, keine Betriebsausgabe. Zählt nicht in der EÜR und nicht in der Umsatzsteuer.',
  'private-contribution': 'Privateinlage: privates Geld für den Betrieb, keine Betriebseinnahme. Zählt nicht in der EÜR und nicht in der Umsatzsteuer.',
  transit: 'Geldtransit: Geld zwischen eigenen Konten oder Bank und Kasse bewegt. Zählt nicht in der EÜR und nicht in der Umsatzsteuer; die Gegenseite auf dem anderen Konto wird genauso zugeordnet.',
};
export const isNeutralEurKind = (kind: string | undefined): kind is NeutralEurKind => kind === 'private-withdrawal' || kind === 'private-contribution' || kind === 'transit';
