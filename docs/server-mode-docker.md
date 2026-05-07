# Server-mode Docker deployment

Billme server mode ships as a Docker Compose stack with five services:

- `postgres` — persistent PostgreSQL database
- `server-api` — Fastify API with automatic Postgres migrations
- `server-worker` — recurring invoices, dunning, email queue, portal sync, and maintenance jobs
- `web` — Billme Lite browser shell
- `web-pro` — Billme Pro browser shell

Published images are available from GHCR as:

- `ghcr.io/bl4ckh4nd/billme/server-api`
- `ghcr.io/bl4ckh4nd/billme/server-worker`
- `ghcr.io/bl4ckh4nd/billme/web`
- `ghcr.io/bl4ckh4nd/billme/web-pro`

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
- optionally set `BILLME_PUBLIC_API_URL` to override the API URL that browsers will call; if unset, the web shells derive `http://<current-host>:3100` automatically
- optionally adjust exposed ports and worker intervals
- optionally set `WORKER_RUN_ONCE=1` for run-once worker debugging or future E2E scenarios
- optionally set `SMTP_PASSWORD` or `RESEND_API_KEY` if queued email delivery should be enabled

The web shells read `BILLME_PUBLIC_API_URL` at container startup through a generated `runtime-config.js` file. That means Portainer can override the API URL without rebuilding the images.

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
- API health: `http://localhost:${BILLME_API_PORT:-3100}/health`

On a clean database, open one of the browser shells and complete the bootstrap flow for the first owner account.

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
