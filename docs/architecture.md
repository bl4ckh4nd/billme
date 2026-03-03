# Architecture Overview

This workspace contains:

- `apps/desktop`: Electron + React desktop application
- `apps/demo`: Cloudflare Worker browser demo (desktop renderer + mock IPC services)
- `apps/offer-portal`: Hono service for public document sharing
- `packages/ui`: shared UI components/utilities

## Desktop App (`apps/desktop`)

- Renderer: React + Vite
- Main process: Electron with typed IPC
- Database: SQLite + Drizzle repositories in `apps/desktop/db`
- Validation: Zod at IPC boundaries
- State: React Query for server-state and Zustand for UI state

### Key Data Model Notes

- Clients support multiple structured addresses/emails.
- Invoices/offers store snapshot address JSON for immutability:
  - `billingAddressJson`
  - `shippingAddressJson`
- Runtime migration logic in `apps/desktop/db/migrate.ts` keeps existing local DBs compatible.

### IPC Contract

The contract is centralized in:

- `apps/desktop/ipc/contract.ts`
- `apps/desktop/ipc/api.ts`
- `apps/desktop/electron/ipcHandlers.ts`
- `apps/desktop/electron/preload.ts`
- `apps/desktop/ipc/window.d.ts`

This keeps channel names, request/response validation, and TS types aligned end-to-end.

## Offer Portal (`apps/offer-portal`)

- API framework: Hono
- Runtime targets:
  - Node (self-hosted)
  - Cloudflare Workers
- Storage adapters:
  - In-memory
  - SQLite + filesystem (Node)
  - D1 + R2 (Workers, optional bindings)

See `docs/offer-portal.md` for run/deploy details.

## Demo App (`apps/demo`)

- Runtime target: Cloudflare Workers + Durable Objects
- Frontend: desktop renderer UI mounted in browser from `@billme/desktop-renderer`
- Backend: session-scoped mock IPC execution through `POST /api/ipc/:routeKey`
- Session handling: `demo_session` cookie mapped to a Durable Object instance

This enables users to try the desktop experience in browser with isolated mock data and no install.
