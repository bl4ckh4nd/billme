# Abschlussreport Buchungspipeline

**Stand:** 12.08.2026 · **Basis:** Branch `fix/accounting-pipeline-hardening`, HEAD `9ea21d2`

Dieser Report beschreibt den technischen Stand der Pro-Buchungspipeline auf dem
oben genannten Stand. Er ist keine steuerliche oder rechtliche Beratung und
keine Aussage über eine gesetzliche, GoBD-, EN-16931- oder DATEV-Zertifizierung.
Produktivdeployment war nicht Teil des Auftrags.

## Ergebnis in einem Satz

Die lokale Pro-Buchungskette ist an den zentralen Stellen von Entwurf über
Journal, OPOS, Anlagen, Reports und DATEV-Evidenz gehärtet; die Server-/Web-
Variante besitzt die wesentlichen Postgres-, API- und Authentifizierungsseams,
ist für die vollständige produktive Accounting-UI aber noch vor Abschluss zu
bestätigen.

## Ist-Topologie und State Ownership

| Oberfläche | Persistenz und Wahrheit | Zugriffsweg | Konsequenz |
|---|---|---|---|
| Pro Desktop | Lokales SQLite in [`apps/pro-desktop/db/schema.ts`](../apps/pro-desktop/db/schema.ts), Migrationen in [`apps/pro-desktop/db/migrate.ts`](../apps/pro-desktop/db/migrate.ts) | Repository-/Service-Seams wie [`proAccountingRepo.ts`](../apps/pro-desktop/db/proAccountingRepo.ts) und [`oposRepo.ts`](../apps/pro-desktop/db/oposRepo.ts); Renderer über typisierte Pro-IPC-Verträge | SQLite ist für diese Installation die Buchhaltungswahrheit. Gebuchte Dokumente und Journale werden nicht aus UI-Zustand rekonstruiert. |
| Pro Server Mode | Tenant-scoped Postgres in [`packages/server-data/src/postgres/schema.ts`](../packages/server-data/src/postgres/schema.ts); inkrementelle Drizzle-Migrationen in [`packages/server-data/drizzle/`](../packages/server-data/drizzle/) | [`proAccountingRepository.ts`](../packages/server-data/src/postgres/proAccountingRepository.ts), [`proAccounting.ts`](../packages/server-data/src/postgres/proAccounting.ts), Fastify in [`apps/server-api/src/app.ts`](../apps/server-api/src/app.ts) | Postgres ist die Serverwahrheit. Tenant- und Produktscope werden an API und Repository erneut geprüft. |
| Pro Desktop Renderer | Temporärer Query-/Adapterzustand in [`apps/pro-desktop/components/ProAccountingPage.tsx`](../apps/pro-desktop/components/ProAccountingPage.tsx) | [`@billme/desktop-contracts-pro`](../packages/desktop-contracts-pro/) und [`ipcHandlers.ts`](../apps/pro-desktop/electron/ipcHandlers.ts) | UI darf laden, validieren und Aktionen auslösen, ist aber nicht die Persistenz. Schreibfehler und Busy-/Audit-Feedback bleiben an der Adaptergrenze sichtbar. |
| Pro Browser | HTTP-Client und Session in [`apps/web-pro/src/api.ts`](../apps/web-pro/src/api.ts) und [`apps/web-pro/src/App.tsx`](../apps/web-pro/src/App.tsx) | API-Responses werden in den Shared Workspace hydriert | Der Browser greift nicht auf SQLite zu. Der aktuell verdrahtete Seed-/Workflow-Pfad ist nicht gleichbedeutend mit einer vollständigen serverseitigen Reports-/Anlagen-UI; dieser Rest ist vor Abschluss zu bestätigen. |
| Öffentliche Portale | Snapshot-/Entscheidungsdaten im Offer Portal | [`apps/offer-portal/`](../apps/offer-portal/) | Portalzustand ist niemals Buchhaltungswahrheit; Desktop bzw. Postgres bleiben Quelle. |

Damit sind die vier Invarianten klar: Wahrheit liegt in SQLite oder Postgres,
Feedback an IPC/API/UI-Grenzen, Buchungs- und Migrationsänderungen haben einen
begrenzten Repository-Blast-Radius, und Reihenfolge wird durch Transaktionen,
Idempotenzschlüssel, Reservierungen und Journalstatus kontrolliert.

