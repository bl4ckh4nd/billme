# Abschlussreport Buchungspipeline

**Stand:** 12.08.2026 · **Codebasis:** Branch
`fix/accounting-pipeline-hardening`, Codebaseline `67a65a3` (danach folgt nur
diese Report-Aktualisierung)

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
`test-results/server-mode/billme-e2e-msq2ya38-1tlad`. Das EU-B2B-Szenario
`EU_B2B_SERVICE_RC` prüft dabei unbedingt die Persistenz und den DATEV-Export
der Felder 40/41/43. Damit ist die technische Pipeline releasefähig; die
fachliche Steuerprüfung, ein Kanzlei-DATEV-Import und ein Produktivdeployment
bleiben externe Gates.

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
- Die additive Postgres-Migrationskette ist vollständig:
  `0006` OPOS, `0007` OPOS-Härtung, `0008` Anlagenbuchhaltung,
  `0009` DATEV-Bytes, `0010` Ausgangsrechnungs-Postingmetadaten,
  `0011` tenant-scoped Steuerkonten-Mappings mit globalem Fallback,
  `0012` Asset-Guard, `0013` Asset-Härtung und `0014` DATEV-Steuer-Evidenz.

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

## Verifikation

| Scope | Ergebnis |
|---|---:|
| Full Pro Server E2E gegen frisch migrierten Postgres-Stack (`test-results/server-mode/billme-e2e-msq2ya38-1tlad`) | **7/7 Szenarien bestanden**, inklusive unbedingter `EU_B2B_SERVICE_RC`-Persistenz-/DATEV-Felder-40/41/43-Prüfung |
| Pro Desktop | **286/286 Tests**, Typecheck und Build bestanden |
| Accounting UI Pro | **36/36 Tests bestanden** |
| Accounting Engine | **5/5 Tests bestanden** |
| Desktop Data | **50/50 Tests bestanden** |
| Server API | **26/26 Tests**, Typecheck bestanden |
| Server Data am finalen HEAD ohne DB-URL | **33 bestanden, 13 erwartete DB-Skips**, Typecheck bestanden |
| SQLite-Import-Paritätsfixture gegen frisches Postgres | **bestanden** |
| Web Pro | **10/10 direkte Tests**, Typecheck und Build bestanden |
| Server Core | **23/23 Tests**, Typecheck bestanden |
| DATEV-Repository-Test gegen echtes Postgres | **1/1 bestanden** |

Der Full-Pro-E2E deckt Stack-Smoke, Pro-Smoke, Session-Wiederherstellung,
Katalog, kanonischen Entwurf/Post, Ausgangs- und Eingangsrechnung, OPOS mit
Retry, Backfill mit Retry, Dokumentstorno, GuV/SuSa/Bilanz, unveränderlichen
DATEV-Download, Produkt-/Routengrenzen und Worker-Flows ab.

## Offene externe Gates

1. Eine Steuerberatung muss Steuerfälle, Kontierungen, Ist-USt, Perioden- und
   Stornoregeln fachlich abnehmen.
2. Eine DATEV-Kanzlei muss repräsentative Soll-/Ist-, EU-, OSS- und
   Reverse-Charge-Exporte in ihrer Zielumgebung importieren.
3. Produktivdeployment, Live-Container-SHA und Produktions-Smoke wurden nicht
   durchgeführt und sind nicht Bestandteil dieses Reports.

## Gesamturteil

Technisch ist die geprüfte Buchungspipeline kohärent und durch fokussierte
Tests sowie einen realen Full-Pro-Postgres-E2E abgesichert. Es bestehen auf
diesem Stand keine bekannten P0/P1-Integritäts- oder Erreichbarkeitslücken im
vereinbarten Scope. Eine fachliche Steuer-/DATEV-Freigabe und die eigentliche
Produktionsausrollung bleiben bewusst getrennt.
