# Handoff: Umbuchungen und Regel-Engine (Branch feature/umbuchungen-regel-engine)

Stand 23.10.2026, nachts. Der Nutzer hat Teil A und B als e1900e7 committet. Danach hat er den Rückbau von Teil A beauftragt: Eine Umbuchung ist ein normaler Buchungssatz, kein eigenes Feature. Der Rückbau ist umgesetzt und getestet, aber **nicht committet** (Commit nur mit Freigabe).

## Umsetzungsstand

**Teil A – Umbuchungen, schlank (Rückbau nach e1900e7).** Eine Umbuchung ist ein normaler Bankentwurf mit Gegenkonto Geldtransit.

- **Eingebaute Regel:** `loadSuggestionContext` in `proAccountingRepository.ts` stellt vor alle Mandantenregeln eine Regel „Umbuchung zwischen eigenen Konten“ (`OWN_ACCOUNTS_RULE_NAME`, id `own-accounts`). Sie ist nicht gespeichert, sondern wird zur Laufzeit gebaut:
  - Bedingung: Gegen-IBAN ist eine IBAN aus `accounts` (ODER über alle eigenen Konten)
  - Ergebnis: Konto `transit` (SKR03 1360 / SKR04 1460), kein Steuerfall, Text „Umbuchung: {Gegenpartei} {Verwendungszweck}“
  - `stop`, damit kein Override einen Steuerfall daraufsetzt; kein Auto-Buchen
  - Sie erscheint im Regel-Trace und im Probelauf wie jede andere Regel.
- **Die andere Seite:** Kontoauszüge von Karten nennen oft keine IBAN. Diese Seite bucht man wie jeden Umsatz auf 1360. Gedächtnis und Bayes dürfen Geldtransit lernen (`transit` steht nicht mehr in `NON_COUNTER_ROLES`), also wird „Zahlung erhalten“ auf der Karte ab dem zweiten Monat von selbst vorgeschlagen.
- **Kontrolle:** `getTransitOverview` (Route `GET /pro/accounting/transit`, IPC `pro:getTransitOverview`) liefert 1360/1460 je Monat mit laufendem Stand. Ausnahmen › „Geldtransit offen“ zeigt die Tabelle; die Zahl am Chip ist die Anzahl Monate mit offenem Stand. Steht der Saldo auf null, heißt es „Geldtransit ist ausgeglichen.“
- `listBankTransactions` liefert `isTransfer: true`, wenn der Vorschlag auf Geldtransit bucht. `ProAccountingPage` markiert solche Umsätze nicht als „Ohne Beleg“.
- Bug 0: `getDraftByTransactionId` liest die Bankseite aus `accounts.default_skr_account_number`, sonst die Rolle `bank`. Der Testfall steht in `proAccountingPosting.pglite.test.ts`. **Beim Merge:** Der Haupt-Checkout hat Bug 0 ebenfalls behoben, mit `bankLedgerAccount(tx, tenant(scope), row.account_id)` aus P2. Abgesichert ist das durch den Test „a bank account with its own ledger account…“ in pro-accounting.test.ts. Die hiesige Variante verwerfen und deren Lösung übernehmen; auch `proposeDraft` soll dann `bankLedgerAccount` nutzen. P3 bietet außerdem `postManualJournalEntryInTransaction` (Route POST /pro/accounting/journal).
- Rolle `transit` in `defaults`: SKR03 1360, SKR04 1460. Das Katalog-Label von SKR04 1460 heißt „Geldtransit“.
- CSV-Import: optionales Feld `counterpartyIbanColumn`. FinTS wählt die Spalte „IBAN“ bzw. „Kontonummer/IBAN“ selbst aus. Die Gegen-IBAN geht NICHT in den Dedup-Hash ein.
- Migration 0049 enthält nur noch `bank_transactions.counterparty_iban` und die Regel-Spalten.
- **Entfernt im Rückbau:**
  - Tabellen `bank_transfer_links` und `pro_booking_settings`
  - `transferMatching.ts` (Paarerkennung, „wahrscheinlich“ über Gegenbetrag ±7 Tage), `proTransfers.ts`
  - Routen und IPC für confirm/reject und die Buchungseinstellungen
  - Umbuchungs-Karte, Badges und Paar-Sammelbestätigung im Bankabgleich; Inbox-Liste „Umbuchungen“ und Paar-Freigabe
  - Kandidatensuche „Partner gesucht“ in Ausnahmen
  - Einstellungsseite „Umbuchungen“ (`ProTransferSettings.tsx`) samt globalen Auto-Buchen-Schaltern; Auto-Buchen hängt jetzt nur am Schalter der Regel
  - `proTransferRoutes.ts` heißt jetzt `proBookingRuleRoutes.ts` (Regeln + Transit-Saldo)
