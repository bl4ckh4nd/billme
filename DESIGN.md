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
  muted: "#6b7280"
  border: "#e5e7eb"
  border-subtle: "#f3f4f6"
  success: "#22c55e"
  success-bg: "#f0fdf4"
  success-border: "#bbf7d0"
  warning: "#f59e0b"
  warning-bg: "#fef3c7"
  warning-border: "#fde68a"
  error: "#dc2626"
  error-bg: "#fef2f2"
  error-border: "#fecaca"
  info: "#3b82f6"
  info-bg: "#eff6ff"
  info-border: "#bfdbfe"
  status-paid: "#d9f944"
  status-paid-text: "#000000"
  status-open: "#ffffff"
  status-open-text: "#000000"
  status-open-border: "#e5e7eb"
  status-overdue: "#fef2f2"
  status-overdue-text: "#dc2626"
  status-draft: "#f3f4f6"
  status-draft-text: "#6b7280"
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
- Primitive components: `packages/ui/src/components/` (`Button`, `Card`, `Input`, `Badge`)

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

### Dark UI (editor)

The editor uses a compact near-black ramp. Depth comes from surface color, not
heavy shadows: `dark-base` → `dark-1` → `dark-2` → `dark-3`, with
`dark-border` and `dark-border-subtle` for separation.

### Light UI

`background` and `surface` are white. Use `surface-muted` for inset tiles and
input fills, `muted` for secondary copy, and `border`/`border-subtle` for
separation.

### Semantic colors

Each role has a base, a tinted `-bg`, and a `-border`:
`success`, `warning`, `error`, and `info`.

### Invoice status

`status-paid`, `status-open`, `status-overdue`, and `status-draft` provide their
matching text/border tokens. Render through `getStatusColors()` or `Badge`
instead of re-deriving status palettes inline.

## Typography

The single family is **Inter** with system fallbacks, set on `body` in
`packages/ui/styles.css`. The working scale is Tailwind's `text-xs` → `text-base`;
emphasis comes from weight and uppercase tracking rather than oversized headings.
Body copy uses `text-foreground`; secondary copy uses `text-muted`.

All monetary amounts, quantities, totals, and KPI figures use `tabular-nums` so
digits align as values update. Apply it to amount cells, totals, and metric
values.

## Layout and depth

Content sits on rounded cards over the light background. Use `rounded-xl` for
dense data cards and reserve `rounded-2xl`/`rounded-3xl` for hero, onboarding,
and modal panels. Inner radii should step down with nesting. Resting cards use
`shadow-sm`; floating panels can use `shadow-xl`/`shadow-2xl`. Overlays use
`bg-dark-base/20` with `backdrop-blur-sm`.

The editor uses a three-pane shell (left tools, center viewport, right
properties) on dark surfaces with `no-print` chrome.

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

- **Button** — `primary`, `secondary`, `danger`, `ghost`, and `dark` variants;
  `sm`/`md`/`lg` sizes; disabled state and focus-visible handling.
- **Card** — token-backed radius, border, and shadow options.
- **Input** — muted fill, border, label, focus ring, error state, and numeric
  `tabular-nums` handling.
- **Badge** — invoice status pill driven by `status-*` tokens.

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

## Exemptions

Print/PDF document components and user-customizable or data-driven colors keep
self-contained styling for fidelity and user choice. These include print
templates and canvas element fills.