## Positive Ausgangslage

- Ein gemeinsames Domänenmodell für Journal, Workflow, Ledger, Steuern und OPOS
  liegt in [`packages/accounting-shared/src/`](../packages/accounting-shared/src/);
  Posting- und AfA-Regeln sind in [`packages/accounting-engine/src/`](../packages/accounting-engine/src/) gebündelt.
- Desktop und Server haben getrennte, sichtbare Persistenzadapter. Neue
  Buchungsdaten werden nicht als untypisierte UI- oder IPC-Seiteneffekte
  gespeichert.
- Das Datenmodell deckt Journalzeilen und Posting-Paare, offene Posten,
  Eingangsrechnungen, Reportsnapshots, DATEV-Exporte sowie Anlagenbewegungen ab.
- Die wesentlichen Mutationen laufen transaktional und wiederholbar. Bereits
  gebuchte Quellen können nicht still überschrieben werden; Storno ist ein
  eigener Journalvorgang.
- Die CI enthält neben Typchecks, Pakettests und Desktop-E2E nun ein separates
  Full-Pro-Gate für den Server-Modus (siehe [`ci.yml`](../.github/workflows/ci.yml)).

## Behobene Risiken nach Bereich

### Ledger und Journal

**Status: im lokalen Pro-Pfad behoben; Server-End-to-End noch gesondert zu bestätigen.**

- [`postingService.ts`](../packages/accounting-engine/src/postingService.ts)
  validiert ausgeglichene Soll-/Haben-Zeilen und erzeugt gebuchte Einträge nur
  aus validierten Entwürfen.
- [`ledgerService.ts`](../packages/accounting-engine/src/ledgerService.ts) und
  [`proAccountingRepo.ts`](../apps/pro-desktop/db/proAccountingRepo.ts) bilden
  Salden, Journalabfragen, Reversal und Berichte aus persistierten Journalzeilen.
- Source-Identität, Idempotenzschlüssel, native Transaktionskennungen und
  Posting-Paare verhindern Doppelbuchungen und verdeckte Fremdquellen. Der
  Server nutzt dafür ebenfalls Transaktionen und tenant-scoped Sperren in
  [`proAccountingRepository.ts`](../packages/server-data/src/postgres/proAccountingRepository.ts).
- Gebuchte Entwürfe und Projektionen sind read-only; Korrekturen erfolgen als
  explizites Storno beziehungsweise neuer Buchungsvorgang.

### OPOS, Ist-USt und Eingangsrechnungen

**Status: Desktop-Pfad gehärtet; laufender Server-/OPOS-Abschluss vor Abschluss zu bestätigen.**

- [`oposRepo.ts`](../apps/pro-desktop/db/oposRepo.ts) trennt Ausgangs- und
  Eingangsrechnungen, Debitoren-/Kreditorenposten, Zahlungen und
  Allokationen. Teilzahlungen, Restbeträge und Überzahlungen werden atomar
  begrenzt; ein Posten wird nicht durch einen UI-Refresh als bezahlt markiert.
- Ist-USt entsteht nur aus tatsächlich zugeordneten Zahlungen. Nicht
  zugeordnete Beträge und Überzahlungen werden nicht erneut als Umsatzsteuer
  angesetzt; aufgeschobene Umsatzsteuer und kontenplanspezifische Mappings
  bleiben explizit.
- Eingangsrechnungszeilen tragen ihre Kosten-/Anlagenkonten und Steuersätze in
  den Buchungssnapshot. Mehrere Steuersätze werden als getrennte Basen gebucht.
- Reservation/Finalisierung, Soft-Lock-Override mit Begründung und der
  Schutz bereits gebuchter Projektionen schließen die bekannten Reihenfolge-
  und Überschreibungsrisiken.
- Für den Server sind die OPOS-Struktur und Härtung in [`0006_server_data_opos.sql`](../packages/server-data/drizzle/0006_server_data_opos.sql), [`0007_server_data_opos_hardening.sql`](../packages/server-data/drizzle/0007_server_data_opos_hardening.sql) und dem Postgres-Repository vorhanden. Die vollständige Browser-/Postgres-Buchungskette bleibt ein Abschlussgate.

### DATEV

**Status: technische Export- und Evidenzkette vorhanden; Kanzlei-Akzeptanz offen.**