- Tests:
  - `proBookingRules.pglite.test.ts`, Test „Umbuchung auf eigene IBAN …“: Zeilen ohne Steuer, Override nach Stopp übersprungen, `isTransfer`, offener Saldo nach einer Seite, null nach beiden, Kartenseite im Folgemonat aus dem Gedächtnis
  - `pro-client.test.ts`, Umbuchungstest am Ende: IBAN-Spalte über den Client, Vorschlag 1360, Transit-Saldo über die Route. Er muss am Ende bleiben, weil 1360-Buchungen die GuV-Mapping-Prüfung früherer Tests verändern.

**Bekannte Grenzen von Teil A (bewusst, nicht gebaut):**
- Die eingebaute Regel hat Vorrang vor allem und `stop`; keine Mandantenregel kann sie überstimmen. Sie steht nicht in der Regelliste und nicht im Live-Test des Editors (dort kann „n von m passen“ zu hoch sein, wenn die IBAN-Regel gewinnt). Sichtbar ist sie nur im Trace und im Probelauf.
- Gedächtnis/Bayes lernen 1360. Bei gemischten Gegenparteien (PayPal: Aufladungen und Käufe vom Girokonto) wird nach einer gebuchten Aufladung auch für Käufe 1360 vorgeschlagen.
- Nennt eine Bank auf Gebühren- oder Zinszeilen die eigene IBAN als Gegen-IBAN, greift die Umbuchungsregel fälschlich. Ein Schutz bräuchte die eigene IBAN der Zeile in `bankItem` (ca. 5 Zeilen, nicht gebaut).
- GuV/UStVA: Umbuchungen haben keinen Steuerfall und keine GuV-Position. Pro hat aber keine Standard-Berichtszuordnung, 1360/1460 erscheint in der GuV-Mapping-Prüfung als „nicht zugeordnet“, bis P6 die Mappings liefert.

**Bewusst offen in Teil A:** Die Übersicht („Aufwandsstruktur“ und Monatsbalken in `desktop-renderer/src/ui/shell/dashboardFlows.ts`) zählt Umbuchungen weiter als Ein- und Ausgang. Die Datei ist geteilter Lite/Pro-Code, und Lite-Geldtransit (L2) gehört der Buchungs-Session. Laut Absprache vom 23.10. baut deren L3 den Lite-Ausschluss (kind transit/privat) produktneutral in dashboardFlows.ts. **Beim Zusammenführen** hängt diese Session den Pro-Ausschluss an dieselbe Stelle, jetzt über `isTransfer` aus listBankTransactions. Nach P3 prüft postDraft auch „Entwurfsbetrag = Bankbetrag“ und „Bankkonto = Konto des Umsatzes“; Transit-Entwürfe sind normale Bankentwürfe und erfüllen beides, das nach dem Merge per Test bestätigen. Die `extraSections`-Prop in SettingsView bleibt additiv, weil der Haupt-Checkout die Datei ebenfalls ändert.

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
  - Umbuchungen laufen über die eingebaute Regel und erscheinen hier wie jede andere Regel.
  - `applyRules` rechnet in einer serialisierbaren Transaktion neu und bricht bei geändertem Hash mit `RULE_PREVIEW_STALE` ab. Der Audit-Eintrag ist `apply_booking_rules`.
