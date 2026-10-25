/**
 * German sentences for the error codes the Pro accounting backend answers with. Every Pro accounting screen
 * shows errors through `accountingErrorText`, so a code never reaches the user raw; each sentence says what
 * to do next.
 */
const ACCOUNTING_ERROR_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/SOFT_LOCK_OVERRIDE_REQUIRED/, 'Der Monat ist vorläufig gesperrt (nach einer UStVA-Vorbereitung oder dem Jahresabschluss). Bestätige die Buchung mit einer Begründung oder entsperre den Monat unter Sonderbuchungen › Perioden.'],
  [/POSTING_DATE_IN_CLOSED_PERIOD|PERIOD_CLOSED/, 'Der Monat ist festgeschrieben und lässt sich nicht mehr ändern. Buche die Korrektur mit einem Datum in einem offenen Monat.'],
  [/PAYMENT_PARTY_MISMATCH|SETTLEMENT_PARTY_MISMATCH/, 'Der offene Posten gehört zu einem anderen Kunden oder Lieferanten als die Zahlung. Wähle einen Posten derselben Partei.'],
  [/OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL/, 'Der Betrag ist höher als der offene Rest des Postens.'],
  [/Invalid workflow transition: incomplete -> /i, 'Der Entwurf ist noch unvollständig. Ergänze die markierten Angaben und gib ihn zur Prüfung, bevor er freigegeben oder gebucht wird.'],
  [/Invalid workflow transition: [a-z_]+ -> approved/i, 'Freigeben geht erst, wenn der Entwurf zur Prüfung gegeben wurde.'],
  [/Invalid workflow transition: [a-z_]+ -> posted/i, 'Buchen geht erst nach der Freigabe.'],
  [/Invalid workflow transition/i, 'Dieser Schritt ist im aktuellen Status nicht möglich. Lade die Ansicht neu und wähle den angebotenen nächsten Schritt.'],
  [/FISCAL_YEAR_ALREADY_CLOSED/, 'Dieses Geschäftsjahr ist bereits abgeschlossen.'],
  [/CARRY_FORWARD_ALREADY_BOOKED/, 'Der Saldovortrag in dieses Jahr ist bereits gebucht.'],
  [/LEDGER_BALANCE_MISMATCH/, 'Die Salden passen nicht mehr zum Hauptbuch. Berechne die Vorschau neu.'],
  [/ACCOUNTING_SOURCE_RUN_CONFLICT/, 'Zu diesem Quellbeleg gibt es schon einen Buchungslauf mit anderen Angaben. Prüfe Quellbeleg und Revision oder öffne den bestehenden Lauf in der Historie.'],
  [/UNKNOWN_ACCOUNT:\s*(\S+)/, 'Das Konto $1 gibt es im Kontenrahmen nicht. Wähle ein Konto aus der Liste.'],
  [/PAYMENT_SOURCE_ALREADY_BOOKED/, 'Diese Bankzeile ist schon gebucht oder einer Rechnung zugeordnet. Storniere die Buchung zuerst; danach lässt sich die Bankzeile über „Neu kontieren“ wieder buchen.'],
  [/Journal entry cannot be reversed again/i, 'Diese Buchung ist bereits storniert.'],
  [/ASSET_REVERSAL_REQUIRED/, 'Anlagenbuchungen werden in der Anlagenverwaltung korrigiert.'],
  [/AGGREGATE_REVERSAL_BLOCKED/, 'Abschluss- und Sonderbuchungen werden unter Sonderbuchungen mit einer Korrektur geändert.'],
  [/DOCUMENT_REVERSAL_REQUIRED/, 'Rechnungsbuchungen werden über die Stornorechnung bzw. den Eingangsbeleg storniert.'],
  [/INCOMING_INVOICE_ASSET_LINE_MISMATCH/, 'Die gewählte Eingangsrechnung hat keine gebuchte Position mit diesem Anlagenkonto und diesem Nettobetrag. Übernimm Konto und Betrag aus der Rechnung.'],
  [/workflowStatus is server controlled/, 'Ein freigegebener Entwurf lässt sich nicht direkt ändern. Lade die Ansicht neu; die Änderung geht danach erneut in die Prüfung.'],
  [/String must contain at least 1 character/, 'Eine Pflichtangabe fehlt, meist die Begründung. Fülle sie aus und versuche es erneut.'],
  [/OPEN_ITEM_ACCOUNT_IN_DRAFT/, 'Forderungen und Verbindlichkeiten werden über „In Offene Posten ausgleichen“ gebucht. Ist der Posten schon anderweitig bezahlt, wähle ein anderes Gegenkonto.'],
];

/** The German sentence for a known accounting error code in `message`, otherwise undefined. */
export const accountingErrorSentence = (message: string): string | undefined => {
  for (const [pattern, sentence] of ACCOUNTING_ERROR_TEXT) {
    const match = pattern.exec(message);
    if (match) return sentence.replace('$1', match[1] ?? '');
  }
  return undefined;
};

export const accountingErrorText = (message: string): string => {
  const text = message.trim();
  const known = accountingErrorSentence(text);
  if (known) return known;
  // "SOME_CODE: Ein Satz." keeps the sentence; a bare code becomes a neutral German line.
  const rest = text.replace(/^(?:[A-Z][A-Z0-9_]+:)+\s*/, '');
  if (!rest || /^[A-Z][A-Z0-9_:]+$/.test(rest)) return 'Die Aktion konnte nicht ausgeführt werden. Prüfe die Angaben und versuche es erneut.';
  return rest;
};