- [`datevExport.ts`](../apps/pro-desktop/services/datevExport.ts) erzeugt
  monatliche Buchungsstapel aus dem Journal und validiert Zeitraum, Berater-,
  Mandanten- und Kontenlänge.
- Der Export speichert Metadaten, Hash/Größe, Zeichensatz und Quell-Snapshot;
  der Exportverlauf ist unveränderlich. Die UI liegt in
  [`DatevExportPanel.tsx`](../packages/accounting-ui-pro/src/components/reports/DatevExportPanel.tsx).
- DATEV-Steuerschlüssel und Evidenzreferenzen kommen aus dem Steuerfall-/Mapping-
  Modell; SQLite- und Postgres-Migrationsfelder werden gemeinsam geführt.
- **Externer Restgate:** Eine DATEV-Kanzlei muss repräsentative Exporte in ihrer
  Importumgebung akzeptieren. Das ist nicht durch Pakettests oder diesen Report
  ersetzt und keine DATEV-Zertifizierung.

### Reports und Drilldowns

**Status: lokaler Desktop nutzt Produktionsadapter; Browser-Reports vor Abschluss zu bestätigen.**

- SuSa, GuV und Bilanz werden im Desktop aus Journal-/Kontodaten gelesen
  ([`getSusaReport`](../apps/pro-desktop/db/proAccountingRepo.ts),
  [`reportAdapters.ts`](../apps/pro-desktop/components/reportAdapters.ts)).
- Reportzeilen bewahren Quelle und Mapping-Identität; Drilldowns führen zu
  Banktransaktion, Ausgangs-/Eingangsrechnung oder Journal statt zu einer
  losgelösten Demo-Zeile. Die gemeinsame Oberfläche liegt in
  [`ReportsView.tsx`](../packages/accounting-ui-pro/src/components/ReportsView.tsx)
  und [`ReportDrilldownPanel.tsx`](../packages/accounting-ui-pro/src/components/reports/ReportDrilldownPanel.tsx).
- Die Anzeige markiert Live- und Beispieldaten. Im aktuellen Browser-Mount wird
  der Workspace seed-basiert ohne produktiven Reports-/Anlagen-Adapter geladen;
  [`mockReportService.ts`](../packages/accounting-ui-pro/src/services/mockReportService.ts)
  und der fallback in [`AssetManagementView.tsx`](../packages/accounting-ui-pro/src/components/AssetManagementView.tsx)
  bleiben deshalb ein explizites Restgate und dürfen nicht als Postgres-Reports
  ausgegeben werden.

### Anlagen, AfA und Abgang

**Status: lokale Buchungs- und Reparaturpfade vorhanden; Server-/Web-Abnahme offen.**

- [`depreciation.ts`](../packages/accounting-engine/src/depreciation.ts) deckt
  lineare AfA, GWG, Pool, Rundung und Abgang mit Restbuchwert/Gewinn/Verlust ab.
- [`assetsRepo.ts`](../apps/pro-desktop/db/assetsRepo.ts) schreibt
  Aktivierung, AfA-Plan, Bewegungen und Abgang zusammen mit Journal- und
  Source-Identität. Fehlerfälle bleiben reparierbar statt halb gebucht.
- Die UI verlangt einen Änderungsgrund und zeigt Schedule-/Buchungsstatus;
  der Adapter in [`ProAccountingPage.tsx`](../apps/pro-desktop/components/ProAccountingPage.tsx)
  bindet die produktiven IPC-Methoden.
- Postgres-Schema, additive Migration und SQLite-Import führen die
  Aktivierungs-/AfA-/Abgangsprovenienz weiter (siehe
  [`0008_server_data_asset_accounting.sql`](../packages/server-data/drizzle/0008_server_data_asset_accounting.sql)
  und [`importDesktop.ts`](../packages/server-data/src/postgres/importDesktop.ts)).

### Import und EÜR

**Status: Desktop-Import/EÜR und Migrationsbrücke vorhanden; produktiver Server-Abschluss offen.**

- [`financeImportRepo.ts`](../apps/pro-desktop/db/financeImportRepo.ts) hält
  Importbatch, Dedup-Identität, Rollback-/Tombstone-Regeln und die Verbindung
  zwischen Kompatibilitäts- und Bankzeile zusammen.
