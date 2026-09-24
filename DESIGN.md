---
version: alpha
name: billme
description: >-
  Design system for the billme invoice/accounting suite (Lite + Pro desktop and
  server-mode browser shells). A bright lime accent over a clean light UI, with
  near-black premium surfaces for the document/invoice editor. Tokens are the
  source of truth; defined in packages/ui/styles.css (Tailwind v4 @theme) and
  mirrored as TS constants in packages/ui/src/utils/colors.ts.
colors:
  ink-0: "#ffffff"
  ink-25: "#f9fafb"
  ink-50: "#f3f4f6"
  ink-100: "#e5e6e9"
  ink-200: "#d2d4d7"
  ink-300: "#b5b7bb"
  ink-400: "#87898d"
  ink-500: "#6f7276"
  ink-600: "#64686d"
  ink-700: "#4a4d52"
  ink-800: "#2e3034"
  ink-900: "#1a1c1f"
  ink-950: "#0d0e11"
  accent: "#d9f944"
  accent-hover: "#cfed41"
  accent-foreground: "#0d0e11"
  accent-50: "#f7fee4"
  accent-100: "#edfcbf"
  accent-200: "#e4fc8c"
  accent-400: "#cfed41"
  accent-500: "#b1cd23"
  accent-600: "#8ea515"
  accent-700: "#6c7e06"
  accent-800: "#4d5a07"
  accent-900: "#313a03"
  surface-inverse: "#0d0e11"
  surface-inverse-raised: "#181a1d"
  surface-inverse-overlay: "#222428"
  border-inverse: "#2e3034"
  inverse-foreground: "#ffffff"
  inverse-muted: "#aeb1b6"
  error-inverse: "#f87171"
  info-inverse: "#93c5fd"
  dark-base: "#0d0e11"
  dark-1: "#181a1d"
  dark-2: "#222428"
  dark-3: "#181a1d"
  dark-border: "#2e3034"
  dark-border-subtle: "#42454a"
  dark-muted: "#aeb1b6"
  background: "#ffffff"
  foreground: "#0d0e11"
  surface: "#ffffff"
  surface-muted: "#f9fafb"
  surface-sunken: "#f3f4f6"
  muted: "#64686d"
  border: "#e5e6e9"
  border-subtle: "#f3f4f6"
  control-border: "#87898d"
  focus-ring: "#0d0e11"
  focus-ring-dark: "#d9f944"
  disabled-foreground: "#4a4d52"
  disabled-surface: "#e5e6e9"
  success: "#22c55e"
  success-bg: "#f5fdf8"
  success-border: "#bbf7d0"
  success-text: "#15803d"
  warning: "#f59e0b"
  warning-bg: "#fbf5da"
  warning-border: "#fde68a"
  warning-text: "#92400e"
  error: "#dc2626"
  error-bg: "#fcf5f5"
  error-border: "#fecaca"
  error-text: "#b91c1c"
  info: "#3b82f6"
  info-bg: "#f3f7fd"
  info-border: "#bfdbfe"
  info-text: "#1d4ed8"
  status-paid: "#d9f944"
  status-paid-text: "#0d0e11"
  status-open: "#ffffff"
  status-open-text: "#0d0e11"
  status-open-border: "#6f7276"
  status-overdue: "#fcf5f5"
  status-overdue-text: "#b91c1c"
  status-draft: "#f3f4f6"
  status-draft-text: "#4a4d52"
  status-draft-border: "#6f7276"
  status-cancelled-border: "#6f7276"
layers:
  z-dropdown: 30
  z-overlay: 40
  z-toast: 50
typography:
  title:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.333
    letterSpacing: "-0.02em"
  section:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.467
  body:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.429
  label:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.385
  caption:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.333
  figure:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.125
    letterSpacing: "-0.02em"
rounded:
  xs: "0.25rem"
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "0.75rem"
  2xl: "1rem"
  3xl: "1.25rem"
  control: "0.5rem"
  card: "0.75rem"
  panel: "1rem"
  modal: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
  input:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.control}"
---

# billme Design System

## Direction dials

Declared per the antislop liveliness toolkit. They are binding: a claim of
MOTION 1 means decorative entrance motion is a defect, not a preference.

| Dial | Value | Meaning here |
| --- | --- | --- |
| ENERGY | 1 | Calm. The interface states what it is and gets out of the way. No greeting, no marketing voice inside the product. |
| RHYTHM | 1 in the apps, 2 on the landing page | Apps: uniform, predictable section and table rhythm, because the work is scanning dense records. Landing page: 2, so one section may break the pattern to carry the product story. |
| MOTION | 1 | Interaction feedback only: hover, focus, loading indicators, and the standard overlay open/close. No decorative entrance animation, no parallax, no infinite loops. |

