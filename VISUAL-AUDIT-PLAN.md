# Visueller Audit-Plan — alle Oberflächen mit `playwright-cli` durchtesten, screenshotten und auf Layout-/Darstellungsfehler prüfen

Stand: 2026-09-16 · Werkzeug: `playwright-cli` 0.1.18 (global, `/home/merres/.local/share/pnpm/bin/playwright-cli`) · Basis: `@playwright/cli`

Dieses Dokument ist ein **Ausführungsplan**, keine Ergebnisdokumentation. Es beschreibt
(a) den vollständigen Prüfumfang (jede Route, jede View, jedes Modal, jeder Flow),
(b) die exakten `playwright-cli`-Kommandos zum Erzeugen der Screenshots,
(c) die automatisierten Layout-Proben und
(d) den anschließenden Review-Pass auf Darstellungsfehlern.

---

## 0. Ergebnis und Nicht-Ziele

**Ergebnis**

1. `docs/audit/visual-audit-2026-09-16/` mit ~450 Screenshots (Basis-Sweep + Viewport-Matrix + Modals + Zustände + Flows) und `manifest.tsv`.
2. `docs/audit/visual-audit-2026-09-16/probes/<app>/<route>.json` — maschinelle Geometrie-/Kontrast-/A11y-Proben je Route.
3. `docs/audit/visual-audit-2026-09-16/findings.json` + `REPORT.md` — konsolidierte, nach Severity sortierte Befunde mit Screenshot-Referenz und Repro-Kommando.

**Nicht-Ziele**

- Keine funktionale Regression: dafür existieren bereits `pnpm test:e2e*` (Desktop-Electron, Server-Mode). Dieser Plan prüft **Darstellung**, nicht Vertragsverhalten.
- Keine Baseline-/Pixel-Diff-Snapshots (`toHaveScreenshot` gibt es im Repo bewusst nicht, siehe `tests/`).
- Keine Fixes. Fixes sind ein Folge-Ticket pro Befund.

---

## 1. Prüfumfang (Inventar)

### 1.1 Apps und Entry-Points

| App | Dev-Start | Port | Backend | Auth-Gate | Renderer-Wurzel |
|---|---|---|---|---|---|
| `apps/desktop` (Lite, Electron) | `pnpm dev` / `pnpm -C apps/desktop dev:renderer` | 3000 | Electron-PGlite (`window.billmeApi`) | keins | `apps/desktop/router.tsx` |
| `apps/pro-desktop` (Pro, Electron) | `pnpm dev:pro` / `pnpm -C apps/pro-desktop dev:renderer` | 3000 | Electron-PGlite | keins | `apps/pro-desktop/router.tsx` |
| `apps/web` (Lite Browser) | `pnpm dev:web` | 4175 | `apps/server-api` (Postgres) | `AuthScreen` + `localStorage['billme.web.lite.session.v1']` | shared hash-Router + `runtime.navigation=['dashboard','clients','documents','finance']` |
| `apps/web-pro` (Pro Browser) | `pnpm dev:web-pro` | 4176 | `apps/server-api` | `AuthScreen product="pro"` | eigener 7-Routen-Hash-Router in `apps/web-pro/src/App.tsx` |
| `apps/demo` | `pnpm dev:demo` (`wrangler dev --local`) | 8787 (wrangler-Default) | Cloudflare-DO-Mock, kein Auth | keins | shared hash-Router, alle 6 Nav-Items |
| `apps/landing-page` | `pnpm dev:landing` | 4173 | keins | keins | `apps/landing-page/src/App.tsx` |
| `apps/offer-portal` | `pnpm -C apps/offer-portal dev` | 3001 | SQLite + Filesystem | Share-Token / API-Key | Hono HTML in `apps/offer-portal/src/app.ts` |
| `apps/server-api` | `pnpm dev:server-api` | 3100 | Postgres | pro Route | JSON-API (kein UI → nur `/health`, `/api/v1/openapi.json`, `/admin/setup` visuell) |
| `packages/desktop-designer/playground` | `pnpm dev:editor` | 4177 | keins (Fixtures) | keins | Canvas-Editor-Fixtures |
| `apps/admin-web` | — | — | — | — | **existiert nicht** (leeres Verzeichnis) → aus Scope ausgeschlossen |

Alle Desktop-Renderer nutzen **Hash-History** (`createHashHistory()`), d. h. URLs der Form `<base>/#/documents`.

### 1.2 Lite — Routen (`apps/desktop/router.tsx:369-461`)

| # | Pfad | View | Sub-State |
|---|---|---|---|
| 1 | `/` | `DashboardPage` → `DashboardHome` (`packages/desktop-ui/src/shell/DashboardViews.tsx`) | KPI-Sektionen + `DashboardSettingsPopover` |
| 2 | `/statistics` | `StatisticsView` | `timeRange: month\|quarter\|year\|all` |
| 3 | `/accounts` | `AccountsView` (`apps/desktop/components/AccountsView.tsx`) | `viewMode: accounts\|matching`, 5 Action-Cards |
| 4 | `/finance` | `FinanceHubView` | `activeTab: statistics\|accounts\|eur` |
| 5 | `/eur` | `EurView` (`packages/desktop-renderer/src/components/EurView.tsx`) | `taxYear`, `queueStatus: all\|unclassified\|classified\|excluded`, `flowFilter`, `queueSort` |
| 6 | `/templates` | `TemplatesView` | `activeTab: invoice\|offer` |
| 7 | `/templates/invoice/editor`, `/templates/offer/editor` | `InvoiceEditor` → `TemplateDesigner` | `activeTab: inspector\|layers` |
| 8 | `/documents` | `DocumentsView` (`InvoicesView.tsx`) | `viewMode: list\|detail`, `documentType: invoice\|offer`, `filter: all\|open\|paid\|overdue`, Suche, Multi-Select; Deep-Links `?kind=offer&id=…&status=overdue` |
| 9 | `/documents/edit` | `DocumentEditor` | `view: edit\|preview`; **guard**: ohne `editingInvoice` leerer Screen |
| 10 | `/recurring` | `RecurringView` | Liste + Edit-Modal |
| 11 | `/clients` | `ClientsView` | `viewMode: grid\|list`, Detail-Pane, In-Pane-Editor (`?id=`) |
| 12 | `/projects` | `ProjectsView` | Suche + `includeArchived` |
| 13 | `/projects/$projectId` | `ProjectDetailView` | zwei Listen (Rechnungen/Angebote) |
| 14 | `/articles` | `ArticlesView` | `viewMode: grid\|list`, Kategorie-Chips, netto/brutto, Multi-Select (`?query=`) |
| 15 | `/settings` | `SettingsView` | 9 Tabs: `company, catalog, finance, numbers, dunning, legal, portal, system, email` |
| 16 | `*` | `NotFoundPage` | „Seite nicht gefunden“ |

Zusätzlich Nicht-Router-Oberflächen (gleiches Bundle): `?__print=1&kind=invoice|offer&id=…` → `PrintDocument`, `?__print=1&kind=eur&taxYear=…` → `PrintEurDocument` (`packages/desktop-renderer/src/createDesktopApp.tsx:12-47`).

### 1.3 Lite — In-View-Views (nicht-Routen)

- `TransactionMatchingView` (bei `AccountsView.viewMode==='matching'`), Tabs `matching | eur`
- `StatisticsView` / `AccountsView` / `EurView` eingebettet in `FinanceHubView`
- `OnboardingWizard`-Overlay (Gate: `shouldShowBusinessOnboarding(settings)`, `packages/desktop-ui/src/components/BusinessOnboarding.tsx:318-324`), 3 Schritte
- `ShortcutsModal` (Taste `?`)
- Globale Suche im Header (`Cmd/Ctrl+K`), Benachrichtigungs-Panel

