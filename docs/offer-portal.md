# Offer Portal

`apps/offer-portal` is a public Node/Hono service for sharing published offers and invoices and
collecting customer decisions. Desktop and server applications remain the accounting source of truth;
the portal stores only published snapshots and decisions.

## Runtime

- Node entrypoint: `apps/offer-portal/src/node.ts`
- SQLite snapshot store: `DATABASE_PATH` (default `./data/offer-portal.sqlite`)
- Filesystem PDF store: `STORAGE_DIR` (default `./storage`)
- In-memory storage is available for tests/development with `STORAGE_MODE=memory`.

The independent `apps/demo` demo is a separate runtime and does not change the portal's storage model.

## Local development

```bash
pnpm install
pnpm -C apps/offer-portal dev
```

Build/start:

```bash
pnpm -C apps/offer-portal build
pnpm -C apps/offer-portal start
```

Environment variables:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `3001`)
- `PUBLIC_BASE_URL` (optional, used for generated links)
- `PUBLISH_API_KEY` (required whenever publishing protection is enabled)
- `REQUIRE_PUBLISH_API_KEY` (default `true` in `NODE_ENV=production`)
- `DATABASE_PATH` (default `./data/offer-portal.sqlite`)
- `STORAGE_DIR` (default `./storage`)
- `STORAGE_MODE` (`sqlite` or `memory`, default `memory`)

Production must set a strong `PUBLISH_API_KEY` and leave `REQUIRE_PUBLISH_API_KEY=1`. If strict
publishing protection is enabled without a key, publish endpoints fail closed with
`503 publish_api_key_required`.

If SQLite fails due to a native-module ABI mismatch, rebuild `better-sqlite3` for Node:

```bash
pnpm -C apps/offer-portal rebuild better-sqlite3
```

## Docker server mode

The root `docker-compose.server-mode.yml` runs the portal as the `offer-portal` service on port 3001,
with persistent SQLite and PDF volumes. Set `BILLME_PORTAL_PUBLISH_API_KEY` in `.env.server-mode`; the
compose service requires that value and always enables publish-key enforcement.

## Key endpoints

- `GET /health`
- `GET /admin/setup`
- `POST /offers`
- `GET /offers/:token`
- `GET /offers/:token/pdf`
- `POST /offers/:token/decision`
- `GET /offers/:token/status`
- `POST /invoices`
- `GET /invoices/:token`
- `GET /invoices/:token/pdf`
- `GET /invoices/:token/status`
- `POST /customers/access-links`
- `POST /customers/access-links/rotate`
- `GET /customers/:token/documents`

## Desktop integration

- Desktop publishes snapshots (and optional PDFs) through portal API endpoints.
- Customer decisions are synced back and persisted locally in the desktop app.
