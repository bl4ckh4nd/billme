---
version: alpha
name: billme
description: >-
  Design system for the billme invoice/accounting suite (Lite + Pro desktop and
  server-mode browser shells). A bright lime accent over a clean light UI, with
  near-black "premium" surfaces for the document/invoice editor. Tokens are the
  source of truth; defined in packages/ui/styles.css (Tailwind v4 @theme) and
  mirrored as TS constants in packages/ui/src/utils/colors.ts.
colors:
  accent: "#d9f944"
  accent-hover: "#cbe83e"
  accent-foreground: "#000000"
  accent-lime: "#ccff00"
  dark-base: "#000000"
  dark-1: "#111111"
  dark-2: "#1a1a1a"
  dark-3: "#1c1c1c"
  dark-4: "#2a2a2a"
  dark-5: "#444444"
  dark-muted: "#666666"
  dark-border: "#222222"
  dark-border-subtle: "#333333"
  editor-viewport: "#555555"
  background: "#ffffff"
  foreground: "#0b0b0b"
  surface: "#ffffff"
  surface-muted: "#f9fafb"
  canvas: "#f3f4f6"
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
  onboarding-canvas: "#f4f4ef"
  onboarding-panel: "#121212"
  onboarding-surface: "#fbfbf8"
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
**light UI**, and switches to **near-black "premium" surfaces** for the document
and invoice editor so the rendered page reads as the hero. The feel is precise,
modern, and slightly editorial — large rounded cards, generous padding, soft
shadows, and bold microcopy.

Tokens are the source of truth and are defined once:

- Tailwind v4 `@theme` block: `packages/ui/styles.css`
- Type-safe mirror for use in TS/JS: `packages/ui/src/utils/colors.ts`
- Primitive components: `packages/ui/src/components/` (`Button`, `Card`, `Input`, `Badge`)

Consume tokens through Tailwind utilities generated from the theme
(`bg-accent`, `text-foreground`, `border-dark-border-subtle`, `rounded-2xl`, …),
not raw hex.

## Colors

### Brand

| Token | Hex | Usage |
| --- | --- | --- |
| `accent` | `#d9f944` | Primary brand action / highlight |
| `accent-hover` | `#cbe83e` | Hover state for accent surfaces |
| `accent-foreground` | `#000000` | Text/icons on accent |
| `accent-lime` | `#ccff00` | Pro accounting-module accent (distinct, brighter lime) |

### Dark UI (editor)

`dark-base` `#000000` · `dark-1` `#111111` · `dark-2` `#1a1a1a` ·
`dark-3` `#1c1c1c` · `dark-4` `#2a2a2a` · `dark-5` `#444444` ·
`dark-muted` `#666666` (secondary text) · `dark-border` `#222222` ·
`dark-border-subtle` `#333333` · `editor-viewport` `#555555` (canvas backdrop).

### Light UI

`background` `#ffffff` · `foreground` `#0b0b0b` · `surface` `#ffffff` ·
`surface-muted` `#f9fafb` · `canvas` `#f3f4f6` (app/editor page background) ·
`muted` `#6b7280` · `border` `#e5e7eb` · `border-subtle` `#f3f4f6`.

### Semantic

Each role has a base, a tinted `-bg`, and a `-border`:
`success` `#22c55e` · `warning` `#f59e0b` · `error` `#dc2626` · `info` `#3b82f6`.

### Invoice status

`status-paid` (lime) · `status-open` (white) · `status-overdue` (red tint) ·
`status-draft` (grey tint), each with matching `-text`/`-border`. Rendered via
`getStatusColors()` / `Badge` — do not re-derive status palettes inline.

### Onboarding

`onboarding-canvas` `#f4f4ef` · `onboarding-panel` `#121212` ·
`onboarding-surface` `#fbfbf8` — scoped to `BusinessOnboarding`.

## Typography

