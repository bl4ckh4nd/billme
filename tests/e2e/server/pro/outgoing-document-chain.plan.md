# Outgoing document-chain E2E

## Acceptance path

1. Seed an isolated Pro tenant and accept an offer containing two tax rates.
2. Reserve/finalize numbers while creating an order confirmation and delivery note.
3. Create advance, partial, and final invoices rooted at the order; verify the cumulative amount cannot exceed the order total.
4. Create a partial credit note and a revision from the finalized invoice; reload the API and browser state.
5. Assert non-billing documents have no journal/OPOS entries, while billing and correction documents have finalized numbers, journal entries, audit history, and the correction reduces the original OPOS residual.

## Deterministic screenshots

- `01-chain-and-revision.png`: hosted Pro documents view showing the full relationship chain and revision.
- `02-chain-after-reload.png`: the same relationship view after a browser reload, proving persisted state.
