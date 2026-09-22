# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The person at the keyboard is **the business owner, not a trained bookkeeper**. Two confirmed
primary audiences:

- **Solo Freiberufler / Kleinunternehmer** — a one-person business handling its own invoicing and
  its own Anlage EÜR. No bookkeeping training. The job is: get the Angebot or Rechnung out, get it
  paid, match the payment, stay defensible at Betriebsprüfung time.
- **Owner (or office admin) of a small business with a few employees** — typically a
  Handwerks- or Dienstleistungsbetrieb. Invoicing, Mahnwesen and bank matching are done *alongside*
  the actual work, not as a dedicated role.

Explicitly **not** confirmed as primary audiences: external Steuerberater / Buchhalter, and in-house
staff accountants. This is the load-bearing consequence for design: **Billme Pro's double-entry
workspace — SKR, journal entries, tax cases, DATEV export, dual-control review — is operated by
someone who is not an accountant.** Accounting-grade correctness with owner-grade legibility is the
standing tension in every Pro screen; density borrowed from professional accounting software is a
failure mode here, not a reference.

Server mode adds multi-user roles (`owner`, `admin`, `accountant`, `sales`, `viewer`), so a bookkeeper
*can* be given a seat — but they are a participant in the owner's system, not the persona the product
is shaped around.

## Product Purpose

Billme is local-first invoicing and accounting for German small businesses. Business data stays on the
user's own machine: the desktop app writes to an embedded PGlite database with no account, no cloud,
and no subscription server that can revoke access to the user's own invoices. An optional self-hosted
server mode (Docker: Postgres + API + worker + browser shells) exists for multi-user or browser access,
and a separate public portal shares offers and invoices with customers.

Success is that a German small business can run its billing and its books end to end, prove what
happened when asked to, and never be dependent on a vendor staying online or staying in business.

## Positioning

Three claims a neighboring product could not truthfully copy:

1. **Ownership is structural, not a promise.** No account, no cloud dependency, no server that can turn
   the invoices off. The self-hosted server mode is opt-in, and it is the *user's* server.
2. **German compliance depth as the core, not a locale pack.** ZUGFeRD / EN 16931 e-invoicing verified
   in CI against Mustang CLI and veraPDF; Anlage EÜR on the official 2025 line catalog; SKR03/SKR04;
   DATEV Buchungsstapel export; Mahnwesen; 14 German tax cases; append-only hash-chained audit log
   enforced by SQL triggers.
3. **The intelligence is local too.** Account suggestions come from a five-stage local cascade
   (rule → counterparty memory → naive Bayes → keyword → fallback) trained on the user's own booking
   history. No cloud AI, no data leaving the machine.

The honesty of the GoBD claim is itself part of the positioning: Billme provides *technical controls
that support* GoBD-oriented workflows and says so plainly. It claims no certification, and the
project's own checklist rates every clause as partial. Future work must not upgrade this into a
compliance guarantee.

## Operating Context

- **Two separate applications, not one with a license key.** Billme Lite (`apps/desktop`,
  `com.billme.desktop`) and Billme Pro (`apps/pro-desktop`, `com.billme.pro`) install side by side and
  use **separate databases** (`billme-pglite/` vs `billme-pro-pglite/`). The split happens at build
  time. **Pro is not a superset of Lite's UI** — it replaces the Statistics and EÜR screens with the
  double-entry accounting workspace. Lite is for EÜR filers; Pro is for double-entry books.
- **Four deployment models:** desktop (Electron, single business per install, local PGlite);
  server mode (Docker stack, multi-user with roles, Postgres); demo (the real desktop UI in a browser
  against in-memory per-session mock data); offer portal (public Hono service, its own snapshot store,
  never the source of accounting truth).
- **The document is the working surface.** A centered A4 editing canvas with inline customer, address,
  date, tax, line-item and live-total fields, shared by Lite, Pro, desktop and browser shells. A
  drag-and-drop visual designer with element rail, inspector, layers, rulers, snapping and undo/redo
  produces the reusable templates behind it.
- **Real work arrives as files and money movements** — bank CSV in German bank encodings, PDF/image
  evidence in Pro's transaction inbox, PDFs out with embedded ZUGFeRD XML, DATEV export files, and the
  Betriebsprüfung package.
- **The Lite browser shell is deliberately reduced** to Dashboard, Clients and Documents; Projects,
  Finance and Articles stay desktop-only in Lite. The Pro browser shell carries its own full UI
  including the accounting workspace.

## Capabilities and Constraints

**Domain terminology is German and is product truth, not decoration.** Angebot, Rechnung,
Abo-Rechnung, Mahnwesen / Mahnstufe, Kunde, Anlage EÜR, SKR03 / SKR04, Buchungsstapel, DATEV,
BU-Schlüssel, SuSa / GuV / Bilanz, Betriebsprüfung, GoBD, ZUGFeRD, Kleinunternehmer §19, §13b
Reverse Charge, §25a Differenzbesteuerung, §48 Bauabzugsteuer, §25b Dreiecksgeschäft. Do not translate
these into English equivalents in the UI, and do not invent softer synonyms — users match them against
letters from the Finanzamt and their Steuerberater.

Hard product rules that design must respect rather than smooth over:

- Journal entries **must balance before posting**; `UNBALANCED_ENTRY` is a hard block.
- Corrections happen by **reversal with a mandatory reason** — never deletion.
- **Mandatory reason prompts** on key document and client change/delete flows, desktop and API alike.
- Journal entries, journal lines and DATEV exports are **immutable at the database level** in Pro;
  Lite protects the audit log the same way.
