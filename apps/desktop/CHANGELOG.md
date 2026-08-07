# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Added guided DE/AT/CH VAT rates, cross-border tax-rule confirmation, VIES checks, and mandatory reverse-charge notices for invoice output.
- Aligned fresh SQLite billing-item tables with the shared invoice and offer repositories.

## [0.4.0] - 2026-07-24

### Changed

- Consolidated shared Lite and Pro renderer, SQLite, Electron, mock, e-invoice, and utility implementations into workspace packages.
- Moved shared behavior tests to their package owners while retaining separate Lite and Pro bootstrap coverage.

### Security

- Server mode now refuses production or database-backed startup with a missing, default, or weak session-signing secret.
