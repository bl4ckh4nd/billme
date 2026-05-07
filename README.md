# Billme

<img src="logos/FullLogo3.svg" alt="Billme logo" width="320" />

A local-first invoicing desktop app (Electron + React + SQLite) and a public offer portal service.
Built with love in Germany.

Check out a web-hosted demo of the app here: [Demo](https://demo.getbillme.com/)).

PLEASE NOTE: This is still a Beta-Version. Expect some minor issues and please report them so they can be fixed!

<img src="assets/screenshot_billme.png" alt="Billme screenshot" width="900" />

## Features

- Visual invoice/offer editor with drag-and-drop canvas blocks, layers, and reusable templates
- Unified invoices/offers dashboard with search, status filters, portal sync, and offer-to-invoice conversion
- Recurring invoice profiles (`Abo-Rechnungen`) with interval scheduling and manual run support
- Bank transaction matching workflow to link payments and automatically update invoice payment status
- Client management with multiple contacts/addresses plus client-level revenue and outstanding metrics
- German-focused settings including payment terms, numbering, and optional ZUGFeRD EN16931 e-invoice export
- Public offer portal API for publishing offers/invoices, customer decision flows, and PDF access links

## GoBD

Billme includes technical controls that support GoBD-oriented workflows:

- Append-only audit log at DB level (update/delete blocked by SQL triggers)
- Hash-chained audit entries with built-in integrity verification
- Audit export as CSV for external review/documentation
- Mandatory reason prompts in key change/delete flows

Important: GoBD conformity is always process- and setup-dependent (including organizational controls and Verfahrensdokumentation). Billme does not claim an official GoBD certification by financial authorities.

## Workspace

- `apps/desktop`: Electron desktop app
- `apps/demo`: Cloudflare Worker-hosted browser demo (desktop UI + mock services)
- `apps/offer-portal`: Hono TypeScript service for published offers/invoices
- `apps/server-api`: Fastify server-mode API
- `apps/server-worker`: background worker for server-mode automation
- `apps/web`: Lite browser shell for server mode
- `apps/web-pro`: Pro browser shell for server mode
- `packages/ui`: Shared UI components and utilities

## Prerequisites

- Node.js 20+
- `pnpm` 10+

## Getting Started

```bash
pnpm install
pnpm dev
```

This starts the desktop app in development mode.

## Common Commands

```bash
pnpm dev                 # Desktop app (Electron + renderer)
pnpm dev:demo            # Demo app (Cloudflare Worker)
pnpm dev:renderer        # Renderer only
pnpm build               # Build desktop bundles
pnpm build:demo          # Build demo frontend + typecheck worker
pnpm dist                # Build distributable desktop packages
pnpm build:server-api    # Build the Fastify API
pnpm build:server-cli    # Build the Billme server CLI package
pnpm build:server-worker # Build the background worker
pnpm build:web           # Build the lite browser shell
pnpm build:web-pro       # Build the pro browser shell
pnpm docker:server-mode  # Start the Docker compose stack
pnpm docker:server-mode:pull
pnpm docker:server-mode:up:ghcr
pnpm docker:server-mode:logs
pnpm docker:server-mode:down
pnpm test:e2e:server:install
pnpm test:e2e:server:smoke
pnpm test:e2e:server:full
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm deploy:demo         # Deploy demo to Cloudflare Workers
pnpm -C apps/offer-portal dev
pnpm -C apps/offer-portal build
```

## Server CLI package

`packages/server-cli` provides a typed server-mode HTTP client plus the `billme` CLI binary for auth, shared billing CRUD, exports, and the v1 pro catalog/template surface.

Server-mode Playwright needs Docker or Podman access plus a local Chromium install. See `docs/server-mode-docker.md` for the smoke/full suite entrypoints, runtime override, and CI prerequisites.

## Documentation

- `docs/architecture.md`
- `docs/offer-portal.md`
- `docs/server-mode-docker.md`
- `docs/releasing.md`

## License

FSL1.1, see `LICENSE`.

## Notes

- Do not commit generated build output (`dist/`, `out/`, logs).
