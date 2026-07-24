# Architecture

Billme is a pnpm workspace with local desktop applications, an optional Postgres-backed server mode,
and two public browser services. Shared packages define contracts and domain behavior; each runtime
surface owns its bootstrap and persistence adapters.

## Runtime surfaces

| Surface | Responsibility |
|---|---|
| `apps/desktop` | Billme Lite: Electron main/preload, React renderer, and local SQLite wiring |
| `apps/pro-desktop` | Billme Pro: separate Electron application with Pro IPC, schema, and accounting integration |
| `apps/web` | Authenticated Lite server-mode shell that mounts the Lite desktop renderer over an HTTP adapter |
| `apps/web-pro` | Standalone Pro server-mode UI; embeds `ProAccountingWorkspace` instead of mounting the desktop renderer |
| `apps/server-api` | Fastify API for Lite and Pro, backed by Postgres in server mode |
| `apps/server-worker` | Scheduled server-mode side effects and maintenance |
| `apps/offer-portal` | Hono service for public offer/invoice links and customer decisions |
| `apps/demo` | Cloudflare Worker demo with the Lite renderer and session-scoped mock IPC |
| `apps/landing-page` | React/Vite marketing site |

## Lite and Pro are separate products

The split is selected at build time. It is not a license-key upgrade or a runtime feature flag:

| Boundary | Lite | Pro |
|---|---|---|
| Application | `apps/desktop` | `apps/pro-desktop` |
| IPC package | `@billme/desktop-contracts` (82 routes) | `@billme/desktop-contracts-pro` (110 routes) |
| SQLite file | `billme.sqlite` | `billme-pro-v2.sqlite` |
| Electron `appId` | `com.billme.desktop` | `com.billme.pro` |

The route counts come from the `ipcRoutes` objects in
`packages/desktop-contracts/src/contract.ts` and
`packages/desktop-contracts-pro/src/contract.ts`. The database names and application IDs are defined
in each app's `productProfile.ts` and `electron-builder.yml`.

The routers also differ. `apps/desktop/router.tsx` exposes `/statistics` and `/eur`;
`apps/pro-desktop/router.tsx` omits both and adds `/accounting`. Pro is therefore not a strict
superset of the Lite UI.

## Desktop persistence and IPC

Both Electron applications use SQLite through `better-sqlite3`. `@billme/desktop-data` owns the shared
connection lifecycle, repositories, transaction matching, and EÜR classification/report logic.
`apps/*/db/connection.ts` supplies the product bootstrap and migration functions; compatibility changes
must remain in `apps/*/db/migrate.ts`.

Invoices and offers persist document-time fields such as `billingAddressJson`,
`shippingAddressJson`, `taxMeta`, and `taxSnapshot`. These snapshots preserve what was issued; sent or
exported documents are accounting artifacts and should not be rewritten in place.

The renderer/main boundary is contract-first:

- `packages/desktop-contracts/src/{contract,schemas,api}.ts` for Lite
- `packages/desktop-contracts-pro/src/{contract,schemas,api}.ts` for Pro
- `apps/*/electron/ipcHandlers.ts` for main-process adapters
- `apps/*/electron/preload.ts` and `apps/*/ipc/window.d.ts` for the exposed window bridge

The app-local `apps/*/ipc/{contract,schemas,api}.ts` files re-export the appropriate shared package.
`@billme/desktop-contracts` owns the generic contract-to-API factory, while
`@billme/desktop-core/electron/preload` owns the common preload bridge. Arguments and results are
parsed with Zod in the preload and handler paths rather than sent over untyped ad hoc channels.

## Renderer reuse and browser shells

`@billme/desktop-renderer` exports `mountDesktopRendererApp` and `createRendererQueryClient` from
`packages/desktop-renderer/src/index.tsx`. The mount function loads `apps/desktop/App`, installs the
provided API as `globalThis.billmeApi`, and creates the React Query client. This is the seam used by
`apps/demo` and `apps/web` to run the Lite Electron renderer in a browser.

The package also owns the shared Lite/Pro document, client, catalog, settings, project, recurring,
transaction-matching, and EÜR views plus their React Query hooks. App-local component and hook paths
are compatibility re-exports. `runtime-api.ts` selects the external Electron/HTTP adapter or one
product-scoped fallback mock, and `ui-store.ts` is the single renderer UI-state instance.

