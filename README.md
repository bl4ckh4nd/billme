# Billme

<img src="logos/FullLogo3.svg" alt="Billme logo" width="320" />

Billme is a German-focused invoicing and accounting workspace. The repository contains local-first Electron desktop apps, server-mode browser shells, a Fastify/Postgres backend, a background worker, a public offer portal, and shared TypeScript packages.

Check out the hosted demo: [demo.getbillme.com](https://demo.getbillme.com/).

This project is still beta software. Expect rough edges and report issues with reproduction details.

<img src="assets/screenshot_billme.png" alt="Billme screenshot" width="900" />

## Product Surfaces

- **Billme Lite desktop**: Electron + React + SQLite invoicing app.
- **Billme Pro desktop**: Electron + React + SQLite app with Pro accounting, ledger, EÜR, and finance workflows.
- **Server mode**: Fastify API, Postgres, worker jobs, and Lite/Pro browser shells.
- **Offer portal**: Public Hono service for published document snapshots, customer access links, and offer decisions.
- **Demo and landing page**: Browser demo and marketing site.

## Features

- Visual invoice/offer editor with drag-and-drop canvas blocks, layers, and reusable templates.
- Client, project, article, template, invoice, offer, recurring invoice, and payment workflows.
- German tax modes plus ZUGFeRD EN16931 e-invoice export.
- Bank transaction import/matching and automatic invoice payment status updates.
- EÜR reporting and classification flows.
- Pro double-entry accounting surfaces backed by shared accounting packages.
- Public offer/invoice portal publishing, PDF links, and customer decision sync.
- Server-mode Docker stack with Lite and Pro browser shells.
- Typed server CLI for auth, billing CRUD, exports, and Pro catalog/template operations.

## GoBD-Oriented Controls

Billme includes technical controls that support GoBD-oriented workflows:

- append-only audit log with SQL trigger protection,
- hash-chained audit entries and integrity verification,
- audit export for external review/documentation,
- required reason prompts in important change/delete flows,
- immutable document snapshots for sent/exported documents.

GoBD conformity is process- and setup-dependent, including organizational controls and Verfahrensdokumentation. Billme does not claim official certification by financial authorities.

## Workspace Layout

### Apps

- `apps/desktop`: Lite Electron desktop app.
- `apps/pro-desktop`: Pro Electron desktop app with accounting extensions.
- `apps/server-api`: Fastify server-mode API.
- `apps/server-worker`: recurring, dunning, email, portal sync, and maintenance worker.
- `apps/web`: Lite browser shell for server mode.
- `apps/web-pro`: Pro browser shell for server mode.
- `apps/offer-portal`: Hono offer/invoice portal for Node or Cloudflare Workers.
- `apps/demo`: Cloudflare Worker-hosted browser demo.
- `apps/landing-page`: marketing site.

### Packages

- `packages/server-core`: server-mode schemas, typed client, routes, domain/services, tax/e-invoice rules.
- `packages/server-data`: Postgres schema, migrations, repositories, seeding, SQLite import.
- `packages/server-cli`: typed server-mode SDK and `billme` CLI binary.
- `packages/desktop-contracts` and `packages/desktop-contracts-pro`: Lite/Pro IPC contracts and schemas.
- `packages/desktop-data`: shared desktop repositories/data modules, EÜR report/classification, validation, backup/audit helpers.
- `packages/desktop-renderer`: shared product-aware renderer mounting, browser shell, print readiness, browser runtime helpers.
- `packages/desktop-core`, `desktop-services`, `desktop-hooks`, `desktop-state`, `desktop-ui`, `desktop-utils`: shared desktop runtime, services, hooks, state, UI, and utility modules.
- `packages/accounting-engine`, `accounting-shared`, `accounting-ui-pro`, `finance-intelligence`: Pro accounting and finance modules.
- `packages/ui`: base design system primitives.

## Prerequisites

- Node.js 20+
- `pnpm` 10+
- Docker or Podman for server-mode stack/E2E
- Chromium for Playwright server-mode E2E: `pnpm test:e2e:server:install`

## Getting Started

```bash
pnpm install
pnpm dev
```

This starts the Lite desktop app in development mode.

For Pro desktop:

```bash
pnpm dev:pro
```

## Common Commands

```bash
pnpm dev                    # Lite desktop app
pnpm dev:pro                # Pro desktop app
pnpm dev:renderer           # Lite renderer only
pnpm dev:web                # Lite browser shell
pnpm dev:web-pro            # Pro browser shell
pnpm dev:server-api         # Fastify API
pnpm dev:server-worker      # Server worker
pnpm dev:demo               # Demo Worker
pnpm dev:landing            # Landing page

pnpm build                  # Lite desktop bundle
pnpm build:server-api       # Server API
pnpm build:server-worker    # Server worker
pnpm build:server-cli       # Server CLI package
pnpm build:web              # Lite browser shell
pnpm build:web-pro          # Pro browser shell
pnpm build:demo             # Demo
pnpm build:landing          # Landing page
pnpm dist                   # Lite desktop distributable

pnpm -C apps/desktop test
pnpm -C apps/pro-desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/pro-desktop typecheck
pnpm -C apps/web typecheck
pnpm -C apps/web-pro typecheck
pnpm -C packages/server-cli test
pnpm -C packages/server-cli typecheck
```

## Server Mode

Server mode runs Postgres, the Fastify API, worker, and both browser shells:

```bash
cp .env.server-mode.example .env.server-mode
pnpm docker:server-mode
```

Open:

- Lite shell: `http://localhost:${BILLME_WEB_PORT:-4175}`
- Pro shell: `http://localhost:${BILLME_WEB_PRO_PORT:-4176}`
- API health: `http://localhost:${BILLME_API_PORT:-3100}/health`

Published GHCR images and operational details are documented in `docs/server-mode-docker.md`.

Server-mode E2E:

```bash
pnpm test:e2e:server:smoke
pnpm test:e2e:server:full
```

## Server CLI

`packages/server-cli` provides a typed HTTP client and the `billme` CLI binary. The binary wrapper lives at `packages/server-cli/bin/billme.mjs` and launches through `tsx` because workspace packages export TypeScript source.

Typical package-level checks:

```bash
pnpm -C packages/server-cli typecheck
pnpm -C packages/server-cli test
pnpm -C packages/server-cli build
```

## Documentation

- `AGENTS.md`: canonical engineering and agent guide.
- `CLAUDE.md`: Claude Code pointer to the canonical guide.
- `docs/architecture.md`: architecture overview.
- `docs/server-mode-docker.md`: server-mode stack, deployment, and E2E matrix.
- `docs/offer-portal.md`: portal runtime and API notes.
- `docs/releasing.md`: release process.
- `docs/compliance-germany-double-entry-gap-checklist.md`: German compliance/accounting gap checklist.
- `docs/eur-integration-plan.md`: EÜR integration notes.

## Notes

- Do not hand-edit generated build output (`dist/`, `out/`), coverage output, or logs.
- Keep Lite and Pro contracts in sync when changing shared document, tax, invoice/offer, renderer, or accounting behavior.
- Treat the offer portal as a snapshot/decision surface, not the source of accounting truth.

## License

FSL1.1, see `LICENSE`.
