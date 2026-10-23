# Handoff: Umbuchungen und Regel-Engine (Branch feature/umbuchungen-regel-engine)

Stand 23.10.2026, spät abends. Teil A und B sind umgesetzt und getestet. Der Nutzer hat die offenen Entscheidungen an Claude delegiert; das gilt als Freigabe zur Umsetzung. Nichts ist committet (Commit nur mit Freigabe).

## Umsetzungsstand

**Teil A – fertig bis auf die E2E-Reise.** Backend:

- Bug 0: `getDraftByTransactionId` liest die Bankseite aus `accounts.default_skr_account_number`, sonst die Rolle `bank`. Der Testfall steht in `proAccountingPosting.pglite.test.ts`.
- Rolle `transit` in `defaults`: SKR03 1360, SKR04 1460. Das Katalog-Label von SKR04 1460 heißt jetzt „Geldtransit“.
- Migration `0049_server_data_transfers_and_rules.sql` (`when` 1790985600049):
  - `bank_transactions.counterparty_iban`
  - `bank_transfer_links`: nur Entscheidungen, also bestätigt oder abgelehnt
  - `pro_booking_settings`
- Die reine Paarerkennung liegt in `packages/finance-intelligence/src/transferMatching.ts`:
  - global eins-zu-eins
  - IBAN ergibt „sicher“, Gegenbetrag innerhalb des Fensters „wahrscheinlich“
  - Gleichstand mehrerer Kandidaten ist nie „sicher“
  - Stichwörter liefern nur eine Begründung
- `packages/server-data/src/postgres/proTransfers.ts` enthält:
  - `loadTransferState`
  - `confirmTransfer` (beide Seiten freigegeben auf 1460, Seite ohne Partner erlaubt)
  - `rejectTransfer` (ein gebuchter Satz nur per Storno)
  - `getTransitOverview` (1460 je Monat, offene Seiten, Kandidaten bis 31 Tage, außerhalb des Fensters markiert)
  - die Einstellungen
- Eingehängt per Spread in `createPostgresProAccountingRepository`. `listBankTransactions` liefert `transfer`, `suggestionLayer: 'transfer'` und `counterpartyIban`.
- Routen in `server-runtime/src/proTransferRoutes.ts`:
  - `GET/PUT /booking-settings`
  - `POST /transfers/confirm` (`post: true` bucht sofort)
  - `POST /transfers/reject`
  - `GET /transfers/transit`
- IPC-Kanäle `pro:getBookingSettings`, `pro:saveBookingSettings`, `pro:confirmTransfer`, `pro:rejectTransfer` und `pro:getTransitOverview` in contract.ts und proHttpApi.ts.
- CSV-Import: optionales Feld `counterpartyIbanColumn`. FinTS wählt die Spalte „IBAN“ bzw. „Kontonummer/IBAN“ selbst aus. Die Gegen-IBAN geht NICHT in den Dedup-Hash ein.
- Tests (alle grün):
  - `server-data/src/postgres/proTransfers.pglite.test.ts`: 5 Tests
  - Bug-0-Test
  - `integration-tests/src/pro-client.test.ts`: Umbuchungstest am Ende der Suite. Er muss dort bleiben, weil 1360-Buchungen die GuV-Mapping-Prüfung früherer Tests verändern.

- Automatisch buchen: `autoPostSureTransfers` in `proTransferRoutes.ts`, aufgerufen nach `POST /pro/finance/import/commit`. Gebucht werden nur vollständige „sicher“-Paare, und nur wenn der Schalter an ist. Geschlossene oder festgeschriebene Perioden lehnt `postDraft` ab; diese Seiten bleiben freigegeben.

UI (accounting-ui-pro, Typecheck Pro und Lite grün):
- Bankabgleich (`ReconciliationWorkbench.tsx`):
  - Badge „Umbuchung · Konto“ und „Gegenseite fehlt“
  - Unterzeile „davon n Seiten von Umbuchungen“
  - „Sichere Treffer bestätigen“ nimmt sichere Paare mit (`confirmTransfer post:true`)
  - Im Detail ersetzt der Abschnitt „Umbuchung zwischen eigenen Konten“ die Karte „Kontierungsvorschlag“. Er zeigt beide Buchungssätze und die Knöpfe „Als Umbuchung buchen“, „Gegenseite öffnen“ und „Keine Umbuchung“.