- **Auto-Buchen** (`autoPostAfterImport`):
  - Wird nach dem Pro-Import aufgerufen; ein Fehler dort lässt den Import bestehen.
  - Nur Regeln mit eigenem Schalter „Automatisch buchen“, nur für unveränderte Entwürfe, die nach der Validierung „suggested“ bleiben. Die eingebaute Umbuchungsregel bucht nie automatisch.
  - Geschlossene Perioden bleiben offen.
- **Gedächtnis/Bayes:** Der Ausschluss von `LIKE '4%'/'8%'` ist durch Rollen ersetzt. Ausgeschlossen sind bank, input/output_vat(_deferred), Forderungen und Verbindlichkeiten, die eigenen Finanzkonten und die Konten aus tax_case_account_mappings. SKR04 lernt jetzt Ausgaben.
- **Routen:** `GET /pro/accounting/rules/preview`, `POST /rules/apply`. Die Regel-Routen in app.ts nutzen das gemeinsame `accountSuggestionRuleSchema`; das Upsert akzeptiert die neuen Felder und meldet Fehler auf Deutsch über `mapped`. IPC: `pro:previewRuleApplication`, `pro:applyRules`.
- **UI:**
  - Einstellungen › Buchhaltung › Buchungsregeln (`apps/pro-desktop/components/ProBookingRulesSettings.tsx`):
    - Liste mit Schalter, Bearbeiten und Löschen
    - dreispaltiger Editor (Wenn/Dann/Live-Test mit Buchungssatz-Vorschau)
    - Karte „Auf Bestand anwenden“ mit Probelauf-Tabelle
  - Das alte Modal `ProAccountRulesModal.tsx` ist gelöscht; „Regeln“ in Buchen und Bankabgleich sind Deep-Links.
  - „Regel aus diesem Umsatz“ im Bankabgleich öffnet `#/settings?section=rules&ruleFrom=<id>` vorbefüllt.
  - Der Bankabgleich zeigt den Regel-Trace unter dem Kontierungsvorschlag.
- **Tests:**
  - `server-data/src/postgres/proBookingRules.pglite.test.ts`, 4 Tests: Steuerzeilen und Overrides, Probelauf und Schutz, Auto-Buchen und Gedächtnis, Umbuchung
  - Nach dem Rückbau: server-data 112 grün, 18 rot (die bekannten SQLite-Tests); server-runtime 48/48; pro-client 11/11; integration-tests 1114 grün, 5 rot (alle SQLite-Migration, better-sqlite3)
- **E2E:** `tests/e2e/pro/pro-transfers-rules.spec.mjs` ersetzt `pro-rules.spec.mjs` (die alte Spec testete das gelöschte Modal), 2/2 grün nach dem Rückbau. pro-bank-import, pro-exceptions und pro-ml-rule-engine: 5/5 grün.
  - Artefakt mit Wiederhol-Anleitung: `~/billme-umb-2026-10-23/e2e-slim/` (6 Screenshots, run.log, README.md). Der Stand vor dem Rückbau liegt in `e2e-final/`.
  - `pro-main-flows.spec.mjs` ist rot (8 Tests), alle an der Kleinunternehmer-Prüfung beim Seeding der Rechnung. Die Prüfung gibt es seit 8ea0ef4 (Vorfahre von HEAD), die Ursache ist also schon vorhanden: Die Seeds stellen §19-Rechnungen aus, bevor KU aktiv ist. P2 der Buchungs-Session behebt das im Haupt-Checkout (dort 8/8 grün), nach dem Merge ist es auch hier erledigt.

**Bewusst nicht gebaut:**
- „Soll/Haben“ ist kein Regel-Feld. Die Seite folgt aus Geldrichtung und Flusstyp; der Editor zeigt sie in der Vorschau.
- Kein Storno-Assistent für gebuchte Sätze (Entscheidung 4).
- Die Probelauf-Tabelle zeigt den Steuerfall als Schlüssel (DE_STD_19), nicht als Text.

