---
version: alpha
name: billme
description: >-
  Design system for the billme invoice/accounting suite (Lite + Pro desktop and
  server-mode browser shells). Bordered white cards on a grey ground, a lime
  accent as the one signal, dense 13px controls, and a near-black viewport for
  the rendered document. The target is the prototype "billme Kontor.html" in
  the repo root. Tokens are the source of truth; defined in
  packages/ui/styles.css (Tailwind v4 @theme) and mirrored as TS constants in
  packages/ui/src/utils/colors.ts.
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
  ground: "#f3f4f6"
  rail: "#ffffff"
  foreground-secondary: "#4a4d52"
  muted: "#64686d"
  border: "#e5e6e9"
  border-subtle: "#f3f4f6"
  border-strong: "#d2d4d7"
  control-border: "#87898d"
  control-border-hover: "#6f7276"
  selected: "#0d0e11"
  selected-foreground: "#ffffff"
  focus-ring: "#0d0e11"
  focus-ring-dark: "#d9f944"
  surface-toast: "#0d0e11"
  border-toast: "#0d0e11"
  donut-2: "#3a3d42"
  donut-3: "#5c6065"
  donut-4: "#77797e"
  donut-5: "#8e9195"
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
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.015em"
  heading:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.412
    letterSpacing: "-0.01em"
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
  control:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.385
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
  micro:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.455
  eyebrow:
    fontFamily: "{typography.title.fontFamily}"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.455
    letterSpacing: "0.04em"
  figure:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.167
    letterSpacing: "-0.025em"
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
  tile: "0.875rem"
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
    rounded: "{rounded.control}"
    height: "34px"
  input:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "34px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
---

# billme Design System

The target is the prototype `billme Kontor.html` in the repo root (its CSS is
lines 6–574). Where this document and the prototype disagree, the prototype
wins and this document is corrected.

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

## Overview

billme is a German invoicing and accounting suite. The interface is a dense
working tool: a white side rail, a white top bar that names the page, and
bordered white cards placed directly on a grey ground. Controls are 34px high
and set in 13px. The **lime accent (`#d9f944`)** is the one signal per view.
The near-black ramp is kept for the viewport of the rendered document, where
the white page is the subject.

Tokens are defined once and consumed everywhere:

- Tailwind v4 `@theme`: `packages/ui/styles.css`
- Type-safe mirror: `packages/ui/src/utils/colors.ts`
- Primitive components: `packages/ui/src/components/` (the exported set is listed in Components below)

Use token-backed utilities (`bg-ground`, `text-foreground-secondary`,
`border-border`, `rounded-card`, …), not raw hex or default palette utilities.

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
| `accent` | `#d9f944` | Primary action fill, progress fill, one focal data point per view |
| `accent-hover` | `#cfed41` | Hover state for accent surfaces |
| `accent-foreground` | `#0d0e11` | Text/icons on accent |
| `accent-50` / `accent-200` | `#f7fee4` / `#e4fc8c` | Selected row, current menu item, accent pill fill and its border |
| `accent-700` / `accent-800` | `#6c7e06` / `#4d5a07` | The only lime values that may carry text on light surfaces (4.54:1 / 7.55:1 on white) |

`accent` is a fill color only. It measures 1.19:1 against white, so never use
`#d9f944` as a focus indicator, text color, or icon color on a light background.
Use `focus-ring` for light surfaces, and `accent-800` when lime-coded state has
to be written as text.

Lime is a signal, not a surface. It marks the primary action, progress, and at
most one focal data point per view (for example the first donut segment). A
full card filled with lime is not allowed.

### Surfaces and text