- Buchen (`InboxView.tsx`):
  - Chip „Umbuchungen“ erscheint nur, wenn es offene gibt (Queue `transfers` in `domain/selectors.ts`)
  - Ebenen-Badges „Regel“ und „Gemerkt“
  - Seitenleiste „Umbuchung“ mit „Paar freigeben“ (ohne Buchen, jede Seite bleibt einzeln buchbar) und „Keine Umbuchung“
- Ausnahmen (`ExceptionCenter.tsx`):
  - Filter „Geldtransit offen“ mit Anzahl
  - Saldo Geldtransit je Monat
  - offene Seiten
  - „Partner gesucht“ mit Kandidaten, auch außerhalb des Fensters; „Als Gegenseite zuordnen“ bucht sofort
  - App.tsx reicht `dataAdapter` durch
- Einstellungen › Buchhaltung › Umbuchungen:
  - `SettingsView` nimmt `extraSections`; `SettingsCard` ist exportiert, Deep-Link `#/settings?section=<id>`
  - Pro hängt `apps/pro-desktop/components/ProTransferSettings.tsx` ein (Erkennung, Zeitfenster, Auto-Buchen). Jede Änderung wird sofort gespeichert.
- Integrationstest `pro-client.test.ts` (11/11) prüft jetzt auch: eine Seite ohne Partner bleibt offen, ein sicheres Paar wird beim zweiten Import gebucht, wahrscheinliche Paare nie.

**Bewusst offen in Teil A:** Die Übersicht („Aufwandsstruktur“ und Monatsbalken in `desktop-renderer/src/ui/shell/dashboardFlows.ts`) zählt Umbuchungen weiter als Ein- und Ausgang. Die Datei ist geteilter Lite/Pro-Code, und Lite-Geldtransit (L2) gehört der Buchungs-Session. Laut Absprache vom 23.10. baut deren L3 den Lite-Ausschluss (kind transit/privat) produktneutral in dashboardFlows.ts. **Beim Zusammenführen** hängt diese Session den Pro-Ausschluss (bank_transfer_links status confirmed bzw. `transfer` aus listBankTransactions) an dieselbe Stelle. Nach P3 prüft postDraft auch „Entwurfsbetrag = Bankbetrag“ und „Bankkonto = Konto des Umsatzes“; die Transit-Entwürfe erfüllen beides, das nach dem Merge per Test bestätigen. Die `extraSections`-Prop in SettingsView bleibt additiv, weil der Haupt-Checkout die Datei ebenfalls ändert.

**Teil B – Regel-Engine: fertig, inklusive E2E.**

- **Speicherung:** Die Tabelle `account_suggestion_rules` bekommt in 0049 die Spalten `name`, `stage` (base|override), `logic` (and|or), `conditions_json`, `actions_json`, `auto_post` und `stop_processing`.
  - Die Altspalten field/operator/value/target bleiben als Projektion für ältere Leser erhalten. Bei Overrides ohne Konto sind sie leer.
  - `advancedRuleFields` (in `accountSuggestions.ts`) liest beide Formen.
- **Engine:** `finance-intelligence/src/bookingRules.ts`, rein.
  - Bedingungen: Gegenpartei/Zweck/beides mit enthält, gleich, beginnt mit oder Regex; Gegen-IBAN; Betrag (genau, ab, bis, zwischen; deutsche Schreibweise); Finanzkonto. Dazu Vorzeichen über `flowType` und UND/ODER.
  - Ergebnis: Konto, Steuerfall, abzugsfähiger Vorsteueranteil, Flusstyp, Buchungstext mit `{Gegenpartei}`/`{Verwendungszweck}`.
- **Stufen (festgelegt):**
  - Die erste passende Basisregel setzt den Satz. Gedächtnis, Bayes und Stichwort laufen nur, wenn keine Basisregel ein Konto setzt.
  - Danach ändern alle passenden Overrides in Prioritätsreihenfolge die Felder, die sie setzen. Das gilt auch auf Ergebnisse der unteren Ebenen.
  - `stop` beendet die Kette.
  - Auto-Buchen gilt nur, wenn die Regel, die das Konto gesetzt hat, es will.
  - Der Trace führt jede aktive Regel (matched, applied, skipped).
