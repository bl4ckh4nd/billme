# Changelog

## Unreleased

- pnpm-10-CI-Installationen erlauben den nativen Build von `better-sqlite3`, Electron und `keytar` jetzt auch über die Root-Paketkonfiguration; dadurch stehen die benötigten Runtime-Artefakte für Import- und Electron-Tests zuverlässig bereit.
- Die gemeinsame `ServerDatabase`-Naht unterstützt jetzt PostgreSQL und direktes persistentes PGlite mit serialisierten Abfragen, reentranten Transaktionen, kanonischen Drizzle-Migrationen und einem gemeinsamen Lifecycle für Embedded- und Hosted-Runtime.
- Öffentliche Produkttexte und Metadaten beschreiben lokale Dokument- und Zahlungsabläufe klarer.
- Lite-Desktop-Onboarding, Navigation, Dokumentvorlagen sowie Import-, Portal-, E-Mail- und Fehlermeldungen geben konkretere nächste Schritte.
- Die Pro-Arbeitsbereiche und der Ausnahmebereich verwenden einheitlichere deutsche Begriffe für Buchhaltung und Verantwortlichkeiten.
- Browser-Shells, Demo, Server-API und Angebotsportal melden Fehler und Status verständlicher auf Deutsch.
