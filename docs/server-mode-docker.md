# Server-mode Docker deployment

Billme server mode ships as a Docker Compose stack with seven services:

- `postgres` — persistent PostgreSQL database
- `server-api` — Fastify API with automatic Postgres migrations
- `server-worker` — recurring invoices, dunning, email queue, portal sync, and maintenance jobs, run once per cycle for every `active` tenant (set `WORKER_TENANT_ID` to pin a worker to a single tenant instead)
- `receipt-worker` — network-isolated OCR worker with a dedicated memory/process budget; it can reach Postgres and the shared document volume but not the public internet
- `web` — Billme Lite browser shell
- `web-pro` — Billme Pro browser shell
- `admin-web` — bare-minimum platform admin console for creating workspaces (tenants) and users

Published images are available from GHCR as:

- `ghcr.io/bl4ckh4nd/billme/server-api`
- `ghcr.io/bl4ckh4nd/billme/server-worker`
- `ghcr.io/bl4ckh4nd/billme/web`
- `ghcr.io/bl4ckh4nd/billme/web-pro`
- `ghcr.io/bl4ckh4nd/billme/admin-web`

## Prerequisites

- Docker Engine with the Compose plugin
- Node.js 20+ and `pnpm` 10+ for local Playwright runs
- Docker daemon access for the current user (`docker info` must succeed)
- Chromium installed for Playwright browser runs: `pnpm test:e2e:server:install`
- A copied env file for manual stack runs or custom E2E overrides: `cp .env.server-mode.example .env.server-mode`

## Configure the stack

Edit `.env.server-mode` before the first start:

- set `BILLME_POSTGRES_PASSWORD`
- optionally set `BILLME_POSTGRES_DATA_DIR` to an absolute host path if PostgreSQL should use a bind-mounted data directory instead of the default named volume
- optionally set `BILLME_POSTGRES_RUN_AS` if PostgreSQL must run under a specific container uid:gid
- set `BILLME_SESSION_SECRET` to a long random value
- set `BILLME_RENDER_SECRET` to a separate random value of at least 24 characters; it authorizes only short-lived internal PDF render sessions
- set `BILLME_POSTGRES_PASSWORD` to a long random value
- set `BILLME_PUBLIC_API_URL` to the public HTTPS API URL in production; leave it blank only for local loopback development
- optionally adjust exposed ports and worker intervals
- optionally set `WORKER_RUN_ONCE=1` for run-once worker debugging or future E2E scenarios
- optionally set `SMTP_PASSWORD` or `RESEND_API_KEY` if queued email delivery should be enabled
- to enable the platform admin console, set `BILLME_PLATFORM_ADMIN_EMAIL` and `BILLME_PLATFORM_ADMIN_PASSWORD`; the `/api/v1/platform/*` routes stay inert (401 for any credential) until both are set
- optionally set `BILLME_PLATFORM_SESSION_SECRET` to a distinct random value for signing platform-admin tokens; it falls back to `BILLME_SESSION_SECRET` if unset, but a distinct value is recommended so a leaked tenant session key cannot also grant platform access
- if `BILLME_PLATFORM_ADMIN_EMAIL` is set while `BILLME_SESSION_SECRET`/`BILLME_PLATFORM_SESSION_SECRET` are left at the dev default, `server-api` logs a startup warning in development and refuses to start in production (`NODE_ENV=production`)

The stack binds all published application ports to `BILLME_BIND_ADDRESS=127.0.0.1` by default and never publishes PostgreSQL. Put an HTTPS reverse proxy in front of the Lite, Pro, admin, and API ports for production, then set `BILLME_PUBLIC_API_URL` to that public HTTPS API URL. The web shells read it at container startup through a generated `runtime-config.js` file; `admin-web` uses the same mechanism.

Server-side portal polling is disabled for an unlisted portal URL. Set `BILLME_PORTAL_ALLOWED_ORIGINS` to the comma-separated HTTPS portal origins the worker may contact.

## Pull the published images

To use the GHCR images instead of rebuilding locally, pull them first and then start the stack without `--build`:

```bash
pnpm docker:server-mode:pull
pnpm docker:server-mode:up:ghcr
```

If you need to point at a different registry namespace or tag, override the `BILLME_SERVER_API_IMAGE`, `BILLME_SERVER_WORKER_IMAGE`, `BILLME_WEB_IMAGE`, and `BILLME_WEB_PRO_IMAGE` values in `.env.server-mode`.

## Start the deployment

```bash
pnpm docker:server-mode
```

Open:

- Lite shell: `http://localhost:${BILLME_WEB_PORT:-4175}`
- Pro shell: `http://localhost:${BILLME_WEB_PRO_PORT:-4176}`
- Platform admin console: `http://localhost:${BILLME_ADMIN_WEB_PORT:-4177}`
- API health: `http://localhost:${BILLME_API_PORT:-3100}/health`

On a clean database, open one of the browser shells and complete the bootstrap flow for the first owner account.

After login, choose **Pair mobile app** in the lower-left corner. The one-time QR code expires after five minutes. See [Mobile app](mobile-app.md) for development builds, secure storage, and deployment requirements.