- **Regex-Heuristik (kein echter Schutz):** höchstens 200 Zeichen, lehnt verschachtelte Quantoren wie `(a+)+` ab, Text auf 500 Zeichen gekappt. Rest-Risiko: Alternation in einer wiederholten Gruppe wie `(a|aa)+` kommt durch und kann exponentiell backtracken. Die Regeln laufen auch auf dem geteilten Server; ein echter Schutz wäre `re2` (neue Abhängigkeit, offen).
- **Kosten Probelauf:** Er geht über die gesamte Umsatzhistorie des Mandanten, gebuchte Zeilen eingeschlossen (wegen des Hinweises), mit etwa 6 Abfragen je Zeile über `proposeDraft`. Bei Mandanten mit mehreren Jahren friert Electron sichtbar ein. Bekannt, noch nicht optimiert.
- **Entwürfe:** `proposeDraft`/`proposalLines` in `proAccountingRepository.ts`.
  - Steuerfall aus der Tabelle `tax_cases` (nur `standard_vat` wird geteilt).
  - Ausgabe: Netto plus nicht abziehbarer Anteil aufs Konto, Vorsteuer über `taxCaseAccount(input_tax)`.
  - Einnahme: Umsatzsteuer über `output_tax`.
  - Eine Erstattung auf ein Aufwandskonto mindert die Vorsteuer.
  - Jeder erzeugte Entwurf trägt `ruleFingerprint` (Hash aus Text und Zeilen) und `ruleTrace` in `draft_json`, beides auch im zod-Schema.
- **Auf Bestand anwenden** (`server-data/src/postgres/proBookingRules.ts`):
  - Der Probelauf ordnet jeden Umsatz einer Klasse zu:
    - `new`: kein Entwurf
    - `update`: Fingerabdruck intakt und Status imported/suggested/incomplete
    - `protected`: von Hand geändert, in Prüfung oder freigegeben
    - `posted`: nur Hinweis
  - Umbuchungen bleiben außen vor.
  - `applyRules` rechnet in einer serialisierbaren Transaktion neu und bricht bei geändertem Hash mit `RULE_PREVIEW_STALE` ab. Der Audit-Eintrag ist `apply_booking_rules`.
- **Auto-Buchen** (`autoPostAfterImport`):
  - Wird nach dem Pro-Import aufgerufen; ein Fehler dort lässt den Import bestehen.
  - Umbuchungen: nur vollständige „sicher“-Paare.
  - Regeln: nur mit globalem Schalter `autoPostRules` und Regel-Schalter, nur für unveränderte Entwürfe, die nach der Validierung „suggested“ bleiben.
  - Geschlossene Perioden bleiben offen.
- **Gedächtnis/Bayes:** Der Ausschluss von `LIKE '4%'/'8%'` ist durch Rollen ersetzt. Ausgeschlossen sind bank, transit, input/output_vat(_deferred), Forderungen und Verbindlichkeiten, die eigenen Finanzkonten und die Konten aus tax_case_account_mappings. SKR04 lernt jetzt Ausgaben.
- **Routen:** `GET /pro/accounting/rules/preview`, `POST /rules/apply`. Die Regel-Routen in app.ts nutzen das gemeinsame `accountSuggestionRuleSchema`; das Upsert akzeptiert die neuen Felder und meldet Fehler auf Deutsch über `mapped`. IPC: `pro:previewRuleApplication`, `pro:applyRules`.
- **UI:**
  - Einstellungen › Buchhaltung › Buchungsregeln (`apps/pro-desktop/components/ProBookingRulesSettings.tsx`):
    - Liste mit Schalter, Bearbeiten und Löschen
    - dreispaltiger Editor (Wenn/Dann/Live-Test mit Buchungssatz-Vorschau)
    - Karte „Auf Bestand anwenden“ mit Probelauf-Tabelle
  - Das alte Modal `ProAccountRulesModal.tsx` ist gelöscht; „Regeln“ in Buchen und Bankabgleich sind Deep-Links.
  - „Regel aus diesem Umsatz“ im Bankabgleich öffnet `#/settings?section=rules&ruleFrom=<id>` vorbefüllt.
  - Der Bankabgleich zeigt den Regel-Trace unter dem Kontierungsvorschlag.
  - Unter Umbuchungen gibt es den zweiten globalen Schalter „Regeltreffer beim Import buchen“.