### 1.4 Modals / Dialoge / Overlays (Trigger = was geklickt werden muss)

Lite und Pro teilen fast alle; Pro ergänzt die letzten sechs.

| # | Dialog | Trigger | Quelle |
|---|---|---|---|
| 1 | Mahnlauf starten | `/documents` → Filter „Überfällig“ → Button | `InvoicesView.tsx:730` |
| 2 | Per E-Mail senden | Detail-Toolbar | `InvoicesView.tsx:804` |
| 3 | Zahlung erfassen/bearbeiten | Detail-Toolbar / Zahlungszeile | `InvoicesView.tsx:874` |
| 4 | Zahlung löschen | Zahlungszeile → Löschen | `InvoicesView.tsx:1073` |
| 5 | Belegkette mit Betrag | Kette-Buttons (Abschlag/Teil/Schluss/Gutschrift/Storno) | `InvoicesView.tsx:1024` |
| 6 | Bulk-Delete | Multi-Select-Aktionsleiste | `InvoicesView.tsx:1754` |
| 7 | Mahnung erstellen (Confirm) | Überfällig-Liste | `InvoicesView.tsx:1869` |
| 8 | Projekt-Editor / Projekt archivieren | `/projects` Buttons | `ProjectsView.tsx:274,430` |
| 9 | Abo-Editor | `/recurring` Neu/Bearbeiten | `RecurringView.tsx:398` |
| 10 | DunningResultModal | `/settings` Mahnlauf | `SettingsView.tsx:1884` |
| 11 | DunningLevelPreviewModal | `/settings` → Mahnstufe „Vorschau“ | `SettingsView.tsx:1891` |
| 12 | BankAccountModal | `/accounts` „Neues Konto“ | `AccountsView.tsx:202,395` |
| 13 | ImportHistoryModal (+ Rollback-Confirm) | `/accounts` „Import-Historie“ | `ImportHistoryModal.tsx:66,344` |
| 14 | CSV-Import prüfen (Confirm) | `/accounts` CSV-Karte | `AccountsView.tsx:332` |
| 15 | Transaktion entkoppeln | `TransactionMatchingView` | `TransactionMatchingView.tsx:1089` |
| 16 | EurRulesModal | `/eur` „Regeln“ (im Web-Shell ausgeblendet) | `EurView.tsx:953` |
| 17 | Ungespeicherte Änderungen verwerfen (Confirm) | Dokument-Editor verlassen | `DocumentEditor.tsx:567` |
| 18 | Nummer entsperren (Confirm) | Dokument-Editor | `DocumentEditor.tsx:580` |
| 19 | Grund der Änderung (GoBD-Confirm) | Speichern eines bestehenden Dokuments | `router.tsx:331-360` |
| 20 | Aktionen (⌘K) Command-Dialog | Dokument-Canvas | `DocumentCanvasEditor.tsx:646` |
| 21 | Spalten anzeigen | Dokument-Canvas ⋮ | `DocumentCanvasEditor.tsx:676` |
| 22 | Kunden-Editor (In-Pane, kein Modal) | `/clients` Neu/Bearbeiten | `ClientsView.tsx:684` |
| 23 | Artikel-Formular | `/articles` | `ArticlesView.tsx:90,357` |
| 24 | Toast/Feedback-Overlays | jede Aktion (`useActionFeedback`) | `packages/ui/src/components/FeedbackProvider.tsx:61` |
| 25 | Pro: Kontierungsvorschlag-Regeln | `/accounting` „Regeln“ | `ProAccountRulesModal.tsx:44` |
| 26 | Pro: JournalEntryDetailModal | `/accounting` Auswertungen/Historie | `accounting-ui-pro/src/App.tsx:205` |
| 27 | Pro: BookingEditor `?`-Hilfe + ConfirmDialog | Buchungserfassung | `BookingEditor.tsx:673,693` |
| 28 | Pro: ReportDrilldownPanel | Auswertungen Zeile auswählen | `ReportDrilldownPanel.tsx:46` |

### 1.5 Pro — Routen (`apps/pro-desktop/router.tsx:362-460`)

Wie Lite, mit Abweichungen:

- **Pro-only:** `/accounting` → `ProAccountingPage`, `/tax-filing` → `TaxFilingCenter`
- **In Pro nicht vorhanden:** `/statistics`
- Nav-Items Pro (`apps/pro-desktop/components/DashboardLayout.tsx:10-18`): `dashboard, clients, projects, documents, finance, tax-filing, articles`

### 1.6 Pro — Buchhaltungs-Workspace (`/accounting`, `packages/accounting-ui-pro/src/App.tsx`)

8 Views, per `useState<AppView>`, **nicht** per URL:

`inbox` · `editor` (Buchungserfassung) · `reconciliation` (Bankabgleich) · `exceptions` · `assets` · `reports` · `opos` · `special` (Sonderbuchungen & Abschluss)

Unterebenen: Inbox-Queues `all, incomplete, review, approval, posted, errors`; Exception-Filter 9 Werte; 6 Report-Tabs `eur, susa, bwa01, management_guv, hgb_guv, bilanz`; 13 Sonderbuchungs-Workflows; Steuervorbereitung `ustva, zm, oss`.

### 1.7 Weitere Apps

| App | Zu prüfende Oberflächen |
|---|---|
| `apps/web` | `AuthScreen` in den Modi `checking` / `setup` („Billme einrichten“) / `login` („Willkommen zurück“) / `unreachable`, Logout-Notice, Renderer-Mount-Fehler, danach die 4 gefilterten Nav-Routen |
| `apps/web-pro` | `AuthScreen product="pro"`, `BusinessOnboarding`-Vollbild, 7 Routen `overview, documents, clients, catalog, recurring, settings, accounting` |
| `apps/demo` | Dauerbanner „Demo mit Beispieldaten…“, alle 6 Nav-Routen |
| `apps/landing-page` | Sektionen `#top,#features,#gobd,#faq`, Legal-Seiten `#/impressum`, `#/datenschutz`, Release-Badge-Fallback |
| `apps/offer-portal` | `/`, `/admin/setup`, `/health`, `/offers/:token`, `/invoices/:token`, `/d/:documentId` (+`/pdf`), Entscheidungsformular, Fehlerseiten `unknown/revoked/expired/rate_limited` |
| `apps/server-api` | `/health` und `/api/v1/openapi.json` als Browservolltext; keine UI |

### 1.8 Komponenten-Inventar

**Design-System `@billme/ui`** (`packages/ui/src/components/`): `Amount`, `AuthScreen`, `Badge`, `BalanceIndicator`, `BillmeLogo`, `Button`, `Card`, `Combobox`, `ConfirmDialog`, `DatePicker`, `Field`, `FeedbackProvider`, `HelpHint`, `Input`, `Modal`, `Portal`, `Select`, `Textarea`, `Toast`, `ValidationSummary`, plus `EmptyState`, `ErrorState`, `SkeletonLoader`, `Spinner`.

**Shell `@billme/desktop-ui`**: `DashboardLayout` (Header-Pills, Suche, Glocken-Panel, Mobile-Strip), `DashboardHome`, `DashboardSettingsPopover`, `TemplatesView`, `StatisticsView`, `OnboardingWizard`, `BusinessOnboarding`, `ErrorBoundary`, `ShortcutsModal`, `DunningResultModal`, `DunningLevelPreviewModal`.