| Role | Light / dark | Use |
| --- | --- | --- |
| `ground` | `#f3f4f6` / `#0d0e11` | The shell background every card sits on. Also the text on a filled neutral pill (`bg-foreground text-ground`). |
| `rail` | `#ffffff` / `#101214` | The side rail |
| `surface` | `#ffffff` / `#181a1d` | Cards, top bar, inputs, modals, popovers |
| `surface-muted` | `#f9fafb` / `#14161a` | Table head, row hover, the inset panel inside an overview card |
| `surface-sunken` | `#f3f4f6` / `#101214` | Inset fills: segmented track, search field, neutral pill, icon tile, hover of buttons and menu items |
| `foreground` | `#0d0e11` / `#ffffff` | Primary text |
| `foreground-secondary` | `#4a4d52` / `#d2d4d7` | Nav items, field labels, neutral pills, chart legends |
| `muted` | `#64686d` / `#aeb1b6` | Secondary copy, table heads, eyebrows, placeholder icons |
| `border` | `#e5e6e9` / `#2e3034` | Card edges, table lines, separators, neutral pill edge |
| `border-strong` | `#d2d4d7` / `#42454a` | Secondary button, key cap, T-Konto rule, hovered card-like control |
| `control-border` | `#87898d` / `#6f7276` | Inputs, selects, textareas, the S/H toggle, checkboxes |
| `control-border-hover` | `#6f7276` / `#87898d` | Hovered input boundary |
| `surface-toast` / `border-toast` | `#0d0e11` / `#1c1e22`, edge `#0d0e11` / `#42454a` | Toast and chart tooltip, with `text-inverse-foreground` |
| `donut-2` … `donut-5` | `#3a3d42 #5c6065 #77797e #8e9195` / `#dfe1e4 #bdc0c4 #9da0a5 #82858a` | Donut segments after the first, which is `accent`. One hue, lightness by size. |

`background` stays as the page default behind the shell; the shell root itself
is `bg-ground`. `surface-sunken` is no longer the shell ground: its dark value
(`#101214`) is lighter than the ground (`#0d0e11`).

`selected` / `selected-foreground` is the one filled mark per control (checked
box, on switch, active nav item, current step, pressed S/H side): ink in light,
lime in dark.

`focus-ring` is `#0d0e11` for light surfaces and `focus-ring-dark` is `#d9f944`
for inverse surfaces. Disabled controls use `disabled-foreground` and
`disabled-surface`; in this product, disabled often signals a locked accounting
period or an immutable posted record, so it must be unmistakable rather than
merely faded.

### Inverse surfaces

The inverse roles are `surface-inverse`, `surface-inverse-raised`,
`surface-inverse-overlay`, `border-inverse`, `inverse-foreground` and
`inverse-muted` (8.11:1 on raised). The older `dark-*` names map onto the same
values for existing call sites; new code uses the inverse role names.
`error-inverse` and `info-inverse` are the semantic hues for icons and text on
inverse surfaces. On inverse surfaces, depth comes from lighter raised steps,
and lime is the signature foreground.

Inverse surfaces are for:

- the viewport of the rendered document: the document editor chrome and the
  receipt preview, where the white page is the subject;
- the `dark` button variant (ink fill, white label).

Toasts and chart tooltips use `surface-toast`, which is ink in light and a
bordered raised step in dark. The command palette is a regular modal on
`surface`. The prototype has no inverse focal card; a page that still has one
turns it into a bordered card when it is ported.

### Dark mode

The product supports a dark theme. The user picks System, Hell or Dunkel in the
rail footer or the command palette; the choice is a per-device preference
(`useThemePreference` in `@billme/ui`) written to `<html data-theme>`. System
follows `prefers-color-scheme`.

Only role tokens change (`background`, `ground`, `rail`, `surface*`,
`foreground*`, `muted`, `border*`, `control-border`, `donut-*`, the semantic
`-bg/-border/-text` triples, the accent tints, `status-*`, shadows). The ink
and accent ramps stay literal, so anything that must flip uses a role, never a
ramp step. Values are mirrored in `darkRoles` in
`packages/ui/src/utils/colors.ts`.

The rendered document stays light: a subtree marked `data-theme="light"`
(document pages, the designer page) keeps light roles inside a dark shell, and
print output is always light.

### Empty values

A missing value renders as `–` (en dash), never `—` (em dash, which the copy
rules forbid). Use `formatEmptyValue()` or the `Amount` primitive rather than
inlining the glyph, so the convention stays in one place.

### Semantic colors

Each role has a base, a tinted `-bg`, a soft `-border`, and an AA-safe `-text`
foreground: `success-text`, `warning-text`, `error-text`, and `info-text` for
the `success`, `warning`, `error`, and `info` roles. The base tokens are for
fills and dots; text on a `-bg` surface must use the matching `-text` token.
Banners, validation rows and pills all use the same triple:
`bg-*-bg border-*-border text-*-text`.

### Status pills

A pill is 11px/500 (`text-micro font-medium`), `px-1.75 py-0.5`,
`rounded-full`, with a 1px border in the soft token of its tone:

| Tone | Fill | Border | Text |
| --- | --- | --- | --- |
| neutral | `surface-sunken` | `border` | `foreground-secondary` |
| success / warning / error / info | `*-bg` | `*-border` | `*-text` |
| accent | `accent-50` | `accent-200` | `accent-800` |
| filled (active filter) | `foreground` | `foreground` | `ground`, 600 |