- **Tests:**
  - `server-data/src/postgres/proBookingRules.pglite.test.ts`, 3 Tests: Steuerzeilen und Overrides, Probelauf und Schutz, Auto-Buchen und Gedächtnis
  - server-data: alles grün bis auf die 18 bekannten SQLite-Tests
  - server-runtime: 48/48
  - pro-client: 11/11
  - integration-tests gesamt: 1114 grün; rot sind nur migration, offer-portal und offers, alle wegen better-sqlite3
- **E2E:** `tests/e2e/pro/pro-transfers-rules.spec.mjs` ersetzt `pro-rules.spec.mjs` (die alte Spec testete das gelöschte Modal), 2/2 grün.
  - Artefakt mit Wiederhol-Anleitung: `~/billme-umb-2026-10-23/e2e-final/` (6 Screenshots, run.log, README.md)
  - `pro-main-flows.spec.mjs` ist rot (8 Tests), alle an der Kleinunternehmer-Prüfung beim Seeding der Rechnung. Die Prüfung gibt es seit 8ea0ef4 (Vorfahre von HEAD), die Ursache ist also schon vorhanden: Die Seeds stellen §19-Rechnungen aus, bevor KU aktiv ist. P2 der Buchungs-Session behebt das im Haupt-Checkout (dort 8/8 grün), nach dem Merge ist es auch hier erledigt.

**Bewusst nicht gebaut:**
- „Soll/Haben“ ist kein Regel-Feld. Die Seite folgt aus Geldrichtung und Flusstyp; der Editor zeigt sie in der Vorschau.
- Kein Storno-Assistent für gebuchte Sätze (Entscheidung 4).
- Die Probelauf-Tabelle zeigt den Steuerfall als Schlüssel (DE_STD_19), nicht als Text.

## Entwurf

- **v2 (App-Look, aktuell):** https://openframe.mnemonicc.com/p/1047104f-b0db-4501-b0b7-5bdd7076dfad/d/0ea8ef8a-9855-48f3-8c19-1bf70a8e5879
  Projekt „billme“, 7 Frames mit je 1440 px, Revision 3. Jeder Frame ist eine echte App-Seite (DOM aus der laufenden Pro-App), die per Patch erweitert wurde.
- v1 (eigenes HTML, nur zum Vergleich): …/d/8ee94a72-e2cb-4966-b8e5-96d7451eb37f. Kann nach Rückmeldung gelöscht werden.

### Platzierung (Kern von v2)

| Funktion | Ort | Begründung |
| --- | --- | --- |
| Umbuchung erkennen und bestätigen | Bankabgleich (Frame 1) | Ein Umsatz wird einem anderen Umsatz zugeordnet, das ist Abgleich. Das Kandidatenmuster und „Sichere Treffer bestätigen“ gibt es dort schon. |
| Paar freigeben | Buchen (Frame 2) | Nur Hinweis-Badges, ein Filter-Chip und das Schnellbuchungs-Panel im Paar-Modus. Die Inbox selbst wird nicht umgebaut. |
| Regelliste und Regel-Editor | Einstellungen › Buchhaltung › Buchungsregeln (Frames 3, 4) | Konfiguration, nicht Tagesarbeit. Die Einstellungen haben noch keine Buchhaltungsgruppe. Die „Regeln“-Knöpfe in Buchen und Bankabgleich werden Deep-Links. „Regel aus diesem Umsatz“ öffnet den Editor vorbefüllt. |
| Auf Bestand anwenden | Unterseite der Regeln (Frame 5) | Erreichbar aus dem Listenkopf und aus dem Editor. |
| Umbuchungs-Einstellungen | Einstellungen › Buchhaltung › Umbuchungen (Frame 6) | Geldtransitkonto, Zeitfenster, Regel für „sicher“, eigene Konten, Auto-Buchen. |
| Geldtransit offen | Ausnahmen (Frame 7) | Neuer Filter-Chip und eine Karte „Saldo je Monat“ für 1460. |

Bewusst verworfen: ein eigener Rail-Eintrag (die Leiste hat schon 17 Einträge), ein Reiter neben der Inbox und ein Sheet für den Editor (@billme/ui hat keinen Drawer, und das Modal ist nur 560 px breit).

### Quellen und Neubau