- **11-state booking workflow with dual-control gates** (submit for review, approve, reject, post,
  reverse, create correction) and accounting periods that are open, soft-locked or closed.
- **Tax snapshots are immutable** and stored on each document.
- DATEV export **validates fields and aborts** rather than writing a malformed file.
- Server mode is **product-isolated**: a Lite token on a Pro route is rejected with `403`.

Technical constraints:

- Electron + React desktop; React browser shells; Fastify API; Hono portal; pnpm workspace, Node 20+.
- Design tokens have a single source of truth: `packages/ui/styles.css` (Tailwind v4 `@theme`) mirrored
  in `packages/ui/src/utils/colors.ts`. See `DESIGN.md`.
- `@billme/ui` primitives are shared by every shell — a change there lands in Lite, Pro, web and demo
  simultaneously.
- The **only** outbound-AI seam is optional: Pro's transaction inbox may send PDF/JPEG/PNG/WebP
  evidence to OpenRouter when `OPENROUTER_API_KEY` is set, against an allowlisted model. It produces
  review evidence and **never posts a booking automatically**. Everything else stays local.
- Licensed **FSL-1.1-ALv2** — usable and modifiable except for building a competing product; each
  release converts to Apache 2.0 after two years.

Explicitly undecided / not yet true — future work must not present these as shipped:

- The **mobile app** (Expo / React Native action cockpit against server mode) is roadmap only, on an
  unmerged branch. No release, no store listing. It is not in this repository.
- The **platform admin console** and **agent control** bridge are likewise design-doc only.
- Pro's SuSa, GuV and Bilanz report engine exists over IPC, but the shared accounting UI is not yet
  wired to it — those screens currently render sample data.
- Server mode ships **no TLS and no reverse proxy**; the operator supplies them.

## Brand Commitments

- **Name:** Billme. Public demo at `demo.getbillme.com`.
- **Voice:** German-first and informal — the product and marketing address the user as **"du"**
  (`Erstelle dein erstes Angebot lokal.`). The English README is secondary documentation, not the
  product voice. Copy is plain, concrete and unhyped; it states what a control does.
- **Claim discipline is a brand commitment.** Beta status, "partial" compliance ratings, and
  "engineering support, not legal advice" are stated openly. Never soften a limitation into a promise.
- **Origin:** "Built with love in Germany" — stated in the README and treated as real, not a badge.
- **Existing identity assets:** `logos/FullLogo3.svg`, `logos/Letter_B_only.svg`. The committed visual
  system is documented in `DESIGN.md` and is the incumbent authority; this file does not restate it.

## Evidence on Hand

Real, verifiable material available to future work:

- `logos/FullLogo3.svg`, `logos/Letter_B_only.svg` — identity assets.
- `assets/screenshot_billme.png` — real product screenshot.
- **Live public demo:** `https://demo.getbillme.com/` — the real desktop UI, per-session in-memory data.
- **Independently verified conformance:** ZUGFeRD/EN 16931 validated against Mustang CLI (profile E)
  and PDF/A against veraPDF in `.github/workflows/einvoice-validation.yml`. This is real, citable proof.
- The **official Anlage EÜR 2025 line catalog** ships in
  `packages/desktop-services/src/eur/lines-2025.json`.
- Bundled SKR03 / SKR04 charts of accounts, imported on first launch.
- `pnpm dev:editor` on `http://127.0.0.1:4177` renders the document editor against real fixtures
  (`?fixture=construction|page-break|all-line-types|long-text|mixed-vat`) — usable as live visual truth.
- Public repository and CI badges; FSL-1.1-ALv2 `LICENSE`.

**Absences future work must not fabricate:** there are no testimonials, no named customers, no user
counts, no revenue or adoption numbers, no press coverage, no awards, no certification (GoBD included),
no pricing page and no published pricing. Billme is in **beta** and says so. If a surface needs social
proof, it must be requested from the user, not invented.

## Product Principles

1. **The user's data is theirs, structurally.** Every design decision defaults to local, offline and
   account-free. Anything that leaves the machine is opt-in, named, and reversible.
2. **Accounting-grade rigor, owner-grade legibility.** The rules are strict because German bookkeeping
   is strict — but the person reading the screen is not an accountant. Explain the block, name the
   consequence, offer the legal path forward. Never assume domain fluency; never dumb down the terms.
3. **Say the true thing plainly.** Beta is beta, partial is partial, "supports GoBD-oriented workflows"
   is not "GoBD-certified". Confidence comes from precision, not from claims.
4. **The document is the product.** Angebot and Rechnung are what the user is actually making; the
   editor's A4 surface is the hero and the surrounding chrome recedes.
5. **One system, two editions, no bait.** Lite and Pro are honest, separate products for two different
   ways of keeping books — not a feature-gated funnel. Neither shell may imply the other is an upgrade.

## Accessibility & Inclusion

**Target: WCAG 2.2 AA** — confirmed, and binding on all future work. Contrast, visible focus, full
keyboard operability and adequate target sizes are non-negotiable, not polish-pass items.

One product-specific consequence worth stating here: the brand accent is a light color with low
contrast on light backgrounds, and invoice status is a core piece of information users act on. How the
accent may carry text and how status is encoded beyond color are `DESIGN.md`'s to govern; this file only
records that AA holds for both.

Existing signal to build on rather than rediscover: the landing page already ships a skip link and
`aria-hidden` on decorative content.