The pill border is decorative. It measures about 1.2:1 against its fill and is
not what identifies the pill: the text does, at ≥4.5:1 on its tint, and the
word itself names the status. The `status-*-border` tokens (3:1) stay defined
for existing call sites and are no longer the rule. The accent pill uses
`accent-800` for its text because `accent-700` measures 4.38:1 on `accent-50`.
Render through `Badge` or `getStatusColors()` instead of re-deriving pill
palettes inline.

## Typography

The single family is **Inter Variable**, self-hosted through
`@fontsource-variable/inter` and imported by `packages/ui/styles.css`, so the
offline desktop apps and print output never fall back to a system font. `body`
sets `font-feature-settings: "cv11", "ss03", "calt"`.

`body` is 14px / 1.429 (set in `packages/ui/styles.css`; the root stays 16px,
so rem-based utilities keep their size). Text without a size utility renders at
14px. Controls and dense rows are 13px and say so with a type role: a primitive
sets `text-control` (weight from the component) or `text-label` (500). Nothing
relies on inheriting 13px.

Type roles (Tailwind utilities generated from `--text-*`):

| Utility | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `text-title` | 16/24, −0.015em | 600 | The page title in the shell top bar; modal titles |
| `text-heading` | 17/24, −0.01em | 600 | Title of an overview card (the 16px-radius cards of Übersicht) |
| `text-section` | 15/22 | 600 | Title of a regular card, empty-state heading |
| `text-sm` | 14/20 | 400 | Body copy; add `font-semibold` for list-row and pane titles |
| `text-control` | 13/18 | inherits | Inputs, selects, table cells, menu items, banners |
| `text-label` | 13/18 | 500 | Buttons (primary adds `font-semibold`), nav items, KPI labels |
| `text-caption` | 12/16 | 400 | Top-bar subtitle, metadata in `text-muted`, small buttons, segmented items; field labels at `font-medium text-foreground-secondary` |
| `text-micro` | 11/16 | 400 | Pills and key caps (`font-medium`), counts, field hints, timeline meta |
| `text-eyebrow` | 11/16, 0.04em | 600 | Rail group titles, table heads, section marks inside a form; written with `uppercase text-muted` |
| `text-figure` | 24/28, −0.025em | 700 | KPI values, always `tabular-nums` |

The page title lives in the shell top bar: one `h1` at `text-title` with an
optional 12px subtitle in `text-muted` beside it. There is no 24px title in the
content area; the content starts with its cards.

Weights are 400, 500 and 600; 700 is for figures (KPI values, list-row amounts,
totals). `font-black` is not used. Uppercase belongs to `text-eyebrow` only:
rail group titles, table heads and section marks. Field labels and card titles
are sentence case. Headings get `text-wrap: balance` and paragraphs
`text-wrap: pretty` from the base layer.

All monetary amounts, quantities, totals, and KPI figures use `tabular-nums` so
digits align as values update. Apply it to amount cells, totals, and metric
values.

Figures are set in **JetBrains Mono Variable** (`--font-mono`, self-hosted via
`@fontsource-variable/jetbrains-mono`): every `tabular-nums` element in the app
chrome switches to the mono face, because amounts, account numbers, document
numbers and IBANs are read digit by digit and a transposed digit is easier to
spot in a monospace face. Key caps use `font-mono` too. The rendered document
keeps its own typography.

## Accessibility

WCAG 2.2 AA is binding for this product:

- Text is ≥4.5:1 on its ground. `muted` clears it on every surface (white
  5.61:1, surface-muted 5.37:1, ground 5.10:1); `foreground-secondary` is
  8.49:1 on white.
- A control whose outline is its only affordance (input, select, textarea,
  checkbox, the S/H toggle) uses `control-border`: 3.50:1 on white, 3.18:1 on
  the ground. Hover strengthens it with `control-border-hover`, never with a
  raw `ink-*` class.
- Focus is a 2px `focus-ring` outline at ≥3:1, offset 2px (inputs: offset 0).
- Interactive targets are at least 24×24.
- Status is never encoded by color alone: a pill carries its word, a KPI tick
  sits beside its label.

Where the prototype accepts a softer value, the boundary is decorative and
something else carries the meaning:

- **Pill borders** use the soft `*-border` tokens (about 1.2:1). The text
  carries the status.
- **Secondary buttons and key caps** use `border-strong` (1.49:1 on white). A
  button is identified by its label and its fill on the card; hover moves the
  edge to `control-border`.