- Harness: `~/billme-umb-2026-10-23/harness/`
  - `launch.mjs 9341` startet Pro mit SKR04-Seed (Girokonto, Amex, PayPal und 12 Umsätze). Aufruf: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1600x1000x24" node launch.mjs 9341`.
  - `capture.mjs` speichert das DOM nach `../playground/captures/`.
  - `pshot.mjs <screen…>` erzeugt die Chrome-Screenshots in `../shots/`.
  - `/tmp/umb-kill.sh` räumt auf.
- Playground: `~/billme-umb-2026-10-23/playground/`
  - Vite auf :4188 starten mit `node_modules/.bin/vite --config vite.config.mjs`.
  - `screens/f1…f7*.js` sind die Patches.
  - `screens/_h.js` bildet die Klassen der @billme/ui-Primitive nach.
- OpenFrame-Build: `~/.cache/billme-of/umbuchungen-v2/build.sh` (snapshot_url je Screen, Frames gepinnt). Danach `load_document` auf die ID in `docid.txt`.
- Lint: nur Warnungen, die die App selbst hat (`text-micro` 11 px, kleine Knöpfe). Keine neuen Muster.

## Geprüfte Befunde (Code und App-Rundgang, 23.10.)

- `finance-intelligence/src/accountSuggestion.ts`: Regeln können nur Feld, contains/equals/startsWith, Flusstyp und Zielkonto. Das Ergebnis hat `accountNumber`, `layer`, `reason` und `confidence`. Die Inbox zeigt `layer` und `reason` nicht an.
- `proAccountingRepository.ts:680` `getDraftByTransactionId`: Der Entwurf hat 2 Zeilen ohne Steuer. Die Bankseite ist immer `m.bank`, `accounts.default_skr_account_number` (nullable seit Migration 0027) wird nicht gelesen. **Bug bestätigt.**
- Rollen stehen in `defaults` (Zeilen 293–294). Ein Override in `accounting_account_mappings` greift nur für Rollen, die es in `defaults` gibt. Für `transit` braucht es deshalb einen Eintrag in `defaults`.
- Katalog: SKR03 1360 ist Geldtransit. Den Namen von SKR04 1460 in `canonicalLedgerCatalog.ts:1421` prüfen („Geldtransit Gegenkonto Vorsteuer…“ sieht falsch aus).
- Regeltabelle `account_suggestion_rules` (Migration 0001). Eine Erweiterung braucht eine neue Migration.
- App heute: „AMEX Abrechnung“ wird als 6300 Sonstige betriebliche Aufwendungen vorgeschlagen. In der Aufwandsstruktur der Übersicht zählen Amex-Ausgleich, PayPal-Aufladung und Auszahlung als Ausgaben.
- Die Einstellungen haben keine Buchhaltungsgruppe, obwohl der Untertitel „Firma, Buchführung und Nummernkreise“ lautet.
- Der Workflow-Status in Ausnahmen zeigt den Rohwert `not_required` (bestehender Anzeigefehler, nicht Teil dieses Auftrags).

## Nächste Schritte

1. Nutzer-Review und Freigabe für Commits; noch ist nichts committet. `ProAccountRulesModal.tsx` und `pro-rules.spec.mjs` sind im Arbeitsbaum gelöscht.
2. Vor dem Zusammenführen mit refactor/slim-architecture:
   - Periodenprüfung auf `accountingPeriods.ts` (P1) umstellen
   - Pro-Ausschluss in `dashboardFlows.ts` an die L3-Stelle hängen
   - Transit-Entwürfe gegen die neuen P3-Prüfungen testen
   - Report-Mappings 1360/1460 (P6) abwarten
   - Tax-Konten aus P4 gegen `proposalLines` prüfen
3. `pnpm ci:prepare-sqlite-tests` würde laut Notiz die better-sqlite3-Bindung bauen und die 18 bzw. 3 SQLite-Suiten wieder ausführbar machen.

## Entscheidungen (23.10.2026, vom Nutzer an Claude delegiert)

1. Regel-Editor als Einstellungs-Unterseite, kein Sheet. Vorbefüllt öffnen über „Regel aus diesem Umsatz“.
2. Ein Paar ist nur bei eigener IBAN (bzw. hinterlegter Kennung wie der PayPal-Adresse) „sicher“. Betrag und ±7 Tage ergeben „wahrscheinlich“.
3. Zeitfenster ±7 Tage. Kandidaten außerhalb des Fensters erscheinen nur in Ausnahmen bei „Partner gesucht“, nie im Bankabgleich und nie automatisch.
4. Gebuchte Sätze im Probelauf: nur ein Hinweis. Ein Storno-Assistent kommt später.
5. Auto-Buchen: zwei globale Schalter plus ein Schalter je Regel, alles standardmäßig aus. Festgeschriebene Monate werden nie automatisch gebucht.
6. „Geldtransit offen“ zunächst nur in Ausnahmen, nicht in Übersicht oder Konten.

