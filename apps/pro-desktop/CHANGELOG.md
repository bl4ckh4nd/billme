# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Added guided DE/AT/CH VAT rates, cross-border tax-rule confirmation, and mandatory reverse-charge notices for invoice output.
- Aligned fresh SQLite billing-item tables with the shared invoice and offer repositories.

## [0.4.0] - 2026-07-24

### Added

- Added tenant-scoped fixed-asset accounting with monthly linear AfA, GWG and pool depreciation, disposals, journal posting, and SQLite/Postgres migrations.
- Connected Pro reports to live ledger data.

### Changed

- Consolidated shared Lite and Pro renderer, SQLite, Electron, mock, e-invoice, and utility implementations into workspace packages.
- Aligned Pro document totals and tax snapshots with the shared Lite/server tax-mode rules.

### Security

- Server mode now refuses production or database-backed startup with a missing, default, or weak session-signing secret.

### Fixed

- Corrected macOS native-package verification for the `Billme Pro.app` bundle.
