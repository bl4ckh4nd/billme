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
- `GET /publish/check` (needs the publish key; `200` when a publish with this key would be accepted, `401` otherwise)
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

## Desktop and web integration

- Desktop and the web apps publish snapshots (and optional PDFs) through the Billme API
  (`POST /api/v1/{lite|pro}/portal/publish-offer`); the API calls the portal with the publish key.
  On the desktop the key comes from Einstellungen → Portal (system keychain), on a hosted server from
  `PORTAL_API_KEY` (compose: `BILLME_PORTAL_PUBLISH_API_KEY`), and only goes to `BILLME_PUBLIC_PORTAL_URL`.
- "Verbindung testen" (Einstellungen → Portal) checks reachability and the key (`/publish/check`), so it
  fails when publishing would fail.
- Customer decisions come back through "Portal-Status synchronisieren" on the offer, and on a hosted
  server also through the worker's `offer-portal-sync` job (`WORKER_PORTAL_SYNC_INTERVAL_MS`).