**Renderer-Views**: `InvoicesView` (105 KB), `ClientsView` (92 KB), `SettingsView` (96 KB), `EurView` (41 KB), `ArticlesView`, `ProjectsView`, `ProjectDetailView`, `RecurringView`, `TransactionMatchingView`, `TemplateEditor`, `InvoiceDocumentEditor`, `PrintDocument`, `PrintEurDocument`, `TaxFilingCenter`, `ImportHistoryModal`, `EurRulesModal`.

**Designer `@billme/desktop-designer`**: `TemplateDesigner`, `CanvasStage`, `ElementRenderer`, `Inspector`, `LayersPanel`, `ElementRail`, `Rulers`, `GridOverlay`, `TopBar`, `DocumentPages`, `DocumentEditor`, `DocumentCanvasEditor`.

**Pro `@billme/accounting-ui-pro`**: siehe 1.6.

### 1.9 Zustandsmatrix (je Liste/Detail)

Pro View existieren explizite Lade-, Fehler- und Leer-Zustände. Diese sind **eigene Screenshot-Ziele**, nicht Beiwerk — Beispiele mit Quelle:

| View | Laden | Fehler | Leer |
|---|---|---|---|
| DashboardHome | `SkeletonLoader variant=card` (`DashboardViews.tsx:140`) | `:131` | „Noch keine Umsätze…“ `:544` |
| Documents | `variant=list` (`InvoicesView.tsx:1154`) | `:1148`, `:2041` | „Kein Dokument passt…“ `:2147` |
| Clients | `variant=card count=6` (`ClientsView.tsx:1246`) | `:1250` | „Noch keine Kunden angelegt“ `:1256` |
| Articles | `variant=card count=6` (`ArticlesView.tsx:429`) | `:431` | „Keine Artikel passen…“ `:439` |
| Projects | `variant=table count=5` (`ProjectsView.tsx:192`) | `:194` | `:204` |
| EurView | Spinner `:620` | `:613`, `:880` | `:624`, `:891` |
| Settings | Spinner `:62` | `:51` | — |
| Recurring | Spinner `:296` | `:289` | `:301` |
| Pro `/accounting` | „Lade Pro-Buchhaltungsdaten…“ `:757` | role=alert `:773` | „Pro Kontenrahmen fehlt“ `:781` |

---

## 2. Erreichbarkeit und Tier-Strategie

### 2.1 Verifizierte Befunde (in dieser Sitzung ausgeführt)

| # | Befund | Beweis |
|---|---|---|
| V1 | Der **Lite-Renderer läuft vollständig in reinem Chromium ohne Electron und ohne Server**: `getRendererApi()` fällt auf `createLiteMockInvoke()` zurück, wenn `globalThis.billmeApi` fehlt (`packages/desktop-renderer/src/runtime-api.ts:43-58`). | `pnpm -C apps/desktop exec vite --port 4310` + `playwright-cli open http://127.0.0.1:4310/#/documents` → Screenshot zeigt gefüllte Rechnungsliste (RE-2023-001…, Status-Pills), keine Konsolenfehler außer der React-DevTools-Info. |
| V2 | **Lite-Mock deckt alle Lite-IPC-Routen ab**: 0 von 84 fehlend. | Diff `packages/desktop-contracts/src/contract.ts` gegen die `case`-Zweige in `packages/desktop-services/src/mockEngine.ts`. |
| V3 | **Pro-Mock ist unvollständig**: 39 von 157 Pro-Routen fehlen — alle in Buchhaltung, Steuer und Eingangsrechnungen (`pro:getAccountingPolicy`, `pro:listOpenItems`, `pro:getReportingReport`, `pro:listVendors`, `pro:uploadIncomingInvoiceDocument`, `tax:saveAuditExportPackage`, …). | derselbe Diff; sichtbar als `Pro-Buchhaltungsdaten konnten nicht geladen werden: Error: Unsupported IPC route in mock backend: pro:getAccountingPolicy` (`/accounting` in Chromium). |
| V4 | Die geteilten Pro-Views (Dashboard, Dokumente, Kunden, Projekte, Artikel, Abos, Einstellungen, Vorlagen, EÜR) laufen dagegen im Pro-Mock. | Pro-Renderer auf Port 4311 geöffnet, Navigation intakt (7 Nav-Items inkl. „Steuer“). |
| V5 | **`playwright-cli` kann sich per CDP an eine laufende Electron-App anhängen** und deren Renderer fernsteuern. | `playwright-cli attach --cdp=http://127.0.0.1:9333` gegen `electron --remote-debugging-port=9333` → Session `proelectron`, Snapshot der echten App. |
| V6 | **Ohne `BILLME_E2E=1` startet der Preload nicht** und die App fällt still auf den Mock zurück: `Unable to load preload script … Error: module not found: crypto`. Ursache: `sandbox: !process.env.BILLME_E2E` (`apps/pro-desktop/electron/main.ts:35`, `apps/desktop/electron/main.ts:37`). | Electron-Konsole im angehängten CDP-Browser. |
| V7 | `playwright-cli` blockiert `goto file://…` („Access to "file:" protocol is blocked“); Hash-Navigation muss über `eval "() => location.hash = '#/x'"` erfolgen — oder über einen HTTP-Renderer-Server. | reproduziert gegen die laufende Electron-App. |
| V8 | Beide Renderer-Dev-Server nutzen Port 3000; Port 3100 ist auf dieser Maschine bereits durch ein fremdes Projekt (`aveda-os-web`) belegt. | `ss -ltnp`; `vite --strictPort` startete erst auf 4310/4311. |

### 2.2 Tier-Matrix

| Tier | Ziel-Oberflächen | Kanal | Infrastruktur | Status |
|---|---|---|---|---|
| **A1** | Alle 16 Lite-Routen, alle Lite-Modals, alle Lite-Zustände, Lite-Flows | reines Chromium gegen `vite`-Dev-Server von `apps/desktop` | keine | verifiziert (V1–V2) |
| **A2** | Pro: alle mit Lite geteilten Routen (13), Pro-Nav/Shell, Pro-Modals 1–24 | reines Chromium gegen `vite` von `apps/pro-desktop` | keine | verifiziert (V4) |
| **A3** | Landing-Page, Designer-Playground | Chromium gegen `vite` (4173 / 4177) | keine | erwartbar (reine Vite-Apps) |
| **B1** | Pro `/accounting`, `/tax-filing`, Pro-Accounts mit Buchhaltungs-IPC, Pro-EÜR-Vollfunktion | **Electron + CDP-Attach**, `BILLME_E2E=1`, `VITE_DEV_SERVER_URL` auf statischen Renderer-Server | `electron-vite build` für `apps/pro-desktop` | Kanal verifiziert (V5–V7), Vollständigkeit der Pro-UI in diesem Modus noch offen |
| **B2** | `apps/demo` (Durable-Object-Mock) | Chromium gegen `wrangler dev --local` | `wrangler`/`workerd` | offen |
| **C1** | `apps/web`, `apps/web-pro` (AuthScreen, Shell-Chrome, Rollen-Guard) | Chromium gegen `vite preview` + Postgres + `server-api` | Compose-Stack **oder** bestehender Harness mit `E2E_SERVER_KEEP_STACK=1` | offen |
| **C2** | `apps/offer-portal` (öffentliche Kundenansicht, Entscheidungsformular, Fehlerseiten) | Chromium gegen `tsx watch src/node.ts` (3001) + publizierter Snapshot | SQLite, `PUBLISH_API_KEY` | offen |
| **C3** | Electron-native Chrome: Titlebar-Fensterknöpfe, Auto-Updater-Button, native Dateidialoge, Druck-/PDF-Fenster (`?__print=1`), Systembenachrichtigungen | nur über B1 bzw. manuell | — | teils offen; PDF-Fenster separat als eigener Renderer-Aufruf screenshotbar |

