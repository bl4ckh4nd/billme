# Changelog

All notable changes to Billme are documented in this file.

## [0.3.0] - 2026-07-20

### Added

- Billme Pro desktop application with accounting workflows, ledger and EÜR tooling, banking reconciliation, reports, inbox processing, and a dedicated product database/profile.
- Server mode with Fastify/Postgres persistence, Lite and Pro browser shells, background jobs, tenant-scoped authentication, and Docker/GHCR deployment support.
- Native mobile app with secure device pairing, offline capture, receipt upload, push notifications, and Lite/Pro server-mode support.
- Platform administration for provisioning server-mode workspaces and users.
- Scoped agent control across the CLI, server API, and token-protected desktop loopback bridge.
- Shared visual document designer for Lite and Pro invoices and offers.
- Background receipt processing and durable document rendering in the server worker.
- Per-invoice tax modes with persisted tax snapshots, small-business handling, shared ZUGFeRD/e-invoice normalization, and matching editor controls.
- Public offer portal access links, document history, stable snapshot identifiers, and customer decision flows.
- Offer-to-invoice conversion and explicit draft-offer finalization.
- Business onboarding, keyboard shortcuts, notification center, refreshed dashboards, and broad UX improvements across core desktop flows.
- Public landing page and Cloudflare Worker demo with expanded in-browser mock workflows.
- Shared packages for desktop contracts, data, services, hooks, state, utilities, UI, accounting, and server domain logic.
- Desktop, Pro, and server-mode Playwright coverage plus expanded repository, service, IPC, and accounting tests.

### Changed

- Split large Lite, Pro, and accounting screens into smaller co-located modules.
- Unified browser-shell authentication and shared design-system styling across product surfaces.
- Hardened server authorization, tenant capability checks, authentication throttling, and outbound portal URL policy.
- Expanded server-mode deployment, architecture, mobile, and agent-control documentation.
- Migrated server persistence to shared Drizzle-backed Postgres repositories and mirrored incremental migration trees.
- Centralized billing repositories, desktop IPC contracts, shared renderer/runtime utilities, and Pro accounting composition behind workspace packages.
- Aligned Lite, Pro, desktop, web, and demo behavior while keeping product and runtime boundaries explicit.
- Extended the Pro accounting model and refreshed the accounting workspace, transaction inbox, and reporting surfaces.
- Replaced the MIT license with the Functional Source License 1.1.
- Expanded CI to validate Lite and Pro releases, package native Electron dependencies, run server smoke coverage, and publish versioned GHCR images.

### Fixed

- Preserved unique customer and document numbering, including reservation/finalization and failure-release behavior.
- Preserved server-mode invoice and offer data across Postgres migrations and save/refetch flows.
- Hardened browser and Electron runtime identifier generation.
- Improved worker scheduling, queued side effects, and receipt-processing diagnostics.
- Restored Electron application identity, Vite environment typing, renderer-safe shared exports, and browser IPC proxy typing.
- Repaired Pro web image builds, runtime API URL resolution, lazy API initialization, React Query dependencies, and desktop/web parity.
- Restored legacy invoice defaults and tax-mode defaults during migration and merge reconciliation.
- Included previously missing source files and native runtime dependencies in builds and release packaging.

[0.3.0]: https://github.com/bl4ckh4nd/billme/compare/v0.2.0...v0.3.0