- **Segmented track, search field, cards** use `border` (1.25:1). The selected
  segment is identified by its raised fill and weight 600, the search field by
  its icon, placeholder and key caps.

## Layout and depth

Surfaces are bordered cards directly on the ground: `bg-surface border
border-border rounded-card`, no shadow. The border is the separator. Shadow is
reserved for things that float, and those carry a border as well:

| Utility | Use |
| --- | --- |
| none | Cards, tiles, panes, table containers, the top bar, the rail |
| `shadow-thumb` | The selected item of a segmented control |
| `shadow-lift` | Popover, menu, combobox list, date picker, modal, toast, chart tooltip, sticky totals, the rail as a drawer |

`shadow-lift` and `shadow-thumb` have no hairline ring, so they sit on a
bordered surface without doubling its edge. The older steps `shadow-xs` …
`shadow-2xl` carry a 1px ring and stay defined for call sites that have not
been ported; do not use them in new code and never beside a border.

**Shell.** The rail is 236px, `bg-rail` with a right border. The top bar is a
`bg-surface` strip with a bottom border, `px-5 py-2.5`, holding the page title,
the subtitle, the search field and the primary action at the far right. The
content scrolls below it with 20px padding, at most 1500px wide.

**Cards.** A card head is `px-3.5 py-3` with a bottom border and a
`text-section` title; the body is `p-3.5` (14px), or flush for a table. Gaps
between cards are 12–14px.

**Overview cards** (Übersicht) are the softer variant: `rounded-panel` (16px),
head `px-4.5 pt-4 pb-3` without a bottom border, `text-heading` title, body
`px-4.5 pb-4.5`. An overview card may hold one inset panel
(`bg-surface-muted border border-border rounded-card p-3.5`) and bordered
legend rows; that is the only nesting allowed.

**KPI tiles** are `rounded-tile` (14px), `px-4 py-3.5`: a `text-label
text-muted` label with a 3×14px tone tick, the value in `text-figure
tabular-nums`, and a 13px `text-muted` addition under it.

**Pages.** Every route is cards on the ground. The former panel page (one
raised `rounded-panel` surface filling the content area with a `PageHeader`
inside) is gone: lists are a card with a flush table, forms are one card per
group, and creating a record opens a modal. The document editor keeps its A4
direct-editing layout on the inverse viewport with `no-print` chrome.

**Modal.** 560px wide, top aligned (`pt-[8vh]`), `rounded-modal`, border plus
`shadow-lift`. The scrim is `bg-ink-950/45` without blur. Head `px-4.5 pt-4
pb-2.5` with a `text-title` heading, body `px-4.5 pb-4` with 12px gaps, foot
`px-4.5 py-3` with a top border and right-aligned actions.

**Popover and menu.** `rounded-card`, border plus `shadow-lift`, `p-1.5`; items
are `rounded-control px-2.25 py-2 text-control`, hover `bg-surface-sunken`,
current `bg-accent-50`.

**Toast.** `bg-surface-toast border border-border-toast
text-inverse-foreground rounded-control shadow-lift`, `px-3 py-2.5
text-control`.

Overlay content (dropdowns, popovers, dialogs, toasts) must render through
`Portal` and use the layer variables `--z-dropdown: 30`, `--z-overlay: 40`, and
`--z-toast: 50`. Tailwind v4 has no z-index theme namespace, so consume these
as `z-[var(--z-dropdown)]`, `z-[var(--z-overlay)]`, and `z-[var(--z-toast)]`;
`z-dropdown` does not exist. This is required because an identity `transform` on
the app shell hijacks `position: fixed`, and this repo has already been bitten
by it.

## Controls

