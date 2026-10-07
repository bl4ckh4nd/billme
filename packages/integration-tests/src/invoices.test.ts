import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { calculateInvoiceTaxSnapshot } from '@billme/server-core';
import { PRODUCTS, startProduct, type LiteHarness } from './harness.js';
import { addDays, asSmallBusiness, datevEvidence, draftInvoice, draftOffer, issueInvoice, today, type DocumentInput } from './fixtures.js';

/**
 * Invoices end to end through the Lite desktop backend.
 *
 * How this can fail (each one has a test below):
 * - numbers: duplicates, gaps on issue, a released number not handed out
 *   again, concurrent reservations colliding, a reservation reused for another
 *   document, the year placeholder not expanded
 * - issuing: a draft issued without a number, a direct jump draft → paid
 * - §14 UStG at issue: an invoice issued without the buyer's address, without
 *   the seller's address or tax number, without a priced line, due before it is
 *   dated, as reverse charge without both VAT IDs, or as Kleinunternehmer by a
 *   tenant that is not one; a Kleinunternehmer's invoice showing VAT because the
 *   editor sent the default mode; no service date on the stored invoice; a
 *   refused issue still consuming an invoice number
 * - immutability: an issued invoice's content, number or tax changed in place,
 *   an issued invoice set back to draft
 * - tax: the snapshot (net/VAT/gross per rate) lost or altered on save; mixed
 *   rates, Kleinunternehmer and reverse charge carried through unchanged
 * - payments: draft invoices taking payments, partial vs. full vs. over
 *   payment status, stale `expectedPayment`, removal reopening the invoice,
 *   bank payments edited outside the bank matching
 * - corrections: credit note / cancellation numbering and status of the source,
 *   revisions of paid invoices
 * - audit: create/update/payment not logged, hash chain broken
 * - persistence: data gone after the app restarts
 * - validation: missing reason, bad item kind, unknown id
 */