**Regel:** Tier A/B/C werden in dieser Reihenfolge abgearbeitet. Ein Tier gilt als „abgedeckt“, wenn jede Oberfläche aus 1.2–1.8 mindestens einen Screenshot pro Viewport-Breite und mindestens einen Screenshot pro Modal besitzt.

---

## 3. Setup und Konventionen

### 3.1 Verzeichnis- und Namensschema

```
docs/audit/visual-audit-2026-09-16/
  manifest.tsv                  # app  tier  route/view  state  viewport  session  png  sha256
  probes/<app>/<route>.json     # Ergebnis der Layout-Probe
  shots/<app>/<viewport>/<route>-<state>.png
  shots/<app>/<viewport>/<route>-modal-<name>.png
  flows/<app>/<flow-id>/<nn>-<step>.png
  findings.json
  REPORT.md
```

Regeln:

- Dateiname = `<route-slug>-<state>.png`; `route-slug` = Pfad ohne führenden Slash, `/` → `_`, z. B. `documents_edit`.
- `state` ∈ `default | empty | loading | error | detail | modal-<name> | hover | focus`.
- Viewports: `1440x900` (Desktop-Referenz), `1280x720` (Laptop), `1024x768` (Tablet-Grenze, Nav-Strip unter `xl`), `390x844` (Mobile, laut bestehendem Test `pro-source-runs.spec.mjs`).
- `docs/` ist in `.gitignore` (Zeile 48) — Screenshots landen bewusst nicht im Commit. Sollen sie ins Repo, nach dem `pr-billme.md`-Muster mit `git add -f` erzwingen.

### 3.2 `playwright-cli`-Konventionen

- **Eine Session pro App** über `-s=<name>`: `lite`, `pro`, `proelectron`, `demo`, `web`, `webpro`, `landing`, `portal`, `designer`. Damit kollidieren parallele Läufe nicht (Sessions sind unabhängig; `playwright-cli list` zeigt alle).
- **Niemals das blanke `close-all`/`kill-all`** verwenden — es beendet fremde Sessions mit.
- Nach jeder Navigation `--raw` nutzen, wenn nur ein Wert gebraucht wird (`playwright-cli -s=lite --raw eval "…"`), sonst blähen die Snapshots die Ausgabe auf.
- Snapshots/Aria-Bäume schreibt `playwright-cli` ungefragt nach `./.playwright-cli/*.yml|log` (gitignoriert). Für den Audit genügt der Screenshot; `snapshot` nur bei Bedarf und mit `--depth`/`find`.

### 3.3 Determinismus vor jedem Screenshot

Pflicht-Präludium, einmal pro Session nach `open` und danach nach jedem `reload`:

```bash
playwright-cli -s=lite resize 1440 900
playwright-cli -s=lite run-code "async page => { await page.emulateMedia({ reducedMotion: 'reduce' }); }"
playwright-cli -s=lite reload
playwright-cli -s=lite run-code "async page => { await page.evaluate(() => document.fonts.ready.then(() => undefined)); }"
```

Regeln:

1. `reducedMotion: 'reduce'` vor dem Reload setzen — `DESIGN.md` („MOTION 1“) verlangt, dass ohne Vorliebe für Bewegung nichts animiert; der Schalter deckt zugleich den Reduced-Motion-Auditpunkt ab.
2. Warten, bis keine Lade-Indikatoren mehr sichtbar sind, statt fester `sleep`s:

```bash
until [ "$(playwright-cli -s=lite --raw eval "() => document.querySelectorAll('.animate-spin, .animate-pulse').length")" = "0" ]; do sleep 0.3; done
```

3. Mock-Daten sind **in-memory pro Seitenaufruf** (kein `localStorage` im Mock-Pfad). Ein `reload` setzt den Ausgangszustand zurück → garantierte Reproduzierbarkeit zwischen Läufen. Innerhalb eines Flows (z. B. Kunde anlegen) **nicht** reloaden.
4. Kein `--hires` für den Standardsweep (verdoppelt die Pixelmenge ohne Layout-Erkenntnis); `--hires` nur bei Detailfragen (Typo, Ränder).
5. `--full-page` für Listen/Formulare ohne fixe Chrome; **ohne** `--full-page` für Views mit fixem Header/Titlebar, damit das Overlap-Verhalten des Viewports sichtbar bleibt. Im Zweifel beide Varianten.

---

## 4. Durchführung — Screenshots

### 4.1 Vorbereitung

```bash
cd /run/media/merres/Volume/Coding2/GITHUB_RELEASES/rechnungs-editor-pro
export AUDIT=docs/audit/visual-audit-2026-09-16
mkdir -p "$AUDIT"/shots "$AUDIT"/probes "$AUDIT"/flows
: > "$AUDIT/manifest.tsv"
```

### 4.2 Tier A — Server starten

```bash
# Lite-Renderer (Mock-Daten, kein Backend nötig)
pnpm -C apps/desktop exec vite --port 4310 --strictPort --host 127.0.0.1 &

# Pro-Renderer
pnpm -C apps/pro-desktop exec vite --port 4311 --strictPort --host 127.0.0.1 &

# Landing + Designer-Playground
pnpm dev:landing &            # 4173
pnpm dev:editor &             # 4177
```

Ports bewusst abweichend von 3000: beide Renderer konfigurieren 3000 (`electron.vite.config.ts:48-51`, `apps/desktop/vite.config.ts:7-10`), was parallel nicht funktioniert; 3100 ist belegt (V8).

Sessions öffnen:

```bash
playwright-cli -s=lite open http://127.0.0.1:4310/#/
playwright-cli -s=pro  open http://127.0.0.1:4311/#/
playwright-cli -s=landing open http://127.0.0.1:4173/
playwright-cli -s=designer open http://127.0.0.1:4177/
```

> Hinweis: `open` gegen einen noch kompilierenden Vite-Server kann bis ~50 s dauern. Danach ist die App erst nach dem React-Mount sichtbar — **erst nach dem Mount screenshoten** (Präludium 3.3), sonst entsteht ein Bild mit dem `#root`-Platzhalter „Loading…“. Genau dieser Fehler wurde in der Verifikation provoziert und bestätigt.

### 4.3 Routen-Sweep

Muster je Route (Beispiel `/documents`, Lite):

```bash
playwright-cli -s=lite goto "http://127.0.0.1:4310/#/documents"
# … Präludium 3.3 (resize / reducedMotion / reload / fonts.ready / idle-wait) …
playwright-cli -s=lite screenshot --filename "$AUDIT/shots/lite/1440/documents-default.png"
playwright-cli --json eval "() => ({ hash: location.hash, title: document.title })" >> "$AUDIT/manifest.tsv"
```

Lite-Routen (Slug → URL-Hash):

`dashboard /` · `statistics /statistics` · `accounts /accounts` · `finance /finance` · `eur /eur` · `templates /templates` · `templates-editor-invoice /templates/invoice/editor` · `templates-editor-offer /templates/offer/editor` · `documents /documents` · `documents-edit /documents/edit` · `recurring /recurring` · `clients /clients` · `projects /projects` · `projects-detail /projects/<id>` · `articles /articles` · `settings /settings` · `notfound /gibt-es-nicht`

Pro-Routen: dieselbe Liste **ohne** `statistics`, **plus** `accounting /accounting` und `tax-filing /tax-filing`.

