# UI Refactor — Completion Handoff

This handoff now reflects the current state after the Lite, Pro, and accounting
UI-refactor passes. The original Groups 1-7 are complete; do not restart them.

## Scope

Two-part effort on the billme invoicing suite:

1. Structural split of large screen monoliths into co-located component folders.
2. UI-polish pass per file: token conformance, dense-radius, states, motion, and
   amount typography.

Foundations are the source of truth: `DESIGN.md`, `packages/ui/styles.css`, and
the TS token mirror in `packages/ui/src/utils/colors.ts`.

## Completed Work

### Foundation

- Dark editor ramp rebuilt; `editor-viewport` is the dark preview surface.
- Light neutrals refined and documented.
- Radius convention documented: dense cards `rounded-xl`, inputs `rounded-lg`,
  larger radii reserved for hero/modal shells.
- Global table numeric rule added: `font-variant-numeric: tabular-nums`.
- `Button`, `Input`, and `Card` primitives polished for loading, focus, press,
  invalid, and radius behavior.

### Shared Designer

- `packages/desktop-designer` is token-conformed.
- TopBar, ElementRail, Inspector, LayersPanel, and TemplateDesigner use the
  shared design vocabulary.
- Inspector grouping uses whitespace instead of divider-heavy chrome.

### Lite Desktop

- Lite split folders are in place: `invoices/`, `settings/`, `dashboard/`,
  `clients/`, `articles/`, `transaction-matching/`, and `eur/`.
- Lite UI pass is complete across the checked component surface.
- Currency and business amounts use Inter `tabular-nums`, not `font-mono`.
- Remaining Lite motion cleanup completed: no `transition-all` remains in the
  checked component surface.
- Remaining gray scrollbar cleanup completed.

### Pro Desktop

- Pro split folders are in place for the same seven screen groups.
- Groups 1-4 are complete:
  - shell/accounts/finance/accounting entry,
  - projects,
  - misc screens and modals,
  - document editor.
- Conformance grep only reports the exempt account-color data option.

### Accounting UI Pro

- Groups 5-7 are complete:
  - booking editor and inbox,
  - main accounting views,
  - report views.
- The actual accounting app path is
  `packages/accounting-ui-pro/src/App.tsx`.
- Debit, credit, balances, totals, and report amounts use tabular numeric
  treatment.
- `accent-lime` remains intentionally preserved for the accounting module.

## Verification Completed

- `pnpm -C apps/pro-desktop typecheck` passed.
- `pnpm -C apps/desktop typecheck` passed.
- Final raw neutral grep across Lite, Pro, and accounting only reports the two
  exempt account-color option values:
  - `apps/desktop/components/DashboardViews.tsx:448`
  - `apps/pro-desktop/components/DashboardViews.tsx:420`
- Final checked-surface grep has no hits for:
  - `transition-all`
  - `scrollbar-thumb-gray-*`
  - `font-mono` on matched amount/currency terms
- Pro renderer smoke was run at `http://127.0.0.1:3003/`:
  - Dashboard checked.
  - Finance checked.
  - Pro Accounting missing-SKR state checked.
  - Browser console had no errors during the smoke pass.
- Lite renderer smoke was run at `http://127.0.0.1:3003/`:
  - Dashboard checked.
  - Finance checked.
  - Browser console had no errors during the smoke pass.
- Lite renderer direct boot now passes `AppComponent` from `apps/desktop/index.tsx`,
  matching the Pro entry pattern and avoiding the empty `import.meta.glob` loader
  path in this Vite root.

## Still Open

- A broader manual QA pass across every screen is still optional if release
  confidence requires it.
- No commit has been made; the worktree intentionally remains dirty.

## Follow-Up Verification Commands

Run from the repository root:

```bash
pnpm -C apps/desktop typecheck
pnpm -C apps/pro-desktop typecheck
git diff --check -- apps/desktop/components apps/pro-desktop/components packages/accounting-ui-pro/src UI_REFACTOR_HANDOFF.md
grep -rnE "(bg|text|border)-(gray|slate|zinc|neutral)-[0-9]+" apps/desktop/components apps/pro-desktop/components packages/accounting-ui-pro/src --include=*.tsx | grep -vi print
rg -n "transition-all|scrollbar-thumb-gray|font-mono[^\n]*(formatCurrency|amount|balance|total|price|revenue|ticket|rate|Budget)|(?:formatCurrency|amount|balance|total|price|revenue|ticket|rate|Budget)[^\n]*font-mono" apps/desktop/components apps/pro-desktop/components packages/accounting-ui-pro/src -g '*.tsx' -g '!**/Print*.tsx'
```
