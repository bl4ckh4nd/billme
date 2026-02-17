# Offer Portal

`apps/offer-portal` is a public-facing service for sharing published offers/invoices and collecting customer decisions.

The desktop app stays the source of truth and publishes document snapshots to the portal.

## Runtime Targets

- Node (self-hosted): `apps/offer-portal/src/node.ts`
- Cloudflare Workers: `apps/offer-portal/src/worker.ts`

## Local Development (Node)

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
- `PUBLISH_API_KEY` (optional, protects publish endpoints with `x-api-key`)
- `REQUIRE_PUBLISH_API_KEY` (optional, default `true` in `NODE_ENV=production`; when enabled and no key is set, publish endpoints return `503 publish_api_key_required`)
- `DATABASE_PATH` (default `./data/offer-portal.sqlite`)
- `STORAGE_DIR` (default `./storage`)
- `STORAGE_MODE` (`memory` or `sqlite`, default `memory`)

If `STORAGE_MODE=sqlite` fails due native module mismatch (`NODE_MODULE_VERSION`), rebuild for Node:

```bash
pnpm -C apps/offer-portal rebuild better-sqlite3
```

## Cloudflare Workers

Config file: `apps/offer-portal/wrangler.toml`

Recommended bindings:

- `DB` (D1)
- `PDF_BUCKET` (R2)

Deploy:

```bash
pnpm -C apps/offer-portal deploy:cf
```

Without `DB`/`PDF_BUCKET`, the worker falls back to in-memory storage.

## Key Endpoints

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

## Desktop Integration

- Desktop publishes snapshots (and optional PDFs) through portal API endpoints.
- Customer decisions are synced back and persisted locally in the desktop app.