Shared behavior is tested once at its package owner (`@billme/desktop-data` or
`@billme/desktop-renderer`). Product bootstrap tests remain in both desktop apps even when their test
bodies currently match: they verify the separate Lite and Pro schemas, migrations, and wiring.
Likewise, the small app-local connection, preload, scheduler, polling, and renderer entrypoints are
intentional composition roots; shared behavior belongs behind them, but the product boundary stays
visible.

`apps/web/src/App.tsx` supplies a Lite HTTP adapter and sets
`globalThis.billmeRuntime.navigation` through the mount options to `dashboard`, `clients`, and
`documents`. `apps/desktop/components/DashboardLayout.tsx` applies that allowlist.

`apps/web-pro` follows a different topology. Its `App.tsx` is a standalone server-mode UI that imports
and embeds `ProAccountingWorkspace`; it does not call `mountDesktopRendererApp`.

## Server mode

`apps/server-api/src/app.ts` creates the Fastify API. When `DATABASE_URL` is available it creates the
Postgres pool and runs `runPostgresMigrations` before registering the pool. Lite and Pro auth and
billing routes live under `/api/v1/lite` and `/api/v1/pro`. `requireSession` rejects a token whose
product does not match the route with `403`.

Authentication uses bearer tokens implemented in `apps/server-api/src/auth.ts`: a base64url payload
plus an HMAC-SHA256 signature, not a standard JWT. Passwords are derived with scrypt in
`apps/server-api/src/authStore.ts` and `packages/server-data/src/postgres/auth.ts`.

Writes and deletes for clients, invoices, offers, and recurring profiles require a non-empty `reason`
and append an audit entry in the same Postgres transaction. This is not yet a universal server-route
invariant: settings, numbering, workflow, and several Pro catalog mutations in `app.ts` do not
currently require a reason or append an audit entry.

The worker implementations live in `apps/server-worker/src/runtime.ts`; scheduling and default
intervals are registered in `apps/server-worker/src/worker.ts`. There are five jobs:
`recurring-invoices`, `dunning`, `queued-email-dispatch`, `offer-portal-sync`, and
`scheduled-maintenance`.

## Pro accounting

The Pro accounting seam is split by responsibility:

- `@billme/accounting-shared`: journal, workflow, ledger, and tax-case types
- `@billme/accounting-engine`: posting and ledger services, including debit/credit balance enforcement
- `@billme/accounting-ui-pro`: the shared accounting workspace UI
- `@billme/finance-intelligence`: local naive Bayes and keyword-based suggestions

The UI is ahead of some adapter wiring. `packages/accounting-ui-pro/src/components/ReportsView.tsx`
loads `mockReportService`, and `AssetManagementView.tsx` owns a local `mockAssets` array. SuSa, GuV,
Bilanz, and asset screens therefore still display sample data in the shared UI.

Real SuSa, GuV, and Bilanz queries exist in `apps/pro-desktop/db/proAccountingRepo.ts`. The Pro contract
declares `pro:getSusaReport`, `pro:getGuvReport`, and `pro:getBilanzReport`, and
`apps/pro-desktop/electron/ipcHandlers.ts` exposes those repository-backed implementations over IPC.

## Offer portal

`apps/offer-portal` uses Hono with separate entrypoints for Node (`src/node.ts`) and Cloudflare Workers
(`src/worker.ts`). Its storage ports have adapters for memory, SQLite plus filesystem on Node, and D1
plus R2 on Workers.

The current tree has no `apps/offer-portal/src/documentPolicy.ts`. Publish authentication, origin
checks, rate limits, sensitive response headers, and request schemas are currently centralized in
`apps/offer-portal/src/app.ts`.

The portal stores published document snapshots and customer decisions. Desktop SQLite and server
Postgres remain the accounting sources of truth; portal state must never become accounting truth.

## Demo

`apps/demo` is a Cloudflare Worker with a `DemoSession` Durable Object. The browser sends
`POST /api/ipc/:routeKey`; the Worker maps the `demo_session` cookie to a Durable Object and validates
the request and response against the Lite IPC contract.

Each `DemoSession` owns a `createLiteMockInvoke()` engine from `@billme/desktop-services` in memory.
The same product-parameterized engine supplies the Pro fallback through `createProMockInvoke()`.
It does not persist business data to a real database, and resetting the session replaces that engine.

## Design tokens

`packages/ui/styles.css` is the token source of truth, expressed through Tailwind v4 `@theme`.
`packages/ui/src/utils/colors.ts` manually mirrors the color values for TypeScript consumers; changes
to shared colors must update both files.
