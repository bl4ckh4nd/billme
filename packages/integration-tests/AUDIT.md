# Test-Audit Oktober 2026

Ziel: keine Unit-Tests mehr, jeder Ablauf der Anwendung über Integrations- und
End-to-End-Tests abgedeckt, die dabei gefundenen Fehler behoben.

## Testlandschaft danach

| Ebene | Wo | Läuft gegen |
| --- | --- | --- |
| Integration | `packages/integration-tests` | Desktop-Backends (Lite/Pro, PGlite), gehostete API (`buildServerApi` + PGlite hinter dem Postgres-Wire), Worker, Angebotsportal, Migrationen |
| Integration | `packages/server-data` | Repositories auf PGlite hinter dem Postgres-Wire (`with-pglite-wire.ts`) |
| Integration | `packages/server-runtime`, `apps/server-api`, `apps/offer-portal`, `packages/embedded-server-runtime`, `packages/server-cli` | echte Fastify/Hono-Apps, echte CLI-Prozesse |
| E2E | `tests/e2e/desktop`, `tests/e2e/pro` | gebaute Electron-Apps (Playwright, `xvfb-run`) |
| E2E | `tests/e2e/lifecycle` | Browser-Shells gegen zwei echte gehostete APIs (`servers.mts`) |
| E2E | `tests/e2e/server` | frischer Podman-Compose-Stack mit Postgres, API, Worker, SQLite-Portal und beiden Browser-Shells: 19/19 grün |

Entfernt bzw. umgebaut:

- 58 Unit-Tests in `server-data` (Fake-Pools, reine Funktionen, Quelltext-/SQL-Greps),
  14 Schema-Tests in `server-api`, die gemockte Migrations-CLI-Suite und die zwei
  statischen Paketierungs-Guards in `apps/desktop` (samt `test`-Skript und CI-Schritt).
- 41 Echt-Postgres-Tests in `server-data` liefen nie (übersprungen ohne `DATABASE_URL`);
  sie laufen jetzt auf PGlite.
- `tests/e2e/lifecycle` beantwortete alle Anfragen mit `page.route`-Attrappen; jetzt zwei
  echte gehostete APIs. Der rein synthetische Workspace-Test mit Mock-Daten ist entfallen.

## Vollständigkeit messbar

`pnpm -C packages/integration-tests coverage` (nach `test`, in CI) liest die
Routentabellen der gehosteten API, der eingebetteten Lite- und Pro-API und des
Portals und gleicht sie mit allen Anfragen der Suiten ab (`route-log.ts`).
Ergebnis: `test-results/integration/route-coverage.json`; der Schritt schlägt fehl,
solange eine registrierte Route nie aufgerufen wird. Zwei Sweep-Tests rufen jede
nicht-öffentliche Route ohne Sitzung bzw. mit falschem lokalem Token auf (gehostet
und Desktop) und prüfen, dass ein Viewer keine Lite-Mutation erreicht.

Die Billing-Suiten (Rechnungen, Angebote/Belegkette, Stammdaten, Automatisierung,
Bank) laufen einmal je Produkt (`PRODUCTS`/`startProduct`). CI fährt die
Integrationssuiten in `TZ=Pacific/Kiritimati` (UTC+14), damit UTC-statt-Ortszeit-Fehler
nicht nur zwischen 0 und 2 Uhr auffallen.

## Gefundene und behobene Fehler

Pro:

1. Rechnungsrevision → 500: die gebuchte Originalrechnung durfte nicht auf „storniert“
   wechseln (Trigger). Migration `0037` erlaubt die Statusprojektion.
2. Mahnlauf blockierte dauerhaft für jede gestellte (gebuchte) Rechnung, obwohl die
   Mahnung bereits versendet war: Gebühr und Stufe wurden auf die gebuchte Rechnung
   geschrieben. Stufe ist jetzt Projektion (`0037`), der gebuchte Betrag bleibt.
3. Transaktionsliste verlor `appliedAmountCents`/`unallocatedAmountCents` (Pro-Schema):
   der Abgleich zeigte bei Teilzuordnung falsche Beträge.
4. EÜR-Regeln ohne Wirkung: Vorschläge wurden nur für Lite berechnet.
5. Skonto und Forderungsausfall aus „Sonderbuchungen“ waren nie buchbar (Quellbeleg
   wurde nicht als Originalbeleg genommen, Vorlage mit Platzhaltern `invoice-id`/`RE-0001`
   und heutigem Steuerdatum); der Client verwarf außerdem die Antwort gebuchter
   Skonto-/Ausfallläufe (Zod-Enum) und meldete Fehler trotz Buchung. Servercodes
   erscheinen jetzt als deutscher Text.
6. „Im Editor öffnen“/„Zurück zur Inbox“ wechselten die Ansicht nur intern: Adresse und
   Navigation zeigten „Bankabgleich“, ein Klick darauf blieb danach wirkungslos.