Deep-Links zusätzlich: `/documents?kind=offer`, `/documents?kind=invoice&status=overdue`, `/clients?id=<id>`, `/articles?query=web`.

Viewport-Matrix: jede der vier Breiten aus 3.1 einmal über die **Haupt-Nav-Routen** (Dashboard, Kunden, Projekte, Dokumente, Finanzen, Artikel, Einstellungen) — die Editor-Routen nur bei 1440 und 1024.

### 4.4 Modal-/Overlay-Sweep

Pro Dialog aus 1.4: Trigger ausführen, `snapshot` zur Bestätigung, dann Screenshot **ohne** `--full-page` (Overlay-Stapel muss im Viewport sitzen):

```bash
# Beispiel: Mahnlauf
playwright-cli -s=lite goto "http://127.0.0.1:4310/#/documents"
playwright-cli -s=lite click "getByRole('button', { name: 'Überfällig' })"
playwright-cli -s=lite click "getByRole('button', { name: /Mahnlauf/ })"
playwright-cli -s=lite screenshot --filename "$AUDIT/shots/lite/1440/documents-modal-mahnlauf.png"
playwright-cli -s=lite press Escape
```

Für jeden Dialog sind zusätzlich zu prüfen (eigene Screenshots): Zustand nach `Escape`, Klick auf Backdrop, und `Tab`-Reihenfolge (Fokusfalle, `packages/ui/src/components/Modal.tsx`). Beleg dafür: Screenshot mit sichtbarem Fokusring.

### 4.5 Zustands-Sweep

Die Zustände aus 1.9 sind ohne Server nur teilweise provozierbar. Wege:

| Zustand | Wie provozieren |
|---|---|
| Leer | Mock liefert für manche Domänen leere Listen (z. B. `/recurring` leer im Frischzustand) — Screenshot direkt nach `reload` |
| Ladend | `playwright-cli -s=lite run-code "async page => { await page.route('**/*', r => new Promise(() => {})); }"` blockt Antworten → Skeleton bleibt stehen; **vor** dem Screenshot wieder `unroute` |
| Fehler | gezielt `route`-Mock auf 500 für den betroffenen Aufruf, z. B. `playwright-cli -s=lite route "**/settings*" --status=500` (Dialog-Mock, siehe `references/request-mocking.md`) |
| Fehler (Pro, ohne Kunstgriff) | `/accounting`, `/tax-filing` und die Pro-Accounts liefern im Mock-Betrieb bereits echte Fehlerzustände (V3) — als Fehlerzustand-Screenshot verwenden, **aber im Report als Mock-Artefakt kennzeichnen, nicht als Produktfehler** |
| Globale Fehlergrenze | `run-code` mit `throw` in einem Renderpfad oder Route-Mock auf 500 für `settings:get` → „Diese Ansicht konnte nicht geladen werden“ |
| 404 | direkt `#/nicht-vorhanden` aufrufen |

### 4.6 Flow-Sweep (alle User-Flows)

Je Flow: ein eigener Ordner mit nummerierten Schritten und einem Ziel-Screenshot. Reihenfolge und Ziel:

**Lite**

| ID | Flow | Schritte | Zielbeweis |
|---|---|---|---|
| F-L1 | Onboarding aus leerem Profil | Frischer Mock → Wizard Schritt 1/2/3 → „Arbeitsbereich einrichten“ | 4 Screenshots, letzter = Dashboard ohne Wizard |
| F-L2 | Kunde anlegen/bearbeiten | `/clients` → Neu → Pflichtfeld leer → Fehler → ausfüllen → speichern → `?id=` Deep-Link | Fehler- und Erfolgszustand, Detailansicht |
| F-L3 | Artikel anlegen (netto/brutto, Kategorie) | `/articles` → Neu → speichern → Kategorie-Chip filtern | Karte + Liste |
| F-L4 | Projekt anlegen → archivieren | `/projects` → Neu → speichern → Zeile → Archivieren mit Grund | Editor + Archiv-Dialog |
| F-L5 | Angebot → Kunde akzeptiert → Rechnung | `/documents?kind=offer` → öffnen → Kette „Auftragsbestätigung“/Konvertierung | Kette-Panel + neue Rechnung |
| F-L6 | Rechnung erstellen → finalisieren → PDF | `/documents` → `+` → Kunde/Positionen → Speichern → Nummer finalisieren → Drucken/PDF-Aktion | Editor, `Grund der Änderung`-Dialog, Toast |
| F-L7 | Zahlung erfassen → bearbeiten → löschen | Dokument-Detail → „Zahlung erfassen“ → speichern → Zeile bearbeiten → löschen | 3 Modal-Screenshots + Statuswechsel |
| F-L8 | Mahnlauf | `/documents` Filter „Überfällig“ → Mahnlauf → Ergebnis | Lauf-Dialog + Ergebnis-Modal |
| F-L9 | E-Mail-Versand | Detail-Toolbar → „Per E-Mail senden“ | Modal inkl. Fehlerzustand (kein SMTP im Mock) |
| F-L10 | Belegkette | Detail → Kette-Buttons → Betragsdialog → Erstellen | je Kettenart ein Dialog |
| F-L11 | Abo anlegen + Generator | `/recurring` → Neu → speichern → Lauf starten | Editor + Lauf-Ergebnis |
| F-L12 | CSV-Import | `/accounts` → Bankkonto → CSV-Karte → Vorschau → bestätigen → Historie → Rollback | Vorschau-Confirm + Historie + Rollback-Confirm |
| F-L13 | Zahlungsabgleich | `/accounts` → „Transaktionen zuordnen“ → Transaktion + Rechnung → verknüpfen → entkoppeln | Matching-Ansicht + Unlink-Modal |
| F-L14 | EÜR klassifizieren + Export | `/eur` → Eintrag wählen → klassifizieren → Report → CSV/PDF | Queue, Report, Export-Toast |
| F-L15 | Einstellungen (9 Tabs) | `/settings` alle Tabs → speichern → Mahnstufe-Vorschau | 9 Tab-Screenshots + Toast |
| F-L16 | Vorlage + Dokument-Editor | `/templates` → Editor → Inspector/Layers → Element ziehen → Dokument-Editor edit/preview | Designer-Panels + Canvas |
| F-L17 | Globale Suche | `Cmd/Ctrl+K` → „KD-0001“ → Ergebnis wählen | Suchpanel + Zielansicht mit `?id=` |
| F-L18 | Shortcuts + 404 | `?` drücken, dann `#/nicht-vorhanden` | Modal + NotFound |

**Pro (zusätzlich zu F-L1…F-L18 in der Pro-App)**

| ID | Flow | Schritte |
|---|---|---|
| F-P1 | Inbox → Buchung erfassen → Posten | `/accounting` → Queue-Filter durchschalten → Vorgang öffnen → Validierungsfehler → Felder füllen → Posten |
| F-P2 | Kontierungsregeln CRUD | Regeln-Modal → anlegen → ändern → deaktivieren → löschen |
| F-P3 | Bankabgleich-Workbench | `/accounting` → Abgleich → Position wählen → zuordnen |
| F-P4 | Ausnahmen-Center | Filter durchschalten, Snooze, Resolve, leere Auswahl |
| F-P5 | Anlagen + AfA-Plan | Anlage anlegen → Abschreibungsplan öffnen |
| F-P6 | Auswertungen | 6 Report-Tabs → Drilldown-Panel → DATEV-Export-Panel |
| F-P7 | OPOS | Liste → Ausgleich-Vorschau |
| F-P8 | Sonderbuchungen & Abschluss | 13 Workflows + UStVA/ZM/OSS-Vorbereitung, inkl. Null-Zeilen-Artefakt |
| F-P9 | Steuer-Center | `/tax-filing`: Provider-, Zertifikats- und Einreichungsbereiche |
| F-P10 | Eingangsrechnungen | nur über Tier B/C (Mock deckt die Routen nicht ab, V3) |