for (const product of PRODUCTS) describe(`invoices (${product})`, () => {
  let h: LiteHarness;
  before(async () => { h = await startProduct(product, null, 'invoices'); });
  after(async () => { await h.close(); });

  describe('numbering', () => {
    test('reserved numbers are sequential, year-expanded and unique under concurrency', async () => {
      const year = new Date().getFullYear();
      const reservations = await Promise.all(Array.from({ length: 8 }, () => h.api.numbers.reserve({ kind: 'invoice' })));
      const numbers = reservations.map((r) => r.number);
      assert.equal(new Set(numbers).size, numbers.length, `duplicate numbers: ${numbers}`);
      for (const n of numbers) assert.match(n, new RegExp(`^RE-${year}-\\d{3}$`));
      const sequence = numbers.map((n) => Number(n.split('-').at(-1))).sort((a, b) => a - b);
      assert.deepEqual(sequence, sequence.map((_, i) => sequence[0]! + i), 'reservations leave no gaps');
      await Promise.all(reservations.map((r) => h.api.numbers.release({ reservationId: r.reservationId })));
    });

    test('a released number is handed out again, so cancelled drafts leave no gap', async () => {
      const first = await h.api.numbers.reserve({ kind: 'invoice' });
      await h.api.numbers.release({ reservationId: first.reservationId });
      const second = await h.api.numbers.reserve({ kind: 'invoice' });
      assert.equal(second.number, first.number);
      await h.api.numbers.release({ reservationId: second.reservationId });
    });

    test('issued invoices get consecutive numbers and offers count separately', async () => {
      const a = await issueInvoice(h.api, { client: 'Seq A' });
      const offerNo = await h.api.numbers.reserve({ kind: 'offer' });
      const b = await issueInvoice(h.api, { client: 'Seq B' });
      const n = (x: string) => Number(x.split('-').at(-1));
      assert.equal(n(b.number), n(a.number) + 1);
      assert.match(offerNo.number, /^ANG-/);
      await h.api.numbers.release({ reservationId: offerNo.reservationId });
    });

    test('a reservation cannot be reused for a second document', async () => {
      const draft = await draftInvoice(h.api, { client: 'Reservation owner' });
      const thief = { ...draft, id: randomUUID() };
      const response = await h.raw('POST', '/invoices', { reason: 'steal', reservationId: draft.numberReservationId, invoice: { ...thief, kind: 'invoice' } });
      assert.equal(response.status, 409, response.text);
    });

    test('issuing a draft without its own reservation draws the next free number', async () => {
      const id = randomUUID();
      const settings = await h.api.settings.get();
      const items = [{ kind: 'item' as const, description: 'Ohne Reservierung', quantity: 1, price: 50, total: 50 }];
      const taxSnapshot = calculateInvoiceTaxSnapshot({ items, taxMode: 'standard_vat' }, settings!);
      const saved = await h.api.invoices.upsert({ reason: 'create', invoice: {
        id, number: 'ENTWURF', client: 'No reservation', clientEmail: '', clientAddress: 'Hauptstraße 1\n10115 Berlin', date: today(), dueDate: today(),
        amount: taxSnapshot.grossAmount, status: 'open', items, payments: [], history: [], taxMode: 'standard_vat', taxSnapshot,
      } });
      assert.match(saved.number, /^RE-\d{4}-\d{3}$/);
    });
  });

  describe('issuing and immutability', () => {
    test('a draft stays editable, then issuing freezes the content', async () => {
      const draft = await draftInvoice(h.api, { client: 'Freeze GmbH' });
      const edited = await h.api.invoices.upsert({ reason: 'edit draft', invoice: { ...draft, client: 'Freeze GmbH & Co. KG' } });
      assert.equal(edited.client, 'Freeze GmbH & Co. KG');

      const open = await h.api.invoices.upsert({ reason: 'issue', invoice: { ...edited, status: 'open' } });
      assert.equal(open.status, 'open');
      assert.equal(open.number, draft.number);

      await assert.rejects(h.api.invoices.upsert({ reason: 'change price', invoice: { ...open, items: [{ ...open.items[0]!, price: 1, total: 1 }] } }), /unverändert/);
      await assert.rejects(h.api.invoices.upsert({ reason: 'renumber', invoice: { ...open, number: 'RE-HACK' } }), /unverändert/);
      await assert.rejects(h.api.invoices.upsert({ reason: 'back to draft', invoice: { ...open, status: 'draft' } }), /unverändert/);
      await assert.rejects(h.api.invoices.upsert({ reason: 'change tax', invoice: { ...open, taxMode: 'small_business_19_ustg' } }), /unverändert/);

      const stored = (await h.api.invoices.list()).find((i) => i.id === open.id)!;
      assert.equal(stored.client, 'Freeze GmbH & Co. KG');
      assert.equal(stored.items[0]!.price, 100);
    });

    test('a draft cannot jump straight to paid', async () => {
      const draft = await draftInvoice(h.api, { client: 'Jump' });
      await assert.rejects(h.api.invoices.upsert({ reason: 'paid', invoice: { ...draft, status: 'paid' } }), /Entwurf muss zuerst/);
    });

    test('a client-side status of an issued invoice is ignored; payments decide it', async () => {
      const open = await issueInvoice(h.api, { client: 'Status forge' });
      const forged = await h.api.invoices.upsert({ reason: 'forge paid', invoice: { ...open, status: 'paid' } });
      assert.equal(forged.status, 'open');
    });

    test('an issued invoice is not deletable', async () => {
      const open = await issueInvoice(h.api, { client: 'Delete me' });
      await assert.rejects(h.api.invoices.delete({ id: open.id, reason: 'delete issued' }));
    });

    test('a draft is deletable and the deletion is audited', async () => {
      const draft = await draftInvoice(h.api, { client: 'Disposable' });
      await h.api.invoices.delete({ id: draft.id, reason: 'Entwurf verworfen' });
      assert.ok(!(await h.api.invoices.list()).some((i) => i.id === draft.id));
      const csv = await h.api.audit.exportCsv();
      assert.ok(csv.includes('invoice.delete') && csv.includes('Entwurf verworfen'));
    });
  });

  const withSettings = async (patch: (s: NonNullable<Awaited<ReturnType<typeof h.api.settings.get>>>) => object, body: () => Promise<void>) => {
    const settings = (await h.api.settings.get())!;
    await h.api.settings.set({ settings: patch(settings) as never });
    // Restore everything but the number counters, which `body` may have advanced.
    try { await body(); } finally { await h.api.settings.set({ settings: { ...settings, numbers: (await h.api.settings.get())!.numbers } }); }
  };

  type Draft = Awaited<ReturnType<typeof draftInvoice>>;
  describe('issuing enforces §14 UStG', () => {
    const issue = (draft: Draft, patch: Partial<Draft> = {}) =>
      h.raw('POST', '/invoices', { reason: 'Rechnung gestellt', invoice: { ...draft, ...patch, kind: 'invoice', status: 'open' } });
    const nextNumber = async () => {
      const probe = await h.api.numbers.reserve({ kind: 'invoice' });
      await h.api.numbers.release({ reservationId: probe.reservationId });
      return probe.number;
    };

    test('a draft may be incomplete; issuing it names every missing Pflichtangabe', async () => {
      const draft = await h.api.invoices.upsert({ reason: 'create', invoice: { ...(await draftInvoice(h.api, { client: 'Lückenhaft' })), clientAddress: '', items: [{ kind: 'text', description: 'Nur Text', quantity: 0, price: 0, total: 0 }], dueDate: addDays(today(), -1) } });
      assert.equal(draft.status, 'draft', 'drafts are not checked');
      const response = await issue(draft);
      assert.equal(response.status, 422, response.text);
      assert.match(response.text, /Anschrift des Kunden/);
      assert.match(response.text, /Position mit Betrag/);
      assert.match(response.text, /Fälligkeitsdatum liegt vor dem Rechnungsdatum/);
      const stored = (await h.api.invoices.list()).find((i) => i.id === draft.id)!;
      assert.equal(stored.status, 'draft', 'the refused draft stays a draft');
    });

    test('a structured billing address counts as the buyer address', async () => {
      const draft = await draftInvoice(h.api, { client: 'Strukturiert' });
      const open = await h.api.invoices.upsert({ reason: 'issue', invoice: { ...draft, clientAddress: '', billingAddressJson: { company: 'Strukturiert', street: 'Ring 2', zip: '20095', city: 'Hamburg', country: 'DE' }, status: 'open' } });
      assert.equal(open.status, 'open');
    });

    test('a seller without address or tax number cannot issue', async () => {
      const draft = await draftInvoice(h.api, { client: 'Kunde ohne Gegenüber' });
      await withSettings((s) => ({ ...s, company: { ...s.company, street: '' }, finance: { ...s.finance, taxId: '', vatId: '' } }), async () => {
        const before = await nextNumber();
        const response = await issue(draft, { number: 'ENTWURF', numberReservationId: undefined } as never);
        assert.equal(response.status, 422, response.text);
        assert.match(response.text, /Anschrift deines Unternehmens/);
        assert.match(response.text, /Steuernummer oder USt-IdNr\./);
        assert.equal(await nextNumber(), before, 'a refused issue consumes no invoice number');
      });
    });

    test('reverse charge needs the buyer VAT ID; an intra-EU service also the seller VAT ID (§14a)', async () => {
      const draft = await draftInvoice(h.api, { client: 'Bau GmbH', taxMode: 'reverse_charge_13b', taxMeta: datevEvidence(product) as never, items: [{ kind: 'item', description: 'Bauleistung', quantity: 1, price: 1000, total: 1000 }] });
      const response = await issue(draft);
      assert.equal(response.status, 422, response.text);
      assert.match(response.text, /USt-IdNr\. des Kunden fehlt/);
      const eu = await draftInvoice(h.api, { client: 'Wien GmbH', taxMode: 'intra_eu_service_reverse_charge', taxMeta: { ...datevEvidence(product), buyerVatId: 'ATU12345678' } as never, items: [{ kind: 'item', description: 'Beratung', quantity: 1, price: 1000, total: 1000 }] });
      await withSettings((s) => ({ ...s, finance: { ...s.finance, vatId: '' } }), async () => {
        const domestic = await issue(draft, { taxMeta: { ...draft.taxMeta, buyerVatId: 'DE987654321' } });
        assert.equal(domestic.status, 200, `a domestic §13b invoice needs only the tax number: ${domestic.text}`);
        const missingOwn = await issue(eu);
        assert.equal(missingOwn.status, 422, missingOwn.text);
        assert.match(missingOwn.text, /deine USt-IdNr\. fehlt/);
      });
    });

    test('only a Kleinunternehmer may issue under §19, and the default mode becomes §19 for one', async () => {
      const ku = await draftInvoice(h.api, { client: 'Kein KU', taxMode: 'small_business_19_ustg', taxMeta: datevEvidence(product) as never });
      const refused = await issue(ku);
      assert.equal(refused.status, 422, refused.text);
      assert.match(refused.text, /Kleinunternehmerregelung ist in den Einstellungen nicht aktiv/);

      await asSmallBusiness(h.api, async () => {
        // The editor sends the schema default; for a Kleinunternehmer that must never put VAT on the invoice (§14c UStG).
        const draft = await draftInvoice(h.api, { client: 'KU-Kunde', taxMeta: datevEvidence(product) as never, items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 500, total: 500, taxRate: 19 }] });
        const open = await h.api.invoices.upsert({ reason: 'issue', invoice: { ...draft, status: 'open' } });
        assert.equal(open.taxMode, 'small_business_19_ustg');
        assert.equal(open.taxSnapshot!.vatAmount, 0);
        assert.equal(open.amount, 500);
        assert.match(open.taxSnapshot!.taxNotice ?? '', /19/);
      });
    });

    test('an invoice without service date is stored with the invoice date', async () => {
      const draft = await draftInvoice(h.api, { client: 'Ohne Leistungsdatum' });
      const open = await h.api.invoices.upsert({ reason: 'issue', invoice: { ...draft, servicePeriod: '', status: 'open' } });
      assert.equal(open.servicePeriod, draft.date);
      const dated = await draftInvoice(h.api, { client: 'Mit Leistungsdatum' });
      const kept = await h.api.invoices.upsert({ reason: 'issue', invoice: { ...dated, servicePeriod: '01.03.2026 bis 31.03.2026', status: 'open' } });
      assert.equal(kept.servicePeriod, '01.03.2026 bis 31.03.2026');
    });

    test('a final invoice for an order without buyer address is refused and consumes no number', async () => {
      const offer = await draftOffer(h.api, { client: 'Auftrag ohne Anschrift' });
      const accepted = await h.api.offers.upsert({ reason: 'accept', offer: { ...offer, clientAddress: '', status: 'accepted' } } as never);
      const order = await h.api.documents.chainIssue({ id: randomUUID(), operation: 'order_confirmation', offerId: accepted.id, date: today(), reason: 'AB' } as never);
      const before = await nextNumber();
      const response = await h.raw('POST', '/document-chain/issue', { id: randomUUID(), operation: 'settlement_invoice', kind: 'final_invoice', amount: 238, orderId: (order as { id: string }).id, date: today(), reason: 'Schluss' });
      assert.equal(response.status, 422, response.text);
      assert.match(response.text, /Anschrift des Kunden/);
      assert.equal(await nextNumber(), before);
    });
  });

  describe('tax', () => {
    const roundTrip = async (taxMode: DocumentInput['taxMode'], items: DocumentInput['items'], taxMeta?: DocumentInput['taxMeta']) => {
      const issued = await issueInvoice(h.api, { client: `Tax ${taxMode}`, taxMode, items, taxMeta: taxMode === 'standard_vat' ? taxMeta : { ...taxMeta, ...datevEvidence(product) } as never });
      const stored = (await h.api.invoices.list()).find((i) => i.id === issued.id)!;
      return { issued, stored };
    };

    test('standard VAT with mixed 19 % and 7 % keeps a per-rate breakdown', async () => {
      const { stored } = await roundTrip('standard_vat', [
        { kind: 'item', description: 'Beratung', quantity: 3, price: 99.99, total: 299.97, taxRate: 19 },
        { kind: 'item', description: 'Buch', quantity: 1, price: 20, total: 20, taxRate: 7 },
      ]);
      const snap = stored.taxSnapshot!;
      assert.equal(snap.netAmount, 319.97);
      assert.equal(snap.vatAmount, 56.99 + 1.4);
      assert.equal(snap.grossAmount, 378.36);
      assert.equal(stored.amount, 378.36);
      assert.deepEqual(snap.vatBreakdown?.map((b) => [b.rate, b.netAmount, b.vatAmount]).sort(), [[19, 299.97, 56.99], [7, 20, 1.4]].sort());
      assert.equal(snap.einvoiceCategoryCode, 'S');
    });

    test('Kleinunternehmer invoices carry no VAT and the §19 notice', async () => {
      await asSmallBusiness(h.api, async () => {
        const { stored } = await roundTrip('small_business_19_ustg', [{ kind: 'item', description: 'Leistung', quantity: 1, price: 500, total: 500, taxRate: 19 }]);
        assert.equal(stored.taxSnapshot!.vatAmount, 0);
        assert.equal(stored.taxSnapshot!.grossAmount, 500);
        assert.match(stored.taxSnapshot!.taxNotice ?? '', /19/);
      });
    });

    test('reverse charge keeps the buyer VAT ID and category AE', async () => {
      const { stored } = await roundTrip('reverse_charge_13b', [{ kind: 'item', description: 'Bauleistung', quantity: 1, price: 1000, total: 1000 }], { buyerVatId: 'ATU12345678' });
      assert.equal(stored.taxSnapshot!.vatAmount, 0);
      assert.equal(stored.taxSnapshot!.einvoiceCategoryCode, 'AE');
      assert.equal(stored.taxMeta?.buyerVatId, 'ATU12345678');
    });

    test('discounts reduce the totals; text and optional lines are not billed', async () => {
      const { stored } = await roundTrip('standard_vat', [
        { kind: 'item', description: 'Arbeit', quantity: 10, price: 80, total: 800 },
        { kind: 'optional', description: 'Option, nicht beauftragt', quantity: 1, price: 200, total: 200 },
        { kind: 'text', description: 'Hinweis ohne Betrag', quantity: 0, price: 0, total: 0 },
        { kind: 'item', description: 'Rabatt', quantity: 1, price: -80, total: -80 },
      ]);
      assert.equal(stored.taxSnapshot!.netAmount, 720);
      assert.equal(stored.taxSnapshot!.vatAmount, 136.8);
      assert.equal(stored.taxSnapshot!.grossAmount, 856.8);
      assert.equal(stored.items.length, 4, 'all lines are kept for the printed document');
    });

    test('the server keeps the amount consistent with the tax snapshot', async () => {
      const draft = await draftInvoice(h.api, { client: 'Wrong total' });
      const saved = await h.api.invoices.upsert({ reason: 'tamper total', invoice: { ...draft, amount: 1 } });
      assert.equal(saved.amount, draft.taxSnapshot!.grossAmount);
    });
  });

  describe('payments', () => {
    test('partial, full and removed payments move the status open → paid → open', async () => {
      const open = await issueInvoice(h.api, { client: 'Payer' });
      const gross = open.amount;
      const p1 = { id: randomUUID(), date: today(), amount: 50, method: 'bank' };
      const partly = await h.api.invoices.savePayment({ invoiceId: open.id, payment: p1, reason: 'Teilzahlung' });
      assert.equal(partly.status, 'open');
      const p2 = { id: randomUUID(), date: today(), amount: Math.round((gross - 50) * 100) / 100, method: 'bank' };
      const paid = await h.api.invoices.savePayment({ invoiceId: open.id, payment: p2, reason: 'Restzahlung' });
      assert.equal(paid.status, 'paid');
      assert.equal(paid.payments.length, 2);
      const reopened = await h.api.invoices.removePayment({ invoiceId: open.id, expectedPayment: p2, reason: 'Rückbuchung' });
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.payments.length, 1);
    });

    test('overpayment settles the invoice as paid', async () => {
      const open = await issueInvoice(h.api, { client: 'Overpayer' });
      const paid = await h.api.invoices.savePayment({ invoiceId: open.id, payment: { id: randomUUID(), date: today(), amount: open.amount + 10, method: 'bank' }, reason: 'Überzahlung' });
      assert.equal(paid.status, 'paid');
    });

    test('a draft takes no payments', async () => {
      const draft = await draftInvoice(h.api, { client: 'Draft payer' });
      await assert.rejects(h.api.invoices.savePayment({ invoiceId: draft.id, payment: { id: randomUUID(), date: today(), amount: 10, method: 'bank' }, reason: 'zu früh' }), /gestellte/);
    });

    test('editing a payment needs the current state (optimistic concurrency)', async () => {
      const open = await issueInvoice(h.api, { client: 'Concurrent payer' });
      const payment = { id: randomUUID(), date: today(), amount: 20, method: 'bank' };
      await h.api.invoices.savePayment({ invoiceId: open.id, payment, reason: 'erste' });
      await assert.rejects(
        h.api.invoices.savePayment({ invoiceId: open.id, payment: { ...payment, amount: 30 }, expectedPayment: { ...payment, amount: 99 }, reason: 'veraltet' }),
        /inzwischen geändert/,
      );
      const updated = await h.api.invoices.savePayment({ invoiceId: open.id, payment: { ...payment, amount: 30 }, expectedPayment: payment, reason: 'korrigiert' });
      assert.equal(updated.payments[0]!.amount, 30);
      const again = await h.api.invoices.savePayment({ invoiceId: open.id, payment: { ...payment, amount: 30 }, expectedPayment: { ...payment, amount: 30 }, reason: 'idempotent' });
      assert.equal(again.payments.length, 1);
    });

    test('bank payments can only be changed in the bank matching', async () => {
      const open = await issueInvoice(h.api, { client: 'Bank payer' });
      await assert.rejects(
        h.api.invoices.savePayment({ invoiceId: open.id, payment: { id: 'tx:forged', date: today(), amount: 5, method: 'bank' }, reason: 'forge' }),
        /Bankabgleich/,
      );
    });

    test('payments on an unknown invoice return 404', async () => {
      await assert.rejects(h.api.invoices.savePayment({ invoiceId: 'nope', payment: { id: randomUUID(), date: today(), amount: 1, method: 'bank' }, reason: 'x' }), /nicht gefunden/);
    });

    test('an issued invoice keeps its payments when the client resends it without them', async () => {
      const open = await issueInvoice(h.api, { client: 'Keep payments' });
      await h.api.invoices.savePayment({ invoiceId: open.id, payment: { id: randomUUID(), date: today(), amount: 5, method: 'cash' }, reason: 'bar' });
      const resent = await h.api.invoices.upsert({ reason: 'resend', invoice: { ...open, payments: [] } });
      assert.equal(resent.payments.length, 1);
    });
  });

  describe('corrections', () => {
    test('a cancellation invoice gets its own number and references the source', async () => {
      const source = await issueInvoice(h.api, { client: 'Storno Kunde' });
      const cancellation = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'cancellation_invoice', date: today(), dueDate: today(), reason: 'Storno' } as never);
      assert.equal(cancellation.documentKind, 'cancellation_invoice');
      assert.equal(cancellation.sourceDocumentId, source.id);
      assert.notEqual(cancellation.number, source.number);
      assert.match(cancellation.number, /^RE-/);
      const chain = await h.api.documents.chainList({ rootDocumentId: source.rootDocumentId ?? source.id } as never);
      assert.ok(chain.some((d) => d.id === cancellation.id));
    });

    test('a partial credit note cannot exceed the invoice', async () => {
      const source = await issueInvoice(h.api, { client: 'Gutschrift Kunde' });
      const credit = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'credit_note', amount: 10, date: today(), dueDate: today(), reason: 'Teilgutschrift' } as never);
      assert.equal(credit.documentKind, 'credit_note');
      await assert.rejects(h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'credit_note', amount: source.amount * 10, date: today(), dueDate: today(), reason: 'zu viel' } as never));
    });

    test('a chain operation replays idempotently by its operation id', async () => {
      const source = await issueInvoice(h.api, { client: 'Idempotent' });
      const op = { operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'cancellation_invoice', date: today(), dueDate: today(), reason: 'Storno' } as never;
      const first = await h.api.documents.chainIssue(op);
      const second = await h.api.documents.chainIssue(op);
      assert.equal(second.id, first.id);
      assert.equal(second.number, first.number);
    });

    test('a credited or cancelled invoice keeps its settled status through later saves and payments', async () => {
      const chain = (body: Record<string, unknown>) => h.api.documents.chainIssue({ id: randomUUID(), date: today(), dueDate: today(), reason: 'Korrektur', ...body } as never);
      const stored = async (id: string) => (await h.api.invoices.list()).find((invoice) => invoice.id === id)!;
      const resave = async (id: string) => h.api.invoices.upsert({ reason: 'unverändert gespeichert', invoice: await stored(id) });

      const credited = await issueInvoice(h.api, { client: 'Voll gutgeschrieben' });
      await chain({ operation: 'correction', invoiceId: credited.id, kind: 'credit_note', amount: credited.amount });
      assert.equal((await stored(credited.id)).status, 'paid', 'a full credit note settles the invoice');
      await resave(credited.id);
      assert.equal((await stored(credited.id)).status, 'paid', 'an unchanged save keeps it settled');

      const mixed = await issueInvoice(h.api, { client: 'Teils bezahlt, Rest gutgeschrieben' });
      await h.api.invoices.savePayment({ invoiceId: mixed.id, payment: { id: randomUUID(), date: today(), amount: 100, method: 'bank' }, reason: 'Teilzahlung' });
      await chain({ operation: 'correction', invoiceId: mixed.id, kind: 'credit_note', amount: mixed.amount - 100 });
      assert.equal((await stored(mixed.id)).status, 'paid', 'payment plus credit note cover the invoice');
      await resave(mixed.id);
      assert.equal((await stored(mixed.id)).status, 'paid', 'an unchanged save does not reopen what the credit note settled');

      const cancelled = await issueInvoice(h.api, { client: 'Storniert' });
      await chain({ operation: 'correction', invoiceId: cancelled.id, kind: 'cancellation_invoice' });
      assert.equal((await stored(cancelled.id)).status, 'cancelled');
      await resave(cancelled.id);
      assert.equal((await stored(cancelled.id)).status, 'cancelled', 'an unchanged save does not revive a cancelled invoice');
    });

    test('a revision of an unpaid invoice cancels the original when it is issued', async () => {
      const source = await issueInvoice(h.api, { client: 'Revision' });
      const revision = await h.api.documents.chainIssue({ operation: 'revision', id: randomUUID(), invoiceId: source.id, date: today(), dueDate: today(), reason: 'Adresse falsch' } as never);
      assert.equal(revision.status, 'draft');
      assert.equal(revision.revisionOfId, source.id);
      const issued = await h.api.invoices.upsert({ reason: 'Ersatz stellen', invoice: { ...revision, client: 'Revision korrigiert', status: 'open' } });
      assert.equal(issued.status, 'open');
      const all = await h.api.invoices.list();
      assert.equal(all.find((i) => i.id === source.id)!.status, 'cancelled');
      assert.ok(all.some((i) => i.sourceDocumentId === source.id && i.documentKind === 'cancellation_invoice'), 'a cancellation documents the replacement');
    });

    test('a paid invoice cannot be revised in place', async () => {
      const source = await issueInvoice(h.api, { client: 'Paid revision' });
      await h.api.invoices.savePayment({ invoiceId: source.id, payment: { id: randomUUID(), date: today(), amount: source.amount, method: 'bank' }, reason: 'bezahlt' });
      const revision = await h.api.documents.chainIssue({ operation: 'revision', id: randomUUID(), invoiceId: source.id, date: today(), dueDate: today(), reason: 'zu spät' } as never).catch((error: Error) => error);
      if (revision instanceof Error) return;
      await assert.rejects(h.api.invoices.upsert({ reason: 'stellen', invoice: { ...revision, status: 'open' } }), /unbezahlt/);
    });
  });

  describe('document reads and exports', () => {
    test('an invoice and an offer read back by kind and id, export as JSON and as a CSV list', async () => {
      const invoice = await issueInvoice(h.api, { client: 'Export Rechnung' });
      const offer = await draftOffer(h.api, { client: 'Export Angebot' });
      const readInvoice = await h.raw('GET', `/documents/invoice/${invoice.id}`);
      assert.deepEqual([readInvoice.status, readInvoice.body.number, readInvoice.body.amount], [200, invoice.number, invoice.amount]);
      assert.ok(readInvoice.body.history.length > 0, 'the read carries the document history');
      const readOffer = await h.raw('GET', `/documents/offer/${offer.id}`);
      assert.deepEqual([readOffer.status, readOffer.body.number], [200, offer.number]);
      assert.equal((await h.raw('GET', `/documents/offer/${invoice.id}`)).body, null, 'an invoice id is no offer');
      assert.equal((await h.raw('GET', '/documents/receipt/x')).status, 400);

      const json = await h.raw('GET', `/documents/invoice/${invoice.id}/export.json`);
      assert.equal(json.status, 200, json.text);
      assert.equal(json.body.number, invoice.number);
      assert.equal((await h.raw('GET', '/documents/invoice/gibt-es-nicht/export.json')).status, 404);

      const csv = await h.raw('GET', '/documents/export.csv?kind=invoice');
      assert.equal(csv.status, 200);
      const [header, ...rows] = csv.text.trim().split('\n');
      assert.match(header!, /^id,number,client/);
      assert.ok(rows.some((row) => row.startsWith(`${invoice.id},${invoice.number},Export Rechnung`)));
      assert.ok((await h.raw('GET', '/documents/export.csv?kind=offer')).text.includes(offer.number));
      assert.equal((await h.raw('GET', '/documents/export.csv?kind=receipt')).status, 400);
      assert.equal((await fetch(`${h.connection.baseUrl}/api/v1/${product}/documents/export.csv?kind=invoice`)).status, 401);
    });
  });

  describe('audit and validation', () => {
    test('every invoice mutation lands in a verifiable audit chain', async () => {
      const open = await issueInvoice(h.api, { client: 'Audited' });
      await h.api.invoices.savePayment({ invoiceId: open.id, payment: { id: randomUUID(), date: today(), amount: 1, method: 'bank' }, reason: 'Audit-Zahlung' });
      const verify = await h.api.audit.verify();
      assert.equal(verify.ok, true, JSON.stringify(verify));
      const csv = await h.api.audit.exportCsv();
      for (const action of ['invoice.create', 'invoice.update', 'invoice.payment.create']) assert.ok(csv.includes(action), `${action} missing`);
      assert.ok(csv.includes('Audit-Zahlung'));
      const history = (await h.api.invoices.list()).find((i) => i.id === open.id)!.history ?? [];
      assert.ok(history.some((entry) => entry.action.includes('Audit-Zahlung')));
    });

    test('a mutation without a reason is rejected before it reaches the server', async () => {
      const draft = await draftInvoice(h.api, { client: 'No reason' });
      await assert.rejects(h.api.invoices.upsert({ reason: '   ', invoice: draft }));
      const raw = await h.raw('POST', '/invoices', { reason: '', invoice: { ...draft, kind: 'invoice' } });
      assert.equal(raw.status, 400);
    });

    test('malformed items are rejected with 400', async () => {
      const draft = await draftInvoice(h.api, { client: 'Bad items' });
      const raw = await h.raw('POST', '/invoices', { reason: 'bad', invoice: { ...draft, kind: 'invoice', items: [{ kind: 'bogus' }] } });
      assert.equal(raw.status, 400, raw.text);
    });

    test('requests without the local token are refused', async () => {
      const response = await fetch(`${h.connection.baseUrl}/api/v1/${product}/invoices`);
      assert.equal(response.status, 401);
      const forged = await fetch(`${h.connection.baseUrl}/api/v1/${product}/invoices`, { headers: { 'x-billme-local-token': 'wrong' } });
      assert.equal(forged.status, 401);
    });
  });
});

for (const product of PRODUCTS) test(`invoices survive an app restart unchanged (${product})`, async (t) => {
  const first = await startProduct(product, null, 'invoices-restart');
  const open = await issueInvoice(first.api, { client: 'Restart GmbH' });
  await first.api.invoices.savePayment({ invoiceId: open.id, payment: { id: randomUUID(), date: today(), amount: 10, method: 'bank' }, reason: 'vor Neustart' });
  await first.close({ keepData: true });

  const second = await startProduct(product, t, 'invoices-restart', first.userDataPath);
  const stored = (await second.api.invoices.list()).find((i) => i.id === open.id)!;
  assert.equal(stored.number, open.number);
  assert.equal(stored.taxSnapshot!.grossAmount, open.taxSnapshot!.grossAmount);
  assert.equal(stored.payments.length, 1);
  const next = await second.api.numbers.reserve({ kind: 'invoice' });
  assert.equal(Number(next.number.split('-').at(-1)), Number(open.number.split('-').at(-1)) + 1, 'numbering continues after restart');
  assert.equal((await second.api.audit.verify()).ok, true);
});
