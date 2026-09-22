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
  accent: "#d9f944"
  accent-hover: "#cbe83e"
  accent-foreground: "#000000"
  dark-base: "#000000"
  dark-1: "#111111"
  dark-2: "#1a1a1a"
  dark-3: "#1c1c1c"
  dark-border: "#222222"
  dark-border-subtle: "#333333"
  dark-muted: "#9ca3af"
  background: "#ffffff"
  foreground: "#0b0b0b"
  surface: "#ffffff"
  surface-muted: "#f9fafb"
  surface-sunken: "#f3f4f6"
  muted: "#676d75"
  border: "#e5e7eb"
  border-subtle: "#f3f4f6"
  control-border: "#8b8b8b"
  focus-ring: "#0b0b0b"
  focus-ring-dark: "#d9f944"
  disabled-foreground: "#4b5563"
  disabled-surface: "#e5e7eb"
  success: "#22c55e"
  success-bg: "#f0fdf4"
  success-border: "#bbf7d0"
  success-text: "#15803d"
  warning: "#f59e0b"
  warning-bg: "#fef3c7"
  warning-border: "#fde68a"
  warning-text: "#92400e"
  error: "#dc2626"
  error-bg: "#fef2f2"
  error-border: "#fecaca"
  error-text: "#b91c1c"
  info: "#3b82f6"
  info-bg: "#eff6ff"
  info-border: "#bfdbfe"
  info-text: "#1d4ed8"
  status-paid: "#d9f944"
  status-paid-text: "#000000"
  status-open: "#ffffff"
  status-open-text: "#000000"
  status-open-border: "#6b7280"
  status-overdue: "#fef2f2"
  status-overdue-text: "#b91c1c"
  status-draft: "#f3f4f6"
  status-draft-text: "#4b5563"
  status-draft-border: "#6b7280"
  status-cancelled-border: "#6b7280"
layers:
  z-dropdown: 30
  z-overlay: 40
  z-toast: 50
typography:
  body:
    fontFamily: "Inter, system-ui, Avenir, Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  body-bold:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "0.875rem"
    fontWeight: 700
  label-sm:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "0.75rem"
    fontWeight: 700
    letterSpacing: "0.05em"
rounded:
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
  2xl: "2.5rem"
  3xl: "3rem"
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
    backgroundColor: "{colors.surface-muted}"
    rounded: "{rounded.xl}"
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
- Reduced motion is handled once, globally: `packages/ui/styles.css` neutralises animation and transition durations under `prefers-reduced-motion: reduce`. New animation still needs its own guard so it does not depend on that override.
- `pnpm check:design-tokens` enforces this section and the rest of the token rules in CI.
- The near-black editor ramp stays: it is the document viewport, where the rendered page is the subject and chrome must recede. That is the reason for dark surfaces in an otherwise light product, not a dark-mode default.

## Overview

billme is a German invoicing and accounting suite. Its visual identity pairs a
confident, energetic **lime accent (`#d9f944`)** with a calm, content-first
**light UI**, and switches to near-black surfaces for the document and invoice
editor so the rendered page reads as the hero. The feel is precise, modern, and
slightly editorial: rounded cards, generous padding, soft shadows, and bold
microcopy.

Tokens are defined once and consumed everywhere:

- Tailwind v4 `@theme`: `packages/ui/styles.css`
- Type-safe mirror: `packages/ui/src/utils/colors.ts`
- Primitive components: `packages/ui/src/components/` (the exported set is listed in Components below)

Use token-backed utilities (`bg-accent`, `text-foreground`,
`border-dark-border-subtle`, `rounded-2xl`, …), not raw hex or default palette
utilities.

## Colors

### Brand

| Token | Hex | Usage |
| --- | --- | --- |
| `accent` | `#d9f944` | Primary brand action / highlight |
| `accent-hover` | `#cbe83e` | Hover state for accent surfaces |
| `accent-foreground` | `#000000` | Text/icons on accent |

`accent` is a fill color only. It measures 1.19:1 against white, so never use
`#d9f944` as a focus indicator, text color, or icon color on a light background.
Use `focus-ring` for light surfaces instead.

