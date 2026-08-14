import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readServerHarnessState } from '../harness.mjs';
import {
  createOwnerCredentials,
  ensureHarnessSession,
  requestJson,
  requestText,
  seedHarnessProTenant,
  setHarnessProBankTransactionStatus,
  setHarnessProPeriodStatus,
} from './helpers.mjs';

const owner = createOwnerCredentials('pro');

const viewerTokenFor = (state, ownerToken) => {
  const [payload] = ownerToken.split('.');
  const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const viewerPayload = Buffer.from(JSON.stringify({
    ...session,
    role: 'viewer',
    user: { ...session.user, role: 'viewer' },
  })).toString('base64url');
  const signature = createHmac('sha256', state.env.BILLME_SESSION_SECRET).update(viewerPayload).digest('base64url');
  return `${viewerPayload}.${signature}`;
};

const rawRequest = async (state, session, requestPath, query, options = {}) => {
  const url = new URL(requestPath, `${state.urls.api}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = {
    accept: options.accept ?? 'application/json',
    authorization: `Bearer ${session.token}`,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* CSV or an error without JSON. */ }
  return { response, body, text };
};

const expectError = async (state, session, requestPath, query, options, status, needle) => {
  const result = await rawRequest(state, session, requestPath, query, options);
  assert.equal(result.response.status, status, `${requestPath}: ${result.text}`);
  if (needle) assert.match(String(result.body?.message ?? result.text), new RegExp(needle));
  return result;
};

const json = async (state, session, requestPath, query, options) => {
  const result = await rawRequest(state, session, requestPath, query, options);
  assert.ok(result.response.ok, `${requestPath}: ${result.response.status} ${result.text}`);
  return result.body;
};

const counts = async (state, session) => {
  const [journal, openItems, snapshots, exports] = await Promise.all([
    requestJson(state, session, '/api/v1/pro/accounting/journal'),
    requestJson(state, session, '/api/v1/pro/accounting/open-items'),
    requestJson(state, session, '/api/v1/pro/accounting/reports/snapshots'),
    requestJson(state, session, '/api/v1/pro/accounting/datev/exports'),
  ]);
  return {
    journal: journal.length,
    openItems: openItems.length,
    snapshots: snapshots.length,
    exports: exports.length,
  };
};

const assertNoAccountingWrite = async (state, session, before, label) => {
  assert.deepEqual(await counts(state, session), before, `${label}: failed request left an accounting write`);
};

const stablePreview = (preview) => preview
  ? {
      ...preview,
      snapshot: preview.snapshot ? { ...preview.snapshot, capturedAt: '<volatile>' } : undefined,
    }
  : preview;

const publicDocumentState = async (state, session, id, { bankTransactionId } = {}) => {
  const [invoice, preview, journal, openItems, transactions] = await Promise.all([
    requestJson(state, session, `/api/v1/pro/invoices/${encodeURIComponent(id)}`),
    json(state, session, '/api/v1/pro/accounting/outgoing-invoices/preview', undefined, {
      method: 'POST',
      body: { reason: `nonhappy inspect ${id}`, invoiceId: id },
    }),
    requestJson(state, session, '/api/v1/pro/accounting/journal'),
    requestJson(state, session, '/api/v1/pro/accounting/open-items'),
    requestJson(state, session, '/api/v1/pro/accounting/transactions'),
  ]);
  return {
    invoice: invoice && {
      status: invoice.status,
      accountingStatus: invoice.accountingStatus,
      accountingSnapshot: invoice.accountingSnapshot,
      accountingJournalEntryId: invoice.accountingJournalEntryId,
      taxSnapshot: invoice.taxSnapshot,
      items: invoice.items,
      payments: invoice.payments,
      history: invoice.history,
    },
    preview: stablePreview(preview),
    journal: journal
      .filter((entry) => entry.sourceType === 'outgoing_invoice' && entry.sourceId === id)
      .map(({ id: entryId, status, sourceType, sourceKey, reversedEntryId, lines }) => ({
        id: entryId,
        status,
        sourceType,
        sourceKey,
        reversedEntryId,
        lines,
      })),
    openItem: openItems
      .filter((item) => item.sourceType === 'outgoing_invoice' && item.sourceId === id)
      .map(({ id: itemId, allocatedAmount, residualAmount, status, journalEntryId }) => ({
        id: itemId,
        allocatedAmount,
        residualAmount,
        status,
        journalEntryId,
      })),
    bankTransaction: bankTransactionId
      ? transactions.find((transaction) => transaction.id === bankTransactionId) ?? null
      : undefined,
  };
};

const assertPublicDocumentStateUnchanged = async (state, session, id, before, label, options) => {
  assert.deepEqual(await publicDocumentState(state, session, id, options), before, `${label}: public accounting state changed`);
};

const draftState = (state, session, transactionId) => requestJson(
  state,
  session,
  `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}`,
);

const makeInvoice = async (state, session, client, id, date = '2026-08-20', tax = {}) => {
  const reservation = await json(state, session, '/api/v1/pro/numbers/reserve', undefined, {
    method: 'POST',
    body: { kind: 'invoice' },
  });
  const invoice = {
    kind: 'invoice',
    id,
    clientId: client.id,
    clientNumber: client.customerNumber,
    number: reservation.number,
    client: client.company,
    clientEmail: client.email,
    clientAddress: client.address,
    taxMode: tax.taxMode ?? 'standard_vat',
    ...(tax.taxMeta ? { taxMeta: tax.taxMeta } : {}),
    taxSnapshot: tax.taxSnapshot ?? {
      vatRateApplied: 19,
      vatAmount: 19,
      netAmount: 100,
      grossAmount: 119,
      einvoiceCategoryCode: 'S',
      vatBreakdown: [{ rate: 19, netAmount: 100, vatAmount: 19 }],
    },
    date,
    dueDate: date,
    servicePeriod: date.slice(0, 7),
    amount: tax.amount ?? 119,
    status: 'open',
    dunningLevel: 0,
    items: [{ description: 'Adversarial server accounting case', quantity: 1, price: tax.amount ?? 119, total: tax.amount ?? 119, taxRate: tax.taxRate ?? 19 }],
    payments: [],
    history: [],
  };
  await json(state, session, '/api/v1/pro/invoices', undefined, {
    method: 'POST',
    body: { reason: `nonhappy create ${id}`, invoice },
  });
  await json(state, session, '/api/v1/pro/numbers/finalize', undefined, {
    method: 'POST',
    body: { reservationId: reservation.reservationId, documentId: id },
  });
  return { invoice, reservation };
};

const postInvoice = async (state, session, id, reservationId, reason = `nonhappy post ${id}`) => json(
  state,
  session,
  '/api/v1/pro/accounting/outgoing-invoices/post',
  undefined,
  { method: 'POST', body: { reason, invoiceId: id, reservationId } },
);

const expectNoDocumentAccounting = async (state, session, id, before, label, beforePublicState, publicStateOptions) => {
  const invoice = await requestJson(state, session, `/api/v1/pro/invoices/${encodeURIComponent(id)}`);
  assert.equal(invoice?.id, id);
  assert.notEqual(invoice?.status, 'paid', `${label}: invoice unexpectedly paid`);
  if (beforePublicState) await assertPublicDocumentStateUnchanged(state, session, id, beforePublicState, label, publicStateOptions);
  await assertNoAccountingWrite(state, session, before, label);
};

export const runProNonHappyAccountingScenario = async () => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, { product: 'pro', ...owner });
  const namespace = `nonhappy-${Date.now()}`;
  await seedHarnessProTenant(state, { tenantId: session.tenantId, namespace });

  // The isolated non-happy run does not depend on the preceding browser
  // scenario's tenant mappings; keep all posting fixtures on seeded accounts.
  for (const [role, accountNumber] of [
    ['accounts_receivable', '1200'],
    ['accounts_payable', '1200'],
    ['bank', '1200'],
    ['expense', '3125'],
    ['revenue', '8400'],
    ['output_vat', '1776'],
  ]) {
    await json(state, session, '/api/v1/pro/accounting/mappings', undefined, {
      method: 'POST',
      body: { reason: `nonhappy fixture mapping ${role}`, chart: 'SKR03', role, accountNumber },
    });
  }

  const clients = await requestJson(state, session, '/api/v1/pro/clients');
  const clientId = `${namespace}-client-beta`;
  const client = clients.find((entry) => entry.id === clientId);
  assert.ok(client?.id, `deterministic seeded Pro client missing: ${clientId}`);
  assert.equal(client.company, 'Beta Digital AG');
  let cases = 0;

  // 1. Viewer cannot mutate Pro accounting, and the protected state is unchanged.
  const viewerSession = { ...session, token: viewerTokenFor(state, session.token) };
  const beforeViewer = await counts(state, session);
  await expectError(state, viewerSession, '/api/v1/pro/accounting/mappings', undefined, {
    method: 'POST',
    body: { reason: 'viewer mutation must fail', chart: 'SKR03', role: 'expense', accountNumber: '3125' },
  }, 403, 'Accounting mutation');
  await assertNoAccountingWrite(state, session, beforeViewer, 'viewer 403');
  cases++;

  // 2. Missing audit reason is rejected at the HTTP boundary before a write.
  const beforeReason = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/policy', undefined, {
    method: 'PUT', body: { activeChart: 'SKR03', vatMethod: 'soll' },
  }, 400, 'reason|Required');
  await assertNoAccountingWrite(state, session, beforeReason, 'missing reason');
  cases++;

  const transactionId = `${namespace}-workflow-transaction`;
  const draftBefore = await json(state, session, `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}`);
  assert.ok(draftBefore?.id, 'seeded workflow draft missing');

  // 3. An unbalanced draft is retained as a reviewable draft, but posting is atomic.
  const invalidDraft = {
    ...draftBefore,
    workflowStatus: 'incomplete',
    lines: [
      { id: `${draftBefore.id}-debit`, accountNumber: '3125', debitAmount: 119, creditAmount: 0 },
      { id: `${draftBefore.id}-credit`, accountNumber: '1200', debitAmount: 0, creditAmount: 118 },
    ],
  };
  const savedInvalid = await json(state, session, '/api/v1/pro/accounting/drafts', undefined, {
    method: 'POST', body: { reason: 'nonhappy save unbalanced draft', draft: invalidDraft },
  });
  assert.ok(savedInvalid.validationIssues.some((issue) => issue.code === 'UNBALANCED_ENTRY'));
  const beforeInvalidDraft = await draftState(state, session, transactionId);
  const beforeInvalidPost = await counts(state, session);
  const invalidPost = await json(state, session, `/api/v1/pro/accounting/drafts/${encodeURIComponent(draftBefore.id)}/post`, undefined, {
    method: 'POST', body: { reason: 'nonhappy post unbalanced draft', idempotencyKey: `${namespace}-invalid-post` },
  });
  assert.ok(invalidPost.issues.some((issue) => issue.code === 'UNBALANCED_ENTRY'));
  assert.equal(invalidPost.entry.id, '');
  assert.deepEqual(await draftState(state, session, transactionId), beforeInvalidDraft, 'unbalanced draft post changed public draft state');
  await assertNoAccountingWrite(state, session, beforeInvalidPost, 'unbalanced draft post');
  cases++;

  // 4. Invalid workflow transition is not allowed to skip approval.
  const beforeTransitionDraft = await draftState(state, session, transactionId);
  const beforeTransition = await counts(state, session);
  await expectError(state, session, `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}/action`, undefined, {
    method: 'POST', body: { action: 'approve', reason: 'nonhappy approve incomplete draft' },
  }, 409, 'Invalid workflow transition');
  assert.deepEqual(await draftState(state, session, transactionId), beforeTransitionDraft, 'invalid workflow transition changed public draft state');
  await assertNoAccountingWrite(state, session, beforeTransition, 'invalid workflow transition');
  cases++;

  // 5. Outgoing posting requires the exact finalized reservation.
  const missingReservation = await makeInvoice(state, session, client, `${namespace}-missing-reservation`);
  const wrongReservationInvoice = await makeInvoice(state, session, client, `${namespace}-wrong-reservation`);
  const beforeMissingReservationPublic = await publicDocumentState(state, session, missingReservation.invoice.id);
  const beforeMissingReservation = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/outgoing-invoices/post', undefined, {
    method: 'POST', body: { reason: 'nonhappy missing reservation', invoiceId: missingReservation.invoice.id },
  }, 400, 'reservationId|Required');
  await expectNoDocumentAccounting(state, session, missingReservation.invoice.id, beforeMissingReservation, 'missing finalized reservation', beforeMissingReservationPublic);
  const wrongReservation = wrongReservationInvoice.reservation;
  assert.notEqual(wrongReservation.reservationId, missingReservation.reservation.reservationId);
  const beforeWrongReservation = await counts(state, session);
  const beforeWrongReservationPublic = await publicDocumentState(state, session, missingReservation.invoice.id);
  await expectError(state, session, '/api/v1/pro/accounting/outgoing-invoices/post', undefined, {
    method: 'POST', body: { reason: 'nonhappy wrong reservation', invoiceId: missingReservation.invoice.id, reservationId: wrongReservation.reservationId },
  }, 409, 'FINALIZED_RESERVATION_REQUIRED');
  await expectNoDocumentAccounting(state, session, missingReservation.invoice.id, beforeWrongReservation, 'wrong finalized reservation', beforeWrongReservationPublic);
  cases++;

  // 6. A closed posting period blocks the public document-post route atomically.
  const lockedInvoice = await makeInvoice(state, session, client, `${namespace}-period-locked`, '2026-08-27');
  await setHarnessProPeriodStatus(state, { tenantId: session.tenantId, period: '2026-08', status: 'closed' });
  const beforeClosedPeriodPublic = await publicDocumentState(state, session, lockedInvoice.invoice.id);
  const beforeClosedPeriod = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/outgoing-invoices/post', undefined, {
    method: 'POST', body: { reason: 'nonhappy closed period', invoiceId: lockedInvoice.invoice.id, reservationId: lockedInvoice.reservation.reservationId },
  }, 409, 'POSTING_DATE_IN_CLOSED_PERIOD');
  await expectNoDocumentAccounting(state, session, lockedInvoice.invoice.id, beforeClosedPeriod, 'closed period', beforeClosedPeriodPublic);
  await setHarnessProPeriodStatus(state, { tenantId: session.tenantId, period: '2026-08', status: 'open' });
  cases++;

  // 7. Duplicate document posting is idempotent: one journal and one OPOS item.
  const postedA = await makeInvoice(state, session, client, `${namespace}-posted-a`);
  const postedAResult = await postInvoice(state, session, postedA.invoice.id, postedA.reservation.reservationId);
  assert.equal(postedAResult.status, 'ready', JSON.stringify(postedAResult));
  const afterFirstPost = await counts(state, session);
  const duplicatePost = await postInvoice(state, session, postedA.invoice.id, postedA.reservation.reservationId, 'nonhappy duplicate post');
  assert.equal(duplicatePost.status, 'ready');
  assert.deepEqual(await counts(state, session), afterFirstPost);
  cases++;

  const openItems = await requestJson(state, session, '/api/v1/pro/accounting/open-items');
  const itemA = openItems.find((item) => item.sourceId === postedA.invoice.id);
  assert.ok(itemA?.id, 'posted invoice OPOS item missing');

  // 8. OPOS under/over-allocation and party mismatch never create a payment journal.
  const beforeUnderPublic = await publicDocumentState(state, session, postedA.invoice.id);
  const beforeUnder = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/open-items/payments', undefined, {
    method: 'POST', body: {
      reason: 'nonhappy allocation exceeds payment',
      payment: { sourceType: 'manual', sourceId: `${namespace}-under`, partyType: 'debtor', partyId: client.id, paymentDate: '2026-08-20', amount: 10, bankAccountNumber: '1200', allocations: [{ openItemId: itemA.id, amount: 11 }], allocationEventId: `${namespace}-under-event` },
    },
  }, 400, 'PAYMENT_ALLOCATION_EXCEEDS_PAYMENT');
  await assertPublicDocumentStateUnchanged(state, session, postedA.invoice.id, beforeUnderPublic, 'OPOS over payment amount');
  await assertNoAccountingWrite(state, session, beforeUnder, 'OPOS over payment amount');
  const beforeOverPublic = await publicDocumentState(state, session, postedA.invoice.id);
  const beforeOver = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/open-items/payments', undefined, {
    method: 'POST', body: {
      reason: 'nonhappy allocation exceeds residual',
      payment: { sourceType: 'manual', sourceId: `${namespace}-over`, partyType: 'debtor', partyId: client.id, paymentDate: '2026-08-20', amount: 200, bankAccountNumber: '1200', allocations: [{ openItemId: itemA.id, amount: 200 }], allocationEventId: `${namespace}-over-event` },
    },
  }, 400, 'OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL');
  await assertPublicDocumentStateUnchanged(state, session, postedA.invoice.id, beforeOverPublic, 'OPOS over residual');
  await assertNoAccountingWrite(state, session, beforeOver, 'OPOS over residual');
  const beforePartyPublic = await publicDocumentState(state, session, postedA.invoice.id);
  const beforeParty = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/open-items/payments', undefined, {
    method: 'POST', body: {
      reason: 'nonhappy party mismatch',
      payment: { sourceType: 'manual', sourceId: `${namespace}-party`, partyType: 'creditor', partyId: 'wrong-party', paymentDate: '2026-08-20', amount: 119, bankAccountNumber: '1200', allocations: [{ openItemId: itemA.id, amount: 119 }], allocationEventId: `${namespace}-party-event` },
    },
  }, 422, 'PAYMENT_PARTY_MISMATCH');
  await assertPublicDocumentStateUnchanged(state, session, postedA.invoice.id, beforePartyPublic, 'OPOS party mismatch');
  await assertNoAccountingWrite(state, session, beforeParty, 'OPOS party mismatch');
  cases += 3;

  // 9. A bank source with the wrong amount and wrong direction is rejected before payment posting.
  const incomeSourceId = `${namespace}-transaction-income`;
  const beforeSourcePublic = await publicDocumentState(state, session, postedA.invoice.id, { bankTransactionId: incomeSourceId });
  const beforeSource = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/open-items/payments', undefined, {
    method: 'POST', body: {
      reason: 'nonhappy bank source mismatch',
      payment: { sourceType: 'bank_transaction', sourceId: incomeSourceId, partyType: 'debtor', partyId: client.id, paymentDate: '2026-02-12', amount: 1, bankAccountNumber: '1200', allocations: [{ openItemId: itemA.id, amount: 1 }], allocationEventId: `${namespace}-source-mismatch` },
    },
  }, 422, 'PAYMENT_SOURCE_MISMATCH');
  await assertPublicDocumentStateUnchanged(state, session, postedA.invoice.id, beforeSourcePublic, 'OPOS source mismatch', { bankTransactionId: incomeSourceId });
  await assertNoAccountingWrite(state, session, beforeSource, 'OPOS source mismatch');
  const directionSourceId = `${namespace}-workflow-transaction`;
  await setHarnessProBankTransactionStatus(state, { tenantId: session.tenantId, transactionId: directionSourceId, status: 'pending' });
  const beforeDirectionPublic = await publicDocumentState(state, session, postedA.invoice.id, { bankTransactionId: directionSourceId });
  assert.equal(beforeDirectionPublic.bankTransaction?.status, 'pending');
  assert.equal(beforeDirectionPublic.bankTransaction?.type, 'expense');
  await expectError(state, session, '/api/v1/pro/accounting/open-items/payments', undefined, {
    method: 'POST', body: {
      reason: 'nonhappy bank source direction mismatch',
      payment: { sourceType: 'bank_transaction', sourceId: directionSourceId, partyType: 'debtor', partyId: client.id, paymentDate: '2026-03-05', amount: 119, bankAccountNumber: '1200', allocations: [{ openItemId: itemA.id, amount: 1 }], allocationEventId: `${namespace}-direction-mismatch` },
    },
  }, 422, 'PAYMENT_SOURCE_DIRECTION_MISMATCH');
  await assertPublicDocumentStateUnchanged(state, session, postedA.invoice.id, beforeDirectionPublic, 'OPOS direction mismatch', { bankTransactionId: directionSourceId });
  await assertNoAccountingWrite(state, session, beforeSource, 'OPOS direction mismatch');
  cases += 2;

  // 10. A partial allocation is a reversal dependency; a second reversal is terminal.
  const partialPayment = await json(state, session, '/api/v1/pro/accounting/open-items/payments', undefined, {
    method: 'POST', body: {
      reason: 'nonhappy partial OPOS allocation',
      payment: { sourceType: 'manual', sourceId: `${namespace}-partial`, partyType: 'debtor', partyId: client.id, paymentDate: '2026-08-20', amount: 119, bankAccountNumber: '1200', allocations: [{ openItemId: itemA.id, amount: 50 }], allocationEventId: `${namespace}-partial-event` },
    },
  });
  assert.equal(partialPayment.allocatedAmount, 50);
  const beforeDependencyReversePublic = await publicDocumentState(state, session, postedA.invoice.id);
  const beforeDependencyReverse = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/documents/reverse', undefined, {
    method: 'POST', body: { reason: 'nonhappy reverse allocated document', documentType: 'outgoing_invoice', documentId: postedA.invoice.id, postingDate: '2026-08-21' },
  }, 409, 'DOCUMENT_HAS_ALLOCATIONS');
  await assertPublicDocumentStateUnchanged(state, session, postedA.invoice.id, beforeDependencyReversePublic, 'reverse with OPOS dependency');
  await assertNoAccountingWrite(state, session, beforeDependencyReverse, 'reverse with OPOS dependency');
  const postedB = await makeInvoice(state, session, client, `${namespace}-posted-b`, '2026-08-22');
  await postInvoice(state, session, postedB.invoice.id, postedB.reservation.reservationId);
  const reversedB = await json(state, session, '/api/v1/pro/accounting/documents/reverse', undefined, {
    method: 'POST', body: { reason: 'nonhappy first document reversal', documentType: 'outgoing_invoice', documentId: postedB.invoice.id, postingDate: '2026-08-23' },
  });
  assert.ok(reversedB.reversalEntryId);
  const beforeDoubleReversePublic = await publicDocumentState(state, session, postedB.invoice.id);
  const beforeDoubleReverse = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/documents/reverse', undefined, {
    method: 'POST', body: { reason: 'nonhappy duplicate document reversal', documentType: 'outgoing_invoice', documentId: postedB.invoice.id, postingDate: '2026-08-24' },
  }, 409, 'DOCUMENT_NOT_POSTED');
  await assertPublicDocumentStateUnchanged(state, session, postedB.invoice.id, beforeDoubleReversePublic, 'duplicate document reversal');
  await assertNoAccountingWrite(state, session, beforeDoubleReverse, 'duplicate document reversal');
  cases += 2;

  // 11. Backfill confirmation is bound to its preview hash and terminal state.
  const stale = await makeInvoice(state, session, client, `${namespace}-backfill-stale`, '2026-08-25');
  const backfill = await requestJson(state, session, '/api/v1/pro/accounting/backfill/preview');
  assert.ok(backfill.candidates.some((candidate) => candidate.sourceId === stale.invoice.id));
  await json(state, session, '/api/v1/pro/invoices', undefined, {
    method: 'POST', body: { reason: 'nonhappy make backfill source terminal', invoice: { ...stale.invoice, status: 'cancelled' } },
  });
  const beforeStaleBackfillPublic = await publicDocumentState(state, session, stale.invoice.id);
  const beforeStaleBackfill = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/backfill/confirm', undefined, {
    method: 'POST', body: { reason: 'nonhappy stale backfill', runId: backfill.runId, confirmationHash: backfill.confirmationHash },
  }, 409, 'BACKFILL_STALE_PREVIEW');
  await assertPublicDocumentStateUnchanged(state, session, stale.invoice.id, beforeStaleBackfillPublic, 'stale backfill');
  await assertNoAccountingWrite(state, session, beforeStaleBackfill, 'stale backfill');
  cases++;

  // 12. Missing reverse-charge evidence remains unresolved and cannot create OPOS/journal rows.
  const missingEvidence = await makeInvoice(state, session, client, `${namespace}-missing-evidence`, '2026-08-26', {
    taxMode: 'intra_eu_service_reverse_charge',
    taxMeta: { buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', destinationVatRate: 20 },
    taxSnapshot: { vatRateApplied: 0, vatAmount: 0, netAmount: 100, grossAmount: 100, einvoiceCategoryCode: 'S', vatBreakdown: [{ rate: 0, netAmount: 100, vatAmount: 0, taxCaseKey: 'EU_B2B_SERVICE_RC' }] },
    amount: 100,
    taxRate: 0,
  });
  const beforeMissingEvidencePublic = await publicDocumentState(state, session, missingEvidence.invoice.id);
  const beforeMissingEvidence = await counts(state, session);
  const previewMissingEvidence = await postInvoice(state, session, missingEvidence.invoice.id, missingEvidence.reservation.reservationId, 'nonhappy missing reverse-charge evidence');
  assert.equal(previewMissingEvidence.status, 'unresolved');
  assert.equal(previewMissingEvidence.reason, 'MISSING_TAX_EVIDENCE');
  await assertPublicDocumentStateUnchanged(state, session, missingEvidence.invoice.id, beforeMissingEvidencePublic, 'missing reverse-charge evidence');
  await expectNoDocumentAccounting(state, session, missingEvidence.invoice.id, beforeMissingEvidence, 'missing reverse-charge evidence');
  cases++;

  // 13. DATEV rejects multi-period exports and keeps successful exports immutable on refetch.
  const beforeDatevInvalid = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/datev/export.csv', { from: '2026-08-01', to: '2026-09-01', consultantNumber: '1001', clientNumber: '7', fiscalYearStart: '2026-01-01', accountLength: 4, encoding: 'utf8-bom', reason: 'nonhappy invalid DATEV period' }, { accept: 'text/csv' }, 400, 'DATEV');
  await assertNoAccountingWrite(state, session, beforeDatevInvalid, 'invalid DATEV period');
  const exported = await requestText(state, session, '/api/v1/pro/accounting/datev/export.csv', { from: '2026-08-20', to: '2026-08-26', consultantNumber: '1001', clientNumber: '7', fiscalYearStart: '2026-01-01', accountLength: 4, encoding: 'utf8-bom', reason: 'nonhappy immutable DATEV export' });
  const exportId = exported.headers.get('x-billme-datev-export-id');
  assert.ok(exportId);
  const refetchedExport = await requestText(state, session, `/api/v1/pro/accounting/datev/exports/${encodeURIComponent(exportId)}`);
  assert.equal(refetchedExport.body, exported.body);
  assert.equal(refetchedExport.headers.get('x-billme-datev-content-sha256'), exported.headers.get('x-billme-datev-content-sha256'));
  cases += 2;

  // 14. Posted journals lock the active chart.
  const beforeLockedChart = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/policy', undefined, {
    method: 'PUT', body: { reason: 'nonhappy switch locked chart', activeChart: 'SKR04', vatMethod: 'soll' },
  }, 409, 'ACCOUNTING_CHART_LOCKED');
  await assertNoAccountingWrite(state, session, beforeLockedChart, 'locked accounting chart');
  assert.equal((await requestJson(state, session, '/api/v1/pro/accounting/policy')).activeChart, 'SKR03');
  cases++;

  // 15. EÜR is explicitly calendar-year 2025 and fails closed for 2027.
  const before2027 = await counts(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/reports/eur', { from: '2027-01-01', to: '2027-12-31' }, undefined, 400, '2025');
  await assertNoAccountingWrite(state, session, before2027, '2027 EÜR fail closed');
  cases++;

  console.log(`PRO_NONHAPPY_CASES=${cases}`);
  assert.ok(cases >= 20, `expected at least 20 meaningful Pro non-happy cases, got ${cases}`);
};
