const categoryNames: Record<string, string> = {
  '111': 'Einnahmen als Kleinunternehmer', '112': 'Einnahmen mit Umsatzsteuer', '103': 'Steuerfreie Einnahmen',
  '100': 'Waren und Material', '110': 'Fremdleistungen', '120': 'Personal', '150': 'Miete und Geschäftsräume',
  '280': 'Telefon und Internet', '221': 'Reisen und Übernachtung', '281': 'Weiterbildung', '194': 'Steuerberatung und Buchführung',
  '223': 'Versicherungen und Beiträge', '228': 'Software und IT', '229': 'Arbeitsmittel', '224': 'Werbung',
  '227': 'Versand und Verpackung', '183': 'Sonstige Betriebsausgaben', '165': 'Bewirtung (abziehbarer Anteil)',
  '175': 'Bewirtung (nicht abziehbarer Anteil)', '185': 'Gezahlte Vorsteuer', '186': 'Umsatzsteuer an das Finanzamt',
  '140': 'Vereinnahmte Umsatzsteuer', '141': 'Umsatzsteuer vom Finanzamt', '132': 'Geringwertige Wirtschaftsgüter',
};
export const simpleEurCategoryLabel = (line: { kennziffer?: string; label: string }) => categoryNames[line.kennziffer ?? ''] ?? line.label;
export const isSimpleEurCategory = (line: { kennziffer?: string }) => Boolean(categoryNames[line.kennziffer ?? '']);
