# HANDOFF

## Stand 25.10.2026: alles zusammengeführt, Server-Mode-E2E grün

- `refactor/slim-architecture` enthält die Fix-Runde, `feature/booking-followups` und `feature/umbuchungen-regel-engine` (Merges `6a3eb0f`, `75c7e75`). Gepusht nach `private` (billme-private).
- Öffentliches `origin/main` (PRs #34–#38) ist per `9f8d150` in den Branch gemergt; das öffentliche Repo bleibt unberührt. Von `main` übernommen: CI-Trigger für `publish-ghcr.yml`, `docker-compose.server-mode.ghcr.yml`, `EUR_PROFILE_REQUIRED` bei fehlenden Server-Einstellungen. Alles andere (Pro-Web-Renderer, API-Proxy, Browser-Shell, `desktop-data`-Mapping, Unit-Tests) war hier schon anders gelöst und behält den Branch-Stand.
- Prüfstand: Integration 1442/1442, Desktop-E2E Lite+Pro 164/164, Server-Mode-E2E `pnpm test:e2e:server:full` 23/23 (Podman, Postgres, alle Migrationen bis 0067).
- Server-Mode-Szenarien waren veraltet, nicht das Produkt: Ansprechpartner sind eine Liste (`lite/scenarios.mjs`), der Jahresabschluss sperrt das Jahr vorläufig und die Festschreibung gilt kumulativ (`pro/source-runs.mjs` öffnet die Monate über die API wieder, Soft-Lock-Fall auf 2026-11), UStVA-Zeilen tragen Kennzahlen, Leserechte-Meldung auf Deutsch, eine Ausgangszeile beim Debitor ist ohne `refund: false` eine Rückzahlung (`pro/nonhappy.mjs`).
- Offen beim User: ob und wann der Stand ins öffentliche `main` geht; wo die Images gebaut werden; Saldovorträge je Personenkonto; DATEV-Formate gegen echten Import prüfen; Verfahrensdokumentation gegenlesen.

## Fix-Runde nach dem Nutzer-Durchgang 24.10.2026 (nicht committet)

Der User wollte alle Befunde aus `~/billme-user-audit-2026-10-24/REPORT.md` behoben haben. Umgesetzt in drei parallelen Spuren im selben Checkout, mit 13 Agenten-Paketen: L1–L3, P1–P4, B1–B3, R1, dazu Nacharbeiten von mir.

**Ablage:** `~/billme-fix-2026-10-24/`
- Pro Paket: Brief, `*-progress.md` mit Rot-Nachweisen, `*-files.txt`, `*-done.patch`.
- `FINAL.patch` + `FINAL-untracked.tgz` (Stand gegen 2f25402).
- `MERGE-NOTES.md`, `final/summary.txt`.

**Regel dieser Runde:** Der rote Test sitzt an der Schicht, die versagt hat. Für UI-Fehler ist das E2E über die Oberfläche, zusätzlich ein Integrationsfall, wenn der Server falsche Daten still geschluckt hat.

- **Blocker behoben:**
  - **L-1:** Lite speichert `vatRate`; ohne Satz antwortet der Server mit 400.
  - **P-1:** Ein Bankkonto muss ein Geldkonto sein, Vorgabe ist die Bank-Rolle. Der Pro-Dialog kann jetzt auch bearbeiten.
  - **P-2:** Ein Bankentwurf mit Steuerfall wird in Netto und Steuer geteilt.
  - **P-3:** Storno und Korrektur zählen in UStVA, ZM und OSS negativ.
  - **M-2:** Standard-Mahnstufen, dazu Stufen hinzufügen und entfernen.
- **Hoch und Rest:**
  - **Mahnwesen:** „Mahnung erstellen“ in der Detailansicht, Mahnschreiben als Vorschau und PDF, Pro-Mahngebühr im Journal.
  - **Belege und Abos:** Abo „Jetzt ausführen“ nur für die eigene Karte; ZUGFeRD mit einzeiliger Adresse; Abschläge centgenau; Positionsrabatt mit BG-27; Leitweg-ID am Kunden.
  - **Zahlen:** Dashboard-Zahlen konsistent mit EÜR und UStVA.
  - **Pro-Buchhaltung:**
    - Ist-Versteuerung wirkt.
    - Jahresabschluss und Vortrag mit eigener Maske; Skonto und Anzahlung ebenfalls.
    - Einzelunternehmen, GbR und e.K. können Doppik wählen.
    - Bereich „Steuer“.
    - Anlagen: Anlagenspiegel, AfA zum Jahresende, Verkauf mit Rechnung und Rückabwicklung.
    - Beleg an Bankzeile, neu buchen nach Storno.
  - **Web-Shells:** Pro-Login, Portal-Veröffentlichung aus dem Web, Lesezugriff, PDF-Name, E-Mail-Hinweise.
  - **Allgemein:** Prüfungen von IBAN, USt-IdNr. und PLZ in UI und Server; rohe Fehlercodes durch deutsche Sätze ersetzt.
  - Die Liste je Befund steht in den Progress-Dateien.
- **Migrationen:**
  - 0060: `import_batches.updated_count`
  - 0065: `bank_transaction_documents`
  - 0066: neu buchen nach Storno
  - 0067: Trigger Anlagenverkauf
  - Die `when`-Werte …030–033 setzen das Schema 17909856000NN fort, `idx` ist gleich der Dateinummer.
  - `feature/booking-followups` hat 0050–0053 mit …020–023, es gibt keine Kollision. Siehe MERGE-NOTES.
- **Prüfstand 24.10. abends:**
  - Typecheck aller 12 Apps und Pakete grün, Lint grün.
  - Integration (TZ=Pacific/Kiritimati) 1432/1435, 0 rot, 3 alte todos.
  - Routenabdeckung 364/364.
  - server-data 129/129, server-runtime, server-api 19/19, embedded, offer-portal, server-cli grün.
  - E2E Lite + Pro: 160/161 im Gesamtlauf; der rote Spec (`pro-bank-ledger`, Setup ohne Doppik) ist angepasst und läuft 4/4.
  - Server-Mode-Docker-E2E nicht gelaufen. `tests/e2e/server/lite/scenarios.mjs` `markIssued` wurde angepasst, ist aber ungelaufen.
- **Bewusst offen:**
  - GDPdU `index.xml` liegt bei followups.
  - SKR03 hat kein Erlöskonto „bei Buchverlust“; es bleibt 8829.
  - Sitzland DE nur in der UI geprüft (AT/CH-Verkäufer-E-Rechnung).
  - DATEV-Export bleibt je Periode, ohne Stammdatenexport.
  - Kanten beim Anlagenverkauf (Teilgutschrift, vorab per CLI gestellt, Storno in weich gesperrtem Monat).
  - Prüferpaket im Browser als Einzeldownloads, nicht als ZIP.
- **Merge mit `feature/booking-followups`:** 35 gemeinsame Dateien, siehe `~/billme-fix-2026-10-24/MERGE-NOTES.md`. Gemeinsam mit dem User mergen.

## Nutzer-Durchgang 24.10.2026 (nur Bericht, kein Code geändert)

Sechs Prüfer haben Lite (Stammdaten, Belege, Buchen), Pro (Buchhaltung, Abschluss) und den Server-Modus (Web Lite/Pro, Portal, CLI) wie Nutzer über playwright-cli/CDP bedient. Bericht: `~/billme-user-audit-2026-10-24/REPORT.md`, Details je Bereich in `<bereich>/findings.md` mit Screenshots. Harness: `launch.mjs`/`stop.sh`/`COMMON.md` daneben.

- **Blocker:**
  - **L-1 Lite:** `vatRate` geht in `EurView.tsx:419/477/503` und `TransactionMatchingView.tsx` nur in Pro mit. Dadurch erscheinen EÜR-Ausgaben brutto und die Vorsteuer fehlt.
  - **P-1 Pro:** Ein neues Bankkonto bekommt das Hauptbuchkonto 0005 (`BankAccountModal.tsx:38`).
  - **P-2 Pro:** Eine Bankbuchung mit Steuerfall bucht keine Vorsteuer, die Steuer wird nur in `BookingEditor.tsx` angezeigt.
  - **P-3 Pro:** Eine Stornorechnung erhöht Kz 81/86.
- **Blocker, übergreifend:** Mahnwesen ist kaputt.
  - Der Button in der Detailansicht tut nichts.
  - Ein neues Profil hat keine Mahnstufen und keinen Weg, welche anzulegen (Blocker: `SettingsView.tsx` bearbeitet nur vorhandene Stufen).
  - Das Mahnschreiben ist in der UI nicht erreichbar.
  - Pro bucht die Mahngebühr nicht.
- **Hoch, weitere:** Offene Forderungen ohne Teilzahlung, Dashboard widerspricht EÜR/UStVA, Ist-Versteuerung wirkt in Pro nicht, die Pro-Web-Shell hat kein Login für bestehende Konten. Die vollständige Liste steht in REPORT.md.
- **Nächster Schritt:** Mit dem User priorisieren, dann je Befund zuerst einen roten Integrations- bzw. E2E-Fall schreiben.

## Buchungs-Folgeaufgaben 24.10.2026 (Worktree `~/.t3/worktrees/rechnungs-editor-pro/feature-booking-followups`, Branch `feature/booking-followups`, nicht committet)

Startet von 2f25402. Logs und Rot-Nachweise: `~/billme-booking-followups-2026-10-24/`. Migrationen ab 0050 (0049 gehört der Umbuchungs-Session).

- **1a erledigt (Entscheidung Nutzer: eigener EB-Export):** `GET /pro/accounting/datev/export.csv?kind=opening_balances` liefert die `carry_forward`-Buchungen des Zeitraums als eigenen Stapel „Eröffnungsbilanzwerte JJJJ“, Datei `EXTF_EB-Werte_…`. Jede Zeile ist ein Bestandskonto gegen 9000, S/H nach Saldo. Der laufende Export (`kind=journal`, Standard) bleibt ohne Saldovorträge. Im DATEV-Panel steht dafür das Feld „Inhalt“. Tests: `pro-reporting` (Jahresabschluss-Fall), `pro-client` (der Client reicht `kind` durch, Rot-Nachweis gemacht).
- **1b erledigt (Entscheidung Nutzer: wie vorgeschlagen):** Lite-`PUT /settings` gibt 409 zurück, wenn `double_entry` ankommt und gespeichert nicht `double_entry` ist. Alte Lite-Profile mit doppelter Buchführung lassen sich unverändert speichern, der Weg zurück zur EÜR bleibt offen. Code: `server-runtime/src/app.ts`.
  - **Falle:** Testdaten für ein Lite-Altprofil lassen sich nicht mehr über die API anlegen. Dafür gibt es `reopenLiteWithStoredSettings` (Integration, `harness.ts`) und `setStoredLiteSettings` (E2E, `support.mjs`). Beide stoppen die App, schreiben `server_settings` direkt in PGlite und starten neu. Betroffene Tests: `masterdata` (Lite-Fall neu, der GmbH-Fall läuft nur noch in Pro), `reports` („EÜR is only available…“), `settings-and-eur.spec`.
- **2 erledigt (§13b und ig. Erwerb im Pro-DATEV-Export):** `buildDatevRows` lässt die Steuerzeilen des Steuerfalls (Rollen `input/output_vat_rc_13b`, `_ige`, `_ige_7`) weg, wenn sie sich zu null aufheben. Der Rest der Buchung wird neu gepaart, denn die gespeicherten Paare kreuzen Aufwand und Steuer (4900/1787 190, 4900/1600 810, …). Die Netto-Zeile bekommt bei §13b BU 0094 (7 %: 0091) mit Sachverhalt L+L 1 (Drittland), 4 (Bau) oder 7 (EU-Leistung), beim ig. Erwerb BU 0019 bzw. 0018. Storno läuft genauso.
  - **Quelle:** DATEV-Kontenrahmen 2025, Fußnote 21: „BU-Schlüssel 94 (mit Vorsteuerabzug) bzw. 95 (ohne) … Tatbestand des § 13b anschließend erfassen“. Die Sachverhaltsnummern stammen aus der Jera-Fibu-Doku und den BuchhaltungsButler-Hilfeseiten.
  - **Abweichung vom Auftrag:** Einen BU-Schlüssel 46 gibt es nicht. 46/47 sind die UStVA-Kennzahlen der EU-Leistung, DATEV bildet sie über BU 94 + Sachverhalt 7 ab. Die amtliche Steuerschlüssel-Tabelle 2025 (Dok.-Nr. 0907054) war nicht abrufbar. Vor dem Release mit dem Steuerberater oder einem DATEV-Testimport gegenprüfen.
  - Test: `pro-accounting` „DATEV gets one net row per self-assessed purchase…“ (Rot-Log `2-red.log`).
  - Nicht gemacht: BU 95 (ohne Vorsteuerabzug), weil es dafür keinen Steuerfall gibt. Lite-DATEV ebenfalls nicht, weil Lite keine §13b-Eingänge bucht.
- **3 erledigt (BWA-Standardzuordnung, Entscheidung Nutzer: BWA 01 für SKR03 und SKR04):** `reportDefaultMapping.ts` hat jetzt `SKR03_BWA`/`SKR04_BWA`, Kontengruppen auf die 21 BWA-01-Zeilen. `defaultReportPosition`/`defaultReportMappings` haben einen neuen Parameter `result` (`hgb-guv` | `bwa01`). Das Muster ist wie bei der GuV: Eine eigene Zuordnung geht vor, nichts wird gespeichert, ein Warnhinweis erscheint. Ohne Zeile bleiben Bestandsveränderungen, aktivierte Eigenleistungen und kalkulatorische Kosten; sie blockieren weiter. Die Management-GuV blockiert wie bisher.
  - Tests: `pro-reporting` (drei Fälle umgestellt, der Blockier-Fall nutzt jetzt 4990), `pro-periods` (SKR04, Rot-Nachweis gemacht). E2E `pro-reports` und `pro-main-flows` sind angepasst. Der Mapping-Dialog listet nur Konten ohne Zuordnung, deshalb gibt es dort keine BWA-Mapping-Schritte mehr.
  - Die Zuordnung ist eine Näherung an die DATEV-BWA (der Katalog ist ohnehin eine „nicht gesetzliche Orientierungsstruktur“). Grenzfälle: Forderungsverluste SKR03 2400–2499 → Sonstige Kosten, SKR04 4830–4999 → neutraler Ertrag.
- **4c erledigt (nicht abziehbare Vorsteuer, § 15 Abs. 1a UStG, Pro-Eingangsrechnung):** Migration 0050 `incoming_invoice_lines.input_vat_deductible`. Eine Zeile mit `inputVatDeductible: false` bucht brutto auf das Aufwandskonto, ohne Vorsteuerzeile. Dafür gibt es in OPOS die Checkbox „Vorsteuer nicht abziehbar (z. B. Geschenk über 50 €)“. Der `sourceVersion`-Hash alter Zeilen bleibt stabil, weil NULL nicht gehasht wird. Test: `pro-accounting` (aus dem Todo, Rot-Log `4c-red.log`).
  - Lücke: Für die Checkbox gibt es nur die Server-Mode-Spec `incoming-invoice-ui`, die Docker braucht, keine Desktop-E2E.
- **4b erledigt (Verzugszinsen buchen, Pro):** Migration 0051 `dunning_history.interest_applied`. Im Versandweg rechnet der Mahnlauf den Zins des Briefs mit `buildDunningDocumentContext` aus, also so, wie der Brief ihn zeigt, und speichert nur den Zuwachs gegenüber früheren Briefen. `finish` bucht ihn über `postDunningInterestInTransaction`: Forderung an `late_interest` (2650/7100), Quelle `dunning_interest`, eigener offener Posten `dunning_interest` mit `${invoiceId}:${level}`. Gebühr und Zins teilen sich jetzt `postDunningClaimInTransaction`. Test: `automation` (aus dem Todo, Rot-Log `4b-red.log`).
  - Offen: Die 40-€-Pauschale (§ 288 Abs. 5 BGB, `flatFee` im Brief) wird nirgends gebucht.
  - Offen: Der manuelle Abgleich `resolveDunningDelivery` bucht keinen Zins.
  - Ungetestet: der Zuwachs über zwei Mahnstufen. Der Test prüft nur eine Stufe in zwei Läufen.
  - Keine E2E: Eine Pro-Spec für den Mahnlauf gibt es nicht (`tests/e2e/pro` hat keine). Sie bräuchte SMTP.
- **4a erledigt (10-Tage-Regel an der Bankzeile, Entscheidung Nutzer: Merkmal an der Bankzeile, Lite):** Migration 0052 `transactions.recurring`. `POST /lite/transactions/:id/recurring {recurring, reason}` setzt das Merkmal und schreibt ein Audit (`recurring_marked`/`_unmarked`). Abgelehnt wird mit 409, wenn die Zahlung außerhalb von 22.12.–10.01. liegt, wenn die Zeile mit einer Rechnung verknüpft ist (dann entscheidet die Rechnung) oder wenn einer der beiden betroffenen Monate festgeschrieben ist. Wirkung: Mit Merkmal zählt eine Zahlung vom 22.–31.12. im Folgejahr, eine vom 01.–10.01. im Vorjahr. Der EÜR-Zweck bekommt den Hinweis „(10-Tage-Regel, § 11 EStG)“. Die Fälligkeit prüft die App nicht, das Häkchen ist die Aussage des Nutzers. Die alte Klassifikation im Flussjahr bleibt in der Tabelle stehen, zählt aber nicht mehr (Test prüft das). IPC `transactions:setRecurring`, Checkbox im EÜR-Klassifizierungsfeld (nur Lite, nur Bankzeilen im Fenster, Label nennt das Zieljahr). Tests: `reports` (aus dem Todo, Rot-Log `4a-red.log`), E2E `settings-and-eur.spec` „a VAT prepayment paid on 8 January…“ mit Screenshots in `e2e-4a/`.
  - Offen: Pro-EÜR (`bank_transactions`/OPOS-Zahlungen) kennt das Merkmal nicht. Die Route ist nur in Lite registriert.
- **5 erledigt (Personenkonten nur im DATEV-Export, Pro):** Migration 0053 `datev_party_accounts`: je OPOS-Partei (`party_type`, `party_id`) eine feste laufende Nummer. Vergeben wird sie beim ersten echten DATEV-Export in der Reihenfolge des ersten Auftretens und nie geändert. Konto = 1·10^L + Nummer für Debitoren, 7·10^L + Nummer für Kreditoren (L = Sachkontenlänge; bei L=4 also 10001… bzw. 70001…). Ist der Nummernkreis erschöpft, kommt ein Fehler.
  - Wirkung: `buildDatevRows` mit `personAccountLength` (nur die Route `export.csv`, `kind=journal`) ersetzt die Rollen `accounts_receivable`/`accounts_payable` durch das Personenkonto. Voraussetzung: Die Buchung oder ihr Original (bei Storno) hat in `open_items`/`open_item_payments` genau eine Partei dieses Typs. Sonst bleibt das Sammelkonto stehen, z. B. bei einem Anlagenzugang ohne Lieferant.
  - Stammdaten-Stapel: `kind=parties` → EXTF Kategorie 16 „Debitoren/Kreditoren“, Version 5, 254 Spalten. Gefüllt werden Konto, Name je Adressatentyp, Adressatentyp, EU-Land/USt-IdNr., Straße/PLZ/Ort aus „Straße\nPLZ Ort“, Land und E-Mail. Datei `EXTF_Debitoren-Kreditoren_<bis>.csv`, Exportnachweis mit formatVersion 5. Im DATEV-Panel ist es die Option „Debitoren/Kreditoren (Stammdaten)“. Die Tabelle steht auch im Z3-Prüferpaket (`datev-party-accounts.jsonl`).
  - Tests: `pro-reporting` „customers and vendors get their own Personenkonto…“ (Rot-Log `5-red.log`). `pro-reporting` und `pro-periods` sind auf Debitor/Kreditor umgestellt. E2E `pro-main-flows` „exports the DATEV Buchungsstapel…“ lädt jetzt beide Stapel und prüft den Debitor in beiden Dateien (`e2e-5/`).
  - **Ungeprüft:** Die Spaltenüberschriften stammen aus ameax/datev-extf (MIT), das amtliche DATEV-Dokument war nicht erreichbar. Header-Felder 15–22 (Zeitraum, Buchungstyp, Festschreibung, WKZ) bleiben leer. Beides vor dem Release mit einem DATEV-Testimport prüfen.
  - **Offen, wichtig:** Die EB-Werte (`kind=opening_balances`) buchen Forderungen und Verbindlichkeiten weiter auf dem Sammelkonto. In DATEV läuft der Ausgleich alter Rechnungen dann auf den Debitor, während der EB-Wert auf 1400 stehen bleibt. Richtig wäre ein EB-Wert je Personenkonto aus den offenen Posten am Stichtag; das braucht einen Rückblick über die Zuordnungen.
  - Weitere Grenzen: Ohne `client_id` ist die Partei der Kundenname. Gleichnamige Kunden teilen sich also einen Debitor, und eine Umbenennung ergibt einen neuen. Die Vorschau `/datev/rows` zeigt weiter die Sammelkonten. Lite ist unverändert.
- **6 erledigt (GDPdU `index.xml` im Pro-Prüferpaket):** `auditExport.ts` legt zu jedem Datensatz und zum Kontenplan zusätzlich eine `*.csv` an, dazu `index.xml` (Beschreibungsstandard, `<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">`) und die DTD selbst (`gdpduDtd.ts`, wörtlich aus stustapay übernommen).
  - CSV-Format: UTF-8, `;`, Text in `"`, CRLF, Kopfzeile (`<Range><From>2</From>`), Dezimalkomma.
  - Typen kommen aus den `dataTypeID`s der Abfrage: numeric → `Numeric/Accuracy` (mindestens 2), int → `Numeric`, Text mit nur `YYYY-MM-DD` → `Date`, sonst `AlphaNumeric`. bytea fällt weg.
  - Zeilenumbrüche in Texten werden in der CSV zu Leerzeichen; das JSONL bleibt unverändert im Paket. Keine Primärschlüssel (laut DTD optional).
  - Prüfung: `xmllint --valid` auf ein echtes Paket (`~/billme-booking-followups-2026-10-24/z3/xmllint.log`) meldet nur, dass das Inhaltsmodell von `Media` in der DTD selbst nicht deterministisch ist. Das ist eine Eigenheit des Standards; das Dokument hat sonst keine Verletzung.
  - Tests: `pro-reporting` „the package also carries every table as CSV with a GDPdU index.xml…“ (rot gesehen). E2E `pro-assets-receipts-exports` „the Prüferpaket (Z3)…“ prüft `index.xml`, die DTD und alle genannten CSVs im geschriebenen Ordner (`e2e-6/`). Nicht gemacht: Lite (Entscheidung Nutzer).
- **7 erledigt (Verfahrensdokumentation als generierter Entwurf, Pro):** `GET /api/v1/pro/tax/procedure-documentation` liefert Markdown (`server-data/src/postgres/procedureDocumentation.ts`), gegliedert nach GoBD Rz. 151 ff. bzw. AWV-Muster.
  - Gefüllt aus Einstellungen und Daten: Firma, Rechtsform, Gewinnermittlung, Steuernummer/USt-IdNr., KU bzw. Soll/Ist, Nummernkreise, Kontenrahmen, Zahl der Buchungen und Belege, festgeschriebene Monate, DATEV-Exporte und Personenkonten, Zustand der Audit-Kette.
  - Abschnitt 5 „Vom Unternehmen zu ergänzen“: Zuständigkeiten, IKS, Belegeingang/Scannen, Datensicherung, weitere Systeme, Unterschrift.
  - UI: Knopf „Verfahrensdokumentation (Entwurf)“ im DATEV-Panel neben dem Prüferpaket, IPC `pro:exportProcedureDocumentation`. Den Dateinamen bildet der Client, weil `content-disposition` kein freigegebener CORS-Header ist.
  - Tests: `pro-reporting` „a draft Verfahrensdokumentation…“ (rot gesehen, 404). E2E `pro-assets-receipts-exports` „the draft Verfahrensdokumentation…“ mit dem gespeicherten Entwurf als Artefakt (`e2e-7/`).
  - Offen: Die Texte beschreiben das Verfahren, wie billme es heute umsetzt (Nummernvergabe, Storno statt Änderung, Belege mit SHA-256, Festschreibung). Bei Änderungen am Verfahren muss der Generator mitgezogen werden. Fachlich gegenlesen lassen.
- **8 erledigt (nachgeholte Rot-Nachweise P2/P5, kein Produktcode geändert):** Je ein Wegwerf-Worktree auf dem Elternstand des Fix-Commits (P2: 5e70d22, P5: 730878f), dazu die Integrationstests aus dem Fix-Commit (07dfe62 bzw. ca20461). Danach wieder entfernt. Logs: `8-p2-red.log`, `8-p2-periods-red.log`, `8-p5-red.log`, `8-p5-worker-red.log`.
  - P2, rot aus fachlichem Grund (9/10):
    - Umbuchung: ohne Route keine Begründungspflicht.
    - Rücklastschrift: `PAYMENT_SOURCE_DIRECTION_MISMATCH`.
    - Rücklastschrift Lite: die bezahlte Rechnung fehlt als Vorschlag.
    - Guthaben-OP fehlt (zwei Fälle).
    - Storno einer bezahlten Rechnung: kein Guthaben-OP.
    - Kreditor-Zahlungsstorno: Route 404.
    - Ist-USt-Test: keine Buchung.
    - Ausgehende Zeile als Erstattung: `PAYMENT_ALLOCATION_INVALID`.
  - P2, nicht rot: Der Pro-Periodentest „a payment recorded on the invoice into a closed month…“ ist auf dem Stand vor P2 grün. Die Sperre kam schon mit P1; der Test sichert sie nur zusätzlich ab.
  - P5: Ist-SKR04 (`pro-periods`) ist rot mit „payments in this month made VAT due“.
  - P5, Worker 2026: rot, aber nur in der Begründung. Der alte Code lehnte 2026 ebenfalls mit 422 ab („Only the 2025 tax filing contract“); fail-closed galt also schon. Der Test belegt die neue Begründung „provider is unavailable“.
- **5–8 abgestimmt 24.10.2026:** 5 = Variante A (nur DATEV), 6 = nur Pro, 7 = generierter Entwurf, 8 = ja, nach 5–7. Konzepte:
  - **5 Personenkonten (Pro):**
    - Heute: Forderungen und Verbindlichkeiten stehen nur auf den Sammelkonten (`accounts_receivable` 1400/1200, `accounts_payable` 1600/3300). OPOS führt die Partei, das Journal nicht.
    - Variante A, nur DATEV: Jeder Kunde bekommt eine Debitorennummer (10000–69999), jeder Lieferant eine Kreditorennummer (70000–99999), gespeichert am Stammsatz und fortlaufend vergeben. Nur der DATEV-Export ersetzt das Sammelkonto durch das Personenkonto; dazu kommt ein Stammdaten-Export (Debitoren/Kreditoren, EXTF Kategorie 16). Journal, Berichte und Bilanz bleiben unverändert. Klein und ohne Risiko für die Salden.
    - Variante B, echte Personenkonten im Hauptbuch: Die Buchungen gehen auf das Personenkonto, und die Berichte fassen es zum Sammelkonto zusammen. Betrifft Buchungsweg, OPOS-Abgleich, Saldovortrag, BWA/GuV-Zuordnung und die Altbuchungen (Migration oder Stichtag). Groß.
    - Empfehlung: A.
  - **6 GDPdU `index.xml` (Z3):**
    - Heute: Das Prüferpaket (`auditExport.ts`) liefert JSONL. IDEA und andere Prüfsoftware lesen aber CSV plus `index.xml` nach dem Beschreibungsstandard (DTD `gdpdu-01-09-2004.dtd`).
    - Vorschlag: zusätzlich je Datensatz eine CSV (Semikolon, Komma als Dezimaltrenner, UTF-8 oder ISO-8859-15) und eine `index.xml` mit Tabellen, Spalten, Datentypen (AlphaNumeric/Numeric mit Accuracy/Date) und Primärschlüsseln. JSONL bleibt im Paket.
    - Umfang: Pro (Journal, Konten, Stammdaten, OPOS, Anlagen, Eingangsrechnungen). Lite optional mit Rechnungen, Bankzeilen, EÜR-Zuordnungen und Kasse.
    - Prüfung: Integrationstest, dass `index.xml` gegen die DTD validiert und jede Spalte zur CSV passt. E2E: Paket herunterladen.
  - **7 Verfahrensdokumentation:**
    - Variante A: eine Vorlage (Markdown/PDF) mit den festen Teilen: allgemeine Beschreibung, Anwender-, technische und Betriebsdokumentation nach GoBD Rz. 151 ff. bzw. AWV-Muster. Die App füllt sie aus Einstellungen und Daten: Kontenrahmen, Festschreibungen, Nummernkreise, Belegablage mit SHA-256, Audit-Kette, Backup, Benutzer und Rollen, Datenquellen.
    - Variante B: nur eine statische Vorlage zum Selbstausfüllen.
    - Empfehlung: A als Export „Verfahrensdokumentation (Entwurf)“ mit Stand-Datum und dem ausdrücklichen Hinweis, dass der Nutzer die organisatorischen Teile (internes Kontrollsystem, Scanprozess) ergänzt.
- **Prüfstand nach 1–8 (24.10.2026, Endstand dieser Session):**
  - Integration komplett 1366/1366 grün (`integration-final.log`).
  - Typecheck der Apps und Server-Pakete sauber; `pnpm lint` exit 0.
  - E2E (audit-config, beide Apps frisch gebaut): `settings-and-eur`, `finance`, `pro-reports`, `pro-main-flows`, `pro-assets-receipts-exports` 23/23 grün (`e2e-all.log`).
  - Nichts ist committet. **Neu und untracked:** `drizzle/0050`–`0053*.sql`, `server-data/src/postgres/gdpduDtd.ts`, `server-data/src/postgres/procedureDocumentation.ts`. Ein `git add -u` würde sie liegen lassen und den Build brechen, also ausdrücklich mit hinzufügen.
  - **Merge mit der Umbuchungs-Session:** Deren 0049 kommt in `_journal.json` vor meinen idx-50-Eintrag. Ihr `when` muss kleiner als 1790985600020 sein (meine: 0050 …020, 0051 …021, 0052 …022, 0053 …023).
  - **Personenkonten:** Die Nummernvergabe in `datev_party_accounts` schreibt kein Audit; die einzige Spur ist der Exportnachweis. Laufen zwei erste Exporte gleichzeitig, kann einer am Unique-Index scheitern; ein zweiter Versuch geht durch.
  - Erneuter Download aus dem DATEV-Verlauf (`/datev/exports/:id`): Der Dateiname kommt jetzt aus der Kopfzeile der gespeicherten Datei (Kategorie 16 → `Debitoren-Kreditoren`, Stapelname → `EB-Werte`). Vorher hieß jede Datei `Buchungsstapel`. Der Test kam nach dem Fix, einen Rot-Nachweis gibt es nicht.
- **Prüfstand nach 1–4 (24.10.2026):**
  - Integration komplett grün: 1363 Tests, davon 311 in `migration`/`offer-portal`/`offers` erst nach dem Binding-Fix (siehe Falle unten). Log: `integration-full.log` + `integration-sqlite.log`.
  - Typecheck `apps/desktop`, `apps/pro-desktop` und der Server-Pakete sauber.
  - `pnpm lint` exit 0; in den angefassten Dateien nur vorbestehende Warnungen.
  - E2E (audit-config): `settings-and-eur`, `finance`, `pro-reports`, `pro-main-flows` 16/16 grün (`e2e-final.log`).
  - **Falle:** Nach `pnpm install --prefer-offline` fehlt im Worktree das Binding von `better-sqlite3`. Ich habe `build/Release/better_sqlite3.node` aus dem Haupt-Checkout in den Worktree kopiert, sonst fallen `migration`, `offer-portal` und `offers` mit „Could not locate the bindings file“ um.
- **Worktree-Setup:** `pnpm install --prefer-offline --frozen-lockfile`. Electron-dist ist aus dem Haupt-Checkout verlinkt (`node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist`), dazu `pnpm -C apps/desktop build` vor der E2E.

## Rechnungsnummern-Lücken 23.10.2026 (gemergt: billme-private PR #1, 3cd735e)

- Ursache: Nummer wird beim Öffnen des Editors reserviert; Zurück-Navigation, gelöschte Entwürfe und Freigaben hinter einer späteren Reservierung ließen Lücken.
- Fix: Entwurf bindet die Reservierung nur (finalisiert beim Stellen), Löschen gibt frei, `reserveDocumentNumber` vergibt zuerst die kleinste freigegebene Nummer des Jahres, Editor gibt beim ungespeicherten Verlassen frei. Gebundene Reservierung ist nicht für andere Belege finalisierbar.
- Live seit 24.10.2026 (Coolify, Images 3cd735edfd52). VPS-Image-Platte sdb1 war voll; Prune-Cron verschärft (5 GB Build-Cache, 12 h). Offen: sdb vergrößern, Build vom VPS weg (Registry-IP-Allowlist blockiert GitHub-Runner und Heim-IP), gestoppte Stacks prüfen.
- Offen: App schließen mit offenem neuen Editor hinterlässt `reserved` (bräuchte Sitzungsbindung); Angebote unverändert; „Nächste Rechnungsnummer“ in den Einstellungen kann über der wirklich nächsten liegen.
- CI-Fallen in billme-private: Runner-Image ubuntu26.04 → Playwright-Install scheitert (beide E2E-Jobs); Commitlint-Token ohne Rechte auf PR-Commits.

## Buchungslogik-Fixes 23./24.10.2026 (nicht committet)

Alle Blocker und „Vor Release“-Punkte aus dem Audit (Abschnitt darunter) sind in neun Paketen behoben: Lite L1–L3, Pro P1–P6. Briefs, Ergebnisberichte (`*-result.md`), Rot-Logs und Patch-Stände nach jedem Paket liegen in `~/billme-booking-fix-2026-10-23/`, der Stand vor Beginn in `00-baseline.patch` und `00-baseline-untracked.tgz`. Jeder Befund hat einen Integrationsfall, der vor dem Fix rot war.

- **Lite**
  - **L1:** 10-Tage-Regel (Feld `taxYear` am Posten).
  - **L1:** Festschreibung gilt auch für Import, Rollback, EÜR-Zuordnung und Belege.
  - **L1:** Rollback-Sperre für Bankzeilen, die in Pro gebucht sind.
  - **L1:** CSV: doppelte Zeilen bleiben erhalten, vorgemerkt → gebucht, PayPal/Stripe-Gebühr als eigene Zeile, Original-CSV wird archiviert (0041).
  - **L1:** Kunde mit Rechnungen → 409.
  - **L2:** Kategorien Geldtransit und Privat (getrennt) mit Paarvorschlag.
  - **L2:** Erstattung und Rücklastschrift.
  - **L2:** Kappung bei Überzahlung.
  - **L2:** Steuer-Stichwörter (Kz 141/186).
  - **L2:** DATEV-Export: Privat- und Transitkonten.
  - **L3:** UStVA: Kz 39/83, Dauerfristverlängerung, KU-Hinweis mit §19-Grenzen.
  - **L3:** Anlage EÜR: abziehbar/nicht abziehbar waren bei 164/165/162/168 vertauscht (0046).
  - **L3:** Formular 2026 amtlich, ab 2027 „vorläufig“.
  - **L3:** Zahlungsart Bank/Bar/ohne Geldfluss.
  - **L3:** Vorlagen ohne Geldfluss (Pauschalen, AfA, Privatanteile).
  - **L3:** Bewirtung 70/30.
  - **L3:** Übersicht ohne Transit und Privat.
- **Pro**
  - **P1:** Perioden sperren und festschreiben (Routen, `accountingPeriods.ts`, `PeriodLockPanel`).
  - **P1:** Berichte ohne `fiscal_close`/`carry_forward`.
  - **P1:** Soll = Haben als DB-Constraint-Trigger (0042).
  - **P1:** Storno behält die Belegreferenz.
  - **P2:** Alle Zahlungswege laufen über OPOS und Journal.
  - **P2:** Zahlungsstorno, Umbuchung Kunde/Lieferant.
  - **P2:** Erstattung, Rücklastschrift, Guthaben (0043).
  - **P3:** Freie Buchung `POST /pro/accounting/journal` mit `ManualEntryPanel`.
  - **P3:** Privat-Schnellwahl.
  - **P3:** Bankentwurf = Bankzeile (`BANK_LINE_MISMATCH`).
  - **P3:** Abgleich Bank gegen Hauptbuch.
  - **P3:** Standardentwurf nimmt das SKR-Konto des Bankkontos (`bankLedgerAccount`).
  - **P4:** Resolver `taxCaseAccount` in `server-data/postgres/taxAccounts.ts`.
  - **P4:** Erlös-, USt- und VSt-Konten je Steuerfall.
  - **P4:** Ist-Versteuerung mit Skonto, Storno und Ausfall.
  - **P4:** Skonto aus der Zahlung.
  - **P4:** Anzahlungen (Mindest-Ist).
  - **P4:** Mahngebühr im Journal.
  - **P4:** Bewirtung, Lieferanten-Standardkonto.
  - **P4:** Altmandanten behalten ihre Konten (0045).
  - **P5:** §13b und ig. Erwerb im Eingang (0047).
  - **P5:** UStVA mit echten Kennziffern (`accounting-shared/ustvaKennziffern.ts`, gemeinsam mit Lite) und `UstvaPanel`.
  - **P5:** UStVA, ZM und OSS 2026+.
  - **P6:** Kontenkatalog aus den amtlichen DATEV-PDFs neu erzeugt (0048). USt nicht fällig: 1766/1761 und 3816/3811.
  - **P6:** DATEV: Belegfeld 1 = Beleg, brutto mit BU, Festschreibung-Kennzeichen, 60 Zeichen.
  - **P6:** Eigene Konten.
  - **P6:** Standardzuordnung GuV/Bilanz, Bilanz für Einzelunternehmer.
  - **P6:** Anlagen: Abgang unterjährig, WJ, degressiv.
  - **P6:** Prüferpaket mit Button und mehr Inhalt.
- **Absprache:** Pro-Geldtransit (Regel „eigene IBAN → 1360/1460“, Transit-Saldo) und Regel-Engine baut die Session `feature-umbuchungen-regel-engine`, Worktree `/home/merres/.t3/worktrees/rechnungs-editor-pro/feature-umbuchungen-regel-engine`, uncommitted, Migration 0049. Den Merge machen wir gemeinsam nach Freigabe. Bekannte Konflikte: `proAccountingRepository.ts` (`proposeDraft`/`createDraftForTransaction` gegen die P3-Prüfung; deren Bug-0-Variante wird verworfen zugunsten von `bankLedgerAccount`), `taxCaseAccount`-Fallback, Periodenprüfung → `accountingPeriods.ts`, `dashboardFlows` (Pro `isTransfer`).
- **Migrationen:**
  - Neu: 0041, 0042, 0043, 0045, 0046, 0047, 0048. 0044 ist frei (Lücke, harmlos). `when` steigt monoton.
  - Eine lokale DB, auf der zwischendurch 0046 lief, überspringt 0045, weil der Runner nach `when` geht.
- **Prüfstand 24.10.:**
  - Integration 1359/1362 (3 todo), Routenabdeckung 357/357.
  - server-data 129/129, server-runtime 48/48.
  - Typecheck aller Apps grün.
  - E2E unter xvfb (`playwright.audit.config.mjs`, alle Specs): Lite 53/53, Pro 52/52. Die drei zuvor schon roten Specs sind behoben:
    - `settings-and-eur`: Produktfehler, die Lite-Desktop-App gab ihr Produkt nicht an und hielt sich bei einem Profil mit doppelter Buchführung für Pro. Jetzt `apps/desktop/index.tsx` mit `runtime.product: 'lite'`, und `apps/pro-desktop/index.tsx` setzt `billmeRuntime.product = 'pro'`. Dadurch verlangt der Pro-Desktop-Editor DATEV-Belegangaben wie web-pro.
    - `datev-lite`: Locator.
    - `outgoing-document-chain`: Testdaten und Kettenreihenfolge.
  - HEAD ist inzwischen 3cd735e (Nummern-PR), die Arbeit liegt darüber als Working-Tree-Änderung. Der Working Tree enthält die PR-Änderungen, geprüft an den sechs überlappenden Dateien. `00-baseline.patch` ist gegen 7b80dac erstellt, `FINAL.patch` gegen 3cd735e.
  - `pnpm -C packages/server-cli test` 2/2 grün. `pnpm lint` ohne Fehler, nur alte Warnungen.
  - Migration 0048 löscht 43 reservierte Katalogkonten, aber nur solche ohne journal_lines, Draft-Zeilen oder Mappings. Konten mit Buchungen bleiben also stornierbar.
  - Merge-Notizen für die Umbuchungs-Session: `~/billme-booking-fix-2026-10-23/MERGE-NOTES.md`. Ihr Socket war veraltet, die Nachricht ging nicht raus.
- **Bewusst offen**
  - **Folgeaufgaben:** Personenkonten 10000+/70000+, `index.xml` (GDPdU-Beschreibungsstandard), Verfahrensdokumentation, BWA-Standardzuordnung.
  - **Todo-Tests:** 10-Tage-Regel für reine Bankzeilen (kein Merkmal „wiederkehrend“), Verzugszinsen im Journal (nicht gespeichert), Feld für nicht abziehbare VSt.
  - **DATEV-Export:** §13b/ig. Erwerb über BU 46/91/94 statt getrennter Steuerzeilen. Lite-DATEV hat für AfA und Kz 106/108/163 kein Konto (Fehlerzeile).
  - **UStVA:** Leistungsdatum ≠ Rechnungsdatum wird nicht ausgewertet.
  - **Pro:** PayPal/Kreditkarte ohne eigenes Geldkonto. Guthaben aus einem Storno lässt sich nicht verrechnen. `reconcileEurToLedger` ist nicht verdrahtet (keine `eur`-Familie in den Report-Mappings).
  - **Entscheidung offen:** DATEV-Export ohne Saldovorträge – für die Erstübergabe als eigener Export anbieten?
  - **Vertragslockerung:** Das Settings-Schema erlaubt jetzt Einzelunternehmer mit doppelter Buchführung (Pro-Bilanz). Lite sperrt das nur in der UI, eine Serversperre würde Alt-Lite-GmbH-Profile vom Speichern aussperren.

## Buchungslogik-Audit 23.10.2026 (nur Bericht, kein Code geändert)

Bericht: `~/billme-booking-audit-2026-10-23/REPORT.md` (Teilberichte 1–6 mit file:line daneben). Bestehende Buchungstests grün (430 + 9 + 56), decken die Befunde aber nicht ab.

- Urteil Lite: nach kurzer Fixliste veröffentlichbar. Blocker: 10-Tage-Regel lässt verschobene Posten aus beiden EÜR-Jahren fallen (`server-data/postgres/eurReport.ts:432` reicht Zahlungsdatum, `calculateEurRows` filtert auf Jahr). Vor Release: Festschreibung sperrt Import/Rollback/Klassifikation/Belege nicht (Text sagt „GoBD“), keine Kategorien Geldtransit/Privat, Rückzahlung/Bareinzahlung nicht verknüpfbar, PayPal-Gebühr fehlt.
- Urteil Pro: nicht als vollwertige Buchhaltung veröffentlichbar. Blocker: Zahlungen über `/invoices/:id/payments` und Bank-Link setzen „bezahlt“ ohne Journal/OPOS; Pro-Perioden nie sperrbar (nur Lite setzt `closed`; UI hat `closedPeriodsBefore: '2026-01-01'` fest); Berichte zählen fiscal_close/carry_forward mit; UStVA-Kennziffern sind Laufnummern; §13b-Eingang nicht buchbar; Import-Rollback löscht gebuchte `bank_transactions`; Zahlungen nicht stornier-/umbuchbar; kein Geldtransit, keine freie Buchung.
- Falsche Defaults: `output_vat_deferred` SKR03 1780 (= USt-Vorauszahlungen, richtig 1765), SKR04 3810 (7 %, richtig 3815) in `proAccountingRepository.ts:293`.
- Reihenfolge-Vorschlag steht in REPORT.md Abschnitt 6.

## Ladezeiten mit großem Datenbestand 19.10.2026 (nicht committet)

Gemessen mit einem Lite-Profil mit 1500 Rechnungen, 300 Angeboten, 60 Kunden und 80 Artikeln (`~/billme-perf-2026-10-19/data-bench.mjs seed|measure <userDataDir>`, Main-Profil `data/prof-main.mjs`, Renderer-Profil `data/prof-renderer.mjs`, Auswertung `data/summarize.mjs`; Seed-Profil liegt unter `/tmp/bp-lite-seed`, das Anlegen dauert ~6 min).

| | vorher | nachher |
|---|---|---|
| Start bis alle Dashboard-Daten da sind | App friert ein (Main-Thread > 3 min voll, Seite reagiert nicht) | ~4,5 s |
| `GET /invoices` (1500 Stück) | 1500 × komplettes Audit-Log (3461 Zeilen inkl. JSON) | 1 Abfrage, ~0,5 s |
| Belegliste öffnen, längste Renderer-Blockade | 2541 ms | 172 ms |
| Dashboard, längste Renderer-Blockade | 390 ms | 160 ms |

- `server-data/postgres/audit.ts` `listBySubject`: filterte Entität und ID in JS über das ganze Audit-Log des Mandanten. Jetzt in SQL (Index `idx_audit_entity` existiert seit 0000).
- `server-runtime/auditHistory.ts`: `withInvoiceHistories`/`withOfferHistories` lesen die Historie aller Belege mit einer Abfrage (nur `entity_id, ts, action, reason`). Die Listenrouten in `app.ts` nutzen sie; Einzelabrufe unverändert. Integrationsfall: `invoices.test.ts` „the list carries each document's own history, the same as the single read“.
- `server-data/postgres/eurReport.ts`: Vorschlag „Bisherige Zuordnung dieses Geschäftspartners“ war O(n²) (je Posten alle Posten mit `toLocaleLowerCase`); jetzt eine vorab gebaute Map.
- `desktop-renderer/ui/shell/dashboardFlows.ts`: Dashboard holte `eur/items` desselben Jahres dreimal; jetzt `fetchQuery` mit dem Key `['eur','items',year]` der EÜR-Ansicht.
- `InvoicesView.tsx`: Liste rendert 100 Zeilen, „Weitere anzeigen“ legt 500 nach; Suche, Filter, Sortierung und „alle auswählen“ gelten weiter für alle. Neuer Filter/Suche setzt auf 100 zurück. E2E: `tests/e2e/desktop/document-list-paging.spec.mjs`.
- `Intl.NumberFormat`/`DateTimeFormat` werden einmal gebaut (`desktop-utils/formatters.ts`, `InvoicesView.tsx`); ungültige Daten liefern wie vorher „Invalid Date“ statt zu werfen.
- Prüfstand: Integration invoices/offers/reports 376/376, server-mode/transactions/chain/pro-reporting/automation 417/417, server-data audit/eurReport grün. Typecheck desktop, pro-desktop, web, web-pro, server-api, server-data, integration-tests grün. Desktop-E2E (alle Lite- und Pro-Specs, `playwright.audit.config.mjs`) 89/100 inkl. neuem Paging-Spec; die 11 roten sind dieselben wie vor diesem Durchgang (9× §19-Seed „Kleinunternehmerregelung … nicht aktiv“ in `pro-main-flows`/`outgoing-document-chain`, `datev-lite` Strict-Mode, `settings-and-eur` GmbH-Fall). Server-Mode-Docker-E2E nicht gelaufen.
- Offen: `GET reports/vat` (Lite-Dashboard) braucht bei 1500 Rechnungen ~0,75 s, weil alle Rechnungen geladen und per Zod geparst werden. Vorfiltern nach Datum ist bei Ist-Versteuerung/Anzahlungen riskant, deshalb nicht gemacht. `eur/items` ~0,5 s. Kundenliste und Artikelliste rendern weiter alle Zeilen (bei 60/80 unkritisch). Nächster großer Hebel bleibt PGlite im `utilityProcess`.
- Das Anlegen ist langsam: ~220 ms pro Rechnung (reserve + 2× upsert + Zahlung), nicht untersucht.

## Startzeit-Durchgang 19.10.2026 (nicht committet)

Gemessen mit `~/billme-perf-2026-10-19/measure.mjs` (gebaute Apps unter xvfb, eigenes userData, Lauf 0 = Erststart, Läufe 1–5 warm; `patch-html.sh` setzt vorher eine Nav-Sonde in `dist/renderer/index.html`, weil Playwright-Zeiten am blockierten Main-Thread hängen). Rohdaten `base-*.json` / `after-*.json` daneben.

| | Shell sichtbar, Erststart | Shell sichtbar, warm (Median) |
|---|---|---|
| Lite vorher → nachher | 3569 → 1106 ms | 1325 → 972 ms |
| Pro vorher → nachher | 3545 → 782 ms | 1350 → 952 ms |

Daten auf dem Dashboard warm weiterhin ~1,3 s: PGlite öffnen (~250 ms, Erststart initdb ~2,2 s) + buildApi (~75 ms) laufen synchron im Electron-Main-Thread.

- `desktopMain.ts`: erst Fenster laden, dann Backend booten. Parallel bringt nichts, PGlite blockiert den Main-Thread und damit auch das Laden des Fensters. Der Handshake `embedded:connection` wartet jetzt auf ein `backendReady`-Promise, weil der Preload die erste Antwort für die ganze Sitzung cached (vorher hätte ein früher Renderer `null` gecached). `enableCompileCache()` spart ~60 ms beim Import des 4-MB-Backend-Chunks.
- Renderer minifiziert (`minify: true` in beiden `electron.vite.config.ts`; electron-vite lässt den Renderer sonst unminifiziert). Lite-Startbundle 2,5 MB → 742 KB.
- Routen außer Dashboard/Belege/Vorlagen per `lazyRouteComponent` (beide Router), Beleg- und Vorlageneditor per `React.lazy` in `AppPages.tsx`, Pro-Buchhaltung per `React.lazy`. Web-Shells erben das (Lite-Web-App-Chunk 737 → 368 KB).
- Lite-`index.tsx` importiert `App` statisch (wie Pro schon): ein `import()` hängt hinter dem PGlite-Boot.
- `tests/e2e/support.mjs`: `seedDesktopData` lädt am Ende neu. Der Renderer fragt die Einstellungen jetzt vor dem Seed ab und cached das leere Profil (sonst Onboarding-Dialog über `/settings`).
- Prüfstand: Typecheck desktop/pro-desktop/web/web-pro grün. Desktop-E2E (alle Lite- und Pro-Specs, `playwright.audit.config.mjs`) 88/99. Die 11 roten sind ohne den Patch genauso rot (Gegenprobe mit `git apply -R ~/billme-perf-2026-10-19/perf-final.patch`): `datev-lite`, `settings-and-eur:69`, `outgoing-document-chain`, 8× `pro-main-flows` (§19-Seed: „Kleinunternehmerregelung … nicht aktiv“). Server-Mode-E2E nicht gelaufen.
- Nächster großer Hebel, nicht gemacht: PGlite/Fastify in einen `utilityProcess`/Worker verlagern. Braucht RPC für `desktopIntegration` (Secrets, PDF-Export).

Stand 13.10.2026, Branch `refactor/slim-architecture`. Lite-Audit, nicht committet.

## Erledigt (dieser Stand)

- **Bug behoben:** Abgelaufene, angenommene und abgelehnte Angebote ließen sich nicht drucken bzw. als PDF exportieren. `documentRenderContextSchema.document` erlaubte nur Rechnungsstatus (`packages/desktop-contracts/src/schemas.ts`). Betraf Lite, Pro, beide Web-Shells und das Server-PDF. Integrationsfall: `offers.test.ts` → „expired, accepted and declined offers still print“ (ohne Fix rot).
- **Lite bleibt EÜR:** In den Lite-Einstellungen ließen sich „GmbH“ und „Doppelte Buchführung“ wählen, dann erschien der SKR03-Kontenrahmen. Lite hat kein Hauptbuch. Jetzt ist das nur noch in Pro wählbar (`SettingsView.tsx`), und Lite zeigt nie einen Kontenrahmen. Ein bestehendes Lite-Profil mit GmbH/doppelter Buchführung bekommt einen Hinweis und kommt über die Rechtsform „Einzelunternehmen“ zurück zur EÜR. Das Backend lehnt Einzelunternehmen mit doppelter Buchführung ohnehin ab. E2E: `settings-and-eur.spec.mjs`, zwei Fälle.
- **Veraltete E2E angepasst:**
  - `article-vat`: erst den §19-Seed anlegen, danach Regelsteuer setzen.
  - `document-actions`: Nach einer Gutschrift wird kein Storno-Button mehr angezeigt. Die Ablehnung durch das Backend prüft der Test jetzt per IPC.

## Prüfstand

- Integration (Billing-Suiten, Lite und Pro): 755/755. Erneut gelaufen: offers, masterdata und server-mode, 393/393.
- Lite-Electron-E2E: 43/43 im Gesamtlauf, danach `settings-and-eur` mit dem GmbH-Fall 4/4. Pro-Smoke: 1/1 (`playwright.audit.config.mjs`, unter xvfb, `ELECTRON_RUN_AS_NODE` vorher entfernen).
- Typecheck: desktop, pro-desktop, web, web-pro.
- Nicht gelaufen: übrige Pro-E2E, Server-Mode-Docker-E2E.
- Release: `pnpm build:server-cli` neu bauen. Das CLI-Bundle enthält noch das alte Render-Kontext-Schema.
- Abdeckungslücke: Die Lite-Auftragskette (Angebot → AB → Lieferschein → Abschlag/Schluss) ist nur in der Integration geprüft, es gibt keinen Lite-UI-Spec dafür.

## Vereinfachte Konten in Lite

Lite zeigt 22 Klartext-Kategorien statt Kontonummern (`desktop-renderer/src/components/eur/categories.ts`). Intern sind sie den Anlage-EÜR-Kennziffern zugeordnet (Katalog 2025/2026 in `desktop-services/src/eur`). Über „Weitere Kategorien anzeigen“ erscheinen alle übrigen Zeilen mit dem amtlichen Wortlaut. Soll/Haben und SKR erscheinen in Lite nur noch im Pro-Zweig.

## Offene Entscheidungen

- Kz neben dem Kategorienamen in Lite anzeigen, z. B. „Software und IT (Kz 228)“? Das hilft beim Abtippen der Anlage EÜR. Pro macht das bereits (`EurView.tsx` ~833).
- Amtliche Labels im JSON-Katalog enthalten ASCII-Umlaute („fuer“).
- Eigene Kategorien/Unterkategorien (z. B. „Software“ → Kz 228) für Lite?

## Lücken zu sevDesk / Lexware Office (priorisiert)

1. E-Rechnungen empfangen: XRechnung/ZUGFeRD einlesen und anzeigen. Seit 01.01.2025 Pflicht für B2B-Empfang. Fehlt komplett, XML wird nur abgelegt.
2. Reine XRechnung (UBL/CII ohne PDF) erzeugen, für Behörden/Leitweg-ID. Bisher nur ZUGFeRD.
3. DATEV-Export für den Steuerberater in Lite (Belege + EÜR-Buchungsstapel). Bisher nur Pro.
4. Bankanbindung live (FinTS/PSD2). Bisher nur CSV.
5. Belegerfassung mit OCR/Upload-Inbox, Lieferanten als Kontakte, Eingangsrechnungen mit Fälligkeit.
6. Beleg duplizieren / als Vorlage, Kunden- und Artikel-CSV-Import, mehrere Ansprechpartner.
7. Zahlungslinks (Stripe/PayPal/GiroCode-QR auf der Rechnung), UStVA-Übermittlung per ELSTER in Lite.
8. Kleiner: Proforma, Mehrwährung/Englisch, Zeiterfassung.

## Fallen

- Siehe Memory `test-env-pitfalls-2026-10`: `unset ELECTRON_RUN_AS_NODE`, `xvfb-run -a`.
- Der Integrationsrunner ist `node --test`, nicht vitest.
- E2E-Seeds stellen immer §19-Rechnungen aus. Regelsteuer erst danach setzen (`useRegularVat`).

## Umsetzung Lückenliste (ab 13.10.2026, läuft)

User-Auftrag: Punkte 1–3, 6, 7, 8 umsetzen. Briefs: `/tmp/billme-briefs/t1..t9-full.md` (gemeinsame Regeln in `common.md`).
Codex-MCP und T3-`delegate_task` (parent_not_active) gingen nicht → Umsetzung über Claude-Subagenten, sequenziell im selben Checkout, Prüfung (Build + Playwright unter xvfb) durch mich nach jeder Aufgabe.
Neue Abhängigkeiten (von mir installiert): `fast-xml-parser` (desktop-services), `qrcode-generator` (desktop-designer).

| # | Aufgabe | Migration | Stand |
|---|---|---|---|
| T1 | Ansprechpartner, Kunden-/Artikel-CSV-Import, Beleg duplizieren | 0040 | fertig: Integration grün (masterdata 108, invoices 96, migration 16), E2E 30/30 inkl. `masterdata-import-duplicate.spec.mjs`. Offen: Artikel-Import ohne Audit (Artikelrouten haben kein Audit), „z. Hd.“ fehlt bei „Neue Rechnung“ aus der Kundenansicht |
| T2 | E-Rechnung empfangen + XRechnung erzeugen | – | fertig: einvoice.test 42/42, E2E `einvoice-inbox` 2/2 (+finance/settings/delivery grün), XRechnung mit Mustang 2.22.0 lokal valide (Jar: /tmp/mustang). Grenzen: §13b/ig. Erwerb-Eingangsrechnungen werden mit 19 % übernommen (ponytail), gemischte Kategorien/Fremdwährung nicht übernommen |
| T3 | DATEV-Export Lite | – | läuft |
| T4 | GiroCode + Zahllink | – | offen |
| T5 | Zeiterfassung | 0041 | offen |
| T6 | Proformarechnung | – | offen |
| T7 | Belegsprache Englisch | 0042 | offen |
| T8 | Fremdwährung | 0043 | offen |
| T9 | UStVA per ELSTER in Lite (nur mit installiertem ERiC) | – | offen |

Bewusste Grenzen: Stripe-API-Integration nicht gebaut (Zahllink-Vorlage deckt Stripe/PayPal-Links ab); ELSTER sendet nur mit ERiC-Binary + Zertifikat; Englisch nur für Belege, nicht für die App-Oberfläche.

---

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