Consequences that are checked in review:

- No `animate-enter` / `animate-scale-in` / staggered `animation-delay` on content. Content is visible on first paint, not animated into view.
- No infinite animation except `animate-spin` / `animate-pulse` on a genuine loading indicator, and those carry a `motion-safe:` guard.
- Overlay enter and exit is interaction feedback and is allowed; its values are in Motion below.
- Reduced motion is handled once, globally: `packages/ui/styles.css` neutralises animation and transition durations under `prefers-reduced-motion: reduce`. New animation still needs its own guard so it does not depend on that override.
- `pnpm check:design-tokens` enforces this section and the rest of the token rules in CI, including `font-black` (P-01), transitions on layout properties (P-02), raw `<table>` outside `@billme/ui` (P-03; the customer document canvas and the server-rendered offer portal are exempt) and icon sizes off the scale (P-04).
- The near-black editor ramp stays: it is the document viewport, where the rendered page is the subject and chrome must recede. That is the reason for dark surfaces in an otherwise light product, not a dark-mode default.

## Overview

billme is a German invoicing and accounting suite. Its visual identity pairs a
confident, energetic **lime accent (`#d9f944`)** with a calm, content-first
**light UI**, and switches to near-black surfaces for the document and invoice
editor so the rendered page reads as the hero. The feel is precise, calm and
slightly editorial: tight radii, layered hairline shadows, weight-driven
hierarchy, and one lime signal per view.

Tokens are defined once and consumed everywhere:

- Tailwind v4 `@theme`: `packages/ui/styles.css`
- Type-safe mirror: `packages/ui/src/utils/colors.ts`
- Primitive components: `packages/ui/src/components/` (the exported set is listed in Components below)

Use token-backed utilities (`bg-accent`, `text-foreground`,
`border-dark-border-subtle`, `rounded-2xl`, …), not raw hex or default palette
utilities.

## Colors

### Ramps

The palette is roles over two ramps plus the semantic hues. Every ramp step is
an OKLCH value rounded to hex, and neighbouring steps are at least 25% apart, so
a step change is always visible.

| Ramp | Steps | Character |
| --- | --- | --- |
| `ink-*` | 0, 25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950 | Faint cool neutral (hue 260, chroma ≤0.009). 0 is paper, 950 is the darkest ink. |
| `accent-*` | 50, 100, 200, 300 (= `accent`), 400 (= `accent-hover`), 500–900 | The brand lime (hue 119). |

Change a ramp step, not a role. The role tokens below point into the ramps.

### Brand

| Token | Hex | Usage |
| --- | --- | --- |
| `accent` | `#d9f944` | Primary action fill, paid state, one focal data point per view |
| `accent-hover` | `#cfed41` | Hover state for accent surfaces |
| `accent-foreground` | `#0d0e11` | Text/icons on accent |
| `accent-50` / `accent-100` | `#f7fee4` / `#edfcbf` | Selected-row and active-item tints |
| `accent-700` / `accent-800` | `#6c7e06` / `#4d5a07` | The only lime values that may carry text on light surfaces (4.54:1 / 7.55:1 on white) |

`accent` is a fill color only. It measures 1.19:1 against white, so never use
`#d9f944` as a focus indicator, text color, or icon color on a light background.
Use `focus-ring` for light surfaces, and `accent-800` when lime-coded state has
to be written as text.

Lime is a signal, not a surface. It marks the primary action, the active or
paid state, and at most one focal data point per view (for example the current
period in a chart). A full card filled with lime is not allowed; scarcity is
what makes it read as premium.

### Inverse surfaces and the contrast budget

The product is light, and contrast is deliberate. The inverse roles are:
`surface-inverse`, `surface-inverse-raised`, `surface-inverse-overlay`,
`border-inverse`, `inverse-foreground`, and `inverse-muted` (8.11:1 on raised).
The older `dark-*` names map onto the same values for existing call sites;
new code uses the inverse role names. `error-inverse` and `info-inverse` are
the semantic hues for icons and text on inverse surfaces. On inverse surfaces, depth comes from
lighter raised steps, not from shadows, and lime is the signature foreground.

Inverse surfaces are allowed only for:

- the document editor chrome (rails, inspector, viewport), where the white A4
  page is the hero;
- tooltips, toasts, and the command palette;
- **at most one focal element per view**, such as the dashboard's open
  receivables card or the statistics revenue figure.

