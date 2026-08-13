# Abschlussreport Buchungspipeline

**Stand:** 13.08.2026 · **Codebasis:** Branch
`fix/accounting-pipeline-hardening`, aktueller Code-HEAD vor dieser
Dokumentaktualisierung `a66353d` (`test: fix Pro soft-lock E2E fixture`). Alle
nach a66353d folgenden Änderungen bis zum aktuellen Report-HEAD betreffen
ausschließlich dieses Dokument und ändern keinen Produktcode.

Dieser Report bewertet den technischen Stand der Pro-Buchungspipeline nach der
Umsetzung. Er ist keine steuerliche oder rechtliche Beratung und keine GoBD-,
EN-16931- oder DATEV-Zertifizierung. Ein Produktivdeployment war nicht Teil des
Auftrags.

## Ergebnis

Die geprüften technischen P0/P1-Probleme der Pipeline sind in den unten
genannten Pfaden behoben. Die Buchungskette ist in Pro Desktop und Pro
Server/Web durchgängig verdrahtet: Entwurf und Freigabe, Ausgangs- und
Eingangsrechnungen, doppelte Buchführung, OPOS und Teilzahlungen, Ist-USt,
Storno, Anlagen/AfA/Abgang, SuSa/GuV/Bilanz, DATEV sowie
SQLite-zu-Postgres-Import.

Der abschließende Full-Pro-E2E lief gegen einen frisch migrierten Postgres-Stack
grün. Alle acht Szenarien bestanden; das Artefakt liegt unter
`test-results/server-mode/billme-e2e-msrm1he1-fbwr` und der Stack wurde im
Teardown zerstört. Das EU-B2B-Szenario `EU_B2B_SERVICE_RC` prüft dabei
unbedingt die Persistenz und den DATEV-Export der Felder 40/41/43. Dieser
Nachweis ist eine technische Prüfung des beschriebenen Scopes, keine
Release-, Steuer- oder Deploymentfreigabe.

### Neue Non-Happy-Path-Abdeckung

- Die Server-Suite enthält **20 adversariale Fälle innerhalb der 8/8
  Full-E2E-Szenarien**.
- Die Pro-Desktop-E2E enthält **9 adversariale Fälle innerhalb von 17/17
  Szenarien**.
- Das Reverse-Charge-Szenario bildet die USt-Zusammenfassung mit **genau einer
  Steuerbasis 100,00 / 19,00 USt / 119,00 brutto** ab; eine dreifache
  Zusammenfassung derselben Basis wird verhindert.
- Die E2E deckt einen echten Soft-Lock-Lauf, exakte OPOS-Überzahlung sowie
  belastbare BWA-/USt-Assertions ab, nicht nur HTTP-Erreichbarkeit.

## Berichtsprofile und Kataloge

Die Profile sind fachlich getrennt und werden nicht aus einem beliebigen
generischen GuV-Ergebnis abgeleitet:

| Profil | Verfügbare Auswertungen | Bewusste Grenze |
|---|---|---|
| Einzelunternehmen · EÜR | native EÜR 2025, SuSa, BWA01, Management-GuV | keine HGB-Bilanz und keine HGB-GKV |
| GmbH · micro/small · Doppik | SuSa, BWA01, Management-GuV, HGB-GuV nach GKV, HGB-Bilanz | keine EÜR |

Die Kataloge sind explizit und unveränderlich versioniert:

| Kategorie | Kanonischer Umfang |
|---|---|
| EÜR | **107** kanonische Zeilen für 2025; Kz **290/293/219** sind `signed computed`, also vorzeichenbehaftete berechnete Kennzahlen und keine frei editierbaren Summen |
| BWA01 | exakt **29** Positionen; betriebswirtschaftliche Orientierungsstruktur, keine gesetzliche Bilanz oder Steuerform ([BMWi/BMWK-Existenzgründungsportal](https://www.existenzgruendungsportal.de/Redaktion/DE/Downloads/DE/GruenderZeiten/GruenderZeiten-23.pdf?__blob=publicationFile), [BWA-Checkliste](https://www.existenzgruendungsportal.de/Redaktion/DE/Downloads/DE/Checklisten-Uebersichten/Controlling/06-check-Betriebswirtschaftliche-Auswertung.pdf?__blob=publicationFile)) |
| Management-GuV | exakt **11** interne Steuerungspositionen |
| HGB-GuV | **17** GKV-Gruppen einschließlich der gesetzlich vorgesehenen a/b-Untergliederungen nach [§ 275 HGB](https://www.gesetze-im-internet.de/hgb/__275.html) |
| HGB-Bilanz | micro: Mindestgliederung **A–E**; small: Buchstaben und römische Ziffern nach [§ 266 HGB](https://www.gesetze-im-internet.de/hgb/__266.html) |

Für BWA01, Management-GuV, HGB-GKV und HGB-Bilanz existieren getrennte
Katalogsnapshots für **2025 und 2026**. Ein Aufruf für **2027** schlägt mit
`PUBLIC_REPORT_CATALOG_UNAVAILABLE` fehl; es gibt keinen stillen Fallback. Die
EÜR bleibt bewusst auf den fest definierten **2025**-Katalog beschränkt. Die
amtliche Referenz ist die [BMF-Anlage EÜR 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.html),
nicht der interne Katalog allein.

Positionsbasierte Reports verlangen für jedes relevante Konto ein explizites,
zum Berichtsdatum gültiges Mapping. Fehlende, mehrdeutige oder nicht zum
Katalog passende Mappings blockieren den Report (fail closed); Konten werden
nicht geraten, abgeschnitten oder aus einem Mock-/Legacy-Report übernommen.
Die **SuSa ist mapping-unabhängig** und basiert ausschließlich auf den
Kontensalden sowie Soll-/Haben-Umsätzen.

Mehrjährige Bilanzberechnungen trennen das laufende Ergebnis vom
Gewinn-/Verlustvortrag. Eine nicht auflösbare Micro-Bilanz-Mehrdeutigkeit oder
eine unausgeglichene Bilanz wird ebenfalls fail closed statt durch eine
implizite Ergebnisbuchung scheinbar ausgeglichen.

## State Ownership und Invarianten

| Oberfläche | Buchhaltungswahrheit | Zugriff |
|---|---|---|
| Pro Desktop | Lokales SQLite | Repository/Facade, typisierte Pro-IPC-Verträge |
| Pro Server Mode | Tenant-scoped Postgres | Fastify-Routen, Accounting-Services und Postgres-Repositories |
| Desktop-/Web-UI | Nur temporärer Query-/Formularzustand | Typisierte Adapter; kein UI-Zustand rekonstruiert Buchungen |
| Offer Portal | Veröffentlichte Snapshots | Keine Buchhaltungswahrheit |

Die Kerninvarianten sind damit explizit:

- Gebuchte Dokumente, Journale, Posting-Paare, OPOS-Zuordnungen und
  Anlagenbewegungen gehören derselben transaktionalen Persistenzgrenze.
- Nummernreservierung und Dokumentfinalisierung gehen dem Posting voraus.
- Wiederholte Mutationen nutzen stabile Idempotenzschlüssel; Überallokation
  und doppelte Buchungen werden blockiert.
- Storno ist ein eigener Journalvorgang. Aggregat-eigene Journalzeilen werden
  nicht über einen generischen Storno-Endpunkt von ihrem Dokument, OPOS oder
  Anlagezustand getrennt.
- Mutationen benötigen Rolle und Begründung; Audit-Einträge entstehen mit dem
  authentifizierten Actor in derselben Transaktion.
- Tenant-scoped Steuerkonten-Mappings übersteuern unveränderliche globale
  Defaults nur innerhalb ihres Mandanten und werden zum Buchungsdatum
  aufgelöst.

## Was jetzt gut ist

### Ledger, Journal und doppelte Buchführung

- Soll/Haben-Ausgleich, gültige Konten, Periodensperren und Steuerfälle werden
  vor dem Posting geprüft.
- Persistierte Posting-Paare sind die DATEV-Quelle; Legacy-Journale werden
  deterministisch ergänzt und nicht still abgeschnitten.
- Gebuchte Entwürfe und virtuelle OPOS-Projektionen sind read-only. Die UI
  bietet bei virtuellen Projektionen keine irreführende Storno-/Korrekturaktion.
- Serialisierbare Postgres-Transaktionen wiederholen ausschließlich die
  retryfähigen SQLSTATEs `40001` und `40P01`, auch wenn der Treiber sie in
  `cause` kapselt.

### Ausgangsrechnungen, Eingangsrechnungen und OPOS

- Ausgangsrechnungen werden nur mit passender finalisierter Nummernreservierung
  gebucht; Backfill besitzt keinen Bypass mehr.
- Eingangsrechnungen können keinen clientseitig gefälschten Accounting-Status
  übernehmen. Mehrere Steuersätze und Anlagenkonten bleiben zeilenweise
  erhalten.
- Teil-, Rest- und Mehrfachzuordnungen prüfen Zahlungsbetrag, Quelle, Partei,
  Banktransaktion und bereits zugeordneten Betrag atomar.
- Der Allocation-Event-Key ist bei Desktop und Web stabil und verpflichtend;
  ein Retry erzeugt keine zweite Zahlung.
- Ist-USt wird anteilig bei Zahlung realisiert. Deferred- und reguläre
  USt-Konten folgen den wirksamen Steuerfall-Mappings.
- Dokumentstatus, offene Posten, Zahlung, Journal und Audit werden gemeinsam
  aktualisiert oder gemeinsam zurückgerollt.

### DATEV und Steuer-Evidenz

- DATEV-Buchungsstapel enthalten persistierte BU-Schlüssel sowie die benötigten
  EU-/OSS-/Reverse-Charge-Felder einschließlich Land, USt-IdNr., Zielsteuersatz
  und Sachverhalt L+L.
- Mapping-Gültigkeit wird zum Buchungsdatum berücksichtigt; ein Storno bewahrt
  die ursprünglichen BU-Daten statt aktuelle Mappings neu zu interpretieren.
- Exporte speichern unveränderliche Bytes, Hash, Zeichensatz, Zeitraum und
  Manifest. Ein erneuter Download liefert exakt den gespeicherten Inhalt.
- Beim Desktop-Import werden historische DATEV-Metadaten und Pfade erhalten,
  nicht jedoch zwingend die früher extern gespeicherten CSV-Bytes. Fehlen diese,
  meldet der Server korrekt `DATEV_EXPORT_CONTENT_UNAVAILABLE` statt einen
  vermeintlich identischen Export zu erfinden.

### Reports

- SuSa trennt Eröffnungswerte und Periodenbewegung; GuV und Bilanz melden
  ungemappte Konten explizit.
- Drilldowns bewahren Quelle, Source-ID, Journal-ID und Berichtszeitraum.
- Desktop und Web lesen Reports aus dem jeweiligen produktiven Journaladapter,
  nicht aus dem Demo-/Mock-Store.

### Anlagen, AfA und Abgang

- Aktivierung, Nutzungsdauer, lineare AfA/GWG/Pool, Buchungsplan, Abgang,
  Restbuchwert und Gewinn/Verlust sind in Desktop und Server transaktional mit
  Journal und Bewegungen verbunden.
- Audit-Snapshots zeigen den tatsächlich persistierten Anlagen- und Planstand.
- Dokumentstorno und generisches Journalstorno blockieren, wenn sonst eine
  aktive Anlage oder deren Bewegungsplan verwaist würde.
- Pro Desktop und Web Pro stellen Anlegen/Aktivieren, AfA-Lauf und Abgang über
  produktive Adapter bereit.

### Import und Migration

- SQLite-Import erhält den Accounting-Status und die Snapshot-/Journal-
  Provenienz gebuchter Ausgangs- und Eingangsrechnungen sowie die Reihenfolge
  ihrer Zeilen.
- Gebuchte Eingangsrechnungen werden beim Import kontrolliert als ungebucht
  gestaged, danach werden Zeilen geladen und erst anschließend der unveränderliche
  Status wiederhergestellt.
- Importläufe sind tenant-sicher, idempotent und behalten einen sichtbaren
  Fehlerstatus. ID-Kollisionen mit fremden Mandanten werden nicht als Erfolg
  gezählt.
- Die Tenant-Advisory-Serialisierung erfolgt vor der Prüfung auf einen leeren
  Zielmandanten. Damit ist die Prüfung nicht mehr ein ungeschütztes
  Check-then-import-Rennen; die Sperre bleibt für den Import atomar bestehen.
- Große Identitätsmengen verwenden Array-Parameter, einschließlich der
  **66.000er-Grenze**, statt eine ungebundene Zahl einzelner Bindings zu
  erzeugen.
- Der unveränderliche globale Katalog mit **2.427 Zeilen** wird beim Import
  validiert. Effective-dated Mappings prüfen Datumsformat, tatsächliche
  Kalenderdaten sowie `valid_from <= valid_to`.
- Tenant-Identität und alle logischen Parent-Referenzen werden geprüft,
  einschließlich der Kundenreferenz von Nummernreservierungen. Fremde
  Mandanten-IDs werden nicht als erfolgreicher Import akzeptiert.
- Der gesamte Import bleibt transaktional: bei einer Kollision, einer
  ungültigen Referenz oder einer Audit-Fehlvalidierung erfolgt atomarer
  Rollback.
- Audit-Sequenzen bleiben `BIGINT`; importierte Audit-Heads und Hashes werden
  tenant-scoped geprüft und fortgeschrieben. Die Hash-Eindeutigkeit gilt pro
  Tenant, nicht fälschlich global.
- Effective-dated Report-Mappings bleiben beim Desktop-zu-Postgres-Import mit
  ihren 2025-/2026-Gültigkeiten erhalten. Generische Legacy-Mappings werden
  separat als Legacy-Provenienz importiert und nicht still in einen
  2025-/2026-Katalog umgedeutet.
- Die additive Postgres-Migrationskette ist vollständig:
  `0006` OPOS, `0007` OPOS-Härtung, `0008` Anlagenbuchhaltung,
  `0009` DATEV-Bytes, `0010` Ausgangsrechnungs-Postingmetadaten,
  `0011` tenant-scoped Steuerkonten-Mappings mit globalem Fallback,
  `0012` Asset-Guard, `0013` Asset-Härtung, `0014` DATEV-Steuer-Evidenz,
  `0015` Reporting/Tax-Submissions, `0016` EÜR-Metadaten, `0017` kanonischer
  107-Zeilen-EÜR-Katalog, `0018` unveränderliche globale Ledger-/Steuerkataloge
  mit **2.427** kanonischen Zeilen und `0019` tenant-scoped Audit-Hash-
  Eindeutigkeit einschließlich Audit-Head-Import.

## UI/UX-Stand

### Positiv

- Der gemeinsame Accounting-Workspace bietet Inbox, Abgleich, Exceptions,
  OPOS/Eingangsrechnungen, Anlagen und Auswertungen einschließlich DATEV.
- Pro Desktop verwendet IPC-Adapter; Web Pro verwendet die Server-API. Beide
  zeigen produktive Daten und fallen bei einem read-only Adapter nicht still
  auf lokale Mock-Mutationen zurück.
- Lade-, Fehler-, Validierungs- und Busy-Zustände sind an der Aktion sichtbar.
  Doppelklicks werden bei Zahlungszuordnung verhindert; serverseitige
  Idempotenz bleibt die letzte Sicherung.
- Transiente Fehler in Reports, Drilldowns und der DATEV-Historie bieten
  zugängliche Retry-Aktionen direkt am betroffenen Bereich; überlappende
  DATEV-Historienabfragen sind nach Latest-Request-Wins sequenziert.
- Viewer, Sales und Auditor erhalten read-only Controls. Owner, Admin und
  Accountant sehen nur die für ihre Rolle freigegebenen Mutationen; der Server
  erzwingt dieselbe Grenze erneut.
- Der Accounting-Bereich nutzt die semantischen Tokens aus `DESIGN.md` und
  `@billme/ui`; rohe Farbwerte und willkürliche Breakpoints wurden entfernt.

### Sinnvolle nächste UX-Verbesserungen

Diese Punkte sind keine offenen Integritätsfehler:

- Größere OPOS-Mengen profitieren künftig von gespeicherten Filtern,
  Sammelzuordnung und keyboard-fokussierter Bearbeitung.
- DATEV- und AfA-Läufe können nach realem Kanzlei-/Buchhalterfeedback um
  geführte Vorlagen ergänzt werden.
- Für Supportfälle wäre eine exportierbare, tenant-scoped Diagnoseansicht über
  Validierungsfehler und Audit-IDs hilfreich. Sie sollte erst gebaut werden,
  wenn ein realer Supportbedarf vorliegt.

## Security und Audit

- Produkt- und Tenant-Scope werden an Auth-, Route- und Repository-Grenze
  geprüft.
- Steuerfall-Mappings und Kontovorschlagsregeln verlangen privilegierte Rolle,
  Begründung und Audit-Kontext; Änderungen eines Mandanten beeinflussen keine
  anderen Mandanten.
- Gebuchte Dokumentzeilen, DATEV-Manifest/-Bytes und Journalquellen sind durch
  Repository-Regeln und Datenbank-Trigger geschützt.
- Die Import-Auditkette validiert `BIGINT`-Sequenzen, den importierten
  `audit_heads`-Stand und die Hash-Verkettung je Tenant; die
  `0019`-Eindeutigkeit verhindert keine gültigen Hashes anderer Mandanten.
- Typed Errors unterscheiden Konflikt, Validierungsfehler, fehlende Quelle und
  nicht verfügbaren historischen Export; normale Accounting-Konflikte werden
  nicht als unspezifischer HTTP 500 ausgegeben.
- Der Release-Workflow veröffentlicht erst nach Server-Data-Prüfung und grünem
  migrationsgestütztem Full-Pro-Postgres-E2E.
- `compose.env` und `runtime-state.json` sind aus allen Server-E2E-
  Diagnoseuploads ausgeschlossen; `test:e2e:artifact-hygiene` prüft die drei
  Uploadstellen.

## Verifikation

| Scope | Ergebnis |
|---|---:|
| Full Pro Server E2E gegen frisch migrierten Postgres-Stack (`test-results/server-mode/billme-e2e-msrm1he1-fbwr`) | **8/8 Szenarien bestanden**, inklusive **20 adversarial cases**, unbedingter `EU_B2B_SERVICE_RC`-Persistenz-/DATEV-Felder-40/41/43-Prüfung; Stack im Teardown zerstört |
| Accounting Engine | **39/39 Tests** |
| Accounting UI Pro | **65/65 Tests** |
| Pro Desktop | **310/310 Tests**, Typecheck und Build bestanden |
| Pro Desktop E2E | **17/17 Szenarien**, darin **9 adversariale Fälle** |
| Server API | **37/37 Tests** |
| Server Data ohne DB-URL (Defaultlauf) | **57 bestanden, 30 erwartete DB-Skips** |
| Server Data gegen echtes Postgres (Full-Lauf) | **87/87 Tests** |
| Web Pro | Typecheck bestanden |

Zum Prüfzeitpunkt war der getrackte Arbeitsbaum sauber; einzig das
benutzerseitige, nicht zu versionierende `.test-artifacts/` blieb erhalten und
wurde nicht verändert. Ältere Zahlen für nicht erneut ausgeführte Scopes
(unter anderem Lite Desktop, Desktop Data, Server Core, Lite Web und frühere
Importläufe) werden hier bewusst nicht als aktuelle Ergebnisse ausgewiesen.

Der Full-Pro-E2E deckt Stack-Smoke, Pro-Smoke, Session-Wiederherstellung,
Katalog, kanonischen Entwurf/Post, Ausgangs- und Eingangsrechnung, OPOS mit
Retry einschließlich exakter Überzahlung, Backfill mit Retry,
Dokumentstorno, Soft-Lock-Lauf, GuV/SuSa/Bilanz, BWA-/USt-Assertions,
unveränderlichen DATEV-Download, Produkt-/Routengrenzen und Worker-Flows ab.

## Bewusste fachliche Grenzen

- Die native EÜR 2025 ist eine Management-/Druckausgabe und **keine
  vollständige offizielle ELSTER-/Anlage-EÜR-Übermittlung**. Die amtliche
  elektronische Übermittlung nach [EStH § 60 Abs. 4 EStDV](https://ao.bundesfinanzministerium.de/esth/2025/A-Einkommensteuergesetz/III-Veranlagung-25-30/Paragraf-25/estdv-60.html)
  benötigt einen verifizierten Datensatz-/Providervertrag, der hier bewusst
  nicht behauptet wird.
- AVEÜR und SZ sind als EÜR-Metadaten-/DAG-Strukturen vorhanden, aber noch
  **keine vollständige persistente offizielle Filing-Pipeline**.
- E-Bilanz-/Taxonomie- und Unternehmensregister-Provider sind nicht verfügbar;
  die betreffenden Übergänge schlagen typed und fail closed fehl, statt eine
  nicht übermittelbare Einreichung zu simulieren.

## Offene externe Gates

1. Eine Steuerberatung muss Steuerfälle, Kontierungen, Ist-USt, Perioden- und
   Stornoregeln fachlich abnehmen; dieser Report ist keine Steuer-/Rechts- oder
   GoBD-Zertifizierung.
2. Eine DATEV-Kanzlei muss repräsentative Soll-/Ist-, EU-, OSS- und
   Reverse-Charge-Exporte in ihrer Zielumgebung importieren.
3. Es gab kein Produktivdeployment, keinen Live-Container-SHA und keinen
   Produktions-Smoke; diese Gates sind nicht Bestandteil dieses Reports.

## Gesamturteil

Die im Scope geprüfte Buchungspipeline ist durch fokussierte Tests sowie einen
realen Full-Pro-Postgres-E2E abgesichert. Die abschließenden Luna-Prüfungen für
Server, Desktop-zu-Postgres-Import und Pro Desktop sind als freigegeben
dokumentiert; es bestehen in diesem Scope keine offenen P0/P1/P2-Befunde. Eine
fachliche Steuer-/DATEV-Freigabe, ein Kanzleiimport und die eigentliche
Produktionsausrollung bleiben bewusst getrennt.