- Legacy-Konflikte werden vor dem Schreiben erkannt und quarantänisiert, statt
  eine fremde Quelle global zu löschen. EÜR-Katalog, Regeln, Klassifikation,
  Vorschläge und Bericht liegen in [`apps/pro-desktop/services/`](../apps/pro-desktop/services/)
  und den zugehörigen Repositories.
- [`importDesktop.ts`](../packages/server-data/src/postgres/importDesktop.ts)
  importiert die accounting-relevanten SQLite-Tabellen tenant-scoped nach
  Postgres und prüft unbekannte befüllte Tabellen; die Migrationsabdeckung ist
  durch Tests gegen das Journal abgesichert.

### UI/UX und Feedback

**Status: lokale Accounting-UI produktiv verdrahtet; Browser-/Server-Interaktionen offen.**

- Inbox, Buchungseditor, Abgleich, Exceptions, Reports und Anlagen verwenden
  den typisierten [`ProAccountingDataAdapter`](../packages/accounting-ui-pro/src/services/mockBookingStore.ts).
  Der Desktop liefert hierfür echte IPC-/Repository-Funktionen.
- Lade-, Fehler- und Schreibzustände werden am Workspace angezeigt; gebuchte
  oder serverseitig read-only gelieferte Daten bieten keine irreführenden
  Mutationsbuttons. Audit-Gründe sind bei mutierenden Accounting-Aktionen
  sichtbar und erforderlich.
- Die Shared UI enthält weiterhin Mock-Fallbacks für Demo/Tests. Das ist eine
  bewusst sichtbare Rückfallstrecke, aber keine produktive Datenquelle.

### Server und Web

**Status: technische Basis vorhanden; vollständige Pro-Accounting-Webabnahme offen.**

- [`apps/server-api/src/app.ts`](../apps/server-api/src/app.ts) registriert
  Pro-Auth, Accounting-Katalog-/Workflow-Seams und typisierte Fehler-/API-
  Grenzen; das umfassendere Postgres-Accounting-Repository liegt in
  [`packages/server-data/src/postgres/proAccountingRepository.ts`](../packages/server-data/src/postgres/proAccountingRepository.ts),
  ist aber noch nicht vollständig als Web-Buchungsoberfläche exponiert.
  [`apps/web-pro/src/api.ts`](../apps/web-pro/src/api.ts) validiert
  Antworten und hält die Session nicht als Buchhaltungswahrheit.
- Das Postgres-Repository deckt Journal, Konten, Entwürfe, OPOS, Eingangs-
  rechnungen, Reports, DATEV-Evidenz und Importdaten ab; Anlagenprovenienz ist
  im Schema/Import vorhanden, ein vollständiger produktiver Asset-Mutationspfad
  ist im Web noch nicht exponiert.
- Der Pro-Browser hat Auth-/Route-/Seed-/Workflow-Nachweise. Eine vollständige
  Reports-/Anlagen-/OPOS-Buchungsfahrt mit Postgres und Browser ist lokal noch
  nicht bestätigt und muss vor einem Abschlussbefund erneut geprüft werden.

### Audit und Security

**Status: Accounting-Mutationen technisch abgesichert; kein pauschaler Audit-Claim für jede Serverroute.**

- Desktop-Audit und SQLite-Trigger liegen in [`apps/pro-desktop/db/audit.ts`](../apps/pro-desktop/db/audit.ts)
  und [`apps/pro-desktop/db/schema.ts`](../apps/pro-desktop/db/schema.ts). Gründe,
  Actor-/Source-Identität und Vorher-/Nachher-Snapshots werden für relevante
  Accounting-Mutationen geführt.
- Server-Audit verwendet eine tenant-scoped Hash-Kette in
  [`packages/server-data/src/postgres/audit.ts`](../packages/server-data/src/postgres/audit.ts);
  Journalposten, Reversals sowie die bereits exponierten Accounting-Mutationen
  schreiben im selben Transaktionskontext. Der noch nicht vollständig exponierte
  Asset-Webpfad ist damit nicht automatisch abgenommen.
- Authentifizierung, Produktgrenzen und Tenant-Scope werden in
  [`apps/server-api/src/auth.ts`](../apps/server-api/src/auth.ts) sowie den
  Repository-Abfragen erzwungen. Das verhindert keinen fachlichen Fehlentscheid
  und ersetzt keine externe steuerliche Prüfung.

### Migration und CI