A second inverse card on the same view spends the budget twice and flattens the
hierarchy it was meant to create.

### Light UI

`background` and `surface` are white. Use `surface-muted` for inset tiles,
`surface-sunken` (ink-50) for the app shell ground that surfaces sit on, `muted`
for secondary copy, and `border`/`border-subtle` for separation.

`muted` is `#64686d` (ink-600): secondary copy clears 4.5:1 on every light
ground the product uses (white 5.61:1, surface-muted 5.37:1, sunken 5.10:1).

`border` is a decorative separator only: at 1.25:1 against white it cannot
outline a control. Interactive controls use `control-border` (`#87898d`, 3.50:1
on white, 3.18:1 on sunken) so their boundary meets the 3:1 non-text
requirement. When a control's only affordance is its outline, that outline must
use `control-border`.

`focus-ring` is `#0d0e11` for light surfaces and `focus-ring-dark` is `#d9f944`
for inverse surfaces. Disabled controls use `disabled-foreground` and
`disabled-surface`; in this product, disabled often signals a locked accounting
period or an immutable posted record, so it must be unmistakable rather than
merely faded.

### Empty values

A missing value renders as `–` (en dash), never `—` (em dash, which the copy
rules forbid). Use `formatEmptyValue()` or the `Amount` primitive rather than
inlining the glyph, so the convention stays in one place.

### Semantic colors

Each role has a base, a tinted `-bg`, a `-border`, and an AA-safe `-text`
foreground: `success-text`, `warning-text`, `error-text`, and `info-text` for
the `success`, `warning`, `error`, and `info` roles. The base tokens are for
fills and borders; text on a `-bg` surface must use the matching `-text` token.
The `-bg` tints carry 60% of the hue's chroma, so a row of semantic tiles reads
as information rather than decoration.

### Invoice status

`status-paid`, `status-open`, `status-overdue`, and `status-draft` provide their
matching text/border tokens. Every status pill needs a visible boundary at
≥3:1 because the pill shape is what makes status scannable in an invoice list;
`status-open-border` (ink-500, `#6f7276`), `status-draft-border`, and
`status-cancelled-border` provide the neutral boundaries. `status-overdue-text`
is `#b91c1c` and `status-draft-text` is ink-700 (`#4a4d52`); both clear 4.5:1 at
12px, which is not large text under WCAG. Render through
`getStatusColors()` or `Badge` instead of re-deriving status palettes inline.

## Typography

The single family is **Inter Variable**, self-hosted through
`@fontsource-variable/inter` and imported by `packages/ui/styles.css`, so the
offline desktop apps and print output never fall back to a system font. `body`
sets `font-feature-settings: "cv11", "ss03", "calt"`.

Hierarchy comes from weight contrast, not from size or uppercase. Use the type
roles (Tailwind utilities generated from `--text-*`):

| Utility | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `text-title` | 24/32, −0.02em | 600 | The one page title per view |
| `text-section` | 15/22 | 600 | Section and card headings |
| `text-sm` | 14/20 | 400 | Body copy and table cells |
| `text-label` | 13/18 | 500 | Field labels, nav items, secondary emphasis |
| `text-caption` | 12/16 | 400 | Metadata, in `text-muted` |
| `text-figure` | 32/36, −0.02em | 600 | KPI and hero amounts, always `tabular-nums` |

Weights are 400, 500 and 600. `font-bold` is reserved for figures;
`font-black` is not used. Uppercase with tracking is reserved for table column
headers (12px, 500, 0.04em). Field labels are sentence case. Headings get
`text-wrap: balance` and paragraphs `text-wrap: pretty` from the base layer.

All monetary amounts, quantities, totals, and KPI figures use `tabular-nums` so
digits align as values update. Apply it to amount cells, totals, and metric
values.

## Accessibility

WCAG 2.2 AA is binding for this product. Body text must be ≥4.5:1; large text
and non-text/UI boundaries must be ≥3:1; focus indicators must be visible at
≥3:1; interactive targets must be at least 24×24; and status must never be
encoded by color alone.

## Layout and depth

Content sits on white surfaces over the sunken shell ground. Elevation is a
layered, transparent, ink-tinted shadow scale. Every step carries a 1px hairline
ring, so a raised surface needs no separate border:

| Utility | Use |
| --- | --- |
| `shadow-xs` | Resting card, the inset shell panel |
| `shadow-sm` | Hover-lifted row or card, segmented-control thumb |
| `shadow-md` / `shadow-xl` | Popover, menu, combobox, date picker |
| `shadow-lg` / `shadow-2xl` | Modal, toast |

