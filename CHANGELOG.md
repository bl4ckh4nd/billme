# Changelog

## Unreleased

- pnpm-10-CI-Installationen erlauben den nativen Build von `better-sqlite3`, Electron und `keytar` jetzt auch über die Root-Paketkonfiguration; dadurch stehen die benötigten Runtime-Artefakte für Import- und Electron-Tests zuverlässig bereit.
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
