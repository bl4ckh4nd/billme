# Architecture Overview

This workspace is a `pnpm` TypeScript monorepo with several runtime surfaces. For
the authoritative, always-current topology, seams, commands, and invariants,
see `AGENTS.md` at the repo root — this document gives a narrative overview
and points into the code.

## Apps

- `apps/desktop`: Billme Lite, an Electron + React desktop invoicing app. Owns
  Electron main/preload, local SQLite, and Lite product wiring.
- `apps/pro-desktop`: Billme Pro, an Electron + React desktop app. Extends
  Lite with accounting UI, the accounting engine, Pro IPC contracts/schema,
  and a separate product database.
- `apps/web` / `apps/web-pro`: Lite/Pro browser shells for server mode. Each
  authenticates against `apps/server-api`, builds a product HTTP adapter, and
  mounts the shared desktop renderer in the browser.
- `apps/server-api`: Fastify server-mode API backed by Postgres. Registers
  Lite/Pro auth, billing, template, and Pro accounting routes.
- `apps/server-worker`: Server-mode background worker for recurring invoices,
  dunning, queued email, offer-portal sync, and maintenance jobs.
- `apps/offer-portal`: Hono service for public offer/invoice sharing and
  customer decisions. Desktop/server apps publish snapshots into it; it is
  not the accounting source of truth.
- `apps/demo`: Cloudflare Worker demo shell that mounts the shared desktop
  renderer against mock/session-scoped services, so users can try the app
  in-browser with no install.
- `apps/landing-page`: Marketing site.

## Desktop Apps (`apps/desktop`, `apps/pro-desktop`)

- Renderer: React + Vite.
- Main process: Electron with typed, contract-first IPC.
- Database: SQLite + Drizzle, driven through `@billme/desktop-data`
  repositories; app-local `apps/*/db/*` modules still exist for
  product-specific wiring and runtime migrations.
- Validation: Zod at IPC and other cross-process boundaries.
- State: React Query for server-state, Zustand for UI state.
- Visual invoice/offer document editor (canvas, layers, inspector, toolbar,
  template designer) lives in the shared `@billme/desktop-designer` package
  and is consumed by both products' `InvoiceDocumentEditor.tsx` — it is not
  duplicated per app.
- Large screen components are split into co-located folders rather than kept
  as monoliths, e.g. `apps/*/components/{invoices,settings,dashboard,clients,
  articles,transaction-matching,eur}/`.

### Key Data Model Notes

- Clients support multiple structured addresses/emails.
- Invoices/offers store snapshot address and tax JSON for immutability
  (`billingAddressJson`, `shippingAddressJson`, tax snapshot fields). Treat
  sent/exported documents as immutable accounting artifacts unless the
  product flow explicitly creates a new revision.
- Runtime migration logic in `apps/*/db/migrate.ts` keeps existing local
  SQLite databases compatible; never bypass it for schema changes.

### IPC Contract

IPC is contract-first and package-based, not app-local:

- Lite contract: `packages/desktop-contracts/src/{contract,schemas,api}.ts`
- Pro contract: `packages/desktop-contracts-pro/src/{contract,schemas,api}.ts`
- Electron adapters: `apps/*/electron/ipcHandlers.ts`
- Preload/window bridge: `apps/*/electron/preload.ts` and
  `apps/*/ipc/window.d.ts`

When adding or changing a renderer/main feature, update the contract, schema,
adapter, and tests together — do not add untyped ad hoc channels.

### Agent control

`@billme/agent-control` derives the agent action catalog from the Lite and Pro
IPC route maps. `billme action run` validates the route arguments and result
against those same Zod contracts before invoking either target:

- Desktop targets use the authenticated loopback bridge started by the
  Electron main process. The bridge calls the existing IPC handlers, so agents
  do not get a second SQLite or business-logic path.
- Server targets use the existing typed Fastify client and product-scoped
  routes. The catalog marks routes without a server implementation as
  desktop-only; the CLI does not pretend those actions are remotely available.
- Mutations require an audit reason, and destructive actions require explicit
  confirmation. Window control, shell escapes, dialogs, secrets, and updater
  actions are excluded from the agent catalog.