| Control | Values |
| --- | --- |
| Button | 34px high (`h-8.5`), `px-3`, `rounded-control`, `text-label`, gap 7px. Small: 28px, `px-2.25`, `text-caption font-medium`. Flat: no shadow. |
| Button, primary | `bg-accent border-accent text-accent-foreground font-semibold`; hover `accent-hover` |
| Button, secondary | `bg-surface border-border-strong text-foreground`; hover `bg-surface-sunken border-control-border` |
| Button, ghost | transparent border and fill; hover `bg-surface-sunken` |
| Button, danger | tinted: `bg-error-bg border-error-border text-error-text` |
| Button, dark | `bg-ink-950 text-inverse-foreground`; hover `ink-800` |
| IconButton | 32×32, `rounded-control`, `text-muted`; hover `bg-surface-sunken text-foreground`. The card kebab is 30×30. |
| Input, Select, Textarea | 34px min height, `px-2.25 py-1.5`, `rounded-control`, `border-control-border`, `bg-surface`, `text-control`. Read-only: `bg-surface-sunken text-muted`. Numeric: right aligned, `tabular-nums`. Select draws its own chevron. |
| Field | label `text-caption font-medium text-foreground-secondary`, 4px above the control; required mark in `error-text`; hint `text-micro text-muted` |
| Segmented control | track `bg-surface-sunken border border-border rounded-control p-0.5`, 32px overall; items 26px, `rounded-sm px-2.5 text-caption font-medium text-muted`; selected `bg-surface text-foreground font-semibold shadow-thumb` |
| Kbd | one box per key: `font-mono text-micro text-muted bg-surface rounded-xs px-1 border border-border-strong border-b-2` |
| Table | container is a card with a flush body. Head: `text-eyebrow uppercase text-muted bg-surface-muted`, `px-3 py-2` (32px), bottom `border-border`, sticky. Cell: `text-control`, `px-3 py-2.25` (rows around 40px), bottom `border-border`, none on the last row. Hover `bg-surface-muted`, selected `bg-accent-50` without a bar. Numeric cells right aligned. |
| List row | `gap-3.25 py-3.25`, dashed bottom `border-border`; 36px icon tile (`rounded-lg`, `bg-surface-sunken text-foreground-secondary` or a semantic `-bg`/`-text` pair); title `text-sm font-semibold`, subtitle `text-caption text-muted`, value 15px/700 mono |
| Progress | 22px high, fully rounded, hatched track, `bg-accent` fill with a 1.5px `foreground` end line |
| Banner | `rounded-control border px-3 py-2.5 text-control` in a semantic triple |

Primary actions: one lime `Button` per view, in the top bar at the far right or
at the end of a modal foot. Everything else on the same view is `secondary`,
`ghost` or an `IconButton`.

## Shapes

| Alias | Value | Use |
| --- | --- | --- |
| `rounded-xs` | 4px | Checkboxes, key caps |
| `rounded-sm` | 6px | Segmented items, combobox options, the brand mark |
| `rounded-control` | 8px | Buttons, inputs, selects, segmented track, menu items, banners, toasts, donut legend rows, the card kebab |
| `rounded-card` | 12px | Cards, panes, table containers, popovers, the inset panel, icon tiles |
| `rounded-tile` | 14px | KPI tiles |
| `rounded-panel` | 16px | Overview cards |
| `rounded-modal` | 20px | Dialogs |

The step utilities (`rounded-md` 8px, `rounded-lg` / `rounded-xl` 12px,
`rounded-2xl` 16px, `rounded-3xl` 20px) stay for existing call sites.

Three prototype radii are mapped onto the scale instead of getting a token,
because each belongs to one element and sits 1–2px from a step: the kebab (9px)
and the donut legend row (10px) use `rounded-control`, the icon tile (11px)
uses `rounded-card`.

Nested corners are concentric: outer radius = inner radius + the padding
between them. `rounded-full` is reserved for status pills, count badges,
steppers, the progress bar and avatars. Controls are never pills.

## Icons

The own icon set (`packages/ui/src/icons/kontor.tsx`) is preferred: a 16px
grid, stroke 1.5, no fill, `currentColor`. Lucide is allowed where no own icon
exists. `packages/ui/styles.css` renders every lucide icon at the same 1.5px
line (`stroke-width: 1.5` with a non-scaling stroke), so the two sets carry one
weight; no call site sets a stroke width.

