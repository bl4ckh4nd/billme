# Changelog

## Unreleased

- Die gemeinsame `ServerDatabase`-Naht unterstützt jetzt PostgreSQL und direktes persistentes PGlite mit serialisierten Abfragen, reentranten Transaktionen, kanonischen Drizzle-Migrationen und einem gemeinsamen Lifecycle für Embedded- und Hosted-Runtime.
- Das eigenständige `billme-pglite-migrate`-CLI migriert Lite- und Pro-SQLite-Datenbanken mit konsistentem Backup, Importlauf-/Count-Prüfung und atomarer Aktivierung in ein neues PGlite-Verzeichnis; vorhandene Ziele werden unverändert abgelehnt. Server-eigene HTTP-Routen fallen bei aktiver Embedded-PGlite-Verbindung nicht mehr still auf SQLite-IPC zurück.
- Der SQLite-Importer kann jetzt dieselbe `ServerDatabase`-Naht auch mit einem persistenten PGlite-Ziel verwenden; Migration, Transaktions-Rollback, Counts, Audit-Verifikation und Importlaufstatus bleiben dabei erhalten, während PostgreSQL-Advisory-Locks im single-process Ziel entfallen.
- Öffentliche Produkttexte und Metadaten beschreiben lokale Dokument- und Zahlungsabläufe klarer.
- Lite-Desktop-Onboarding, Navigation, Dokumentvorlagen sowie Import-, Portal-, E-Mail- und Fehlermeldungen geben konkretere nächste Schritte.
- Die Pro-Arbeitsbereiche und der Ausnahmebereich verwenden einheitlichere deutsche Begriffe für Buchhaltung und Verantwortlichkeiten.
- Browser-Shells, Demo, Server-API und Angebotsportal melden Fehler und Status verständlicher auf Deutsch.
