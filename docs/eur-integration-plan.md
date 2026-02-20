# EÜR / Anlage EÜR Integration Plan (Billme)

Stand: 2026-02-18

## 1) What “EÜR lines” are (Anlage EÜR lines)

In Germany, “EÜR” (Einnahmenüberschussrechnung) is the cash-basis profit determination for certain taxpayers. The **official reporting format** is the tax form **“Anlage EÜR”**.

When we say **“EÜR lines”** in this project, we mean:

- **Each official field/line of the Anlage EÜR form that carries a “Kennziffer” (Kz)** (a numeric field identifier used by ELSTER/official datasets).
- Some lines are **direct-input lines** (you enter a value).
- Some are **computed/summary lines** (e.g. “Summe …”), i.e. totals that are derived from other lines.

So “mapping to EÜR lines” means: every income/expense item we include in the EÜR is assigned to exactly one **Kennziffer-defined** line (or explicitly excluded as private/transfer), and we aggregate totals per Kennziffer.

### Source of truth (researched)

For the tax year **2025**, the Federal Ministry of Finance (BMF) publishes the official Anlage EÜR form and related annexes as a PDF:

```text
BMF – Anlage EÜR 2025 (PDF, published 2025-08-29)
https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.html
```

This PDF contains the BMF letter and the full form set (Anlage EÜR plus annexes like AVEÜR, SZ, etc.). We will treat the **Kennziffer + label text** in this PDF as the canonical definition for the 2025 “EÜR lines”.

For tax year **2026**: as of **2026-02-18** there is no BMF publication page equivalent to the 2025 one (we must add 2026 once BMF publishes it). We will implement the system as **year-versioned** and ship 2025 lines first; 2026 lines will be added when the official form is available.

### Concrete examples from Anlage EÜR 2025

From the official PDF, the “Betriebseinnahmen” section includes lines like:

- “Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer (nach § 19 Abs. 1 UStG) …” (Kz 111)
- “Umsatzsteuerpflichtige Betriebseinnahmen …” (Kz 112)
- “Vereinnahmte Umsatzsteuer sowie Umsatzsteuer auf unentgeltliche Wertabgaben” (Kz 140)
- “Summe Betriebseinnahmen …” (Kz 159)

The “Betriebsausgaben” section includes lines like:

- “Betriebsausgabenpauschale für bestimmte Berufsgruppen” (Kz 195)
- “Bezogene Fremdleistungen” (Kz 110)
- “Ausgaben für eigenes Personal …” (Kz 120)
- “Miete/Pacht für Geschäftsräume …” (Kz 150)
- … plus many more (the official form has dozens of expense lines).

## 2) Product goal (v1)

Add an **EÜR (Anlage EÜR)** area that:

1. Lets users classify their cash flows to official Anlage‑EÜR lines (Kennziffern).
2. Produces a year/period report: totals per Kennziffer + summary (income, expenses, surplus).
3. Exports **CSV** with Kennziffer totals (for copying into ELSTER / sharing with a tax advisor).

Out of scope for v1:

- Direct ELSTER transmission (ERiC)
- Full SKR03/04 bookkeeping/journal
- Multi-rate VAT splits (we keep it intentionally simple)

## 3) Where it integrates in the app

Renderer:

- Add a new tile in `apps/desktop/components/FinanceHubView.tsx`: **“EÜR”**
- Add route `/eur` in `apps/desktop/router.tsx`
- Implement `apps/desktop/components/EurView.tsx` as the EÜR screen

Electron backend:

- Add IPC routes under a new group `eur:*` (similar to existing `finance:*`, `transactions:*` patterns)
- Implement report computation in a service module (pure functions where possible)

SQLite:

- Add persistent classification so users don’t have to re-tag every year

## 4) Data basis (v1)

We will compute EÜR from two sources that already exist in Billme:

### Income

- `invoice_payments` (cash receipts) within the selected period
- Unlinked positive `transactions` (income) within the selected period (e.g. other income not tied to invoices)

We must avoid double counting:

- If an income `transaction` is linked to an invoice (`transactions.linked_invoice_id`), we do **not** count it separately; we count the invoice payment.

### Expenses

- Negative `transactions` (expense), `status = booked`, within the selected period

### Exclusions

- Soft-deleted imported transactions (`transactions.deleted_at`) are excluded
- User-marked “private/transfer” items are excluded (see classification model)

## 5) VAT handling (v1)

We will support a single “VAT mode” per item:

- `none` (0%) or
- `default` (use `settings.legal.defaultVatRate`)

For v1 we treat all bank amounts as **gross** and compute net/VAT if VAT mode is `default`.

Note: This is **not** a complete VAT accounting system; it’s a pragmatic helper to get correct EÜR totals for many small businesses.

