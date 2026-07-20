# Changelog

All notable changes to Billme are documented in this file.

## [0.3.7] - 2026-07-20

### Fixed

- Disable package lifecycle scripts while copying isolated release dependencies, leaving cross-platform native rebuilding exclusively to Electron Builder after the stage is prepared.

## [0.3.6] - 2026-07-20

### Fixed

- Verify the macOS Pro native modules inside `Billme Pro.app` instead of using the Lite application bundle name.

## [0.3.5] - 2026-07-20

### Fixed

- Let Electron Builder rebuild native modules directly from each isolated production stage, removing a redundant pre-packaging rebuild that could not resolve the staged project context on hosted runners.

## [0.3.4] - 2026-07-20

### Fixed

- Package Lite and Pro from isolated production dependency stages, preventing pnpm workspace graph expansion from exhausting Windows and Linux release runners.
- Verify native Electron modules and collect release artifacts from the same isolated stage used to build each installer.
- Pin the Electron runtime used by staged builds and preserve Pro's bundled accounting database resource.

## [0.3.3] - 2026-07-20

### Fixed

- Preserve the server worker's internal render API URL when the browser runtime configuration script loads, restoring queued PDF rendering without exposing the container-local API address to users.
- Upgrade the Electron packager to a pnpm-aware dependency collector so Lite and Pro installers can be produced without exhausting the release runner heap.
- Make Linux Electron smoke tests reliable by installing the native keychain runtime, disabling hardware acceleration in E2E mode, and launching through Playwright's Electron instrumentation.
- Rebuild shared Electron native dependencies sequentially while retaining the normal PDF readiness timeout and release memory limit.

### Changed

- Add actionable Electron startup checkpoints, child-process output, and browser-launch diagnostics to CI failures.
- Add browser-render failure diagnostics to the server worker while preserving typed job failure reporting.

## [0.3.2] - 2026-07-20

### Fixed

- Rebuild shared Electron native dependencies sequentially before Linux smoke tests.
- Allow slower CI workers enough time to finish asynchronous PDF rendering.
- Raise the release packager heap for large pnpm workspace dependency graphs.

## [0.3.1] - 2026-07-20

### Fixed

- Run Electron smoke tests inside a virtual X display on Linux CI.
- Give electron-builder enough heap for workspace dependency collection and pin Windows packaging to the Visual Studio-equipped Windows 2022 runner.
- Include PostgreSQL declarations in the isolated server-worker image build.
- Publish the platform administration image alongside the other server-mode GHCR images.

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

[0.3.7]: https://github.com/bl4ckh4nd/billme/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/bl4ckh4nd/billme/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/bl4ckh4nd/billme/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/bl4ckh4nd/billme/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/bl4ckh4nd/billme/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/bl4ckh4nd/billme/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/bl4ckh4nd/billme/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/bl4ckh4nd/billme/compare/v0.2.0...v0.3.0
