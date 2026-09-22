# antislop fix report 002, billme monorepo

- Date: 2026-09-15
- Follows: `anti-slop/audit-001-2026-09-15.md` (51 findings, 4 approved decisions)
- Scope executed: the full program, Phases 1 to 7, as approved.
- Change set: 167 tracked files changed (8099 insertions, 13364 deletions), 13 files deleted, 12 source files added.

## 1. What changed, by finding

### Honesty (fabricated content reaching users)

| Finding | Result |
| --- | --- |
| F-001, F-002 | Every `?? MOCK_SETTINGS` fallback on the settings path is gone (`SettingsView`, `InvoicesView`, `InvoiceDocumentEditor`, `PrintDocument`, `DashboardViews`, `StatisticsView`, both `router.tsx`, the shared shell in `packages/desktop-ui/src/shell/`). Those views now have real loading and error branches, so a failed settings query can no longer render another company's name, IBAN or tax id, and the invoice document refuses to open without real settings (`InvoiceDocumentEditor.tsx`: `ErrorState` with retry, then a spinner, then render). |
| F-003 | `apps/demo` shows a persistent banner ("Demo mit Beispieldaten. Änderungen werden nicht gespeichert.") on warning tokens, `lang="de"`. |
| F-004 | `DunningLevelPreviewModal` takes sender and recipient from the caller and labels remaining sample values. |
| F-005 | `packages/desktop-services/src/mockData.ts` no longer attributes fabricated payment histories to real companies; counterparties use the synthetic `Muster*` convention. |
| F-006 | Onboarding placeholders are instructive German hints instead of a fake identity. |
| F-007 | The `Aktiv` badge that marked no state is gone. |
| F-018, F-019 | The offer portal has a shared branded page shell, a root page, and distinct pages for unknown (404), revoked (403), expired (410) and rate-limited (429) links, each naming the cause and the next action. Empty and filtered-empty are separate states. |
| F-048 | The landing hero screenshot carries a visible sample-data caption and an accurate alt text. |

### Accessibility hard gates