## Entwurf (vor dem Rückbau; Teil A dort ist überholt)

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

1. Nutzer-Review und Freigabe für den Commit des Rückbaus (e1900e7 enthält noch die große Umbuchungs-Version).
2. Vor dem Zusammenführen mit refactor/slim-architecture:
   - Periodenprüfung auf `accountingPeriods.ts` (P1) umstellen
   - Pro-Ausschluss in `dashboardFlows.ts` an die L3-Stelle hängen
   - Transit-Entwürfe gegen die neuen P3-Prüfungen testen
   - Report-Mappings 1360/1460 (P6) abwarten
   - Tax-Konten aus P4 gegen `proposalLines` prüfen
3. `pnpm ci:prepare-sqlite-tests` würde laut Notiz die better-sqlite3-Bindung bauen und die 18 bzw. 3 SQLite-Suiten wieder ausführbar machen.

## Entscheidungen (23.10.2026, vom Nutzer an Claude delegiert)

1. Regel-Editor als Einstellungs-Unterseite, kein Sheet. Vorbefüllt öffnen über „Regel aus diesem Umsatz“.
2. und 3. (Paarerkennung, Zeitfenster) sind mit dem Rückbau entfallen: Erkannt wird nur die eigene IBAN, als eingebaute Regel.
4. Gebuchte Sätze im Probelauf: nur ein Hinweis. Ein Storno-Assistent kommt später.
5. Auto-Buchen: nur der Schalter je Regel, standardmäßig aus (die globalen Schalter sind mit dem Rückbau entfallen). Festgeschriebene Monate werden nie automatisch gebucht.
6. „Geldtransit offen“ nur in Ausnahmen, als Monatssaldo.
7. (Nutzer, 23.10. nachts) Umbuchungen sind kein eigenes Feature: eingebaute Regel + Saldo-Kontrolle statt Paarerkennung, Paar-Tabelle und Sonder-UI.

## Abstimmung mit der Buchungs-Session (rechnungs-editor-pro-74, 23.10.2026)

- Die Session arbeitet im Haupt-Checkout auf refactor/slim-architecture, ohne Commits. Ihre Briefs und Ergebnisse liegen in `~/billme-booking-fix-2026-10-23/` (P1-done.patch, P3.md …).
- **Diese Session baut:** Geldtransit in Pro (transit-Rolle 1360/1460, eingebaute Regel für eigene IBANs, „Geldtransit offen“ in Ausnahmen), Bug 0 in `getDraftByTransactionId`, die Regel-Engine und das Label von SKR04 1460.
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
- e1900e7 ist auf origin gepusht; der Rückbau wird ein zweiter Commit. `proBookingRuleRoutes.ts` ist neu und muss mit `git add` dazu (sonst fehlt der Import in app.ts).
- 0049 wurde nach e1900e7 geändert (Tabellen `bank_transfer_links`/`pro_booking_settings` gestrichen). Ein Dev-Datenverzeichnis, das die alte 0049 angewendet hat, behält die zwei leeren Tabellen; schadet nicht, weil der Migrator nur `created_at` vergleicht, keine Hashes; sauberer ist ein frisches Verzeichnis (E2E nutzt frische /tmp-Verzeichnisse).
- Der Navigationspunkt „Auswertungen“ ist in Bankabgleich und Ausnahmen markiert (zu sehen auf den Screenshots). Das liegt nicht in diesem Diff und ist nicht untersucht.
- `accounting-ui-pro` zeigt Regel-Trace und Umbuchungen nur, wenn `ProAccountingPage` die Felder durchreicht (`ruleTrace`, `isTransfer`). Neue Felder in contract.ts **und** schemas.ts eintragen, sonst entfernt zod sie.
- Migrationsnummer 0049 ist mit der Buchungs-Session abgestimmt, dort sind 0040–0048 belegt. `when` muss größer als deren Werte bleiben.

## Offene Entscheidungen

- Keine. Neu auftauchende Fragen hier sammeln.
