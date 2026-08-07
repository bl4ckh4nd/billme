# Billme

<img src="logos/FullLogo3.svg" alt="Billme logo" width="320" />

[English](README.md) · **Deutsch**

[![CI](https://github.com/bl4ckh4nd/billme/actions/workflows/ci.yml/badge.svg)](https://github.com/bl4ckh4nd/billme/actions/workflows/ci.yml)
[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg)](LICENSE)

Lokale Rechnungsstellung und Buchhaltung für deutsche Kleinunternehmen — als Electron-Desktop-App mit
SQLite, optional im selbst gehosteten Servermodus mit Postgres und mit einem öffentlichen Portal zum
Teilen von Angeboten und Rechnungen mit Kunden. Mit Liebe in Deutschland entwickelt.

Probiere Billme ohne Installation aus: **[demo.getbillme.com](https://demo.getbillme.com/)**

> **Beta.** Rechne mit Ecken und Kanten und melde sie bitte, damit sie behoben werden können.

<img src="assets/screenshot_billme.png" alt="Billme screenshot" width="900" />

---

## Was ist Billme

Billme speichert Geschäftsdaten auf dem eigenen Rechner. Die Desktop-App schreibt in eine lokale
SQLite-Datei — kein Konto, keine Cloud und kein Abonnementserver, der Rechnungen abschalten kann.
Sind mehrere Benutzer oder Browserzugriff erforderlich, lässt sich dasselbe Produkt als selbst
gehosteter Servermodus-Stack mit Docker betreiben.

Billme wurde speziell für den deutschen Markt entwickelt: ZUGFeRD-/EN-16931-E-Rechnungen, Anlage EÜR mit
amtlichem Zeilenkatalog, Mahnwesen, SKR03-/SKR04-Kontenrahmen, DATEV-Export und GoBD-orientierte
Kontrollmechanismen.

---

## Editionen

Billme wird als zwei getrennte Anwendungen ausgeliefert. Sie lassen sich parallel installieren, verwenden
**getrennte Datenbanken** und keine ist ein Lizenzschlüssel-Upgrade der anderen — die Trennung erfolgt zur
Build-Zeit.

| | **Billme Lite** | **Billme Pro** |
|---|---|---|
| Desktop-App | `apps/desktop` (`com.billme.desktop`) | `apps/pro-desktop` (`com.billme.pro`) |
| Browser-Shell (Servermodus) | `apps/web` — Port 4175 | `apps/web-pro` — Port 4176 |
| Lokale Datenbank | `billme.sqlite` | `billme-pro-v2.sqlite` |
| Schwerpunkt | Rechnungen, Angebote, Anlage EÜR | Doppelte Buchhaltung, SKR, DATEV |
| Buchhaltungsansichten | — | Belegeingang, Buchungseditor, Abstimmung, Auswertungen |

Pro ist **keine** strikte Obermenge der Lite-Oberfläche: Die Ansichten Statistik und EÜR werden durch den
Arbeitsbereich für doppelte Buchhaltung ersetzt. Wähle Lite für eine Einnahmen-Überschuss-Rechnung und Pro
für doppelte Buchhaltung.

### Betriebsmodelle

| Modus | Beschreibung | Speicherort der Daten |
|---|---|---|
| **Desktop** | Electron-App, ein Unternehmen pro Installation | Lokales SQLite |
| **Servermodus** | Docker-Stack: Postgres + API + Worker + zwei Browser-Shells, mehrere Benutzer mit Rollen | Postgres |
| **Demo** | Die echte Desktop-Oberfläche im Browser mit Mock-Daten | Nirgends — im Arbeitsspeicher, pro Sitzung |
| **Angebotsportal** | Öffentlicher Hono-Dienst für kundenorientierte Angebots-/Rechnungslinks | Eigener Snapshot-Speicher |

---

## Funktionen

### Dokumente und Abrechnung — Lite und Pro

- **Visueller Dokumentdesigner** — Drag-and-drop-Zeichenfläche, Elementleiste, Inspektor, Ebenenpanel,
  Lineale, Einrasten, Rückgängig/Wiederholen und wiederverwendbare Vorlagen für Rechnungen und Angebote
- **Einheitliche Dokumentübersicht** — Suche, Statusfilter, Portal-Synchronisierungsstatus und Umwandlung
  von Angeboten in Rechnungen
- **Abo-Rechnungen** — intervallbasierte Planung mit manueller Ausführung
- **Mahnwesen** — mehrstufige Mahnungen mit konfigurierbaren Gebühren und Vorschau
- **Kunden** mit mehreren strukturierten Adressen und Kontakten sowie Umsatz- und Außenstandskennzahlen
  pro Kunde
- **Projekte** und ein **Artikelkatalog** mit Umsatzsteuer je Artikel
- **Bank-CSV-Import** (papaparse + iconv-lite, verarbeitet deutsche Bankkodierungen) und
  **Transaktionsabgleich**, der Zahlungen verknüpft und den Zahlungsstatus von Rechnungen aktualisiert
- **Statistik- und Finanzzentrale**, Einrichtungsassistent, Sicherung/Wiederherstellung, E-Mail-Versand,
  automatische Updates

### Deutsche Konformität — Lite und Pro

- **ZUGFeRD-/EN-16931-E-Rechnungen** — XML-Erzeugung und Einbettung in die PDF-Datei. Die Konformität
  wird in CI mit Mustang CLI (profile E) sowie veraPDF für PDF/A geprüft — siehe `.github/workflows/einvoice-validation.yml`
- **Anlage EÜR** — amtlicher Zeilenkatalog 2025 (`apps/desktop/eur/lines-2025.json`),
  Klassifizierungspipeline, Schlüsselwortvorschläge und ein druckbares EÜR-Dokument
  *(Lite; Pro ersetzt dies durch doppelte Buchhaltung)*
- **Steuerfälle** einschließlich Kleinunternehmer §19, mit unveränderlichen Steuer-Snapshots auf jedem
  Dokument
- **Nur anhängbares Audit-Log**, durch SQL-Trigger erzwungen, mit Hash-Verkettung und integrierter
  Integritätsprüfung

### Pro-Buchhaltung — nur Pro

- **Doppelte Buchhaltung** — von Buchungsentwürfen zu gebuchten Journalbuchungen mit Soll-/Haben-Zeilen.
  Buchungen müssen vor dem Buchen ausgeglichen sein (`UNBALANCED_ENTRY` blockiert hart); Korrekturen
  erfolgen durch Storno mit verpflichtender Begründung, niemals durch Löschen
- **SKR03 / SKR04** — der vollständige deutsche Kontenrahmen wird mit dem Installer ausgeliefert, beim
  ersten Start importiert und kann über die Oberfläche erneut importiert werden
- **14 deutsche Steuerfälle** — §19 Kleinunternehmer, §13b Reverse Charge, §25a Differenzbesteuerung,
  §48 Bauabzugsteuer, §25b Dreiecksgeschäft, OSS B2C, innergemeinschaftliche Lieferung/Erwerb, Export
  in Drittländer und weitere — mit kontenrahmenspezifischen Zuordnungen einschließlich
  DATEV-BU-Schlüssel und Versionierung über `validFrom`/`validTo`
- **Konformitätsprüfung vor dem Buchen** — blockierende und nicht blockierende Hinweise, beispielsweise
  eine fehlende USt-IdNr. der Gegenpartei oder fehlende Nachweise
- **DATEV-Buchungsstapel-Export** — EXTF-Kopfzeile, 12 Spalten, CP1252 + BOM, DDMMYYYY-Datumswerte und
  Feldvalidierung, die den Export abbricht, statt eine fehlerhafte Datei zu schreiben
- **Buchungsperioden** (offen / vorläufig gesperrt / geschlossen) und ein Buchungsworkflow mit
  11 Zuständen und Vier-Augen-Freigaben: zur Prüfung einreichen, genehmigen, ablehnen, buchen, stornieren,
  Korrektur anlegen
- **Automatische Kontenvorschläge, vollständig lokal** — eine fünfstufige Kaskade aus Regel →
  Gegenparteiengedächtnis → Naive Bayes → Schlüsselwort → Rückfall, wobei Konfidenz und Begründung in der
  Oberfläche angezeigt werden. Der Klassifikator lernt aus der lokalen Buchungshistorie. Keine
  Cloud-KI, keine Daten verlassen den Rechner
- **Exportpaket für die Betriebsprüfung** — ein Befehl erzeugt JSONL-Exporte von Journal, Zeilen,
  Perioden, Zuordnungen und Audit-Log mit SHA-256 pro Datei sowie einem Manifest
- **Unveränderlichkeit auf Datenbankebene** — SQL-Trigger schützen `journal_entries`, `journal_lines`
  und `datev_exports` vor Änderungen und Löschen (Lite schützt nur `audit_log`)
- **Rollenprüfungen** für Buchung, Storno, DATEV-Export und Audit-Export
- **Summen- und Saldenliste (SuSa), GuV und Bilanz** — die Auswertungslogik ist implementiert und über
  IPC verfügbar; die Anbindung der gemeinsamen Buchhaltungsoberfläche ist noch in Arbeit, daher zeigen
  diese Ansichten derzeit Beispieldaten

### Servermodus — Lite und Pro

- Mehrere Benutzer mit Rollen (`owner`, `admin`, `accountant`, `sales`, `viewer`)
- Produktisolierte Authentifizierung — ein Lite-Token wird auf einer Pro-Route mit `403` abgewiesen
- Hintergrund-Worker für Abo-Rechnungen, Mahnwesen, E-Mail-Warteschlange, Portal-Synchronisierung und
  Wartung
- Schreib- und Löschvorgänge bei Kunden, Rechnungen, Angeboten und Abo-Profilen erfordern eine `reason`
  und fügen in derselben Transaktion einen hashverketteten Audit-Eintrag an (Einstellungen, Nummernkreise
  und Pro-Katalogrouten noch nicht)
- `billme` CLI für Skripting gegen die API
- Einwegimport einer vorhandenen Desktop-SQLite-Datenbank nach Postgres

> Die Lite-Browser-Shell bietet absichtlich ein reduziertes Menü — nur Dashboard, Kunden und Dokumente.
> Projekte, Finanzen und Artikel sind in Lite nur auf dem Desktop verfügbar. Die Pro-Browser-Shell besitzt
> eine eigene vollständige Oberfläche einschließlich des Buchhaltungsarbeitsbereichs.

---

## Installation

### Desktop

Lade den passenden Installer aus dem
[neuesten Release](https://github.com/bl4ckh4nd/billme/releases/latest) herunter. Lite und Pro werden
als getrennte Artefakte veröffentlicht.

| Plattform | Format |
|---|---|
| Windows | NSIS-Installer (`.exe`) |
| macOS | `.dmg` und `.zip` |
| Linux | `.AppImage` und `.deb` |

### Demo

Keine Installation — öffne [demo.getbillme.com](https://demo.getbillme.com/). Die Daten liegen pro
Sitzung im Arbeitsspeicher; beim Zurücksetzen der Sitzung werden sie gelöscht.

---

## Servermodus (Docker)

```bash
cp .env.server-mode.example .env.server-mode
# edit BILLME_POSTGRES_PASSWORD and BILLME_SESSION_SECRET
pnpm docker:server-mode
```

Öffne anschließend die Lite-Shell unter <http://localhost:4175> oder die Pro-Shell unter
<http://localhost:4176> und schließe die Ersteinrichtung des ersten Eigentümers ab.
API-Zustand: <http://localhost:3100/health>.

### Dienste

| Dienst | Image / Build | Host-Port |
|---|---|---|
| `postgres` | `postgres:16-alpine` | `BILLME_POSTGRES_PORT` (5432) |
| `server-api` | `apps/server-api` — Fastify | `BILLME_API_PORT` (3100) |
| `server-worker` | `apps/server-worker` | — |
| `web` | `apps/web` → nginx | `BILLME_WEB_PORT` (4175) |
| `web-pro` | `apps/web-pro` → nginx | `BILLME_WEB_PRO_PORT` (4176) |

```bash
pnpm docker:server-mode:logs   # follow api + worker
pnpm docker:server-mode:down
```

### Konfiguration

Wichtige Variablen in `.env.server-mode` — die vollständige Liste steht in `.env.server-mode.example`:

| Variable | Standardwert | Bedeutung |
|---|---|---|
| `BILLME_POSTGRES_PASSWORD` | `change-me` | Datenbankpasswort |
| `BILLME_SESSION_SECRET` | — | HMAC-Schlüssel für Sitzungstoken |
| `BILLME_PUBLIC_API_URL` | `http://localhost:3100` | API-URL, die von den Browsern aufgerufen wird |
| `WORKER_*_INTERVAL_MS` | siehe unten | Jobintervalle |
| `SMTP_PASSWORD` / `RESEND_API_KEY` | — | Zugangsdaten für ausgehende E-Mails |

Drei wichtige Hinweise vor dem Deployment:

1. **`BILLME_PUBLIC_API_URL` wird zur Build-Zeit in die Browser-Images eingebettet.** Eine Änderung
   erfordert `docker compose --env-file .env.server-mode -f docker-compose.server-mode.yml build web web-pro`.
2. **Setze `BILLME_SESSION_SECRET`.** Ist der Wert leer, verwendet die API stillschweigend einen
   allgemein bekannten Entwicklungsschlüssel; dadurch kann jeder ein Sitzungstoken fälschen.
3. **Postgres wird standardmäßig auf dem Host veröffentlicht.** Entferne die Portfreigabe bei jedem
   internetseitig erreichbaren Betrieb. Der Stack verwendet unverschlüsseltes HTTP und enthält weder
   Reverse Proxy noch TLS-Terminierung — schalte selbst einen davor.

### Worker-Jobs

| Job | Standardintervall |
|---|---|
| `recurring-invoices` | 15 min |
| `dunning` | 15 min |
| `queued-email-dispatch` | 1 min |
| `offer-portal-sync` | 1 min |
| `scheduled-maintenance` | 24 h |

Setze `WORKER_RUN_ONCE=1`, um jeden Job einmal auszuführen und den Prozess anschließend zu beenden —
nützlich für Fehlersuche und E2E-Läufe.

### `billme` CLI

`packages/server-cli` stellt einen typisierten HTTP-Client und das Programm `billme` bereit. Benannte
Profile werden in `~/.config/billme/server-cli.json` gespeichert.

```
billme auth       login | bootstrap | me
billme meta       health | capabilities
billme clients    list | get | upsert | delete
billme invoices   list | get | create | upsert | delete
billme offers     list | get | create | upsert | delete
billme recurring  list | get | upsert | delete
billme settings   get | set
billme numbers    reserve | release | finalize
billme documents  export-json | export-csv
billme pro        articles | accounts | templates
```

### Migration vom Desktop

```bash
DATABASE_URL=... SQLITE_PATH=/path/to/billme.sqlite SERVER_PRODUCT=lite \
  pnpm -C packages/server-data import:sqlite
```

Vollständige Anleitung, Podman-Hinweise und E2E-Details:
[`docs/server-mode-docker.md`](docs/server-mode-docker.md).

---

## GoBD

Billme enthält technische Kontrollmechanismen, die GoBD-orientierte Abläufe unterstützen:

- Nur anhängbares Audit-Log auf Datenbankebene — Aktualisieren und Löschen werden in SQLite und Postgres
  durch SQL-Trigger blockiert
- Hashverkettete Audit-Einträge mit integrierter Integritätsprüfung
- Verpflichtende Begründungsabfragen in den zentralen Dokument- und Kundenabläufen für Änderung und
  Löschung, auf dem Desktop wie in der Server-API
- Audit-Export als CSV zur externen Prüfung sowie das Pro-Paket für die Betriebsprüfung mit Prüfsummen
  pro Datei
- Pro schützt zusätzlich Journalbuchungen, Journalzeilen und DATEV-Exporte auf Datenbankebene vor
  Änderungen

**Wichtig:** GoBD-Konformität hängt immer vom Prozess und von der konkreten Einrichtung ab, einschließlich
organisatorischer Kontrollen und einer Verfahrensdokumentation. Billme beansprucht keine offizielle
GoBD-Zertifizierung, und die eigene Konformitätscheckliste des Projekts bewertet jede Vorschrift
(HGB §238, AO §146/§147, GoBD, UStG §14, DATEV) als *teilweise* erfüllt — insbesondere fehlen derzeit ein
Kontrollpfad für den Jahresabschluss, eine erzwungene Verknüpfung zwischen Beleg und Buchung sowie eine
Engine für Aufbewahrungsrichtlinien. Betrachte dies als technische Unterstützung, nicht als Rechtsberatung.

---

## Angebotsportal

`apps/offer-portal` ist ein Hono-Dienst, der Angebote und Rechnungen als kundenorientierte Links
veröffentlicht und Entscheidungen erfasst. Die Desktop- und Serveranwendungen übertragen Snapshots und
bleiben die Quelle der Wahrheit — das Portal enthält niemals die buchhalterische Wahrheit.

Der Dienst läuft als selbst gehosteter Node-Dienst mit SQLite-Snapshots und PDF-Speicher im Dateisystem
(für Tests steht weiterhin ein In-Memory-Adapter bereit). Die Veröffentlichung wird mit einem `x-api-key`
geschützt; Kunden-URLs basieren auf Token. Der Servermodus-Docker-Stack enthält das Portal und verlangt
für sichere Veröffentlichung den Wert `BILLME_PORTAL_PUBLISH_API_KEY`.

Siehe [`docs/offer-portal.md`](docs/offer-portal.md).

---

## Roadmap — noch nicht in diesem Repository

Diese Bestandteile werden in internen Entwurfsdokumenten beschrieben, liegen aber nicht auf `main`; nach
dem Klonen sind sie daher nicht vorhanden.

- **Mobile-App** — ein Expo-/React-Native-Client (SDK 57, RN 0.86, expo-router) für iOS und Android, der
  als Aktionszentrale für den Servermodus dient und nicht als verkleinerte Desktop-Oberfläche.
  Anmeldung per Passwort oder durch Scannen eines QR-Kopplungscodes; Token im sicheren Speicher des
  Betriebssystems mit biometrischer Sperre; lokal nur ein verschlüsselter Cache, Entwürfe und eine
  Upload-Warteschlange. Liegt auf dem noch nicht zusammengeführten Branch `feat/ux-audit-improvements`.
  Prototypstatus: kein Release, kein Store-Eintrag.
- **Plattform-Administrationskonsole** — eine minimale Webkonsole zur Bereitstellung von Workspaces und
  Benutzern im Servermodus.
- **Agentensteuerung** — ein typisierter Aktionskatalog und eine token-geschützte Loopback-Bridge für
  lokale Automatisierung.

---

## Workspace

### Apps

| Pfad | Beschreibung |
|---|---|
| `apps/desktop` | Lite Electron + React Desktop-App; verantwortet Electron main/preload, SQLite-Verbindung und Lite-Produktverdrahtung |
| `apps/pro-desktop` | Pro Electron + React Desktop-App; ergänzt Buchhaltungsoberfläche, Engine, Pro-Verträge und Pro-Schema |
| `apps/web` | Lite-Browser-Shell für den Servermodus — bindet den Lite-Desktop-Renderer über einen HTTP-Adapter ein |
| `apps/web-pro` | Pro-Browser-Shell für den Servermodus — eigenständige Oberfläche mit eingebettetem Buchhaltungsarbeitsbereich |
| `apps/server-api` | Fastify-API des Servermodus mit Postgres |
| `apps/server-worker` | Hintergrund-Worker für Abo-Rechnungen, Mahnwesen, E-Mail, Portal-Synchronisierung und Wartung |
| `apps/offer-portal` | Hono-Dienst für öffentliche Angebots-/Rechnungsfreigaben und Kundenentscheidungen |
| `apps/demo` | Cloudflare-Worker-Demo — gemeinsamer Renderer mit sitzungsgebundenen Mock-Diensten |
| `apps/landing-page` | Marketingseite |

### Packages

| Package | Beschreibung |
|---|---|
| `@billme/ui` | Grundlegende Designsystem-Komponenten und Quelle der Design-Token (`packages/ui/styles.css`) |
| `@billme/desktop-contracts` / `-pro` | Typisierte IPC-Verträge und Zod-Schemas für die Lite- und Pro-Grenzen zwischen Renderer und Main-Prozess |
| `@billme/desktop-core` | Gemeinsame Desktop-Laufzeithelfer — IPC-Fehlerbehandlung, Protokollierung/Wiederholungen, E-Mail-Dienst, Benachrichtigungsstatus |
| `@billme/desktop-data` | Gemeinsame SQLite-/Drizzle-Repositories, Validierungsschemas, Sicherung, Audit, EÜR- und Mahnwesen-Schnittstellen |
| `@billme/desktop-designer` | Gemeinsamer visueller Dokumentdesigner — Zeichenfläche, Elementleiste, Inspektor, Ebenen sowie Zoom-/Schwenk-/Verlaufs-Hooks |
| `@billme/desktop-renderer` | Bindet die Desktop-React-App in beliebige Hosts ein und ermöglicht dadurch Demo und Web-Shells die Wiederverwendung der Electron-Oberfläche |
| `@billme/desktop-services` | Portal-Client, CSV-Import, EÜR-Katalog und Vorschlagshelfer |
| `@billme/desktop-hooks` / `-state` / `-ui` / `-utils` | Kleine gemeinsame Bausteine: Hook für Tastenkürzel, Zustand-Oberflächenstore, Toast/Spinner/Skeleton, Formatierer |
| `@billme/accounting-shared` | Reine Pro-Buchhaltungstypen — Journal, Workflowzustände, Kontenrahmen, Steuerfälle |
| `@billme/accounting-engine` | Buchungs- und Hauptbuchdienste einschließlich der vor dem Buchen erzwungenen Saldenprüfung |
| `@billme/accounting-ui-pro` | Pro-Buchhaltungsarbeitsbereich — Belegeingang, Buchungseditor, Abstimmung, Ausnahmen, Auswertungen |
| `@billme/finance-intelligence` | Lokaler Naive-Bayes-Klassifikator und deutsche Schlüsselwortheuristiken für Kontenvorschläge |
| `@billme/server-core` | Produkt-/Laufzeitschemas, typisierter API-Client, Domänentypen, Steuer-/E-Rechnungslogik, gemeinsame Dienste |
| `@billme/server-data` | Postgres-Schema, Migrationen, Repositories, Seed-Daten und SQLite-Importwerkzeuge |
| `@billme/server-cli` | Typisierter HTTP-Client für den Servermodus sowie das Programm `billme` |

---

## Entwicklung

### Voraussetzungen

- Node.js 20+
- pnpm 10+

```bash
pnpm install
pnpm dev          # starts the Lite desktop app
```

### Befehle

```bash
# Development
pnpm dev                  # Lite desktop app
pnpm dev:pro              # Pro desktop app
pnpm dev:renderer         # Lite renderer only (Vite)
pnpm dev:web              # Lite browser shell
pnpm dev:web-pro          # Pro browser shell
pnpm dev:server-api       # Fastify API
pnpm dev:server-worker    # Background worker
pnpm dev:demo             # Cloudflare Worker demo
pnpm dev:landing          # Landing page

# Build
pnpm build                # Lite desktop bundle
pnpm build:web            # Lite browser shell
pnpm build:web-pro        # Pro browser shell
pnpm build:server-api
pnpm build:server-worker
pnpm build:server-cli
pnpm build:demo
pnpm build:landing

# Distributables
pnpm dist                       # Lite desktop installers
pnpm -C apps/pro-desktop dist   # Pro desktop installers

# Server-mode stack
pnpm docker:server-mode
pnpm docker:server-mode:logs
pnpm docker:server-mode:down

# Deploy
pnpm deploy:demo                     # demo to Cloudflare Workers
```

Die Typprüfung erfolgt pro Package, beispielsweise mit `pnpm -C apps/desktop typecheck`.

---

## Tests

Tests liegen neben dem Code; das Stammverzeichnis `tests/` enthält nur End-to-End-Tests. Es gibt keinen
einzelnen Testbefehl im Wurzelverzeichnis, der den gesamten Workspace ausführt — teste die geänderte
Laufzeitoberfläche.

```bash
# Unit — Vitest (the two Electron apps)
pnpm -C apps/desktop test
pnpm -C apps/pro-desktop test
pnpm -C apps/desktop test:einvoice     # ZUGFeRD conformance subset

# Unit — Node built-in test runner (everything else)
pnpm -C apps/server-api test
pnpm -C apps/server-worker test
pnpm -C apps/offer-portal test
pnpm -C packages/server-data test
pnpm -C packages/server-cli test

# End-to-end — Playwright
pnpm test:e2e:smoke
pnpm test:e2e:full
pnpm test:e2e:server:install   # one-time: playwright install chromium
pnpm test:e2e:server:smoke
pnpm test:e2e:server:full
```

Servermodus-E2E benötigt Docker oder Podman sowie ein lokales Chromium. Die Testsuite startet einen
eigenen isolierten Stack, daher wird `.env.server-mode` nur für manuelle Compose-Läufe benötigt.

### CI

| Workflow | Auslöser | Aufgabe |
|---|---|---|
| `ci.yml` | Push / PR | Lite- und Pro-Typprüfung, Tests, E-Rechnungstests und Build; Angebotsportal-Build; Desktop-Smoke-E2E; Servermodus-Smoke-E2E |
| `e2e-nightly.yml` | nächtlich | Vollständige Desktop- und Servermodus-E2E-Tests |
| `einvoice-validation.yml` | E-Rechnungsänderungen | ZUGFeRD-Validierung mit Mustang CLI und PDF/A mit veraPDF |
| `commitlint.yml` | Push / PR | Erzwingt Conventional Commits |
| `release-please.yml` | Push auf `main` | Öffnet und pflegt den Release-PR |
| `publish-release.yml` | Tag `v*` | Baut Lite und Pro unter Linux, macOS und Windows und veröffentlicht das GitHub-Release |

---

## Mitwirken

Commits folgen [Conventional Commits](https://www.conventionalcommits.org/), was in CI erzwungen wird:

```
<type>: <subject>
```

Zulässige Typen: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

Releases sind automatisiert: release-please öffnet anhand der Commit-Historie einen Versions-PR. Beim
Zusammenführen wird ein Tag erstellt, das den plattformübergreifenden Build und das GitHub-Release auslöst.

Übertrage keine generierten Build-Ausgaben (`dist/`, `out/`, `release/`, Coverage, Logs) in das Repository.

---

## Dokumentation

- [`docs/server-mode-docker.md`](docs/server-mode-docker.md) — Servermodus-Stack, Docker/Podman, E2E-Testumgebung
- [`docs/offer-portal.md`](docs/offer-portal.md) — Ausführung und Deployment des Angebotsportals
- [`docs/releasing.md`](docs/releasing.md) — Release-Prozess
- [`docs/eur-integration-plan.md`](docs/eur-integration-plan.md) — Hinweise zur EÜR-Integration
- [`docs/architecture.md`](docs/architecture.md) — frühe Architekturhinweise zur Lite-Desktop-App,
  Demo und Portal (vor den Pro- und Servermodus-Oberflächen)

---

## Lizenz

[Functional Source License 1.1 mit einer zukünftigen Apache-2.0-Lizenz](LICENSE) (FSL-1.1-ALv2).
Billme darf für jeden Zweck außer dem Aufbau eines konkurrierenden Produkts verwendet, verändert und
weitergegeben werden; jede Veröffentlichung wechselt zwei Jahre nach ihrer Veröffentlichung zu Apache 2.0.
