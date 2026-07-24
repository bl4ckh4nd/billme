# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-07-24

### Added

- Added tenant-scoped fixed-asset accounting with monthly linear AfA, GWG and pool depreciation, disposals, journal posting, and SQLite/Postgres migrations.
- Connected Pro reports to live ledger data.

### Changed

- Consolidated shared Lite and Pro renderer, SQLite, Electron, mock, e-invoice, and utility implementations into workspace packages.
- Aligned Pro document totals and tax snapshots with the shared Lite/server tax-mode rules.

### Security

- Server mode now refuses production or database-backed startup with a missing, default, or weak session-signing secret.