7. `?asOfDate=kaputt` lieferte stillschweigend alle Salden; Workflow-Einträge (CLI)
   nahmen Nicht-JSON an.
8. Die CLI bot für Pro Kassen- und USt-Befehle an, die der Pro-Server nicht hat (404).

Lite und Pro:

9. Rechnungen mit Stornorechnung oder voller Gutschrift blieben „offen“ und wurden
   weiter gemahnt bzw. zum Bankabgleich vorgeschlagen; Teilzahlung plus Gutschrift
   wurde beim nächsten Speichern wieder „offen“.
10. Zeitzone: wiederkehrende Rechnungen (Rechnungsdatum, Fälligkeit, Leistungszeitraum),
    Mahnschreiben (Datum, „zahlbar bis“, Tage überfällig) und der CSV/PayPal/Stripe-Import
    rechneten mit dem UTC-Tag. In Deutschland landete z. B. ein Monatsabo, das am 1.
    zwischen 0 und 2 Uhr läuft, im Vormonat, und PayPal-Zahlungen nach Mitternacht am Vortag.
    Ebenso die „heute“-Vorbelegungen mehrerer Formulare.
11. Belegkette: englische Servermeldungen mit „Error:“-Präfix im Rechnungsdialog.
12. Produktneutrale Auth-Routen (`/api/v1/auth/*`, CLI `whoami`) antworteten 500 statt 409/401.
13. Mahnstufen-Felder (Tage, Gebühr) ohne zugänglichen Namen.

Tests: die zwei seit Wochen roten `server-runtime`-Tests hatten veraltete Fixtures;
`today()` der Integrationsfixtures rechnete in UTC; die Pro-Transkripte zweier Suiten
überschrieben sich gegenseitig.

## Verhaltensänderungen (für PR/CHANGELOG)

- Migration `0037_server_data_posted_invoice_projections`: gebuchte Rechnungen dürfen den
  Status „storniert“ und eine neue Mahnstufe als Projektion annehmen; das Journal bleibt.
- Belegkette: eine gestellte Stornorechnung setzt die Quelle auf „storniert“; Gutschriften,
  die zusammen mit Zahlungen den Betrag decken, setzen sie auf „bezahlt“.
- Pro-Mahnlauf: auf gebuchten Rechnungen keine Gebühr mehr (vorher: Lauf brach ab).
- Datum: Abo-Rechnungen, Mahnschreiben und Formular-Vorbelegungen nutzen den lokalen
  Kalendertag statt des UTC-Tages.
- CSV-Import: das Datum wird so übernommen, wie es in der Datei steht; auch bei Exporten
  mit ausdrücklicher UTC-Zeit (z. B. Stripe „Created (UTC)“) wird nicht mehr umgerechnet.
- Sonderbuchungen: bei Skonto/Forderungsausfall ohne genannten Originalbeleg gilt der
  Quellbeleg (Id oder Rechnungsnummer) als Original; die §17-Angaben zum Original werden
  daraus ergänzt.
- Belegketten-Fehlertexte sind deutsch (Integrationstests prüfen die neuen Texte).
- Pro-`editor` ist eine routbare Ansicht (`/accounting?view=editor`); ohne ausgewählte
  Bankzeile zeigt sie den Posteingang.
- CLI: `billme actions --product pro` listet keine `cash`/`vat`-Befehle mehr.

## Servermodus-Abnahme am 07.10.2026

- Ein ununterbrochener vollständiger Lauf auf einem neu gebauten Compose-Stack:
  **19 Szenarien grün**, darunter 38 Belegquellen- und 20 Buchhaltungs-Negativfälle.
  Prozess-Fallback war ausgeschaltet. Migrationen liefen gegen leeres echtes Postgres.
- Veraltete Fixtures wurden an die geltenden Regeln angepasst: gültige IBAN und
  GmbH-Berichtsprofile, eigene Mandanten, unveränderliche versandte Angebote,
  serverberechnete Steuern und die aktuelle Browser-Navigation. Reservierungs- und
  Backfill-Fehlerfälle verwenden tatsächlich ungebuchte historische Rechnungen;
  gebuchte Rechnungen bleiben bei einem Wiederholungsaufruf unverändert.
- Viewer melden sich mit echten gespeicherten Zugangsdaten an. Worker-Flüsse
  veröffentlichen im echten SQLite-Portal und prüfen die gespeicherte Kundenentscheidung;
  ein echter SMTP-Empfänger bestätigt die Zustellung. Die kontrollierten Worker-Läufe
  starten den produktiven Worker einmalig auf dem Host gegen das Compose-Postgres;
  zusätzlich läuft der Worker-Container mit seinen regulären Jobs und Healthchecks.
