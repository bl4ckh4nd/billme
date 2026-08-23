# Changelog

## Unreleased

- pnpm-10-CI-Installationen erlauben den nativen Build von `better-sqlite3`, Electron und `keytar` jetzt auch über die Root-Paketkonfiguration; dadurch stehen die benötigten Runtime-Artefakte für Import- und Electron-Tests zuverlässig bereit.
- Die Pro-Web-Shell verwendet jetzt den gemeinsamen, DOM-freien Pro-HTTP-Adapter; Hosted-Bearer, contract-validierte Antworten und native IPC-Fallbacks bleiben erhalten.
- Die Lite-Web-Shell verwendet jetzt den gemeinsamen, DOM-freien HTTP-Adapter; Hosted-Bearer, contract-validierte Serverantworten und Browser-Fallbacks bleiben dabei erhalten.
- Portal-, E-Mail-, Dunning- und Recurring-Aktionen sowie Tax-Audit-Exporte und verbleibende Pro-Buchhaltungsmutationen laufen im HTTP-Adapter jetzt tenant-sicher über Server/PGlite; native PDF-/Audit-Paket-Speicherung bleibt contract-validiert beim Electron-Fallback.
- Der Pro-HTTP-Client liegt jetzt als gemeinsamer, DOM-unabhängiger Service vor; Hosted-Bearer bleiben kompatibel, während Embedded-Aufrufe den privaten Local-Token-Handshake nutzen und fehlende lokale Verbindungen eindeutig melden.
- Der Pro-HTTP-Adapter routet jetzt Buchhaltungskatalog, Kontierungen, Journal-/Saldoabfragen, Reports, Anlagen, DATEV-Belege und Accounting-Source-Runs über die authentifizierte Server-/PGlite-Naht; Antworten und Schreibgründe bleiben am Pro-Contract validiert.
- EÜR-Berichte, Klassifikationen, Regel- und Anlagen-Fakten sowie Projekte und Finanzimport-Läufe werden im Pro-HTTP-Adapter jetzt tenant-sicher über Server/PGlite gelesen und mutiert; Import-Rollbacks und Transaktionsverknüpfungen bleiben auditiert und contract-validiert.
- Der Lite-HTTP-Business-Adapter liegt jetzt DOM-frei in `@billme/desktop-services`, unterstützt Hosted-Bearer- und Embedded-Local-Token-Authentifizierung und delegiert native Browserfunktionen über einen injizierten Contract-Fallback.
- Server-Automation verarbeitet Portal-Publikation/-Status, Kundenlinks, E-Mail-Outbox, Dunning und wiederkehrende Rechnungen jetzt tenant-sicher, idempotent und auditiert; Portal-Bearer-Tokens werden vor externer Publikation persistiert und der Portal-Publikationsstand bleibt in PostgreSQL/PGlite migrationsverwaltet.
- Projekte werden jetzt für Lite und Pro tenant-sicher über die Server-/PGlite-Naht gelesen, gespeichert und archiviert; Pro kann zusätzlich einen rollenbeschränkten, tenant-scoped Tax-Audit-Export mit optionalen Dokumenten erzeugen.
- EÜR-Cash-Items unterstützen jetzt autoritative Suche, Quelle, Fluss, Konto, Status und Pagination; EÜR-Regeln bleiben tenant-sicher, rollenbeschränkt, auditiert und für Lite/Pro über dieselbe Server-/PGlite-Naht verfügbar.
- Lite und Pro können CSV-Finanztransaktionen jetzt über die gemeinsame Server-/PGlite-Naht mandantensicher importieren, deduplizieren, prüfen, zurückrollen und mit Rechnungen verknüpfen; jede Mutation bleibt atomar und auditiert.
- Die gemeinsame `ServerDatabase`-Naht unterstützt jetzt PostgreSQL und direktes persistentes PGlite mit serialisierten Abfragen, reentranten Transaktionen, kanonischen Drizzle-Migrationen und einem gemeinsamen Lifecycle für Embedded- und Hosted-Runtime.
- Das eigenständige `billme-pglite-migrate`-CLI migriert Lite- und Pro-SQLite-Datenbanken mit konsistentem Backup, Importlauf-/Count-Prüfung und atomarer Aktivierung in ein neues PGlite-Verzeichnis; vorhandene Ziele werden unverändert abgelehnt. Server-eigene HTTP-Routen fallen bei aktiver Embedded-PGlite-Verbindung nicht mehr still auf SQLite-IPC zurück.
- Der SQLite-Importer kann jetzt dieselbe `ServerDatabase`-Naht auch mit einem persistenten PGlite-Ziel verwenden; Migration, Transaktions-Rollback, Counts, Audit-Verifikation und Importlaufstatus bleiben dabei erhalten, während PostgreSQL-Advisory-Locks im single-process Ziel entfallen.
- Die Hosted-Fastify-Kernkomposition ist als eigenständiges `@billme/server-runtime`-Paket bezogen und kann unabhängig vom `server-api`-Entrypoint eingebunden werden.
- Die vollständigen Hosted-Pro-Accounting-Routen sind jetzt Teil derselben Runtime-Komposition und behalten ihre Authentifizierungs- und Rollenprüfungen beim Paketwechsel bei.
- Hosted-Lite- und -Pro-Instanzen können ihre tenantbezogene Audit-Kette jetzt prüfen und als CSV exportieren; beide Endpunkte bleiben hinter der jeweiligen Produktauthentifizierung.
- Die lokale Runtime startet Lite und Pro jetzt mit einem per-Start-Token geschützten HTTP-Server auf persistentem PGlite; Migrationen, Tenant-Scope und atomare Restore-Prüfung bleiben vor dem Listener-Start abgeschlossen.
- Die Pro-Server-Fixtures und E2E-Prüfungen decken jetzt das vollständige Vorsteuer-/Journal-Referenzkonto sowie die aktuelle Onboarding- und Accounting-Oberfläche ab.
- Öffentliche Produkttexte und Metadaten beschreiben lokale Dokument- und Zahlungsabläufe klarer.
- Lite-Desktop-Onboarding, Navigation, Dokumentvorlagen sowie Import-, Portal-, E-Mail- und Fehlermeldungen geben konkretere nächste Schritte.
- Die Pro-Arbeitsbereiche und der Ausnahmebereich verwenden einheitlichere deutsche Begriffe für Buchhaltung und Verantwortlichkeiten.
- Browser-Shells, Demo, Server-API und Angebotsportal melden Fehler und Status verständlicher auf Deutsch.