**Status: inkrementelle Datenpfade und CI-Gate vorhanden.**

- Postgres-Änderungen werden als vollständiges Drizzle-Set aus SQL-Datei,
  Journal und Schema geführt; die Server-Initialisierung prüft, ob das Journal
  aktuell ist. SQLite-Kompatibilität bleibt in den Pro-Migrationen erhalten.
- [`packages/server-data/src/postgres/importDesktop.test.ts`](../packages/server-data/src/postgres/importDesktop.test.ts),
  [`assetsMigration.test.ts`](../packages/server-data/src/postgres/assetsMigration.test.ts)
  und [`rawSqlGuard.test.ts`](../packages/server-data/src/postgres/rawSqlGuard.test.ts)
  schützen Journal, Spiegelfelder und Query-Seams.
- [`ci.yml`](../.github/workflows/ci.yml) führt Pro-Typecheck, Pro-Tests,
  Build, Server-Paketchecks, Server-Smoke und ein eigenes
  `e2e-server-pro-full`-Gate (`pnpm test:e2e:server:full:pro`) aus. Das Gate ist
  ergänzt; sein lokaler Docker-Lauf ist in diesem Auftrag nicht erfolgt.

## Verifikationsmatrix

Die Zahlen beziehen sich auf fokussierte Läufe dieses Branches, nicht auf eine
Freigabe eines Produktivsystems. `skip` bedeutet hier eine von der Testsuite
bewusst übersprungene echte Postgres-Prüfung ohne `DATABASE_URL` bzw.
`BILLME_TEST_DATABASE_URL`.

| Scope | Nachweis | Ergebnis |
|---|---|---:|
| [`packages/accounting-engine/src/depreciation.test.ts`](../packages/accounting-engine/src/depreciation.test.ts) | Node-Testlauf der AfA-/Abgangsregeln | **5 bestanden** |
| [`packages/accounting-ui-pro`](../packages/accounting-ui-pro/) | Vitest: alle sechs UI-Testdateien | **20 bestanden / 20** |
| Pro Desktop Accounting-Fokus | Vitest: OPOS (20), Reports (4), Assets (7), DATEV (10), Adapter/Drilldown/Workspace/IPC (15) | **56 bestanden / 56** |
| [`packages/server-data`](../packages/server-data/) | 24 ausgewählte Postgres-/Import-/Audit-/Migrations-Tests | **18 bestanden, 6 übersprungen, 0 fehlgeschlagen** |
| [`packages/server-core`](../packages/server-core/) | Billing-Line-, oRPC-, Tax- und VAT-Validation-Fokus | **23 bestanden / 23** |
| [`apps/server-api`](../apps/server-api/) | App-, Auth-Client- und Session-Secret-Fokus | **17 bestanden / 17** |
| Lokaler Docker Full-Pro-Server-E2E | `pnpm test:e2e:server:full:pro` | **nicht ausgeführt**; CI-Gate in [`ci.yml`](../.github/workflows/ci.yml) ergänzt |
| Produktivdeployment | Deployment-/Live-Smoke-Nachweis | **nicht Bestandteil dieses Auftrags** |

## Externe und abschließende Gates

1. Steuerliche und rechtliche Beratung muss die verwendeten Steuerfälle,
   Ist-USt-Logik, Aufwands-/Anlagenkonten, Perioden- und Stornoregeln fachlich
   prüfen. Dieser Report ist keine Beratung.
2. Eine DATEV-Kanzlei muss mindestens einen repräsentativen Export importieren
   und fachlich abnehmen. Paket- und Format-Tests beweisen keine Akzeptanz.
3. Der lokale Docker Full-Pro-E2E-Lauf gegen Postgres ist derzeit offen. Das
   zugehörige CI-Gate ist vorhanden, aber ein grünes CI-Ergebnis liegt in diesem
   Arbeitsauftrag nicht vor.
4. Die laufenden OPOS-/Server-Slices (insbesondere vollständige Browser-
   Reports, Anlagen, OPOS-Buchung und Persistenz-Rücklesen) sind **vor Abschluss
   zu bestätigen** und dürfen bis dahin nicht als vollständig produktiv
   bezeichnet werden.
5. Ein Produktivdeployment, Live-Container-SHA und Produktions-Smoke wurden
   nicht durchgeführt und sind nicht Teil dieses Reports.
