import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readServerHarnessState } from '../harness.mjs';
import {
  createHarnessProTenant,
  createOwnerCredentials,
  ensureHarnessSession,
  requestJson,
  seedHarnessProTenant,
  setHarnessProPeriodStatus,
} from './helpers.mjs';

const owner = createOwnerCredentials('pro');

const stableJson = (value) => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};

const snapshotHash = (snapshot) => createHash('sha256').update(stableJson(snapshot)).digest('hex');

const rawRequest = async (state, session, requestPath, query, options = {}) => {
  const url = new URL(requestPath, `${state.urls.api}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { accept: options.accept ?? 'application/json', authorization: `Bearer ${session.token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* binary/text response */ }
  return { response, body, text };
};

const expectError = async (state, session, path, query, options, status, pattern) => {
  const result = await rawRequest(state, session, path, query, options);
  assert.equal(result.response.status, status, `${path}: ${result.text}`);
  if (pattern) assert.match(String(result.body?.message ?? result.text), pattern);
  return result;
};

const json = async (state, session, path, query, options) => {
  const result = await rawRequest(state, session, path, query, options);
  assert.ok(result.response.ok, `${path}: ${result.response.status} ${result.text}`);
  return result.body;
};

const accountingState = async (state, session) => {
  const [runs, journal] = await Promise.all([
    requestJson(state, session, '/api/v1/pro/accounting/source-runs'),
    requestJson(state, session, '/api/v1/pro/accounting/journal'),
  ]);
  return { runs, journal };
};

const mapAccounts = async (state, session) => {
  for (const [role, accountNumber] of [
    ['accounts_receivable', '1200'],
    ['accounts_payable', '1200'],
    ['bank', '1200'],
    ['revenue', '8400'],
    ['output_vat', '1776'],
    ['expense', '3125'],
    ['input_vat', '1776'],
  ]) {
    await json(state, session, '/api/v1/pro/accounting/mappings', undefined, {
      method: 'POST',
      body: { reason: `source-run fixture mapping ${role}`, chart: 'SKR03', role, accountNumber },
    });
  }
  const rows = await requestJson(state, session, '/api/v1/pro/accounting/mappings', { chart: 'SKR03' });
  return Object.fromEntries(rows.map((row) => [row.role, row.accountNumber]));
};

const sourceFact = (namespace, id, overrides = {}) => ({
  sourceType: 'standalone_source',
  sourceId: id,
  sourceRevision: 'v1',
  effectiveDate: '2026-11-15',
  postingDate: '2026-11-15',
  period: '2026-11',
  fiscalYear: 2026,
  currency: 'EUR',
  bookingText: `E2E source fact ${namespace}`,
  lines: [
    { accountNumber: '1200', debitAmount: 100, creditAmount: 0 },
    { accountNumber: '8400', debitAmount: 0, creditAmount: 100 },
  ],
  ...overrides,
});

const closing = async (state, session, body) => json(state, session, '/api/v1/pro/accounting/closing', undefined, { method: 'POST', body });

const makeEurInvoiceAndPayment = async (state, session, namespace, client) => {
  const reservation = await json(state, session, '/api/v1/pro/numbers/reserve', undefined, { method: 'POST', body: { kind: 'invoice' } });
  const invoiceId = `${namespace}-eur-invoice`;
  const invoice = {
    kind: 'invoice', id: invoiceId, clientId: client.id, clientNumber: client.customerNumber,
    number: reservation.number, client: client.company, clientEmail: client.email, clientAddress: client.address,
    taxMode: 'standard_vat', taxSnapshot: { vatRateApplied: 19, vatAmount: 19, netAmount: 100, grossAmount: 119, einvoiceCategoryCode: 'S', vatBreakdown: [{ rate: 19, netAmount: 100, vatAmount: 19 }] },
    date: '2026-02-10', dueDate: '2026-02-20', servicePeriod: '2026-02', amount: 119, status: 'open', dunningLevel: 0,
    items: [{ description: 'EÜR 2026 source invoice', quantity: 1, price: 119, total: 119, taxRate: 19 }], payments: [], history: [],
  };
  await json(state, session, '/api/v1/pro/invoices', undefined, { method: 'POST', body: { reason: 'EÜR source invoice', invoice } });
  await json(state, session, '/api/v1/pro/numbers/finalize', undefined, { method: 'POST', body: { reservationId: reservation.reservationId, documentId: invoiceId } });
  await json(state, session, '/api/v1/pro/accounting/outgoing-invoices/post', undefined, { method: 'POST', body: { reason: 'EÜR source invoice post', invoiceId, reservationId: reservation.reservationId } });
  const openItems = await requestJson(state, session, '/api/v1/pro/accounting/open-items');
  const item = openItems.find((entry) => entry.sourceId === invoiceId);
  assert.ok(item?.id, 'EÜR source invoice open item missing');
  const payment = await json(state, session, '/api/v1/pro/accounting/open-items/payments', undefined, {
    method: 'POST',
    body: {
      reason: 'EÜR 2026 cash source payment',
      payment: {
        sourceType: 'manual', sourceId: `${namespace}-eur-payment`, partyType: 'debtor', partyId: client.id,
        paymentDate: '2026-02-20', amount: 119, bankAccountNumber: '1200', allocations: [{ openItemId: item.id, amount: 119 }],
        allocationEventId: `${namespace}-eur-payment-event`,
      },
    },
  });
  assert.ok(payment?.id, 'EÜR source payment missing');
  return { invoiceId, paymentId: payment.id };
};

const makePersistedIncomingInvoice = async (state, session, namespace) => {
  const vendorId = `${namespace}-correction-vendor`;
  const invoiceId = `${namespace}-correction-original`;
  await json(state, session, '/api/v1/pro/accounting/vendors', undefined, {
    method: 'POST',
    body: {
      reason: 'Persist correction original vendor',
      vendor: { id: vendorId, vendorNumber: `V-${namespace}`, name: 'Correction Original Vendor', email: `${namespace}@billme-e2e.local`, defaultExpenseAccount: '3125' },
    },
  });
  await json(state, session, '/api/v1/pro/accounting/incoming-invoices', undefined, {
    method: 'POST',
    body: {
      reason: 'Persist correction original invoice',
      invoice: {
        id: invoiceId, vendorId, number: `ER-${namespace}`, invoiceDate: '2026-10-01', dueDate: '2026-10-31',
        netAmount: 100, taxAmount: 19, grossAmount: 119, status: 'open', taxRate: 19, taxCaseKey: 'DE_STD_19',
        notes: 'Immutable correction source', accountingStatus: 'unposted',
        lines: [{ id: `${invoiceId}-line`, incomingInvoiceId: invoiceId, position: 0, description: 'Correction source service', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: '3125' }],
      },
    },
  });
  await json(state, session, '/api/v1/pro/accounting/incoming-invoices/post', undefined, {
    method: 'POST', body: { reason: 'Post correction original invoice', invoiceId },
  });
  const invoices = await requestJson(state, session, '/api/v1/pro/accounting/incoming-invoices');
  const original = invoices.find((invoice) => invoice.id === invoiceId);
  assert.ok(original?.accountingSnapshot, 'posted correction original snapshot missing');
  return { original, snapshot: original.accountingSnapshot };
};

export const runProSourceRunScenario = async () => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, { product: 'pro', ...owner });
  const namespace = `source-runs-${Date.now()}`;
  await seedHarnessProTenant(state, { tenantId: session.tenantId, namespace, includeEurCatalog2026: true });
  const mapped = await mapAccounts(state, session);

  let cases = 0;

  const firstFact = await closing(state, session, {
    command: 'source_fact', sourceId: `${namespace}-fact`, sourceRevision: 'v1', idempotencyKey: `${namespace}-fact-key`, reason: 'source fact posting',
    input: sourceFact(namespace, `${namespace}-fact`),
  });
  assert.equal(firstFact.replayed, false);
  assert.equal(firstFact.run.status, 'posted');
  assert.ok(firstFact.run.journalEntryId);
  cases++;

  const replayFact = await closing(state, session, {
    command: 'source_fact', sourceId: `${namespace}-fact`, sourceRevision: 'v1', idempotencyKey: `${namespace}-fact-key`, reason: 'source fact replay',
    input: sourceFact(namespace, `${namespace}-fact`),
  });
  assert.equal(replayFact.replayed, true);
  assert.equal(replayFact.run.id, firstFact.run.id);
  cases++;

  await expectError(state, session, '/api/v1/pro/accounting/closing', undefined, {
    method: 'POST', body: {
      command: 'source_fact', sourceId: `${namespace}-fact`, sourceRevision: 'v1', idempotencyKey: `${namespace}-fact-key`, reason: 'source fact conflict',
      input: sourceFact(namespace, `${namespace}-fact`, { lines: [{ accountNumber: '1200', debitAmount: 101, creditAmount: 0 }, { accountNumber: '8400', debitAmount: 0, creditAmount: 101 }] }),
    },
  }, 409, /SOURCE_RUN_CONFLICT/);
  cases++;

  const fiscal = await closing(state, session, {
    command: 'fiscal_close', sourceId: `${namespace}-close`, sourceRevision: 'v1', idempotencyKey: `${namespace}-close-key`, reason: 'fiscal close',
    input: { fiscalYear: 2026, period: '2026-12', closingDate: '2026-12-31', currency: 'EUR', revenueAccounts: ['8400'], expenseAccounts: ['3125'], retainedEarningsAccount: '1200', balances: [
      { accountNumber: '8400', openingBalance: 0, debitTurnover: 0, creditTurnover: 100, closingBalance: -100 },
      { accountNumber: '3125', openingBalance: 0, debitTurnover: 40, creditTurnover: 0, closingBalance: 40 },
    ] },
  });
  assert.equal(fiscal.run.status, 'posted');
  assert.equal(fiscal.result.result.netResult, 60);
  cases++;

  const provision = await closing(state, session, {
    command: 'provision', sourceId: `${namespace}-provision`, sourceRevision: 'v1', idempotencyKey: `${namespace}-provision-key`, reason: 'provision adjustment',
    input: { effectiveDate: '2026-12-31', period: '2026-12', fiscalYear: 2026, currency: 'EUR', previousAmount: 10, targetAmount: 12.5, expenseAccount: '3125', provisionAccount: '1776' },
  });
  assert.equal(provision.run.status, 'posted');
  cases++;

  const inventory = await closing(state, session, {
    command: 'inventory_closing', sourceId: `${namespace}-inventory`, sourceRevision: 'v1', idempotencyKey: `${namespace}-inventory-key`, reason: 'inventory closing',
    input: { effectiveDate: '2026-12-31', period: '2026-12', fiscalYear: 2026, currency: 'EUR', items: [{ id: 'sku-1', quantity: 2, unitCost: 10, unitMarketValue: 8, inventoryAccount: '1200', expenseAccount: '3125' }] },
  });
  assert.equal(inventory.run.status, 'posted');
  assert.equal(inventory.result.result.totalWriteDown, 4);
  cases++;

  const fx = await closing(state, session, {
    command: 'fx_valuation', sourceId: `${namespace}-fx`, sourceRevision: 'v1', idempotencyKey: `${namespace}-fx-key`, reason: 'FX valuation',
    input: { effectiveDate: '2026-12-31', period: '2026-12', fiscalYear: 2026, foreignCurrency: 'USD', functionalCurrency: 'EUR', foreignAmount: 100, closingRate: 0.95, carryingAmount: 90, position: 'asset', positionAccount: '1200', gainAccount: '8400', lossAccount: '3125' },
  });
  assert.equal(fx.run.status, 'posted');
  assert.equal(fx.result.result.difference, 5);
  cases++;

  const payroll = await closing(state, session, {
    command: 'payroll_batch', sourceId: `${namespace}-payroll`, sourceRevision: 'v1', idempotencyKey: `${namespace}-payroll-key`, reason: 'payroll control totals',
    input: { batchId: `${namespace}-payroll`, effectiveDate: '2026-11-30', period: '2026-11', fiscalYear: 2026, currency: 'EUR', lines: [{ employeeId: 'employee-1', gross: 1000, employeeTaxes: 200, otherDeductions: 50, net: 750 }] },
  });
  assert.equal(payroll.run.status, 'noop');
  assert.equal(payroll.result.result.status, 'valid');
  cases++;

  const correctionSource = await makePersistedIncomingInvoice(state, session, namespace);
  const missingOriginalBody = {
    id: `${namespace}-missing-correction`, idempotencyKey: `${namespace}-missing-correction-key`, correctionDate: '2026-11-20', taxEffectiveDate: '2026-10-01', documentType: 'incoming_invoice', postingDate: '2026-11-20', reason: 'Missing §17 original must fail',
    original: { documentId: `${namespace}-missing-original`, documentNumber: 'ER-MISSING', revision: 'missing-revision', snapshotHash: snapshotHash(correctionSource.snapshot), taxEffectiveDate: '2026-10-01', taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] },
    deltas: [{ rate: 19, grossAmount: 11.9 }],
  };
  await expectError(state, session, '/api/v1/pro/accounting/corrections', undefined, { method: 'POST', body: missingOriginalBody }, 400, /ORIGINAL_DOCUMENT_NOT_FOUND/);
  cases++;

  const correctionBody = {
    id: `${namespace}-correction`, idempotencyKey: `${namespace}-correction-key`, correctionDate: '2026-11-20', taxEffectiveDate: correctionSource.original.invoiceDate, documentType: 'incoming_invoice', postingDate: '2026-11-20', reason: '§17 invoice correction',
    original: { documentId: correctionSource.original.id, documentNumber: correctionSource.original.number, revision: correctionSource.snapshot.sourceVersion, snapshotHash: snapshotHash(correctionSource.snapshot), currentSnapshotHash: snapshotHash(correctionSource.snapshot), taxEffectiveDate: correctionSource.original.invoiceDate, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] },
    deltas: [{ rate: 19, grossAmount: 11.9 }],
  };
  const correction = await json(state, session, '/api/v1/pro/accounting/corrections', undefined, { method: 'POST', body: correctionBody });
  assert.equal(correction.replayed, false);
  assert.equal(correction.document.creditGrossAmount, 11.9);
  cases++;

  const correctionReplay = await json(state, session, '/api/v1/pro/accounting/corrections', undefined, { method: 'POST', body: correctionBody });
  assert.equal(correctionReplay.replayed, true);
  assert.equal(correctionReplay.run.id, correction.run.id);
  cases++;

  const beforeMissingSettlement = await accountingState(state, session);
  const missingSettlementId = `${namespace}-missing-settlement`;
  await expectError(state, session, '/api/v1/pro/accounting/closing', undefined, {
    method: 'POST', body: {
      commandType: 'bad_debt', sourceId: missingSettlementId, sourceRevision: 'v1', idempotencyKey: `${missingSettlementId}-key`, reason: 'Missing settlement original must fail',
      input: {
        sourceId: missingSettlementId, sourceRevision: 'v1', effectiveDate: '2026-11-20', postingDate: '2026-11-20', period: '2026-11', fiscalYear: 2026, currency: 'EUR',
        taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], writeOffGrossAmount: 119, badDebtExpenseAccount: mapped.expense,
        facts: { originalDocumentId: `${namespace}-missing-settlement-original`, originalDocumentNumber: 'ER-MISSING' },
      },
    }, }, 404, /ORIGINAL_DOCUMENT_NOT_FOUND/);
  assert.deepEqual(await accountingState(state, session), beforeMissingSettlement);
  cases++;

  const accrualId = `${namespace}-accrual-schedule`;
  const accrualBody = {
    command: 'accrual', sourceId: accrualId, sourceRevision: 'v1', idempotencyKey: `${accrualId}-key`, reason: 'Multi-period accrual',
    input: { sourceId: accrualId, sourceRevision: 'v1', startDate: '2026-01-15', endDate: '2026-03-15', period: '2026-01', fiscalYear: 2026, currency: 'EUR', totalAmount: 300, expenseAccount: mapped.expense, deferralAccount: mapped.accounts_payable },
  };
  const accrual = await closing(state, session, accrualBody);
  assert.equal(accrual.replayed, false);
  assert.equal(accrual.run.status, 'posted');
  assert.equal(accrual.result.journalEntryIds.length, 3);
  assert.equal(new Set(accrual.result.journalEntryIds).size, 3);
  const accrualReplay = await closing(state, session, accrualBody);
  assert.equal(accrualReplay.replayed, true);
  assert.deepEqual(accrualReplay.result.journalEntryIds, accrual.result.journalEntryIds);
  cases++;

  const loanId = `${namespace}-loan-schedule`;
  const loanBody = {
    command: 'loan_schedule', sourceId: loanId, sourceRevision: 'v1', idempotencyKey: `${loanId}-key`, reason: 'Multi-period loan',
    input: { sourceId: loanId, sourceRevision: 'v1', startDate: '2026-01-01', period: '2026-01', fiscalYear: 2026, currency: 'EUR', principal: 300, annualInterestRate: 0, termMonths: 3, liabilityAccount: mapped.accounts_payable, interestAccount: mapped.expense, cashAccount: mapped.bank },
  };
  const loan = await closing(state, session, loanBody);
  assert.equal(loan.replayed, false);
  assert.equal(loan.run.status, 'posted');
  assert.equal(loan.result.journalEntryIds.length, 3);
  assert.equal(new Set(loan.result.journalEntryIds).size, 3);
  const loanReplay = await closing(state, session, loanBody);
  assert.equal(loanReplay.replayed, true);
  assert.deepEqual(loanReplay.result.journalEntryIds, loan.result.journalEntryIds);
  cases++;

  await expectError(state, session, '/api/v1/pro/accounting/corrections', undefined, {
    method: 'POST', body: { ...correctionBody, id: `${namespace}-correction-conflict`, deltas: [{ rate: 19, grossAmount: 23.8 }] },
  }, 409, /SOURCE_RUN_CONFLICT|IDEMPOTENCY_CONFLICT/);
  cases++;

  const tenantBIdentity = { email: `${namespace}-other@billme-e2e.local`, fullName: 'Other Pro Tenant', password: owner.password };
  const tenantBFixture = await createHarnessProTenant(state, tenantBIdentity);
  await seedHarnessProTenant(state, { tenantId: tenantBFixture.tenantId, namespace: `${namespace}-other` });
  const tenantB = await ensureHarnessSession(state, { product: 'pro', ...tenantBIdentity });
  const hiddenRun = await rawRequest(state, tenantB, `/api/v1/pro/accounting/source-runs/${encodeURIComponent(firstFact.run.id)}`);
  assert.equal(hiddenRun.response.status, 404);
  const otherRuns = await requestJson(state, tenantB, '/api/v1/pro/accounting/source-runs');
  assert.equal(otherRuns.some((run) => run.id === firstFact.run.id), false);
  cases++;

  const closedId = `${namespace}-closed`;
  const beforeClosed = await accountingState(state, session);
  await setHarnessProPeriodStatus(state, { tenantId: session.tenantId, period: '2026-10', status: 'closed' });
  await expectError(state, session, '/api/v1/pro/accounting/closing', undefined, {
    method: 'POST', body: { command: 'source_fact', sourceId: closedId, sourceRevision: 'v1', idempotencyKey: `${closedId}-key`, reason: 'closed period must reject', input: sourceFact(namespace, closedId, { effectiveDate: '2026-10-15', postingDate: '2026-10-15', period: '2026-10' }) },
  }, 409, /POSTING_DATE_IN_CLOSED_PERIOD/);
  assert.deepEqual(await accountingState(state, session), beforeClosed);
  cases++;

  const softId = `${namespace}-soft`;
  await setHarnessProPeriodStatus(state, { tenantId: session.tenantId, period: '2026-09', status: 'soft_locked' });
  await expectError(state, session, '/api/v1/pro/accounting/closing', undefined, {
    method: 'POST', body: { command: 'source_fact', sourceId: softId, sourceRevision: 'v1', idempotencyKey: `${softId}-key`, reason: 'soft period must reject', input: sourceFact(namespace, softId, { effectiveDate: '2026-09-15', postingDate: '2026-09-15', period: '2026-09' }) },
  }, 409, /SOFT_LOCK/);
  cases++;
  const softOverride = await closing(state, session, {
    command: 'source_fact', sourceId: softId, sourceRevision: 'v1', idempotencyKey: `${softId}-override-key`, reason: 'approved soft period override', softLockOverride: true, overrideReason: 'Controller approved soft-lock override',
    input: sourceFact(namespace, softId, { effectiveDate: '2026-09-15', postingDate: '2026-09-15', period: '2026-09' }),
  });
  assert.equal(softOverride.run.status, 'posted');
  cases++;
  await setHarnessProPeriodStatus(state, { tenantId: session.tenantId, period: '2026-10', status: 'open' });
  await setHarnessProPeriodStatus(state, { tenantId: session.tenantId, period: '2026-09', status: 'open' });

  for (const [label, input, pattern] of [
    ['invalid', sourceFact(namespace, `${namespace}-invalid`, { postingDate: '2026-13-01', effectiveDate: '2026-13-01', period: '2026-13' }), /INVALID_PERIOD|INVALID_DATE|Invalid date/i],
    ['unbalanced', sourceFact(namespace, `${namespace}-unbalanced`, { lines: [{ accountNumber: '1200', debitAmount: 100, creditAmount: 0 }, { accountNumber: '8400', debitAmount: 0, creditAmount: 99 }] }), /CLOSING_COMMAND_REJECTED|UNBALANCED_ENTRY|Debit and credit/i],
    ['unknown-account', sourceFact(namespace, `${namespace}-unknown`, { lines: [{ accountNumber: '9999', debitAmount: 100, creditAmount: 0 }, { accountNumber: '8400', debitAmount: 0, creditAmount: 100 }] }), /UNKNOWN_ACCOUNT/],
  ]) {
    const before = await accountingState(state, session);
    await expectError(state, session, '/api/v1/pro/accounting/closing', undefined, {
      method: 'POST', body: { command: 'source_fact', sourceId: input.sourceId, sourceRevision: 'v1', idempotencyKey: `${input.sourceId}-key`, reason: `${label} atomic rollback`, input },
    }, label === 'unknown-account' ? 409 : 400, pattern);
    assert.deepEqual(await accountingState(state, session), before, `${label} source changed public state`);
    cases++;
  }

  const taxEntries = [{ postingDate: '2025-01-15', status: 'posted', lines: [{ taxCaseKey: 'DE_STD_19', direction: 'output', netAmount: 100, taxAmount: 19, grossAmount: 119, taxRate: 19 }] }];
  const ustvaBody = { kind: 'ustva', period: '2025-01', idempotencyKey: `${namespace}-ustva-key`, reason: 'UStVA preparation', entries: taxEntries };
  const ustva = await json(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, { method: 'POST', body: ustvaBody });
  assert.equal(ustva.artifact.kind, 'ustva');
  assert.equal(ustva.artifact.rows[0].taxCaseKey, 'DE_STD_19');
  cases++;
  const ustvaRefetched = await json(state, session, `/api/v1/pro/accounting/tax-exports/ustva/${encodeURIComponent(ustva.run.id)}`);
  assert.equal(ustvaRefetched.sourceHash, ustva.artifact.sourceHash);
  const ustvaExport = await rawRequest(state, session, `/api/v1/pro/accounting/tax-exports/ustva/${encodeURIComponent(ustva.run.id)}/export`);
  assert.equal(ustvaExport.response.status, 200);
  assert.match(ustvaExport.text, /"kind":"ustva"/);
  cases++;
  const ustvaReplay = await json(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, { method: 'POST', body: ustvaBody });
  assert.equal(ustvaReplay.replayed, true);
  cases++;
  await expectError(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, {
    method: 'POST', body: { ...ustvaBody, entries: [{ ...taxEntries[0], lines: [{ ...taxEntries[0].lines[0], netAmount: 101, grossAmount: 120.19 }] }] },
  }, 409, /SOURCE_RUN_CONFLICT/);
  cases++;

  const emptyZm = await json(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, { method: 'POST', body: {
    kind: 'zm', period: '2025-02', idempotencyKey: `${namespace}-zm-empty-key`, reason: 'Empty ZM preparation', entries: [],
  } });
  assert.equal(emptyZm.artifact.status, 'prepared');
  assert.deepEqual(emptyZm.artifact.rows, []);
  assert.notEqual(emptyZm.run.id, ustva.run.id);
  cases++;

  const zm = await json(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, { method: 'POST', body: {
    kind: 'zm', period: '2025-01', idempotencyKey: `${namespace}-zm-key`, reason: 'ZM evidence preparation', entries: [{ postingDate: '2025-01-02', status: 'posted', lines: [{ taxCaseKey: 'EU_B2B_SERVICE_RC', netAmount: 100, countryCode: 'FR', counterpartyVatId: 'FR12345678901', evidenceType: 'transport', evidenceReference: 'CMR-2025-1' }] }],
  } });
  assert.equal(zm.artifact.rows[0].counterpartyVatId, 'FR12345678901');
  cases++;
  const oss = await json(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, { method: 'POST', body: {
    kind: 'oss', period: '2025-01', idempotencyKey: `${namespace}-oss-key`, reason: 'OSS preparation', entries: [{ postingDate: '2025-01-03', status: 'posted', lines: [{ taxCaseKey: 'EU_B2C_OSS', netAmount: 50, taxAmount: 10, taxRate: 20, countryCode: 'AT' }] }],
  } });
  assert.equal(oss.artifact.rows[0].countryCode, 'AT');
  cases++;
  const beforeMissingEvidence = await accountingState(state, session);
  await expectError(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, { method: 'POST', body: {
    kind: 'zm', period: '2025-01', idempotencyKey: `${namespace}-zm-missing-evidence`, reason: 'ZM missing evidence', entries: [{ postingDate: '2025-01-02', status: 'posted', lines: [{ taxCaseKey: 'EU_B2B_SERVICE_RC', netAmount: 100, countryCode: 'FR', counterpartyVatId: 'FR12345678901' }] }],
  } }, 422, /MISSING_EVIDENCE/);
  assert.deepEqual(await accountingState(state, session), beforeMissingEvidence);
  cases++;
  await expectError(state, session, '/api/v1/pro/accounting/tax-exports/prepare', undefined, { method: 'POST', body: {
    kind: 'oss', period: '2025-01', idempotencyKey: `${namespace}-oss-invalid-country`, reason: 'OSS invalid country', entries: [{ postingDate: '2025-01-03', status: 'posted', lines: [{ taxCaseKey: 'EU_B2C_OSS', netAmount: 50, taxAmount: 10, taxRate: 20, countryCode: 'XX' }] }],
  } }, 422, /INVALID_COUNTRY/);
  cases++;

  const clients = await requestJson(state, session, '/api/v1/pro/clients');
  const client = clients.find((entry) => entry.id === `${namespace}-client-beta`);
  assert.ok(client?.id, 'EÜR source client missing');
  const eurSource = await makeEurInvoiceAndPayment(state, session, namespace, client);
  const currentSettings = await requestJson(state, session, '/api/v1/pro/settings');
  await json(state, session, '/api/v1/pro/settings', undefined, { method: 'PUT', body: { settings: { ...currentSettings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'soll' } } } });
  const eurItems = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/items', { taxYear: 2026 });
  const incomeItem = eurItems.find((item) => item.sourceId.includes(`payment:${eurSource.paymentId}:allocation`));
  const expenseItem = eurItems.find((item) => item.sourceId === `${namespace}-workflow-transaction`);
  assert.ok(incomeItem?.sourceId && expenseItem?.sourceId, '2026 EÜR cash sources missing');
  for (const item of eurItems) {
    await json(state, session, '/api/v1/pro/accounting/reports/eur/classifications', undefined, {
      method: 'PUT',
      body: {
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        taxYear: 2026,
        eurLineId: item.flowType === 'income' ? 'E2026_KZ112' : 'E2026_KZ280',
        reason: 'EÜR 2026 source classification',
      },
    });
  }
  cases++;

  const incomeFact = await json(state, session, '/api/v1/pro/accounting/reports/eur/facts/cash', undefined, { method: 'POST', body: {
    sourceType: 'transaction', sourceId: incomeItem.sourceId, taxYear: 2026, kind: 'income', flowType: 'income', amountNet: 100, eurLineId: 'E2026_KZ112', idempotencyKey: `${namespace}-eur-income-key`, reason: 'EÜR 2026 income fact',
  } });
  assert.equal(incomeFact.provenance.catalogId, 'anlage-euer-2026');
  cases++;
  const expenseFact = await json(state, session, '/api/v1/pro/accounting/reports/eur/facts/cash', undefined, { method: 'POST', body: {
    sourceType: 'transaction', sourceId: expenseItem.sourceId, taxYear: 2026, kind: 'expense', flowType: 'expense', amountNet: 100, eurLineId: 'E2026_KZ280', splits: [
      { amountNet: 60, deductibility: 'deductible', lineId: 'E2026_KZ280', reason: 'telecom deductible split' },
      { amountNet: 40, deductibility: 'non-deductible', reason: 'private share excluded' },
    ], idempotencyKey: `${namespace}-eur-expense-key`, reason: 'EÜR 2026 expense split',
  } });
  assert.equal(expenseFact.splits.length, 2);
  const eurFacts = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/facts/cash', { taxYear: 2026 });
  assert.ok(eurFacts.some((fact) => fact.id === incomeFact.id) && eurFacts.some((fact) => fact.id === expenseFact.id));
  cases++;

  const annexFact = await json(state, session, '/api/v1/pro/accounting/reports/eur/facts/annex', undefined, { method: 'POST', body: {
    taxYear: 2026, annex: 'AVEÜR', lineId: 'AVEÜR_2026_GB_100', amount: 250, sourceId: expenseItem.sourceId, date: '2026-03-05', idempotencyKey: `${namespace}-eur-annex-key`, reason: 'EÜR AVEÜR fact',
  } });
  const annexFacts = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/facts/annex', { taxYear: 2026, annex: 'AVEÜR' });
  assert.ok(annexFacts.some((fact) => fact.id === annexFact.id && fact.lineId === 'AVEÜR_2026_GB_100'));
  cases++;

  const eurReport = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur', { taxYear: 2026 });
  assert.equal(eurReport.catalog.elsterReady, false);
  assert.equal(eurReport.unclassifiedCount, 0);
  const eurSnapshot = await json(state, session, '/api/v1/pro/accounting/reports/snapshots', undefined, { method: 'POST', body: { reportType: 'eur', taxYear: 2026, from: '2026-01-01', to: '2026-12-31', reason: 'EÜR 2026 immutable snapshot' } });
  assert.equal(eurSnapshot.taxYear, 2026);
  cases++;

  const genericSnapshot = await json(state, session, '/api/v1/pro/accounting/reports/snapshots', undefined, { method: 'POST', body: { reportType: 'susa', from: '2026-01-01', to: '2026-12-31', reason: 'official filing negative-path source snapshot' } });
  assert.equal(genericSnapshot.reportType, 'susa');
  cases++;
  const filing = await json(state, session, '/api/v1/pro/tax-filings', undefined, { method: 'POST', body: {
    kind: 'euer', periodStart: '2025-01-01', periodEnd: '2025-12-31', idempotencyKey: `${namespace}-unsupported-elster`, reason: 'official EÜR submission must fail closed', payload: { taxYear: 2025, reportSnapshotId: genericSnapshot.id, sourceSnapshotHash: genericSnapshot.sourceHash },
  } });
  await expectError(state, session, `/api/v1/pro/tax-filings/${encodeURIComponent(filing.id)}/validate`, undefined, { method: 'POST', body: { reason: 'official EÜR provider unavailable', idempotencyKey: `${namespace}-unsupported-elster-validate` } }, 422, /EÜR|ELSTER|provider/i);
  cases++;

  assert.equal(cases, 38, `expected exactly 38 Pro source-run/tax/EÜR cases, got ${cases}`);
  console.log(`PRO_SOURCE_RUN_CASES=${cases}`);
};