Inverse surfaces take no shadow; they step up to `surface-inverse-raised`
instead. Overlays use `bg-dark-base/20` with `backdrop-blur-sm`.

The editor uses a three-pane shell (left tools, center viewport, right
properties) on inverse surfaces with `no-print` chrome.

Two page layouts exist, and each route uses exactly one:

- **Panel pages** (lists, forms, detail views, the designer excluded): one raised
  `rounded-panel` surface fills the content area and holds the `PageHeader`.
- **Overview pages** (Übersicht, Statistiken): the `PageHeader` sits on the sunken
  ground and the content is a grid of raised cards, one of which may be the
  inverse focal card.

Overlay content—dropdowns, popovers, dialogs, and toasts—must render through
`Portal` and use the layer variables `--z-dropdown: 30`, `--z-overlay: 40`, and
`--z-toast: 50`. Tailwind v4 has no z-index theme namespace, so consume these
as `z-[var(--z-dropdown)]`, `z-[var(--z-overlay)]`, and `z-[var(--z-toast)]`;
`z-dropdown` does not exist. This is required because an identity `transform` on
the app shell hijacks `position: fixed`, and this repo has already been bitten
by it.

## Shapes

A precision scale. The step utilities stay for existing call sites; primitives
and new code use the semantic aliases.

| Alias | Value | Use |
| --- | --- | --- |
| `rounded-control` | 8px | Buttons, inputs, selects, segmented items, menu items |
| `rounded-card` | 12px | Cards, table containers, list rows |
| `rounded-panel` | 16px | The shell content panel, side panels, popovers |
| `rounded-modal` | 20px | Dialogs |

| Step | Value |
| --- | --- |
| `rounded-xs` | 4px (checkboxes, key caps) |
| `rounded-sm` | 6px |
| `rounded-md` | 8px |
| `rounded-lg` / `rounded-xl` | 12px |
| `rounded-2xl` | 16px |
| `rounded-3xl` | 20px |

Nested corners are concentric: outer radius = inner radius + the padding
between them. `rounded-full` is reserved for status pills, count badges, and
avatars. Controls are never pills.

## Motion

MOTION 1 (see Direction dials) sets the scope; these are the values.

| Token | Value | Use |
| --- | --- | --- |
| default transition | 150ms, `cubic-bezier(0.2, 0, 0, 1)` | Every `transition-*` utility without its own duration or ease: hover, colour and border state |
| `--dur-micro` | 120ms | Press, check, thumb, chevron |
| `--dur-overlay` / `--dur-overlay-exit` | 180ms / 120ms | Popover, modal, and toast enter / exit |
| `--dur-panel` | 240ms | Disclosure height |
| `ease-out-strong` | `cubic-bezier(0.23, 1, 0.32, 1)` | Overlays |

Overlays enter through `.ui-enter-fade`, `.ui-enter-panel`, `.ui-enter-popover`
and `.ui-enter-toast` in `packages/ui/styles.css`. `@starting-style` supplies
the from-state, and a closing state's utilities reuse the same transition for
the exit. Popovers scale from `--origin`, the side that faces their trigger.
Press feedback is `scale(0.96)` on `Button` and `.ui-press`. Frequent
interactions (the command palette, keyboard navigation) do not animate.

Two more motions are defined once in `packages/ui/styles.css`:

- **Disclosure:** native `<details>` content grows to its measured height over
  `--dur-panel` (`::details-content` plus `interpolate-size`, scoped to
  `details`). Use `<details>` for show/hide sections instead of animating a
  height yourself.
- **Row delete:** a row deleted through `useDeferredDelete` stays rendered with
  `data-leaving` and fades out over `--dur-overlay`, then leaves the list;
  the undo toast is unchanged. Under reduced motion the row leaves at once.

## Components

Primitives live in `@billme/ui` (`packages/ui/src/components/`). Prefer them
over re-implementing chrome:

- **Amount** — Formats euro amounts with automatic, always-visible, or accounting signs and accessible labels.
- **AuthScreen** — Provides the shared Lite/Pro browser sign-in and first-account setup screen, with server status and a hidden server-address dialog.
- **Badge** — Renders invoice and document status pills with semantic fill, text, and border tokens.
- **BalanceIndicator** — Shows whether Soll and Haben balance, including the two sides and their difference.
- **BillmeLogo** — Renders the Billme wordmark; the mark stays accent and the lettering follows `currentColor`.
- **Button** — Provides primary, secondary, danger, ghost, and dark actions with sizes, loading, and disabled states.
- **Card** — Provides a token-backed content surface with configurable radius, border, and shadow.
- **Combobox** — Provides searchable/autocomplete selection with keyboard navigation, optional free text, and a portal list.
- **ConfirmDialog** — Provides a modal confirmation flow with optional destructive styling, details, and a required reason.
- **DatePicker** — Provides a German-localized date input and keyboard-navigable calendar with date bounds.
- **Field** — Wraps one control with its label, required marker, hint, and error semantics.
- **FeedbackProvider** — Provides scoped action feedback with timed, pausable toast notifications.
- **HelpHint** — Provides a help button that opens an anchored, portal-rendered tooltip.
- **Input** — Provides text, numeric, currency, and percent inputs with parsing, labels, hints, errors, and prefixes/suffixes.
- **Modal** — Provides a portal-rendered dialog with focus management, inert background content, Escape, and backdrop dismissal.
- **Portal** — Renders overlay content into `document.body` so it escapes transformed app shells.
- **Select** — Provides a labeled native select with shared styling, required state, hints, and errors.
- **Textarea** — Provides a labeled multiline input with shared styling, required state, hints, and errors.
- **Toast** — Provides transient success, error, info, or progress feedback with optional actions and dismissal.
- **ValidationSummary** — Provides an assertive, linked list of form errors that jumps to each invalid control.
- **PageHeader** — The one page title per view, with description, back link, right-aligned actions (primary last) and a toolbar row.
- **SegmentedControl** — One choice from a small fixed set (filters, view modes, time ranges); a radio group with a sliding raised thumb.
- **Table** — `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`: sticky header, sortable columns (`aria-sort`), `numeric` cells with tabular figures, interactive and selected rows. The only place uppercase column labels are allowed.
- **Menu** — Anchored action menu with arrow keys, typeahead and focus return; the home for row actions.
- **Tooltip** — Short supplementary label on hover and keyboard focus, on the inverse surface; never the only accessible name. Attaches to its child without a wrapper, flips below near the title bar, and stays hidden while the child's menu or panel is expanded.
- **Icons** — lucide at four sizes: 12 beside captions, 14 in dense controls, 16 by default (buttons, headings, IconButton), 20 in tiles. 24, 32 and 48 are for illustrations only (empty and error states).
- **IconButton** — Square icon-only button (32/36px) with a 40px hit area; `aria-label` is required and doubles as its tooltip. Pass `tooltip` for a shorter label ("Aktionen" instead of "Aktionen für RE-2023-001"), or `tooltip={false}` where it would be noise. Do not add a native `title`.
- **Checkbox** / **Switch** — Native checkbox with house styling and a mixed state; an on/off switch for settings that apply immediately.
- **Metric** — Label, tabular figure and hint; a tone dot plus the label carries status, never colour alone. The `sparkline` slot sits beside the figure.
- **Sparkline** — Word-sized trend line (no axes) for a `Metric` or a figure; the last point is the current period, and its label names the latest direction for screen readers. Only where a real per-period series exists.
- **Avatar**, **Kbd**, **Spinner** — Initials, key caps and the only loading spinner.
- **BarChart** — Single-series SVG bars with a hover value and a screen-reader table; the current period is the one lime bar.

Overlay motion is shared: `useExitTransition` keeps a closing overlay mounted for its exit, and `useAnchoredPosition` places a portalled overlay and sets its `--origin`.

Primary actions: one lime `Button` per view (the default variant). Everything else on the same view is `secondary`, `ghost` or an `IconButton`.

## Do's and Don'ts

**Do**

- Use token-backed utilities such as `bg-dark-2`, `border-border`,
  `text-muted`, and `rounded-2xl`.
- Add a new token in **both** `packages/ui/styles.css` and
  `packages/ui/src/utils/colors.ts` when a genuinely new, intentional value is
  needed.
- Reuse `@billme/ui` primitives and the `getStatusColors()`/
  `getDunningColors()` helpers instead of inlining palettes.

**Don't**

- Don't hardcode arbitrary hex in Tailwind utilities or use default gray/slate
  palette utilities in app-shell chrome.
- Don't use arbitrary radii. Use the radius scale.
- Don't introduce one-off colors that already have a semantic token.
- Never use the accent as a focus ring or as text or an icon color on light
  surfaces; it is a fill color only.
- Never nest cards.
- Declare elevation once: use a border or a shadow, never a 1px border under a
  wide soft shadow.
- Guard every animation with `prefers-reduced-motion`, and animate transform or
  opacity rather than layout properties.

## Exemptions

Print/PDF document components and user-customizable or data-driven colors keep
self-contained styling for fidelity and user choice. These include print
templates and canvas element fills.