- Dabei gefunden und behoben: Bei gemischten USt-Sätzen wurde eine angeforderte
  Teilgutschrift von 20,00 € als 20,01 € gebucht. Anteilig abgerechnete Mengen passen
  jetzt zu den centgenauen Nettobeträgen bei unverändertem Einzelpreis und Rabatt.
  Nicht darstellbare Bruttobeträge liefern 422 vor dem Speichern; die umgebende
  Transaktion rollt auch die Nummernreservierung zurück. Der geprüfte offene Posten
  behält nach der Gutschrift einen Restbetrag von 50,40 €.
- Gedruckte Mengen zeigen bis zu sechs statt drei Nachkommastellen; das gilt auch
  beim erneuten Ausdruck vorhandener Belege. Finanzielle Snapshots bleiben unverändert.
  Die echte Gutschrift wurde als PDF erzeugt, der Text geprüft und die gerenderte Seite
  visuell kontrolliert (Mengen 0,1424/0,1425, netto 17,09 €, USt 2,91 €, brutto 20,00 €).
- Podman verwendet einen isolierten Overlay-Speicher unter `/tmp`, setzt `TMPDIR`
  und baut sequenziell, um den Platzbedarf zu begrenzen. Der Harness führt die
  deklarierten Healthchecks im richtigen Speicher aus; er setzt keinen künstlichen
  Healthy-Status. Stack, Volumes und isolierter Image-Speicher sind nach dem Lauf entfernt.
- Nach dem gemeinsamen Rechenfix: UTC+14-Integration **1146 bestanden, 1 bestehender
  offener Mahngebühr-Fehler, 0 fehlgeschlagen**; Route-Coverage **321/321**.
  Typechecks von server-core, server-data, Integration, web und web-pro sind grün.
  Keine Unit-Tests oder gemockten E2E hinzugefügt; nichts committed.

Beleg des vollständigen Laufs:
`test-results/server-mode/acceptance-20261007-0903/summary.json` (`mode: compose`,
`freshStack: true`, `selected: 19`, `passed: 19`). Pro Browser-Szenario liegen dort
Playwright-Traces, Screenshots und HTTP-Statusprotokolle. Die geprüfte Gutschrift liegt
unter `pro-outgoing-document-chain/credit-note.{pdf,png,txt}`; CLI-PDFs und
Archiv-Downloads sind ebenfalls erhalten. Das Laufprotokoll liegt unter
`.test-logs/server-e2e-fixes/compose-full-final.log`.

## Wiederholen

```bash
pnpm -C packages/integration-tests test && pnpm -C packages/integration-tests coverage
TZ=Pacific/Kiritimati pnpm -C packages/integration-tests test
pnpm -C apps/desktop build && pnpm -C apps/pro-desktop build
# Hosts, die ELECTRON_RUN_AS_NODE=1 vererben (z. B. manche Agenten-Umgebungen), müssen es vorher entfernen.
AUDIT_DESKTOP_SPECS="$(ls tests/e2e/desktop/*.spec.mjs | xargs -n1 basename | paste -sd,)" \
AUDIT_PRO_SPECS="$(ls tests/e2e/pro/*.spec.mjs | xargs -n1 basename | paste -sd,)" \
  xvfb-run -a npx playwright test -c playwright.audit.config.mjs --reporter=list,json
pnpm test:e2e:lifecycle
env -u ELECTRON_RUN_AS_NODE E2E_CONTAINER_RUNTIME=podman \
  E2E_SERVER_FORCE_COMPOSE=1 E2E_SERVER_ALLOW_PROCESS_FALLBACK=0 \
  E2E_SERVER_BOOT_TIMEOUT_MS=1200000 node tests/e2e/server/run-suite.mjs full
```

Artefakte: `test-results/integration/route-coverage.json` und die HTTP-Transkripte,
Screenshots/PDFs der E2E-Specs unter `test-results/`, Lifecycle unter
`<OS-Temp>/billme-lifecycle-artifacts`.

## Offen (Entscheidung nötig)

- Pro: Mahngebühren werden auf gebuchten Rechnungen nicht berechnet, das Mahnschreiben
  nennt die Gebühr (`%F`) aber trotzdem; zahlt der Kunde sie, entsteht eine Überzahlung.
  Dafür braucht es eine eigene Mahngebühr-Buchung samt Konto und offenem Posten
  (`todo: 'BUG: …'` in `automation.test.ts`, `chargedFee` kodiert den Ist-Stand).
- Pro: „Gesellschaftervorgang“ dokumentiert nur (kein Journal), die Meldung klingt aber
  nach Eingabefehler („Bitte Beträge … prüfen“).
- CSV-Exporte (Belege, Audit, EÜR) neutralisieren keine Formel-Zellen (`=…`).
- Weitere englische API-Fehlertexte außerhalb der Belegkette (z. B. „Invoice not found“).
- Kunden: erneuter Aufruf von „Kunden“ bleibt in der geöffneten Kundenansicht.
- Scheitert ein Test mitten im Pro-Backup-Restore, beendet sich der Testprozess nicht.