## 6) “EÜR lines” catalog in the repo (year-versioned)

We will store the official line catalog as data files:

- `apps/desktop/eur/lines-2025.json` (from BMF Anlage EÜR 2025 PDF)
- `apps/desktop/eur/lines-2026.json` (add once BMF publishes Anlage EÜR 2026)

Format (stable internal IDs + official Kennziffer):

```ts
type EurLineDef = {
  year: 2025 | 2026;
  id: string;          // stable internal key (do not change once shipped)
  kennziffer: string;  // official Kz (string to preserve leading zeros if ever needed)
  label: string;       // official label text (German)
  kind: 'income' | 'expense' | 'computed';
  exportable: boolean; // whether to include in CSV export
  computedFromIds?: string[];
};
```

Important:

- We do **not** try to infer these lines from heuristics; we will populate them directly from the official form.
- If the form changes in future years, we add a new JSON file (never “edit history” for previous years).

### 6.1) How we will populate `lines-2025.json` (decision complete)

We will **manually transcribe** the line catalog from the official BMF PDF for tax year 2025 to avoid subtle parsing mistakes.

Rules for transcription:

1. Include **only** the lines belonging to **Anlage EÜR** itself (not annex forms like AVEÜR, SZ, etc.).
2. For each official form line that has a Kennziffer, create one entry:
   - `kennziffer`: exactly as printed (e.g. `"111"`)
   - `label`: the printed German description (trimmed, keep meaning intact)
   - `kind`:
     - `income` for Betriebseinnahmen lines
     - `expense` for Betriebsausgaben lines
     - `computed` for totals/subtotals (e.g. “Summe …”)
3. Stable `id` naming convention:
   - `E2025_KZ111` for a direct line with Kz 111
   - `E2025_SUM_<slug>` for computed sum lines when the PDF provides no unique Kennziffer (if every sum has a Kennziffer, we still prefer `E2025_KZ…`).
4. `computedFromIds`:
   - only for `computed` lines
   - must list the exact child line IDs that are summed
5. `exportable`:
   - `true` for any line we want in the CSV output (typically all `income`/`expense` direct lines and the final “sum” lines)
   - `false` for UI-only helper lines if any exist

This makes `lines-2025.json` auditable and stable across releases.

## 7) Classification model (how users map items to Kennziffer lines)

We will store per-year classification in a new table `eur_classifications`:

- key: `(source_type, source_id, tax_year)`
- values:
  - `eur_line_id` (nullable while unclassified)
  - `excluded` (private/transfer)
  - `vat_mode` (`none` | `default`)
  - optional note + `updated_at`

Sources:

- `source_type = 'transaction'` and `source_id = transactions.id`
- `source_type = 'invoice'` and `source_id = invoices.id` (classification applies to all payments of that invoice for the year)

## 8) Report computation

New module `apps/desktop/services/eurReport.ts`:

Inputs:

- tax year + from/to (defaults to full year)
- settings (`defaultVatRate`, §19 flag is still respected if you want to force `none`)
- database query results:
  - invoice payments + invoices
  - transactions
  - eur classifications

Outputs:

- totals per line id (and Kennziffer)
- summary KPIs (income, expenses, surplus)
- unclassified counts + warnings

## 9) IPC surface

Add these IPC routes:

- `eur:getReport` (year/period → totals)
- `eur:listItems` (unclassified queue + drilldowns)
- `eur:upsertClassification` (persist mapping/exclusion/vat mode)
- `eur:exportCsv` (returns UTF‑8 CSV string with BOM)

## 10) UI behavior (EurView)

EurView shows:

- Year selector (2025/2026)
- Period selector (optional)
- “Unclassified” queue:
  - list items with date, counterparty, purpose, amount, source
  - side panel lets user pick:
    - Kennziffer line (searchable dropdown)
    - VAT mode (none/default)
    - excluded (private/transfer)
- Report table:
  - one row per Kennziffer line with totals
  - click → drill down to contributing items

## 11) Development on a branch (required)

All work happens on a feature branch:

- Branch name: `feat/eur-anlage-euer`
- Workflow:
  1. Create branch from current default branch
  2. Push branch
  3. Open PR/MR with a checklist (DB migration, IPC schema, UI screenshots, tests)
  4. Merge after review + passing checks

Note: If Git refuses operations due to “dubious ownership”, fix by adding the repo to Git’s safe directories, or by changing folder ownership. This is a local developer-machine concern, not app behavior.

## 12) Tests

Add Vitest tests for:

- VAT gross→net computations
- Invoice payments split + rounding reconciliation
- classification overlay & exclusions
- line catalog validation (no duplicate IDs, no cycles in computed lines)

Update IPC schema tests to include `eur:*` routes.