### Dark UI (editor)

The editor uses a compact near-black ramp. Depth comes from surface color, not
heavy shadows: `dark-base` → `dark-1` → `dark-2` → `dark-3`, with
`dark-border` and `dark-border-subtle` for separation.

### Light UI

`background` and `surface` are white. Use `surface-muted` for inset tiles and
input fills, `surface-sunken` for the app shell ground that cards sit on, `muted`
for secondary copy, and `border`/`border-subtle` for separation.

`muted` is `#676d75`, not `#6b7280`: secondary copy must clear 4.5:1 on every
light ground the product uses (white 5.22:1, surface-muted 5.00:1, sunken
4.75:1). The previous value failed on `surface-sunken` at 4.39:1.

`border` is a decorative separator only: at 1.24:1 against white it cannot
outline a control. Interactive controls use `control-border` (`#8b8b8b`, 3.41:1
on white) so their boundary meets the 3:1 non-text requirement. When a control's
only affordance is its outline, that outline must use `control-border`.

`focus-ring` is `#0b0b0b` for light surfaces and `focus-ring-dark` is `#d9f944`
for near-black surfaces. Disabled controls use `disabled-foreground` and
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

### Invoice status

`status-paid`, `status-open`, `status-overdue`, and `status-draft` provide their
matching text/border tokens. Every status pill needs a visible boundary at
≥3:1 because the pill shape is what makes status scannable in an invoice list;
`status-open-border` (now `#6b7280`), `status-draft-border`, and
`status-cancelled-border` provide the neutral boundaries. `status-overdue-text`
is `#b91c1c`; `status-draft-text` is `#4b5563`; the previous `#dc2626` and `#6b7280` values
failed 4.5:1 at 12px bold, which is not large text under WCAG. Render through
`getStatusColors()` or `Badge` instead of re-deriving status palettes inline.

## Typography

The single family is **Inter** with system fallbacks, set on `body` in
`packages/ui/styles.css`. The working scale is Tailwind's `text-xs` → `text-base`;
emphasis comes from weight and uppercase tracking rather than oversized headings.
Body copy uses `text-foreground`; secondary copy uses `text-muted`.

All monetary amounts, quantities, totals, and KPI figures use `tabular-nums` so
digits align as values update. Apply it to amount cells, totals, and metric
values.

## Accessibility

WCAG 2.2 AA is binding for this product. Body text must be ≥4.5:1; large text
and non-text/UI boundaries must be ≥3:1; focus indicators must be visible at
≥3:1; interactive targets must be at least 24×24; and status must never be
encoded by color alone.

## Layout and depth

Content sits on rounded cards over the light background. Use `rounded-xl` for
dense data cards and reserve `rounded-2xl`/`rounded-3xl` for hero, onboarding,
and modal panels. Inner radii should step down with nesting. Resting cards use
`shadow-sm`; floating panels can use `shadow-xl`/`shadow-2xl`. Overlays use
`bg-dark-base/20` with `backdrop-blur-sm`.

The editor uses a three-pane shell (left tools, center viewport, right
properties) on dark surfaces with `no-print` chrome.

Overlay content—dropdowns, popovers, dialogs, and toasts—must render through
`Portal` and use the layer variables `--z-dropdown: 30`, `--z-overlay: 40`, and
`--z-toast: 50`. Tailwind v4 has no z-index theme namespace, so consume these
as `z-[var(--z-dropdown)]`, `z-[var(--z-overlay)]`, and `z-[var(--z-toast)]`;
`z-dropdown` does not exist. This is required because an identity `transform` on
the app shell hijacks `position: fixed`, and this repo has already been bitten
by it.

## Shapes

The radius scale is the only allowed corner-radius scale:

| Token | Value | Utility |
| --- | --- | --- |
| `sm` | 0.5rem | `rounded-sm` |
| `md` | 1rem | `rounded-md` |
| `lg` | 1.5rem | `rounded-lg` |
| `xl` | 2rem | `rounded-xl` |
| `2xl` | 2.5rem | `rounded-2xl` |
| `3xl` | 3rem | `rounded-3xl` |

Pills and avatars use `rounded-full`.

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