## Abstimmung mit der Buchungs-Session (rechnungs-editor-pro-74, 23.10.2026)

- Die Session arbeitet im Haupt-Checkout auf refactor/slim-architecture, ohne Commits. Ihre Briefs und Ergebnisse liegen in `~/billme-booking-fix-2026-10-23/` (P1-done.patch, P3.md …).
- **Diese Session baut:** Geldtransit in Pro komplett (transit-Rolle 1360/1460, Paarerkennung, „Geldtransit offen“ in Ausnahmen), Bug 0 in `getDraftByTransactionId`, die Regel-Engine und das Label von SKR04 1460.
- **Nicht anfassen:** Lite-Geldtransit (Spur L2), die freie Buchung `POST /pro/accounting/journal`, Privat 1800/1890 bzw. 2100/2180, die Prüfung Entwurfsbetrag = Bankbetrag (P3) und die übrigen Katalognamen (P6).
- **Migration: 0049.** 0040–0048 sind dort belegt oder reserviert.
- Heiße Dateien nur additiv ändern: `proAccountingRepository.ts`, `proAccountingRoutes.ts`, `accountingSourceRuns.ts`, `desktop-contracts-pro`, `_journal.json`.
- Periodenstatus: Nach P1 liegt er in `packages/server-data/src/postgres/accountingPeriods.ts`, das hier noch fehlt. Die Abfrage deshalb in einer Funktion kapseln und beim Zusammenführen umstellen.
- Geldtransit läuft über den normalen Bankentwurf mit Gegenkonto 1460 (draft/postDraft) und braucht die freie-Buchung-API nicht.

## Fallen

- `pnpm test` in server-data: 18 SQLite-Importtests sind rot, weil `better-sqlite3` im Worktree nicht für Node gebaut ist. Das ist ein Umgebungsproblem und hat mit dieser Änderung nichts zu tun.
- `scripts/raw-sql-guard.mjs` schlägt schon auf HEAD fehl. Neue Dateien nutzen dasselbe `q()`-Muster wie `proAccountingRepository.ts`.
- Pro hat keine Standard-Berichtszuordnung (`report_account_mappings`). Jedes bebuchte Konto, auch 1460 oder 1820, erscheint in der GuV-Mapping-Prüfung als „nicht zugeordnet“, bis der Mandant es zuordnet. Gehört zu P6 der Buchungs-Session.
- Die Übersicht „Aufwandsstruktur“ rechnet für Pro aus `transactions.type`, nicht aus dem Journal. Umbuchungen zählen dort weiter als Ausgaben, bis die Übersicht die Transfer-Markierung kennt.
- Gedächtnis/Bayes unter SKR04: behoben (Rollen-Ausschluss statt `LIKE`).
- E2E hier nur mit `unset ELECTRON_RUN_AS_NODE` und `xvfb-run -a`, sonst „Process failed to launch!“.
- Die Spalten für die Regeln hängen an 0049. Ein Dev-Datenverzeichnis, das 0049 schon in der Umbuchungs-Version angewendet hat, bekommt sie nicht. Solche PGlite-Verzeichnisse vor dem Test löschen (E2E nutzt frische /tmp-Verzeichnisse).
- Der Navigationspunkt „Auswertungen“ ist in Bankabgleich und Ausnahmen markiert (zu sehen auf den Screenshots). Das liegt nicht in diesem Diff und ist nicht untersucht.
- `accounting-ui-pro` zeigt Regel-Trace und Umbuchungen nur, wenn `ProAccountingPage` die Felder durchreicht (`ruleTrace`, `transfer`). Neue Felder in contract.ts **und** schemas.ts eintragen, sonst entfernt zod sie.
- Migrationsnummer 0049 ist mit der Buchungs-Session abgestimmt, dort sind 0040–0048 belegt. `when` muss größer als deren Werte bleiben.

## Offene Entscheidungen

- Keine. Neu auftauchende Fragen hier sammeln.