Single family: **Inter** (with system fallbacks), set on `body` in
`packages/ui/styles.css`. There is no separate display face. The working scale
is Tailwind's `text-xs` → `text-base` (0.75–1rem); emphasis is carried by weight
(`font-bold`) and uppercase tracking for labels (`uppercase tracking-wider`)
rather than large headings. Body copy is `text-sm`/`text-foreground`; secondary
copy is `text-muted`.

## Layout

Content sits on rounded "cards" over the `canvas` (`#f3f4f6`) background. The
dominant container shape is a `rounded-2xl` (2.5rem) card with `p-6`/`p-8`
padding and `shadow-sm`. Inner tiles use `rounded-xl` (2rem). The editor uses a
three-pane shell (left tools, center viewport, right properties) on dark
surfaces with `no-print` chrome.

## Elevation & Depth

Soft, low-spread shadows: `shadow-sm` for resting cards, `shadow-xl`/`shadow-2xl`
for hero/floating panels and slide-overs. Overlays dim with `bg-black/20` +
`backdrop-blur-sm`. Depth comes primarily from surface color and radius, not
heavy borders.

## Shapes

Radius scale (the only allowed corner radii):

| Token | Value | Utility |
| --- | --- | --- |
| `sm` | 0.5rem | `rounded-sm` |
| `md` | 1rem | `rounded-md` |
| `lg` | 1.5rem | `rounded-lg` |
| `xl` | 2rem | `rounded-xl` |
| `2xl` | 2.5rem | `rounded-2xl` |
| `3xl` | 3rem | `rounded-3xl` |

Pills/avatars use `rounded-full`.

## Components

Primitives live in `@billme/ui` (`packages/ui/src/components/`). Prefer them over
re-implementing chrome.

- **Button** (`Button.tsx`) — variants `primary` (accent), `secondary`
  (surface + border), `danger` (error), `ghost`, `dark` (near-black); sizes
  `sm`/`md`/`lg` mapping to `rounded-lg`/`rounded-xl`/`rounded-2xl`. Always
  `font-bold` with a 200ms transition.
- **Card** (`Card.tsx`) — `radius` (`md`→`3xl`), `withBorder`, `withShadow`.
- **Input** (`Input.tsx`) — `bg-surface-muted`, `border-border`, `rounded-xl`,
  `focus:ring-accent`; error state flips to `error` tokens.
- **Badge** (`Badge.tsx`) — invoice status pill driven by the `status-*` tokens.

## Do's and Don'ts

**Do**

- Use token-backed Tailwind utilities (`bg-dark-2`, `border-border`,
  `text-muted`, `rounded-2xl`).
- Add a new token (in `styles.css` **and** `colors.ts`) when a genuinely new,
  intentional value is needed — keep the two in sync.
- Reuse `@billme/ui` primitives and the `getStatusColors`/`getDunningColors`
  helpers instead of inlining palettes.

**Don't**

- Don't hardcode arbitrary hex in Tailwind utilities — no `bg-[#1a1a1a]`,
  `border-[#333]`, `text-[#666]`. Use the matching token.
- Don't use arbitrary radii — no `rounded-[2.5rem]`. Use the radius scale.
- Don't introduce one-off colors that already have a token.

**Exemptions (not app-shell chrome — keep self-contained styling)**

- Print/PDF document components (`PrintDocument.tsx`, `PrintEurDocument.tsx`,
  invoice/offer PDF templates): they render outside the app and need inline,
  self-contained styles for print fidelity.
- User-customizable / data-driven colors (e.g. `CanvasElement.tsx` element
  fills, user-chosen invoice colors).

**Known follow-up (out of scope here)**

- The codebase still has widespread use of Tailwind's default `gray`/`slate`
  palette (`text-gray-900`, `bg-gray-50`, `text-slate-800`, …) where brand
  tokens (`foreground`, `surface-muted`, `muted`, `border`) apply. Migrating
  these to tokens is a tracked, separate cleanup — not part of the exact-match
  conformance pass.