**Browser-Shells (Tier C)**

| ID | Flow |
|---|---|
| F-W1 | Erststart `setup`: „Billme einrichten“ → Konto anlegen → Renderer |
| F-W2 | Login: „Willkommen zurück“ → Anmelden → Dashboard |
| F-W3 | Logout inkl. Notice „Du wurdest abgemeldet.“ |
| F-W4 | Stale Token: gespeicherte Session manipulieren → Reload → Login |
| F-W5 | `unreachable`: `VITE_SERVER_API_URL` auf toten Port → Fehlerzustand |
| F-W6 | Pro: Onboarding-Vollbild → Arbeitsbereich |
| F-W7 | Pro: Route-Guard mit falschem Produkt-Session |

### 4.7 Tier B — Electron, Demo, Playground

**B1 Electron mit echter lokaler Datenbank (nötig für Pro-Buchhaltung):**

```bash
# 1) Renderer bauen und statisch ausliefern (umgeht die file://-Sperre, V7)
pnpm -C apps/pro-desktop build
node -e "const h=require('http'),f=require('fs'),p=require('path');const r='apps/pro-desktop/dist/renderer';h.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);let t=p.join(r,u);if(!f.existsSync(t)||f.statSync(t).isDirectory())t=p.join(r,'index.html');s.setHeader('content-type',{'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[p.extname(t)]||'application/octet-stream');s.end(f.readFileSync(t))}).listen(4312,'127.0.0.1')" &

# 2) Electron headless starten — BILLME_E2E=1 ist zwingend (V6), sonst kein Preload
xvfb-run -a node_modules/electron/dist/electron \
  --no-sandbox --disable-gpu-sandbox --remote-debugging-port=9333 \
  --user-data-dir=/tmp/billme-pro-audit \
  apps/pro-desktop &

# 3) Anhängen und navigieren
playwright-cli -s=proelectron attach --cdp=http://127.0.0.1:9333
playwright-cli -s=proelectron goto "http://127.0.0.1:4312/index.html#/accounting"
```

Alle Prüfungen von `window.billmeApi` (IPC-Kanal vorhanden), Datensätze und PGlite-Zustand sind damit echt; `?__print=1`-Fenster sind als eigene URL auf demselben statischen Server screenshotbar.

**B2 Demo:**

```bash
pnpm dev:demo     # wrangler dev --local, Durable-Object-Mock
playwright-cli -s=demo open http://127.0.0.1:8787/#/
```
Banner „Demo mit Beispieldaten…“ und alle 6 Nav-Routen screenshotten; `POST /api/session/reset` vor jedem Lauf für Determinismus.

**A3 Designer-Playground:** Fixtures `construction | page-break | all-line-types | long-text | mixed-vat` durchschalten — deckt Canvas, Rulers, GridOverlay, Inspector, LayersPanel ohne App-Shell ab.

### 4.8 Tier C — Server-Mode-Shells und Portal

Empfohlen über den bestehenden Harness, weil er Ports, Migration und Seed bereits löst:

```bash
E2E_SERVER_KEEP_STACK=1 node tests/e2e/server/run-suite.mjs smoke lite
# Stack bleibt stehen; URLs stehen in test-results/server-mode/runtime-state.json
jq -r '.urls.web, .urls.webPro, .urls.api' test-results/server-mode/runtime-state.json
```

Alternative ohne Harness: `pnpm docker:server-mode:up` (Compose, Ports 3100/3001/4175/4176).

Login: für reinen UI-Audit den echten Formularweg nehmen (nicht die localStorage-Injektion), damit der `AuthScreen` selbst geprüft wird: `lite-owner@billme-e2e.local` / `billme-server-123` (`tests/e2e/server/lite/support.mjs:12`).

Portal:

```bash
pnpm -C apps/offer-portal dev          # 3001
# Snapshot publizieren (Schema-Referenz: apps/offer-portal/src/app.integration.test.ts)
curl -sS -X POST http://127.0.0.1:3001/offers \
  -H "x-api-key: $PUBLISH_API_KEY" -H 'content-type: application/json' --data @offer.json
```
Danach `/offers/:token`, `/invoices/:token`, `/d/:documentId`, `/d/:documentId/pdf`, das Entscheidungsformular, plus die vier Fehlerseiten (`unknown`, `revoked`, `expired`, `rate_limited` — letztere durch >180 Abrufe/min).

### 4.9 Komponenten-Galerie (optional, für Basis-Primitive)

`@billme/ui`-Primitive (Button-Varianten, Input-Zustände, Badge-Status, Combobox offen/leer, DatePicker, Toast-Arten, ValidationSummary) erscheinen in den Views nur ausschnittsweise. Für vollständige Abdeckung eine **temporäre** Vite-Seite anlegen, z. B. `apps/desktop/audit-gallery.tsx` + `audit-gallery.html`, die alle Primitives in allen Zuständen rendert; screenshotten; danach **Dateien löschen** (nicht committen). Das ist der einzige Eingriff in den Quellbaum, den dieser Plan vorsieht.

---

## 5. Automatisierte Layout- und Darstellungsproben

Ergänzt den visuellen Review um messbare Kriterien. Als wiederverwendbares Skript `tools/visual-audit/layout-probe.js` ablegen und je Route ausführen:

```bash
playwright-cli -s=lite --raw run-code --filename=tools/visual-audit/layout-probe.js \
  > "$AUDIT/probes/lite/documents.json"
```

Inhalt (Kern; Schwellen aus `DESIGN.md` und WCAG 2.2 AA):