Server agents authenticate with product-scoped, tenant-bound agent tokens. The
database stores only token hashes; token scopes are checked in addition to the
normal tenant role capabilities. See `docs/server-mode-docker.md` for token
management commands.

## Server Mode (`apps/server-api`, `apps/server-worker`, `apps/web`, `apps/web-pro`)

- `apps/server-api/src/app.ts` wires auth, product-scoped routes, migrations,
  audit, and repositories on Fastify + Postgres.
- `apps/server-worker/src/runtime.ts` owns scheduled job execution and
  durable side effects.
- `@billme/server-core` owns shared product/runtime contracts and pure
  service rules (including tax/e-invoice logic).
- `@billme/server-data` owns Postgres persistence, migrations, seeding, and
  SQLite import tooling. Schema changes must update both the raw SQL and
  Drizzle migration trees together.
- `@billme/desktop-renderer` owns browser shell mechanics shared by
  `apps/web` and `apps/web-pro`: runtime API URL resolution, session
  lifecycle, bootstrap/login orchestration, print-mode detection
  (`useBrowserDocumentShell`), product-aware mounting (`BrowserRendererHost`),
  and PDF print-readiness (`usePdfAutoPrint`). The app files themselves stay
  thin: auth adapter, API adapter factory, navigation, and UI copy.

### Multi-tenancy and platform admin (`apps/admin-web`)

- Domain tables have always been `tenant_id`-scoped; the previous limitation was purely in provisioning: `bootstrap()` (`packages/server-data/src/postgres/auth.ts`) only ever creates the first tenant per product.
- `apps/admin-web` is a minimal, server-mode-only console that lets an operator create additional workspaces (tenants) and users via new `/api/v1/platform/*` routes on `apps/server-api`, authenticated with an env-seeded `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` credential and a `PlatformTokenService`-issued token that carries no `tenantId` (distinct from the tenant-scoped `SessionTokenService`).
- `createTenantAsPlatformAdmin`/`listTenants`/`addUserToTenant` in `packages/server-data/src/postgres/auth.ts` share the same `provisionTenantWithOwner` transaction the public bootstrap flow uses, just without its single-tenant-per-product guard.
- Desktop apps (`apps/desktop`, `apps/pro-desktop`) are explicitly out of scope — they remain single-business-per-install.
- `apps/server-worker/src/runtime.ts` resolves the set of tenants to process via `resolveScopes()`, which lists every `active` tenant (`createPostgresTenantRepository(...).listActive()`) and runs each scheduled job (recurring, dunning, queued-email, portal-sync, maintenance) once per tenant, isolating failures so one tenant's error doesn't block the others. Set `WORKER_TENANT_ID` to pin a worker instance to a single tenant instead of iterating all of them.

## Offer Portal (`apps/offer-portal`)

- API framework: Hono.
- Runtime targets: Node (self-hosted) or Cloudflare Workers.
- Storage adapters: in-memory, SQLite + filesystem (Node), or D1 + R2
  (Workers, optional bindings).
- Shared request/publish/auth/access-link policy is centralized in
  `apps/offer-portal/src/documentPolicy.ts`.

See `docs/offer-portal.md` for run/deploy details.

## Demo App (`apps/demo`)

- Runtime target: Cloudflare Workers + Durable Objects.
- Frontend: desktop renderer UI mounted in browser from
  `@billme/desktop-renderer`.
- Backend: session-scoped mock IPC execution through `POST /api/ipc/:routeKey`.
- Session handling: `demo_session` cookie mapped to a Durable Object instance.

## Shared Packages

See the "Shared Packages" section of `AGENTS.md` for the full, current list
(server, desktop-contracts, desktop-data, desktop-renderer, desktop-core,
desktop-services, desktop-hooks/state/ui/utils, desktop-designer,
accounting-*, `@billme/ui`, `@billme/server-cli`). Notably:

- `@billme/desktop-designer` owns the shared visual document editor UI used
  by both Lite and Pro (previously duplicated per app as
  `CanvasElement.tsx`/`LayersPanel.tsx`/`PropertiesPanel.tsx`/`Toolbar.tsx`).
- `@billme/ui` is the design-token source of truth; see `DESIGN.md`.