Sizes: 12 beside captions, 14 in dense controls, 16 by default (buttons,
headings, nav, IconButton), 20 in tiles. 24, 32 and 48 are for illustrations
only (empty and error states).

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
over raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>` and
hand-built card or pill class strings. Their measures are in Controls and
Layout above.

- **Amount** — Formats euro amounts with automatic, always-visible, or accounting signs and accessible labels.
- **AuthScreen** — Provides the shared Lite/Pro browser sign-in and first-account setup screen, with server status and a hidden server-address dialog.
- **Badge** — Renders status pills with the soft semantic triple (see Status pills).
- **BalanceIndicator** — Shows whether Soll and Haben balance, including the two sides and their difference.
- **BillmeLogo** — Renders the Billme wordmark; the mark stays accent and the lettering follows `currentColor`.
- **Button** — Provides primary, secondary, danger, ghost, and dark actions with sizes, loading, and disabled states.
- **Card** — The bordered content surface: `border-border`, no shadow, 12px radius.
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
- **PageHeader** — Actions and toolbar row of a page. The title is shown by the shell top bar, not in the content.
- **SegmentedControl** — One choice from a small fixed set (filters, view modes, time ranges); a radio group on a bordered track.
- **Table** — `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`: sticky header, sortable columns (`aria-sort`), `numeric` cells with tabular figures, interactive and selected rows.
- **Menu** — Anchored action menu with arrow keys, typeahead and focus return; the home for row actions.
- **Tooltip** — Short supplementary label on hover and keyboard focus; never the only accessible name. Attaches to its child without a wrapper, flips below near the title bar, and stays hidden while the child's menu or panel is expanded.
- **IconButton** — Square icon-only button (32px) with a 40px hit area; `aria-label` is required and doubles as its tooltip. Pass `tooltip` for a shorter label ("Aktionen" instead of "Aktionen für RE-2023-001"), or `tooltip={false}` where it would be noise. Do not add a native `title`.
- **Checkbox** / **Switch** — Native checkbox with house styling and a mixed state; an on/off switch for settings that apply immediately.
- **Metric** — Label, tabular figure and hint; a tone tick plus the label carries status, never colour alone. The `sparkline` slot sits beside the figure.
- **Sparkline** — Word-sized trend line (no axes) for a `Metric` or a figure; the last point is the current period, and its label names the latest direction for screen readers. Only where a real per-period series exists.
- **Avatar**, **Kbd**, **Spinner** — Initials, key caps and the only loading spinner.
- **BarChart** — SVG bars for one measure, optionally a hatched comparison series and a dashed reference line, with a hover value and a screen-reader table; the current period is the one lime bar.
- **TimeSeriesChart** — Figures over time on Recharts (the only place Recharts is styled): `solid` bars for the measure in focus, `hatched` for the context, `downward` series below the zero line (Erträge up, Aufwand down in one stack) and a `foreground-secondary` line for a balance. A series with `axis: 'right'` gets its own scale (e.g. a balance next to monthly flows) and says so in the legend. Lime only on `highlightKey`; no animation; `onSelect` opens a period, and the screen-reader table carries a button per period for it.
- **BarList** — Ranked rows with a share bar behind each (value against the largest), label left, figure right in `tabular-nums`; rows are buttons when the list opens something. `foreground` tone for the measure in focus, `muted` for context. No colour carries meaning.
- **Donut** — 134px ring with the total in the centre (value above its label) and the legend to its right; segments are `accent`, then `donut-2` … `donut-5`.

Overlay motion is shared: `useExitTransition` keeps a closing overlay mounted for its exit, and `useAnchoredPosition` places a portalled overlay and sets its `--origin`.

## Do's and Don'ts

**Do**

- Use token-backed utilities such as `bg-ground`, `border-border`,
  `text-foreground-secondary`, and `rounded-card`.
- Add a new token in **both** `packages/ui/styles.css` and
  `packages/ui/src/utils/colors.ts` when a genuinely new, intentional value is
  needed. A new `text-*`, `rounded-*` or `shadow-*` role is also registered in
  `packages/ui/src/utils/cn.ts`, or `cn()` drops it beside a colour utility.
- Reuse `@billme/ui` primitives and the `getStatusColors()`/
  `getDunningColors()` helpers instead of inlining palettes.
- Write 11px as `text-micro` or `text-eyebrow`, never `text-[0.6875rem]` or
  `text-[11px]`.

**Don't**

- Don't hardcode arbitrary hex in Tailwind utilities or use default gray/slate
  palette utilities in app-shell chrome.
- Don't use arbitrary radii. Use the radius scale.
- Don't introduce one-off colors that already have a semantic token.
- Never use the accent as a focus ring or as text or an icon color on light
  surfaces; it is a fill color only.
- Don't put a shadow on a card, tile or pane. Shadow means the surface floats.
- Don't use the ring shadows (`shadow-xs` … `shadow-2xl`) beside a border.
- Don't nest cards, except the one inset panel and the legend rows of an
  overview card.
- Don't put a page title in the content area; it belongs to the top bar.
- Don't blur the modal scrim.
- Guard every animation with `prefers-reduced-motion`, and animate transform or
  opacity rather than layout properties.

## Exemptions

Print/PDF document components and user-customizable or data-driven colors keep
self-contained styling for fidelity and user choice. These include print
templates and canvas element fills. The rendered document
(`packages/desktop-designer/src/flow/*`, any `data-theme="light"` subtree) is
not restyled by these rules.