```js
async page => {
  return await page.evaluate(() => {
    const issues = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    const root = document.documentElement;
    const label = (el) => {
      const cls = (el.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.');
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
    };
    const vis = (el) => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0 && r.width > 0 && r.height > 0;
    };
    const add = (rule, severity, el, detail) =>
      issues.push({ rule, severity, el: typeof el === 'string' ? el : label(el), detail });

    // L1 Dokument läuft horizontal über
    if (root.scrollWidth > root.clientWidth + 1)
      add('h-overflow', 'high', 'html', `scrollWidth=${root.scrollWidth} clientWidth=${root.clientWidth}`);

    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el)) continue;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();

      // L2 Element verlässt den Viewport (scrollbare Container ausgenommen)
      const scrolls = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if (s.position !== 'fixed' && r.width < vw * 0.98 && !scrolls) {
        if (r.right > vw + 1)  add('escapes-right', 'high', el, `right=${Math.round(r.right)} vw=${vw}`);
        if (r.left < -1)       add('escapes-left', 'high', el, `left=${Math.round(r.left)}`);
      }

      // L3 Text abgeschnitten ohne Ellipsis/Titel
      if (!el.children.length && (el.textContent || '').trim()) {
        if (el.scrollWidth > el.clientWidth + 1 && s.overflowX === 'hidden' && s.textOverflow !== 'ellipsis')
          add('text-clipped-x', 'medium', el, el.textContent.trim().slice(0, 40));
        if (el.scrollHeight > el.clientHeight + 2 && s.overflowY === 'hidden')
          add('text-clipped-y', 'medium', el, el.textContent.trim().slice(0, 40));
      }

      // L4 Interaktive Fläche unter 24x24 (DESIGN.md: WCAG 2.2 binding)
      const role = el.getAttribute('role');
      const interactive = el.matches('button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem]');
      if (interactive && (r.width < 24 || r.height < 24))
        add('target-too-small', 'medium', el, `${Math.round(r.width)}x${Math.round(r.height)}`);

      // L5 Radius außerhalb der Skala (DESIGN.md: 8/16/24/32/40/48 px oder Vollkreis)
      const br = parseFloat(s.borderTopLeftRadius || '0');
      if (br > 0) {
        const ok = [0, 8, 16, 24, 32, 40, 48].some((v) => Math.abs(br - v) < 0.6) || br >= 1000;
        if (!ok) add('radius-off-scale', 'low', el, `${br}px`);
      }
    }

    // L6 Kontrast (Text gegen effektiv zusammengesetzten Hintergrund)
    const lum = (c) => { const f = c / 255; return f <= 0.03928 ? f / 12.92 : ((f + 0.055) / 1.055) ** 2.4; };
    const rel = (rgb) => 0.2126 * lum(rgb[0]) + 0.7152 * lum(rgb[1]) + 0.0722 * lum(rgb[2]);
    const parse = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && !c.startsWith('rgba(0, 0, 0, 0')) return parse(c);
      }
      return [255, 255, 255];
    };
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el) || el.children.length) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      const s = getComputedStyle(el);
      const fg = parse(s.color), bg = bgOf(el);
      const a = rel(fg), b = rel(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(s.fontSize), bold = +s.fontWeight >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const min = large ? 3 : 4.5;
      if (ratio < min) add('contrast', ratio < min - 1 ? 'high' : 'medium', el,
        `${ratio.toFixed(2)}:1 < ${min} (${s.color} auf rgb(${bg.join(',')}))`);
    }

    // L7 Bild nicht geladen
    for (const img of document.images)
      if (img.complete && img.naturalWidth === 0) add('broken-image', 'high', img, img.currentSrc || img.src);

    // L8 Schrift nicht geladen (Fallback aktiv)
    if (!document.fonts.check('16px Inter')) add('font-fallback', 'medium', 'body', 'Inter nicht geladen');

    // L9 Beträge ohne tabular-nums
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el) || el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!/^-?[\d.]{1,12},\d{2}\s?€$/.test(t)) continue;
      const s = getComputedStyle(el);
      if (!/tabular-nums/.test(s.fontVariantNumeric))
        add('amount-not-tabular', 'low', el, t);
    }

    // L10 Overlays: Portal-Pflicht (body-Kind) und Layer-Token (--z-dropdown 30 / --z-overlay 40 / --z-toast 50)
    for (const el of document.querySelectorAll('[role=dialog], [role=alertdialog], [data-overlay], [role=menu], [role=listbox]')) {
      const box = el.parentElement ?? el;
      if (!box.parentElement || box.parentElement !== document.body)
        add('overlay-not-portaled', 'medium', el, `parent=${label(box.parentElement ?? box)}`);
      const z = getComputedStyle(box).zIndex;
      if (z !== 'auto' && !['30', '40', '50'].includes(z))
        add('layer-off-token', 'low', el, `z-index=${z}`);
    }

    return { url: location.href, vw, vh, issues, counts: issues.reduce((m, i) => (m[i.rule] = (m[i.rule] || 0) + 1, m), {}) };
  });
}
```

Zusätzlich (nicht im Skript, sondern per `playwright-cli`):

- **L11 Fokusring:** `press Tab` in Schleife, je Schritt `eval "() => { const a = document.activeElement; const s = getComputedStyle(a); return { tag: a.tagName, outline: s.outlineWidth + ' ' + s.outlineStyle, shadow: s.boxShadow }; }"` — fehlt `outline` **und** `box-shadow` am fokussierenden Element, ist das ein Befund (WCAG 2.4.11 / DESIGN.md).
- **L12 Konsolenfehler je Route:** `playwright-cli -s=lite --raw console error` — jeder Eintrag ist mindestens „medium“, sofern er nicht aus einem bewusst gemockten Fehlerzustand stammt.
- **L13 Deutsches Copy-Overflow:** `find --regex "[A-Za-zÄÖÜäöüß]{40,}"` im Snapshot; lange Komposita sind der häufigste Truncation-Auslöser in diesem Produkt.
- **L14 Status-Pills mit sichtbarer Grenze** (≥3:1, DESIGN.md): Elemente mit `BEZAHLT|OFFEN|ÜBERFÄLLIG|ENTWURF` prüfen auf `border-color` ≠ transparent.

Ergebnis: `probes/**.json` mit `counts` je Regel → Top-10-Liste für den Report, unabhängig vom visuellen Review.

---

## 6. Screenshot-Review auf Layout- und Darstellungsfehler

### 6.1 Vorgehen

1. **Batching:** Screenshots in Chargen von 12–16 Bildern, gruppiert nach App + Route, an Subagenten (Vision-fähig) mit identischer Checkliste und identischem Ausgabeschema. Jeder Befund enthält: `screenshot`, `view` (Region im Bild), `rule`, `severity`, `beschreibung`, `begründung` (Token-/WCAG-Bezug), `repro` (Kommando aus `manifest.tsv`).
2. **Vier-Augen-Prinzip nur bei P0/P1:** jeder P0/P1-Befund wird von einer zweiten Runde bestätigt (anderer Betrachter, gleicher Screenshot), um Fehlalarme durch Bildkompression oder Antialiasing zu eliminieren.
3. **Gegenprobe am DOM:** jeder visuelle Befund wird mit der Layout-Probe aus § 5 desselben Screenshots korreliert. Befund ohne Messgrundlage → in `findings.json` als `evidence: 'visual-only'` markiert.
4. **Aggregation:** `findings.json` deduplizieren nach `rule + selector + app`; `REPORT.md` sortiert nach Severity.

### 6.2 Fehlerkatalog (Checkliste je Screenshot)

| Kategorie | Worauf schauen |
|---|---|
| Überlauf | horizontale Scrollbar; abgeschnittene Spalten in Tabellen; Text ohne Ellipsis; Zahlen, die den Betrag rechts abschneiden |
| Überlappung | Header/Sticky-Chrome über Inhalt; Toast über primärer Aktion; Modal über Modal; Badge über Text; Dropdown hinter Karte |
| Ausrichtung | Baseline-Sprünge in Karten-Grids; unterschiedliche Innenabstände in einer Reihe; Zahlen nicht rechtsbündig; Icon nicht auf Textmitte |
| Abstände/Rhythmus | inkonsistente Gaps innerhalb eines Views; „RHYTHM 1“ (DESIGN.md) verletzt durch Sektionssprünge |
| Radien/Tiefe | Radien außerhalb der Skala (8/16/24/32/40/48 px, Vollkreis); Schatten-Sprünge; verschachtelte Radien größer als äußere |
| Farbe/Kontrast | `accent` als Textfarbe (verboten, 1.19:1); `border` als Controller-Rahmen statt `control-border`; Status-Pill ohne Rand; `-text`-Token nicht verwendet |
| Typografie | Schriftgrößen außerhalb `text-xs`…`text-base`; Beträge ohne `tabular-nums`; Fallback-Schrift sichtbar; Uppercase-Label ohne Tracking |
| Zustände | leerer Bildschirm ohne `EmptyState`; Skeleton bleibt stehen; Fehlertext ohne Retry; deaktivierter Button nicht unterscheidbar |
| Copy (DE) | Umbrüche mitten im Kompositum; doppelte Leerzeichen; „—“ statt „–“; „…“ fehlt bei Truncation |
| Editor (Dark) | Near-Black-Rampe konsistent; `no-print`-Chrome nicht sichtbar; Canvas-Seite klar vom Chrome abgesetzt |
| Druck/PDF | Seitenumbrüche, Kopf-/Fußzeile, keine Bedienelemente, `__PDF_READY__` erreicht |

