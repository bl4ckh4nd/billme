# Abschlussreport Buchungspipeline

**Stand:** 12.08.2026 · **Codebasis:** Branch
`fix/accounting-pipeline-hardening`, funktionale Accounting-Baseline `f089e6e`,
Report `6314c18`, anschließender CI-Hygiene-Fix `caa2843`

Dieser Report bewertet den technischen Stand der Pro-Buchungspipeline nach der
Umsetzung. Er ist keine steuerliche oder rechtliche Beratung und keine GoBD-,
EN-16931- oder DATEV-Zertifizierung. Ein Produktivdeployment war nicht Teil des
Auftrags.

## Ergebnis

Die zuvor gefundenen technischen P0/P1-Probleme der geprüften Pipeline sind
behoben. Die Buchungskette ist in Pro Desktop und Pro Server/Web durchgängig
verdrahtet: Entwurf und Freigabe, Ausgangs- und Eingangsrechnungen, doppelte
Buchführung, OPOS und Teilzahlungen, Ist-USt, Storno, Anlagen/AfA/Abgang,
SuSa/GuV/Bilanz, DATEV sowie SQLite-zu-Postgres-Import.

Der abschließende Full-Pro-E2E lief gegen einen frisch migrierten Postgres-Stack
grün. Alle sieben Szenarien bestanden; das Artefakt liegt unter
`test-results/server-mode/billme-e2e-msqejbh0-2ftmn` und der Stack wurde im
Teardown zerstört. Das EU-B2B-Szenario `EU_B2B_SERVICE_RC` prüft dabei
unbedingt die Persistenz und den DATEV-Export der Felder 40/41/43. Damit ist
die technische Pipeline im vereinbarten Umfang releasefähig; die fachliche
Steuerprüfung, ein Kanzlei-DATEV-Import und ein Produktivdeployment bleiben
externe Gates.

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
- Effective-dated Report-Mappings bleiben beim Desktop-zu-Postgres-Import mit
  ihren 2025-/2026-Gültigkeiten erhalten. Generische Legacy-Mappings werden
  separat als Legacy-Provenienz importiert und nicht still in einen
  2025-/2026-Katalog umgedeutet.
- Die additive Postgres-Migrationskette ist vollständig:
  `0006` OPOS, `0007` OPOS-Härtung, `0008` Anlagenbuchhaltung,
  `0009` DATEV-Bytes, `0010` Ausgangsrechnungs-Postingmetadaten,
  `0011` tenant-scoped Steuerkonten-Mappings mit globalem Fallback,
  `0012` Asset-Guard, `0013` Asset-Härtung, `0014` DATEV-Steuer-Evidenz,
  `0015` Reporting/Tax-Submissions, `0016` EÜR-Metadaten und `0017` kanonischer
  107-Zeilen-EÜR-Katalog.

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
| Full Pro Server E2E gegen frisch migrierten Postgres-Stack (`test-results/server-mode/billme-e2e-msqejbh0-2ftmn`) | **7/7 Szenarien bestanden**, inklusive unbedingter `EU_B2B_SERVICE_RC`-Persistenz-/DATEV-Felder-40/41/43-Prüfung; Stack im Teardown zerstört |
| Accounting Engine | **39/39 Tests**, Typecheck bestanden |
| Accounting UI Pro | **65/65 Tests**, Typecheck und Build bestanden |
| Desktop Data | **63/63 Tests**, Typecheck bestanden |
| Lite Desktop | **200/200 Tests**, Typecheck und Build bestanden |
| Pro Desktop | **309/309 Tests**, Typecheck und Build bestanden |
| Server API | **37/37 Tests**, Typecheck bestanden |
| Server Data am finalen HEAD ohne DB-URL | **53 bestanden, 19 erwartete DB-Skips**, Typecheck bestanden |
| SQLite-zu-Postgres-Import gegen echtes Postgres | **12/12 Tests bestanden** |
| Server Core | **32/32 Tests**, Typecheck bestanden |
| Lite Web | **1/1 Test**, Typecheck und Build bestanden |
| Web Pro | **14/14 Tests**, Typecheck und Build bestanden |
| Server-E2E-Artefakt-Hygiene | `compose.env`/`runtime-state.json` ausgeschlossen; **3 Uploadstellen** geprüft |

Zum Prüfzeitpunkt war der getrackte Arbeitsbaum sauber; einzig das
benutzerseitige, nicht zu versionierende `.test-artifacts/` blieb erhalten.

Der Full-Pro-E2E deckt Stack-Smoke, Pro-Smoke, Session-Wiederherstellung,
Katalog, kanonischen Entwurf/Post, Ausgangs- und Eingangsrechnung, OPOS mit
Retry, Backfill mit Retry, Dokumentstorno, GuV/SuSa/Bilanz, unveränderlichen
DATEV-Download, Produkt-/Routengrenzen und Worker-Flows ab.

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

Technisch ist die geprüfte Buchungspipeline kohärent und durch fokussierte
Tests sowie einen realen Full-Pro-Postgres-E2E abgesichert. Es bestehen auf
diesem Stand keine bekannten P0/P1-Integritäts- oder Erreichbarkeitslücken im
vereinbarten Scope. Eine fachliche Steuer-/DATEV-Freigabe und die eigentliche
Produktionsausrollung bleiben bewusst getrennt.