## Creating a second workspace (multi-tenant)

Server mode is single-tenant per product until an operator explicitly creates additional workspaces through the platform admin console. This is separate from the desktop apps (`apps/desktop`, `apps/pro-desktop`), which remain single-business-per-install and are not part of multi-tenancy.

1. Set `BILLME_PLATFORM_ADMIN_EMAIL` / `BILLME_PLATFORM_ADMIN_PASSWORD` in `.env.server-mode` and restart `server-api`.
2. Open the admin console at `http://localhost:${BILLME_ADMIN_WEB_PORT:-4177}` and sign in with those credentials.
3. Use "Create workspace" to provision a new tenant (slug, display name, product, and an owner account) — this works even if a tenant already exists for that product, unlike the public self-service `/auth/bootstrap` flow, which only ever creates the first tenant per product.
4. From a workspace's "Manage users" screen, add additional users with a role from `owner, admin, accountant, sales, viewer`.
5. Users log in normally through the Lite/Pro web shells using their workspace credentials; their session token is scoped to that tenant only.

## Agent access

Server-mode agents should use scoped agent tokens instead of a human session
token. Create them from an owner/admin human session with the CLI:

```bash
billme auth agent-token create --product lite \
  --label "Invoice agent" --scopes read,clients:write
billme auth agent-token list --product lite
billme auth agent-token revoke --product lite --id <token-id> --confirm
```

The raw token is returned only at creation time. Store it as a secret and pass
it to the CLI with `--token` or `BILLME_TOKEN`; do not commit it or place it in
the CLI profile if that profile is shared. Tokens are bound to one tenant and
product, stored as hashes, and checked against both their scopes and the
tenant role capabilities.

Inspect and invoke the supported server action surface with:

```bash
billme actions list --target server --product lite
billme action run clients:list --target server --product lite
```

Mutating actions require `--reason`; destructive actions also require
`--confirm`. `actions list` intentionally shows only actions with an existing
server route. The remaining business actions are available through the
authenticated local desktop bridge when the corresponding Electron app is
running; they are not silently emulated on the server.

## Operations

Check health:

```bash
docker compose --env-file .env.server-mode -f docker-compose.server-mode.yml ps
```

View logs:

```bash
pnpm docker:server-mode:logs
```

Stop the stack:

```bash
pnpm docker:server-mode:down
```

## Persistence

PostgreSQL data is stored in the named Docker volume `billme-postgres-data` by default.
If `BILLME_POSTGRES_DATA_DIR` is set to an absolute host path, PostgreSQL uses that bind-mounted
directory instead.

Server-mode migrations are now applied through Drizzle. Existing deployments that still have the
older `server_schema_migrations` history table are adopted automatically on the next startup, so a
persisted PostgreSQL volume does not need to be wiped just because an older raw SQL checksum no
longer matches the current image.

On some rootless Podman setups, PostgreSQL cannot `chown` a bind-mounted host directory during
startup. In that case, pre-create the directory with:

```bash
mkdir -p /path/to/postgres-data
podman unshare chown -R 70:70 /path/to/postgres-data
```

Then set:

```env
BILLME_POSTGRES_DATA_DIR=/path/to/postgres-data
BILLME_POSTGRES_RUN_AS=70:70
```

To inspect or back it up:

```bash
docker volume inspect billme-postgres-data
```

## Service health checks

- `postgres` uses `pg_isready`
- `server-api` probes `GET /health`
- `server-worker` validates its `DATABASE_URL` with `SELECT 1`
- `web` and `web-pro` expose an internal `/health` endpoint from nginx

## Server-mode E2E coverage matrix

This is the approved first-pass E2E scope for server mode:

- in scope: `web`, `web-pro`, `server-api`, `server-worker`, `docker-compose.server-mode.yml`, and SQLite-to-Postgres import flows
- out of scope: Electron desktop/pro-desktop clients talking to the remote server stack
- external portal sync should be covered with a local stubbed HTTP responder, not by adding the separate `apps/offer-portal` deployment to this stack

### Suggested future suite buckets

- `server-docker-smoke`
- `server-lite-smoke`
- `server-pro-smoke`
- `server-lite-full`
- `server-pro-full`
- `server-worker-full`
- `server-import-smoke`
- `server-import-full`

### Smoke vs full matrix