### 6.3 Severity

| Stufe | Definition | Beispiel |
|---|---|---|
| **P0** | Unlesbar oder Handlung blockiert | Primäraktion von Overlay verdeckt; Modal ohne Schließen; leerer weißer Screen |
| **P1** | Klar sichtbarer Defekt, Nutzung möglich | Text abgeschnitten; Spalte überlagert; Kontrast unter 4.5:1 in Fließtext |
| **P2** | Politur/Inkonsistenz | Radius außerhalb der Skala; ungleiche Gaps; Icon-Baseline |
| **P3** | Geschmack/Begriff | Wortwahl, Mikro-Abweichung |

### 6.4 Berichtsformat

```markdown
## P1 — Betragsspalte in /documents abgeschnitten (1280x720)
- Screenshot: shots/lite/1280/documents-default.png
- Regel: text-clipped-x (Probe: probes/lite/documents.json → counts["text-clipped-x"]=3)
- Beleg: `InvoicesView.tsx` Betragszeile, Betrag endet auf "1.25…" ohne Ellipsis
- Repro: playwright-cli -s=lite goto "http://127.0.0.1:4310/#/documents"
- Vorschlag: `tabular-nums` + `min-w` an der Betragsspalte
```

Abschluss des Reports: Abdeckungsnachweis — welche Routen/Modals/Flows aus § 1 einen Screenshot haben und welche nicht (mit Grund). Ohne diesen Abschnitt gilt der Audit nicht als abgeschlossen.

---

## 7. Ablaufplan

| Phase | Inhalt | Ergebnis | Aufwand (Schätzung) |
|---|---|---|---|
| P0 | Setup, Server, Sessions, Ordner, Präludium-Helfer, `layout-probe.js` | lauffähige Umgebung | 0,5 h |
| P1 | Tier A1: Lite-Routensweep, 1440 | 16 PNG | 1 h |
| P2 | Tier A2: Pro-Routensweep, 1440 | 18 PNG | 1 h |
| P3 | Viewport-Matrix 1280/1024/390 über Nav-Routen | ~60 PNG | 2 h |
| P4 | Modal-Sweep (28 Dialoge × Lite/Pro) | ~50 PNG | 3 h |
| P5 | Zustands-Sweep (leer/ladend/fehler/404) | ~25 PNG | 1,5 h |
| P6 | Flow-Sweep F-L1…F-L18, F-P1…F-P9 | ~150 PNG | 6 h |
| P7 | Tier B1 (Electron Pro), A3 (Playground), B2 (Demo) | ~80 PNG | 3 h |
| P8 | Tier C (web, web-pro, offer-portal, server-api) | ~50 PNG | 3 h |
| P9 | Layout-Proben über alle besuchten Routen | `probes/**.json` | 1 h |
| P10 | Vision-Review in Chargen + Vier-Augen für P0/P1 | `findings.json` | 4 h |
| P11 | Triage gegen `DESIGN.md`/WCAG, `REPORT.md`, Fix-Tickets | Report | 2 h |

**Abbruchkriterien**

- Vite-Dev-Server liefert nach 90 s kein DOM → Umgebungsthema, nicht Produktbefund: abbrechen und melden.
- Eine Route wirft im Mock einen `Unsupported IPC route`-Fehler (V3) → Screenshot als Mock-Artefakt ablegen, im Report kennzeichnen, **nicht** als Produktfehler zählen; die Oberfläche in Tier B nachziehen.
- > 20 % der Screenshots sind Platzhalter („Loading…“, leeres `#root`) → Determinismus-Präludium fehlerhaft, Charge wiederholen statt bewerten.

---

## 8. Bekannte Fallstricke

1. **Port 3000 doppelt belegt** durch beide Renderer-Konfigurationen; 3100 ist auf dieser Maschine fremdbelegt. Immer `--strictPort` mit explizitem Port verwenden und den Fehler „Port is already in use“ nicht als App-Fehler lesen.
2. **Platzhalter-Screenshot:** direkt nach `open` ist `#root` noch `Loading…`. Ohne Mount-Warten ist das Ergebnis wertlos (in der Verifikation reproduziert).
3. **Mock-Lücken Pro (V3):** 39 Routen fehlen. Buchhaltung/Steuer/Eingangsrechnungen sind im Browser allein nicht auditierbar.
4. **Electron ohne `BILLME_E2E=1`:** Preload scheitert an `module not found: crypto`, die App fällt still auf den Mock zurück — man auditiert dann versehentlich den falschen Zustand (V6).
5. **`file://` gesperrt (V7):** in angehängten Electron-Sessions nur Hash-Navigation per `eval` oder statischer HTTP-Server.
6. **`close-all`/`kill-all`** beenden fremde Sessions; nur die eigene Session schließen.
7. **`.playwright-cli/`** füllt sich mit Snapshots/Logs (gitignoriert); für den Audit nicht als Artefakt verwenden.
8. **Reduced-Motion erst nach Reload prüfen** — die Medien-Emulation muss vor dem Rendern gesetzt sein, sonst ist der Screenshot nicht reproduzierbar.
9. **Portal- und Worker-Flows** brauchen Rate-Limit-Bewusstsein: > 180 Abrufe/min auf `/offers/:token` erzeugen absichtlich `rate_limited`.

---

## 9. Definition of Done

- [ ] Jede Zeile aus 1.2–1.8 hat mindestens einen Screenshot; fehlende Zeilen sind in `REPORT.md` mit Grund gelistet.
- [ ] Alle 28 Dialoge aus 1.4 je Produkt gescreenshottet (Trigger sichtbar + offen + geschlossen).
- [ ] Alle vier Viewports aus 3.1 über die Nav-Routen abgedeckt.
- [ ] Alle Flows F-L1…F-L18, F-P1…F-P10, F-W1…F-W7 mit Schrittfolge dokumentiert.
- [ ] `probes/**.json` für jede besuchte Route vorhanden; `counts` im Report aggregiert.
- [ ] `findings.json` und `REPORT.md` erstellt; jeder P0/P1-Befund gegengeprüft und mit Repro-Kommando versehen.
- [ ] Kein Befund ohne Screenshot-Referenz; kein Screenshot ohne Manifest-Eintrag.

## 10. Offene, noch zu verifizierende Punkte

1. **Tier B1 Vollständigkeit:** ob `/accounting`, `/tax-filing` und die Pro-EÜR im Electron-Modus mit `BILLME_E2E=1` vollständig rendern, ist erst nach dem ersten Screenshot-Lauf belegbar (Kanal V5–V7 verifiziert, Datenlage nicht).
2. **Tier B2:** ob `wrangler dev --local` auf dieser Maschine startet (workerd ist im Einsatz, aber für ein anderes Projekt) — vor P7 prüfen.
3. **Tier C:** ob der Harness lokal den Podman-Process-Mode nimmt und ob `pnpm -C apps/web build` durchläuft.
4. **Portal-Fixture:** ein gültiges `offer.json`-Publish-Payload muss aus `apps/offer-portal/src/app.integration.test.ts` abgeleitet werden.
5. **Zahl der Screenshots** ist geschätzt; die Manifest-Zeilen nach P6 sind die verbindliche Zahl.