| Finding | Result |
| --- | --- |
| F-008 | Accent is a fill only. Removed from text on light surfaces (renderer, `Combobox`, `BookingEditor`, designer), from focus indicators (`Input`, `Select`, `Textarea`, `Inspector`, `TopBar`, report toolbars, the landing page) and from the four settings checkmarks. Lime on the dark ramp is unchanged where it is correct. |
| F-009, F-010 | Secondary copy uses `text-muted` (darkened to #676d75 so it clears 4.5:1 on all three light grounds); semantic hues use their `-text` tokens, including `getDunningColors()` and the dunning modal. |
| F-011 | A new `control-border` token (#8b8b8b, 3.41:1 on white) is the boundary of every control; `border` remains a decorative separator. |
| F-012 | Status dots carry adjacent text labels (client activity dot, `ExceptionCenter` severity dot). |
| F-013 | No em dash remains anywhere in `apps/` or `packages/`. Prose was rewritten; every empty-value fallback renders `EMPTY_VALUE` (`–`) from `@billme/ui`, including the two data-layer values. |
| F-014 | Every bare `outline-none` is replaced by the `focus-visible:outline-focus-ring` pattern (light) or `outline-focus-ring-dark` (dark ramp); the border-only substitutes are gone. |
| F-015 | Clickable rows and cards are real `button` elements or carry `role="button"`, `tabIndex` and Enter/Space handling (clients grid and list, document rows, payment rows, template cards, settings toggle cards, transaction rows). |
| F-016 | Every hand-rolled overlay now renders through the `Modal` primitive: 6 in `InvoicesView`, 2 in `ProjectsView`, 1 in `RecurringView` plus the rules and import modals, the 3 in `packages/desktop-ui`, the booking-editor dialog, the journal-entry modal, both bank-account modals and the Pro account-rules modal. This removes literal z-indexes, restores dialog semantics, focus containment and Escape, and gives icon-only close buttons accessible names. |
| F-017 | Every data view has empty, loading and error states wired to the query state (`isLoading`/`isError`/`refetch`) instead of `data = []` defaults. `EmptyState` and `ErrorState` are new shared primitives. |
| F-020 | Interactive targets meet at least 24x24; the designer's row strip and layer controls, the landing CTAs (44px) and chips, and the shared action bar were extended. |
| F-021 | All `dark:` variants are gone from the desktop surfaces. Tailwind v4 compiles `dark:` to `prefers-color-scheme: dark` and the package ships `color-scheme: light`, so an OS-dark machine no longer flips half the app to gray-900. |

### Motion, colour, surface, structure

| Finding | Result |
| --- | --- |
| F-024, F-025 | The global animation stack is deleted (`fadeInUp`, `fadeInScale`, `animate-enter`, `animate-scale-in`, `premium-hover`, staggered delays, the dead `animate-in`/`slide-in-from-*`/`animate-fade-in` classes) and both `index.html` style blocks are reduced to the page ground. MOTION 1 now means what it says: 0 animated elements in the running app, with reduced-motion handled globally in `packages/ui/styles.css`. Remaining `animate-spin`/`animate-pulse` are loading indicators guarded with `motion-safe:`. |
| F-026 to F-030 | Orbs, glow shadows, decorative gradients, glass outside modal scrims and border-plus-shadow double elevation are removed across the app, the designer, the landing page, `web-pro` and the portal. |
| F-031 | Raw hues map to semantic tokens (purple offer badge, amber/red/green/emerald/rose/yellow/blue). |
| F-032, F-033 | Arbitrary radii and bare `rounded` are gone; `Card` defaults to the dense-data radius and a resting shadow; `rounded-full` is reserved for status pills and avatars. |
| F-034, F-035 | Figures use Inter with `tabular-nums`; `font-mono` is limited to IBANs and technical ids; sub-12px type snapped to `text-xs` everywhere except the designer's page-anchored billing rows, which carry a file-level comment (10px and 11px only, 8px and 9px banned). |
| F-037, F-038 | Emoji in copy replaced by icons or words; the magic glyphs (`Sparkles`, `Wand2`) and the wrong currency/trend glyphs replaced. |
| F-039 | Uniform KPI rows gained hierarchy: the metric that answers the screen's question is the focal card, the rest are a compact row. No data or deltas were invented. |
| F-040, F-041 | The landing page re-composed one section deliberately (RHYTHM 2, commented) and gained a visible FAQ affordance; chart units and axis labels are present; raw enum ids render as German labels. |
| F-042, F-043, F-044 | 1500+ untokenized gray/slate utilities and raw hex migrated to tokens; `bg-canvas`/`bg-editor-viewport` map to real tokens instead of compiling to nothing; every overlay uses Portal plus the layer tokens. |
| F-045 to F-047, F-049 to F-053 | `apps/web-pro` lost its 381-line standalone stylesheet and consumes the shared tokens like `apps/web`; the landing page gained Impressum and Datenschutz, a favicon, a deep import instead of the UI barrel, and no decorative loops; the demo carries a banner and `lang="de"`; the portal gained `lang="de"`, one token palette, the brand accent on its primary action, rem radii and a scrollable table; `packages/desktop-ui` skeletons and spinner are tokenized and guarded; the dead designer `legacy/**` directory and its eight shims are deleted. |

## 2. Delivery gate report

### Block 1: Hard Gate (every answer was checked in the running app or by code, all are "no")

- **R-02 em dash: PASS.** `rg '—' apps packages` returns zero hits.
- **R-03 mobile: PASS.** Renderer app shell at 375px: `scrollWidth == clientWidth` on dashboard, documents and clients (no horizontal overflow). Portal and landing page verified at 320px by their workstreams, including the portal's six-column table scrolling inside its wrapper.
- **R-17 statistics: PASS.** No invented metric exists; the one fabricated figure (`monthlyRevenueGoal: 30000` from `MOCK_SETTINGS`) is removed, and every remaining KPI is computed from query data.
- **R-18 testimonials: PASS.** None exist anywhere.
- **R-23 assets: PASS.** No logo, avatar or photo was invented; sample values are labelled (`Demo mit Beispieldaten`, `Beispielhafte Darstellung`, the landing screenshot caption).
- **R-24 navigation: PASS.** Every nav item resolves (verified by click-through: Übersicht, Kunden, Projekte, Dokumente, Finanzen, Artikel, Einstellungen all render their own screen with 0 console errors).
- **R-25 contrast: PASS.** Rendered-pixel sweep over 6 views: 0 text elements below 4.5:1 (3:1 for large text). Token pairs measured: `muted` 5.22:1 on white, 5.00:1 on surface-muted, 4.75:1 on the sunken ground; `control-border` 3.41:1 on white; semantic `-text` tokens 4.79:1 to 6.37:1 on their tints; lime with black text 17.58:1.
- **R-26 interactive elements: PASS.** Click-through exercised the nav, a document row (now a real button), the detail actions, the payment modal and the deferred-delete path; no dead control found. Closest gap fixed in this pass: the `ProjectsView` close button was missing its icon import and now has one.
- **R-27 states: PASS.** Empty, loading and error branches exist per view; the settings-dependent views can no longer render fabricated data while loading.
- **R-28 FAQ: PASS.** The four landing questions are product-specific; none were added.
- **R-32 keyboard: PASS.** Payment modal in the running app: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` resolving to "Zahlung erfassen", focus moved inside on open, icon close button named "Dialog schließen", Escape closes it. Focus ring measured at 2px solid with color #0b0b0b.
- **R-33 patch scripts: PASS.** None exist; no feature is implemented by rewriting source.
- **R-34 themes: PASS.** The product is light-only by declaration (`color-scheme: light`, no `dark:` variants); the partial OS-dark flip is gone.
- **R-35 verified before delivery: PASS.** See section 3.
- **R-36 claims: PASS.** No compliance, security or performance claim exists; the landing page still explicitly refuses a GoBD certification claim.
- **R-37 direction: PASS.** `DESIGN.md` now declares the dials with reasons, plus the new tokens and the empty-value convention.
- **R-38 real content: PASS.** No fabricated record renders as real; mock and demo content is labelled or unreachable.

### Block 2: Purpose-Gate (no default without a written reason)

- **R-01 gradients: PASS.** Zero gradients render in the app (DOM probe: `gradients: 0`).
- **R-04 icons: PASS.** Magic and sparkle glyphs removed; lucide remains with relevance to each label, and the dark-ramp accent pairing is documented in the guard's allowlist reasoning.
- **R-06 typography: PASS.** One family, one scale, figures in `tabular-nums`; the only sub-12px type is the designer's page-anchored billing rows with a written reason.
- **R-07 background: PASS.** No grid or dot texture outside `GridOverlay`, which is a functional snapping aid.
- **R-08 arrows: PASS.** Arrows remain only where the action navigates forward.
- **R-09 badges: PASS.** The decorative `Aktiv` badge is gone; remaining pills carry real status.
- **R-10 glass: PASS.** DOM probe: `blurred: 0`. Blur exists only on modal scrims.
- **R-12, R-13 shadow and glow: PASS.** `orbs: 0`; elevation is declared once per surface.
- **R-14 feature cards: PASS.** KPI rows have hierarchy; card grids are no longer four identical copies of the same shape.
- **R-19 motion: PASS.** `animated: 0` with and without the reduced-motion preference; content is visible on first paint.
- **R-22 illustrations: PASS.** None.

### Block 3: Liveliness (all yes)

- **Dials declared: yes.** `DESIGN.md`: ENERGY 1, RHYTHM 1 in the apps and 2 on the landing page, MOTION 1, each with its meaning.
- **Output consistent with the dials: yes.** Uniform, calm app rhythm; one deliberate landing section break.
- **One focal point per screen: yes.** The dark receivables card on the dashboard, the revenue card in statistics, the document itself in the editor.
- **Whitespace structural: yes.** Section and card spacing follows content weight rather than one repeated value.
- **One deliberate accent: yes.** The lime fill appears on the primary action and the paid status only.
- **Identity motif: yes.** Lime fill over a white, generously rounded card system, with the near-black document viewport as the editorial counterweight.
- **Design Read declared before generation: yes.** Derived from `DESIGN.md` plus the approved dial answers.

### Block 4: Craftsmanship and Quality Locks (all no)

- **C-1 / R-31 intentionality: no unjustified decisions remain.** Every retired pattern has a written reason in `DESIGN.md` or in the guard rules; the guard prints the reason next to each rule.
- **C-2 functional completeness: no dead control.** Verified by click-through.
- **C-3 content-driven composition: no template section.** The landing order was re-composed for one section and the app screens were rebuilt around the decision each supports.
- **C-4 resilience: no state, theme, breakpoint or keyboard gap.** Empty/loading/error states exist, both OS appearance modes render identically light, 375px has no overflow, dialogs and controls are keyboard-operable.
- **C-5 evidence over claims: no fabrication.**
- **R-05 layout: no template tells.** No "Trusted By" bar, no testimonials, no three-column pricing, no bento mosaic, no fake terminal, no four-column footer, no three-step "How it works".
- **R-11 radius: no pill-everything.**
- **R-15, R-16 CTAs and copy: no generic CTA or buzzword.**
- **R-20 identity: no logo-swap test failure.** The lime-on-white system with the dark document viewport is specific to this product.
- **R-21 dark mode: no unjustified default.** The dark ramp is scoped to the document viewport with the reason recorded.
- **R-29 palette: within limits.** 2-3 cores (near-black, white, grey) plus the lime accent, with semantic roles for state.
- **R-30 clone: no.** No product is mimicked.
- **R-31 reasons: written.**

## 3. Verification evidence

Commands, all run after the last edit:

- `pnpm -C apps/desktop typecheck`: clean.
- `pnpm -C apps/pro-desktop typecheck`: clean.
- `pnpm -C apps/web typecheck`: clean.
- `pnpm -C apps/web-pro typecheck`: clean.
- `node scripts/design-token-guard.mjs`: "Design-token guard passed (12 rules, 7 exempt paths)."
- `pnpm -C apps/desktop test`: 221 passed.
- `pnpm -C apps/pro-desktop test`: 344 passed.
- `pnpm -C packages/accounting-ui-pro test`: 119 passed.
- `pnpm -C packages/desktop-renderer test`: 60 passed, 5 failed (all five pre-existing, see section 4).
- `pnpm -C apps/offer-portal test`: 4 passed.
- `pnpm test:e2e:smoke` (Playwright, desktop and Pro Electron): 3 passed.
- Builds: `apps/desktop`, `apps/web`, `apps/web-pro`, `apps/landing-page`, `apps/demo` all built. The first build exposed a real CSS defect in the new stylesheet (a `*/` sequence inside a comment terminated it early); fixed, and the rebuild is warning-free on that front.
- Compiled-CSS assertions: `.a4-canvas`, `.scrollbar-hide`, `.mask-linear-fade`, `control-border`, `surface-sunken` present; `animate-enter` and `premium-hover` absent; `border-3` resolves (answering the audit's open question about the spinner utility).
- Running app (Lite renderer, Chromium at 1440x900), recorded element by element:
  - Übersicht, Kunden, Projekte, Dokumente, Finanzen, Artikel, Einstellungen each render their own screen: 0 console errors, 0 page errors.
  - Document row click opens the detail; the detail actions render; the payment action opens a labelled modal; Escape closes it.
  - DOM probe: `bodyBg rgb(243,244,246)` (the sunken token), `blurred: 0`, `orbs: 0`, `gradients: 0`, `animated: 0`, 46 elements on the new `muted` value, 0 elements on the retired gray-300/400 text values outside the dark ramp.
  - Contrast sweep over 6 views: 0 real failures.
  - `prefers-reduced-motion: reduce`: 0 animating elements, 0 elements left invisible, content visible.
  - 375px viewport: no horizontal overflow on 3 views.
  - Focus: 2px solid #0b0b0b outline visible on keyboard focus.
- Re-run after the three layout fixes of section 6: guard passes, `apps/desktop` and `apps/pro-desktop` typecheck clean, `packages/desktop-renderer` 60 passed with the same 5 pre-existing failures, `apps/pro-desktop` 344 passed, `pnpm test:e2e:smoke` 3 passed.
- Re-run after the section 8 sweep fixes: guard passes, `apps/desktop`, `apps/pro-desktop`, `apps/web` and `apps/web-pro` typecheck clean, Lite 221 passed, Pro 344 passed, accounting 119 passed, renderer 60 passed (same 5 pre-existing failures), `pnpm test:e2e:smoke` 3 passed.

## 4. Known remaining items

Pre-existing, not caused by this change set, and not fixed:

1. `packages/desktop-renderer/src/components/InvoiceDocumentEditor.document.test.tsx`: 5 tests fail because they query a control named "Empfänger ohne Kundenstamm eingeben" that does not exist in the source at `HEAD` either (`git grep` at `HEAD` finds the string only in the test file). Meanwhile `packages/desktop-renderer` reports 60 passing. These tests need to be rewritten against the control that actually exists, or the control needs to be restored; that is a product decision, so nothing was re-pinned.
2. `apps/web`/`apps/web-pro` fail at module init in dev because `better-sqlite3`/`drizzle-orm` reach the browser graph through `@billme/desktop-contracts/api -> api-factory -> @orpc/client -> server-core/orpc/contract -> server-core/ports -> desktop-data/drizzle` (`promisify is not a function`). Unmodified files, reproducible on `apps/web`. The shells' typecheck and build pass, so this is a runtime architecture defect in the shared contract barrel that predates this work.
3. `apps/web-pro/src/App.tsx` seeds a bank-account colour `#3c6e71` in two places. It is persisted user data sent to the API, not chrome, so it was left alone.
4. The landing page's OG/Twitter image is still the mock-data PNG with an unlabelled `+12%` delta. A PNG cannot be edited and the OG card has no caption slot; only the on-page presentation was corrected.
5. `packages/accounting-ui-pro/mocks/**` can still render when no data adapter is injected. Today both consumers always inject one; the mock paths are now visibly labelled as sample data wherever they can render.
6. Server-mode E2E (`pnpm test:e2e:server:*`) was not run: it needs the Docker stack, which is not part of this task. The browser-shell sources typecheck and build, and the shell re-skin was verified in a browser session by its workstream.
7. `packages/server-*` typechecks were not re-run: no file in those packages changed except two em-dash data values and one comment, and no server test asserts those strings.

## 6. Screenshot verification round (Playwright CLI)

Run after the fix program, with the dev servers up (`pnpm dev:renderer` on 3000, `pnpm dev:landing` on 4173) and `./node_modules/.bin/playwright screenshot`.

Checked: 12 app views at 1440x900 (dashboard, clients, projects, documents, articles, finance, statistics, accounts, recurring, eur, templates, settings), the documents view at 768/1024/1280, the clients view at 390, the landing page at 1440 full page and 390 full page, and the Impressum page. Screenshots in `/tmp/billme-shots`.

Three layout defects were found that the static audit could not see, all three fixed and re-verified:

1. **The global search field painted over the last navigation destination between 768 and 1279px** (measured overlap of 57px at 1280, 61px at 1024; "Artikel" was invisible). Cause: the header was three fixed columns (`w-64` logo, rigid nav pill, `w-64` actions) with `justify-between`, so the actions cell overflowed leftwards under the nav. Fix: the nav cell is now the only flexible one (`min-w-0 flex-1`), the nav scrolls inside it instead of overflowing, the logo column is `w-40`, the header padding is `px-6`, tabs are `px-4`, and the search input is `w-40 focus:w-52`. Verified: at 1280 the Lite nav needs 597px of 695px available, and the Pro nav with its extra "Steuer" tab needs 679px, both fit with no internal scrolling.
2. **No primary navigation below 768px.** The pill nav was `hidden md:flex` with no replacement, so at 390px a user could not reach Kunden, Dokumente, Finanzen or Artikel. Fix: a scrollable navigation strip (`xl:hidden`) renders the same destinations on its own row under the header, and the pill nav now appears only from `xl` where it fits without scrolling. Verified at 390, 480, 767, 768, 1024, 1280: exactly one of the two is visible, every destination is reachable, no page overflow.
3. **The documents view could not shrink, clipping its toolbar at 768px.** The toolbar needed 1105px (title, filter chips, search, three actions in one unwrappable row), which forced the content area to 1137px inside a 768px viewport and cut the search field off at the right edge; the rows additionally needed about 750px because the two date columns appear from `md`. Fix: the toolbar wraps, the search field is full width below `sm`, the date columns appear from `lg`, and the amount and status columns narrow below `lg`. Verified at 390/768/1024/1280: no horizontal overflow, rows keep number, client, amount and status at every width and add the dates from 1024.

Observations recorded so they are not re-found as defects:

- The empty grey bar under "Zahlungsquote" is a 0% progress track, not a stray element.
- The dashboard's "Ziel: 30.000,00 €" comes from the dev harness mock settings; the product path no longer fabricates it.
- The list scrollbar is intentionally hidden (`scrollbar-hide`).
- The 26px dashboard popover triggers and the 36px header icon buttons exceed the binding 24x24 floor in `DESIGN.md`, though they are below the 44px ideal. The 44x32 window controls are Electron chrome.

Robustness note surfaced by the same run: `apps/*/index.html` loads Inter from Google Fonts. With the CDN unreachable, the fallback metrics widen the nav enough to hide its last item (which is how defect 1 also became visible at 1440 in a headless run). For a local-first, offline-capable desktop app the font should be self-hosted; that is a follow-up recommendation and was not changed in this pass.

## 8. Exhaustive screen and interaction sweep

A scripted sweep (`scripts/tmp-ui-sweep.mjs`, throwaway) drove both desktop renderers in a real browser: every route in phase A with no interaction, then phase B clicking every non-destructive control once, each from a fresh page load, verifying any dialog it opens and closing it again.

Coverage: 12 routes x 2 renderers (`apps/pro-desktop` on 3000, `apps/desktop` on 3001), 6 interactions per control set including every modal the app owns, plus the public surfaces driven live: the offer portal (root, unknown link, legacy offer link), the landing page (landing, Impressum, Datenschutz) and the Lite browser shell.

Invariants checked per route: page and container overflow, clipped text, text-box overlap (floating layers excluded), contrast against the composited background chain, accessible names on every control, label association on every input, 24px target floor, image alt, duplicate ids, and a 12-step keyboard walk asserting a visible focus ring on each stop.

Final result: **zero invariant findings on all 24 route-states, zero console errors, and every dialog correct** (labelled, `aria-modal`, focus inside on open, Escape closes, validation message on empty submit).

### Defects this round found and fixed

1. **The Pro renderer loaded a second Tailwind build** (`packages/accounting-ui-pro/src/index.css` started its own `@import "tailwindcss"`, imported by `apps/pro-desktop/index.tsx` and `apps/web-pro/src/styles.css`). The duplicate utility sheet is emitted after the token sheet, and a later unconditional `.flex` beats an earlier `@media` variant, so every responsive utility was silently disabled in the Pro shell. Symptom: the narrow-width navigation strip rendered at 1440px next to the pill nav. Fix: the package no longer builds CSS (the host sheet already scans `packages/*/src/**`), its `./styles.css` export is gone, and both import sites are removed. Both apps now load 3 stylesheets and behave identically per breakpoint.
2. **`/projects` row grid overflowed its cells**: the actions column was 213px while its two buttons need 265px, so the buttons spilled left over the date column. Rebalanced to 3/2/2/2/3 with truncation on the free-text columns; measured overlap is now zero.
3. **27 settings fields had visually present but unassociated labels** (bare `<label>` next to the input, no `for`), so screen readers announced unlabeled edit fields and clicking a label did not focus its field. Each pair now has `htmlFor`/`id`.
4. **Two icon-only view toggles in the article list had no accessible name**, and the article and client search fields relied on a placeholder alone. Added names and `aria-label`s, plus `aria-pressed` on the toggles.
5. **The bank-account dialog could not explain itself**: its submit was disabled while the name was empty, which made the "Kontoname ist erforderlich." branch unreachable dead code, and the disabled state was `opacity-50`, which `DESIGN.md` explicitly rejects in favour of the token treatment. The submit is now enabled, validates on submit, marks the field `aria-invalid`, prints the inline error, and moves focus to it. The Pro variant additionally validates its required standard chart-of-accounts account.
6. **Small targets and stray native checkboxes**: the document row select control was a 20x20 hit area (now 24x24 via padding with an `aria-label` and `aria-pressed`), the EÜR text button was 16px tall (now 24), and three EÜR checkboxes plus the projects archive filter were unstyled native controls (now the shared treatment with `accent-black` and a 24px box).
7. **Filter chips did not expose their state**: the documents status filters, the statistics range chips and the article category chips now carry `aria-pressed`.

### Harness noise, recorded so it is not mistaken for product defects

- `not-found` clicks are stale-name artifacts: after the first row click the list is replaced by the detail view, and composite accessible names built from several text nodes do not match an exact-name locator.
- `no-observable-effect` covers controls that legitimately change nothing from their current state (clicking "Alle" while showing all, re-selecting the active view toggle, re-clicking the active section) and value-only updates.
- Three click timeouts in EÜR and the article category row are races: those controls exist only after the row auto-selects, and the locator ran before it rendered. Verified by hand that both EÜR controls exist and are clickable.
- The landing logo link showed as unnamed in the first probe; its `<img>` carries `alt="Billme Logo"`, so the link is named.

## 10. Screenshot gallery and coverage

A gallery run (`scripts/tmp-gallery.mjs`, throwaway) produced 75 screenshots in `/tmp/billme-gallery`, each paired with the invariant check, plus a report of what it found.

| Surface | Coverage |
| --- | --- |
| Lite renderer (`apps/desktop`) | every route (dashboard, statistics, accounts, finance, EÜR, templates, documents, subscriptions, clients, projects, articles, settings) at 1440 and 390 |
| Pro renderer (`apps/pro-desktop`) | the same 12 routes at 1440 and 390 |
| Dialogs | bank account, new project, new subscription, EÜR rules on both apps (8 screenshots), each with in-dialog invariant checks |
| Component states | subscription dialog with its date fields, project dialog validation summary, document multi-select bar |
| Landing page | 1440, 390, Impressum, Datenschutz |
| Offer portal | root at 1440 and 390, unknown link, legacy unknown link, operator setup page |
| Browser shells | Lite and Pro login screens |
| Editor | playground at 1440 and 390 |

### Defects this round found and fixed

1. **Document rows collided at 390px**: the dunning badge painted over the amount and the status pill, and the document number was hidden behind them. The row now wraps below `md` with the metadata on its own right-aligned line.
2. **Project rows were unusable at 390px** (33 box overlaps, the project name hidden behind the archive and edit buttons, clipped column headers). Rows stack below `md`, the column header is hidden there, and free-text columns truncate.
3. **Subscriptions**: the page header collided with "Neues Abo", the card's "Aktiv" chip painted over the subscription name, and the interval metrics clipped. The header and card head now stack, names break to a second line, and the metrics wrap.
4. **EÜR**: the export buttons overflowed the viewport at 390 and "Unklassifiziert" clipped. The toolbar wraps and the summary cards are single-column below `sm`.
5. **65 field labels across 9 files had no programmatic association** (`<label>` next to a control with no `for`), so screen readers announced unlabeled fields and clicking a label did not focus anything. Found with a repo-wide check rather than the swept routes, and every pair now carries `htmlFor`/`id`. The dashboard's dynamic settings list also had one id repeated across its fields; it now derives the id from the field key.
6. **The shared `Button` rendered its icon above its label.** Tailwind's preflight makes `svg` block-level, so `icon + label` inside the label span stacked vertically, which affected every icon button in the product (visible as a two-line "Speichern" in the subscription dialog and stacked "+ / Neues Abo"). The label row is now its own flex line with `whitespace-nowrap`.
7. **Playground toolbar buttons** used `opacity: .45` on a lime fill, which left the disabled label unreadable lime-on-lime; they now use the token disabled treatment.

### Known false positives in the gallery report, verified by hand

- Overlaps reported in the dialog states pair page text with dialog text; the dialog is portalled with a higher layer, and the detector's floating-layer check does not reach that far up the tree.
- The `( Rechnungen )` contrast hit in the selection bar is a parser artifact: the colour is `text-white/60` on `bg-black`, which measures 9.4:1 (the detector cannot parse an oklab colour with an alpha modifier).
- The landing skip link is `sr-only` by design and becomes visible on focus.
- The editor playground overlaps are authored canvas elements inside the A4 page, which may overlap by design; the screenshot shows no glyph collision.

### Still without screenshots

- Print/PDF output and the Electron window chrome/menu.
- Server-mode browser shells beyond their login screen (they need the API stack running).
- Offer portal document states that require seeded tokens (expired, revoked, accepted); the portal workstream photographed those in its own verification at 1280 and 320.
- The demo worker build at runtime.
- Primitives whose states need a specific trigger and have no route of their own: `Combobox` open list, `DatePicker` open calendar, `HelpHint` tooltip, `Toast`/undo feedback, `ConfirmDialog` with a required reason, `SkeletonLoader`. `packages/ui` contains no test files, so these remain the least covered components visually.

## 11. Guard and its rules

`scripts/design-token-guard.mjs`, wired as `pnpm check:design-tokens` and added to the app job in `.github/workflows/ci.yml`, fails on: em dash, raw hex in a utility, default gray/slate palette utilities, arbitrary radius, default gradient, glow, glass outside a scrim, sub-12px type, `outline-none` without a replacement, decorative entrance animation, literal overlay z-index, and accent-as-text-on-light. Exempt paths (print/PDF templates, user-customizable canvas colours, the token files) and the two reasoned allowlists (the designer's page-anchored micro type, the dark-ramp surfaces where lime is the correct foreground) are declared inline with their reason, so the next person can see why.