| Area | Smoke coverage | Full coverage | Notes |
| --- | --- | --- | --- |
| Docker + stack bootstrap | Bring up `postgres`, `server-api`, `server-worker`, `web`, and `web-pro` from `docker-compose.server-mode.yml`; wait for `/health` and browser shell reachability; confirm clean-db bootstrap status is `bootstrapped=false`. | Re-run stack startup against an already migrated database and confirm migrations stay idempotent and tenant data survives restart. | Keep this as the stack entry gate for all other server-mode E2E projects. |
| Auth + bootstrap | Cover first-owner bootstrap through the public auth flow, then login and session restore via `/api/v1/lite/auth/me` and `/api/v1/auth/me?product=pro`. | Add product-boundary assertions: lite token rejected on pro routes, pro token rejected on lite routes, logout clears stored session, expired/invalid token returns user to auth screen. | First owner should be created through public auth routes, not direct DB seeding. |
| Lite web | Bootstrap/login, mount the shared renderer shell, visit the major lite routes, create one client, create one invoice or offer draft from that client, and verify one export path works. | CRUD for clients, invoices, offers, and recurring profiles; settings write/read; document number reserve/release/finalize; JSON export and CSV export; session survives reload. | Align with implemented lite routes under `/api/v1/lite/*` and the mounted desktop renderer navigation (`dashboard`, `clients`, `documents`). |
| Pro web | Bootstrap/login, open the core hash routes (`overview`, `documents`, `clients`, `catalog`, `settings`, `accounting`), and persist one settings/catalog record. | Persist articles, bank accounts, templates, active templates, workflow entries, tax mappings, and suggestion rules; verify ledger stats/accounts load and accounting deep links stay stable after reload. | Align with `apps/web-pro/src/App.tsx` and `/api/v1/pro/*` routes. |
| Worker-driven flows | Verify the worker service starts inside the Docker stack and reaches a healthy idle state before any tenant exists. | Run recurring generation, dunning, queued email dispatch, portal decision sync, and maintenance against seeded data; assert durable DB side effects (`invoices`, `dunning_history`, email outbox/log rows, offer decision updates, retention deletions, audit entries). | Use test-friendly intervals or run-once execution; do not require real SMTP/Resend credentials or a real offer portal. |
| SQLite import + migration | Run `packages/server-data/src/cli/import-sqlite.ts` against a minimal Lite fixture and assert `sqlite_import_runs.status='completed'` plus basic tenant/settings/document counts. | Run populated Lite and Pro fixtures, assert supported tables import losslessly enough by row counts and audit-chain verification, assert unsupported populated tables fail unless partial import is enabled, and assert importing into a non-empty tenant fails cleanly. | Use the real import CLI so migrations and import-run bookkeeping are exercised together. |

### Fixture strategy

- Smoke should start from a clean Postgres volume and use as little seeded data as possible.
- Full browser flows may seed repetitive records through API helpers after the first owner exists.
- Shared helpers now live in `@billme/server-core` (`createServerApiClient().ensureSession(...)`) and `@billme/server-data` (`build/seedServerMode*Tenant`) so future server-mode suites can reuse deterministic lite/pro fixtures instead of UI-only setup.
- Full worker coverage should seed due recurring profiles, overdue invoices, queued emails, stale reservations/import runs, and published offers awaiting portal decisions.
- Import fixtures should include one minimal Lite database and one populated Pro database with accounting data, plus one unsupported-table fixture for the failure path.

## Server-mode Playwright harness

The Playwright harness boots the full server-mode container stack without Electron builds. It generates an isolated env file automatically, so `.env.server-mode` is only required when you want manual compose commands or want to layer custom values through `E2E_SERVER_ENV_FILE`.

### Local entrypoints

```bash
pnpm test:e2e:server:smoke
pnpm test:e2e:server:full
```

For narrower local debugging, use the dedicated project entrypoints:

```bash
pnpm test:e2e:server:smoke:stack
pnpm test:e2e:server:smoke:lite
pnpm test:e2e:server:smoke:pro
pnpm test:e2e:server:full:lite
pnpm test:e2e:server:full:pro
```

Useful harness overrides:

- `E2E_TARGET=server` — switch Playwright to the server-mode projects
- `E2E_SERVER_ENV_FILE=path/to/.env` — layer custom server-mode values on top of the generated test env
- `E2E_CONTAINER_RUNTIME=docker|podman` — force a specific container runtime (default: auto-detect Docker, then Podman)
- `E2E_SERVER_KEEP_STACK=1` — keep the container stack running after Playwright exits for local debugging
- `E2E_FULL=1` — use the server-mode full project names (`server-lite-full`, `server-pro-full`) as coverage expands

Runtime env files, compose diagnostics, and harness state are written to `test-results/server-mode/`.

### CI expectations

Use these conventions in automation:

1. Install Chromium before the suite (`pnpm exec playwright install --with-deps chromium` on Linux CI runners).
2. Run `pnpm test:e2e:server:smoke` on push/PR validation.
3. Run `pnpm test:e2e:server:full` on nightly or manually triggered workflows.
4. Upload both `playwright-report/` and `test-results/server-mode/` as artifacts for failure triage.

If neither Docker nor Podman is available, the suite fails during global setup with an explicit container-runtime error before any browser flow starts.

## Updating

Rebuild and restart after image or config changes:

```bash
docker compose --env-file .env.server-mode -f docker-compose.server-mode.yml up -d --build
```

If only the browser API URL changes, rebuilding the two web images is sufficient:

```bash
docker compose --env-file .env.server-mode -f docker-compose.server-mode.yml build web web-pro
```

If you need to run the database upgrade step manually against an existing PostgreSQL volume, use:

```bash
DATABASE_URL=postgresql://... pnpm -C packages/server-data migrate
```
