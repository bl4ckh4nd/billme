import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { calculateInvoiceTaxSnapshot } from '@billme/server-core';
import { PRODUCTS, startProduct, startPro, type LiteHarness, type ProHarness } from './harness.js';
import { addDays, draftInvoice, draftOffer, issueInvoice, newClient, today } from './fixtures.js';
import { documentIdFromUrl, newToken, startPortal, type PortalHandle } from './offer-portal-fixtures.js';

/**
 * Offers, the order chain (offer → order confirmation → delivery note →
 * advance / partial / final invoice, corrections) and the offer portal, end to
 * end through the Lite desktop backend, with one Pro backend where Pro posts.
 *
 * How this can fail (each one has a test below):
 * - offer numbers: shared sequence with invoices, duplicates under concurrency,
 *   gaps after a released draft, a reservation reused for another offer or
 *   kind, a duplicate number answered with a 500 that leaks the SQL
 * - offer edits: draft edits lost, status set outside the allowed values,
 *   malformed dates saved, a stale copy erasing the portal publication or the
 *   recorded customer decision, an accepted offer's content changing after the
 *   customer agreed, missing history / audit, the typed client refusing to list
 *   or save an offer the portal accepted or declined, requests without the
 *   local token served
 * - offer delete: unknown ids, a converted offer or one with an order chain
 *   deleted (or refused with a raw database error), the deletion not audited
 * - create from client: wrong name / number / billing e-mail / address /
 *   project, a wrong due date, an unknown client accepted, leaked reservations
 * - convert to invoice: amounts, items, tax or addresses changed, no new
 *   number, no link back, a second invoice on repeat or concurrent requests,
 *   a declined or draft offer converted, a request id that belongs to
 *   another document
 * - mixed VAT settlements: a requested partial credit rounded to a different
 *   gross amount, changing the residual debt by a cent
 * - order chain: an order confirmation from an unaccepted offer or twice from
 *   one offer, settlements over the order amount, a final invoice that does not
 *   settle exactly the remainder, a zero amount document, a cancelled advance
 *   invoice that never frees its amount, partial documents without a tax
 *   snapshot (VAT report and Pro posting wrong), corrections beyond the invoice,
 *   non-billing documents corrected, duplicate or out-of-order numbers
 * - idempotency: a replay creating a second document or consuming a number, a
 *   changed intent accepted, concurrent identical requests creating two, a
 *   failed request leaking a number or a half-written document
 * - API errors: business-rule violations answered with 500
 * - portal: publishing without a configured portal, with a wrong key (and the
 *   key error not explained), repeated (token must be stable), the raw token in
 *   audit data, the customer's decision not reaching the offer (or reaching it
 *   twice, or overwriting a manual decision), expired and declined offers, an
 *   offer expiring on its last valid day, a decision lost by re-publishing,
 *   customer access links not scoped to the customer or surviving rotation,
 *   invoices published stale or decidable
 * - Pro: order-chain billing documents not posted (or posted twice on replay,
 *   or with the wrong amount), non-billing documents posted, corrections not
 *   allocated against the source open item
 * - persistence: offers, chain documents, receipts and numbering gone or
 *   restarted after the app restarts
 */
const offerLine = (overrides: Record<string, unknown> = {}) => ({ kind: 'item' as const, description: 'Beratung', quantity: 10, price: 100, total: 1000, taxRate: 19, ...overrides });
const GROSS = 1190;
type Doc = { id: string; number: string; amount: number; documentKind: string; [key: string]: any };

for (const product of PRODUCTS) describe(`offers and the document chain (${product})`, () => {
  let h: LiteHarness;
  before(async () => { h = await startProduct(product, null, 'offers'); });
  after(async () => { await h.close(); });

  /** What the renderer sends for an offer it saves (legacy shape, date fields as the UI names them). */
  const saveOffer = (offer: Record<string, unknown>, reason = 'bearbeitet') => h.api.offers.upsert({ reason, offer } as never);
  const serverOffer = async (id: string) => (await h.raw('GET', `/offers/${id}`)).body as Record<string, any> | null;
  /**
   * The offer in the renderer's field names, read from the server. The typed offers.list() cannot be used
   * here: it throws as soon as one offer is accepted or declined (see the todo test in the portal section).
   */
  const findOffer = async (id: string) => {
    const offer = await serverOffer(id);
    if (!offer) return undefined;
    const share = offer.share ?? {};
    return {
      ...offer, payments: [], dueDate: offer.validUntil as string, billingAddressJson: offer.billingAddress, shippingAddressJson: offer.shippingAddress,
      shareToken: (share.token ?? null) as string | null, sharePublishedAt: (share.publishedAt ?? null) as string | null, shareDecision: (share.decision ?? null) as string | null,
      shareDecisionTextVersion: (share.decisionTextVersion ?? null) as string | null, acceptedAt: (share.acceptedAt ?? null) as string | null,
      acceptedBy: (share.acceptedBy ?? null) as string | null, acceptedEmail: (share.acceptedEmail ?? null) as string | null,
    } as Record<string, any>;
  };
  const offerOf = async (id: string) => (await findOffer(id))!;
  const plain = <T,>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  /** The offer as the server stores it (domain shape), for raw writes the typed client cannot make. */
  const rawOffer = (offer: Record<string, any>, overrides: Record<string, unknown> = {}) => ({
    kind: 'offer', id: offer.id, number: offer.number, client: offer.client, clientEmail: offer.clientEmail, clientAddress: offer.clientAddress,
    taxMode: offer.taxMode, taxSnapshot: offer.taxSnapshot, date: offer.date, validUntil: offer.dueDate, amount: offer.amount,
    status: offer.status, items: offer.items, history: [], ...overrides,
  });
  const accept = (offer: Record<string, any>) =>
    saveOffer({ ...offer, shareDecision: 'accepted', acceptedAt: new Date().toISOString() }, 'Angebot manuell als angenommen markiert');
  const issue = async (body: Record<string, unknown>) => (await h.api.documents.chainIssue({ id: randomUUID(), date: today(), reason: 'Test', ...body } as never)) as unknown as Doc;
  const issueRaw = (body: Record<string, unknown>) => h.raw('POST', '/document-chain/issue', { id: randomUUID(), date: today(), reason: 'Test', ...body });
  const settle = (order: { id: string }, kind: 'advance_invoice' | 'partial_invoice' | 'final_invoice', amount: number, extra: Record<string, unknown> = {}) =>
    issue({ operation: 'settlement_invoice', orderId: order.id, kind, amount, reason: `${kind} ${amount}`, ...extra });
  /** An accepted offer of 1.000 EUR net (1.190 EUR gross) with its order confirmation. */
  const orderFromOffer = async (client = 'Auftrag GmbH', extra: Record<string, unknown> = {}) => {
    const offer = await draftOffer(h.api, { client, items: [offerLine()] });
    await accept(offer);
    const order = await issue({ operation: 'order_confirmation', offerId: offer.id, reason: 'Auftragsbestätigung', ...extra });
    return { offer, order };
  };
  const numberOf = (number: string) => Number(number.split('-').at(-1));
  const cents = (value: number) => Math.round(value * 100);

  describe('numbering', () => {
    test('offer numbers are ANG-year-sequence, unique under concurrency and gapless', async () => {
      const year = new Date().getFullYear();
      const reservations = await Promise.all(Array.from({ length: 8 }, () => h.api.numbers.reserve({ kind: 'offer' })));
      const numbers = reservations.map((reservation) => reservation.number);
      assert.equal(new Set(numbers).size, 8, `duplicate numbers: ${numbers}`);
      for (const number of numbers) assert.match(number, new RegExp(`^ANG-${year}-\\d{3}$`));
      const sequence = numbers.map(numberOf).sort((a, b) => a - b);
      assert.deepEqual(sequence, sequence.map((_, index) => sequence[0]! + index), 'no gaps');
      await Promise.all(reservations.map((reservation) => h.api.numbers.release({ reservationId: reservation.reservationId })));
    });

    test('offers count separately from invoices; releasing the latest reservation hands its number out again', async () => {
      const invoiceA = await h.api.numbers.reserve({ kind: 'invoice' });
      const offerA = await h.api.numbers.reserve({ kind: 'offer' });
      const offerB = await h.api.numbers.reserve({ kind: 'offer' });
      const invoiceB = await h.api.numbers.reserve({ kind: 'invoice' });
      assert.match(invoiceA.number, /^RE-/);
      assert.match(offerA.number, /^ANG-/);
      assert.equal(numberOf(invoiceB.number), numberOf(invoiceA.number) + 1, 'offer reservations do not advance the invoice counter');
      assert.equal(numberOf(offerB.number), numberOf(offerA.number) + 1);
      await h.api.numbers.release({ reservationId: offerB.reservationId });
      const again = await h.api.numbers.reserve({ kind: 'offer' });
      assert.equal(again.number, offerB.number, 'a cancelled latest draft leaves no gap');
      await h.api.numbers.release({ reservationId: offerA.reservationId });
      const afterMiddle = await h.api.numbers.reserve({ kind: 'offer' });
      assert.notEqual(afterMiddle.number, again.number, 'a number that is still reserved is never handed out twice');
      for (const reservation of [invoiceA, invoiceB, again, afterMiddle]) await h.api.numbers.release({ reservationId: reservation.reservationId });
    });

    test('saving an offer with its reservation finalizes the number, so the next one is new', async () => {
      const offer = await draftOffer(h.api, { client: 'Nummer GmbH' });
      const next = await h.api.numbers.reserve({ kind: 'offer' });
      assert.equal(numberOf(next.number), numberOf(offer.number) + 1);
      await h.api.numbers.release({ reservationId: next.reservationId });
      assert.match(offer.number, /^ANG-\d{4}-\d{3}$/);
    });

    test('releasing twice or releasing a saved offer\'s reservation changes nothing', async () => {
      const first = await h.api.numbers.reserve({ kind: 'offer' });
      const second = await h.api.numbers.reserve({ kind: 'offer' });
      await h.api.numbers.release({ reservationId: second.reservationId });
      await h.api.numbers.release({ reservationId: second.reservationId });
      const third = await h.api.numbers.reserve({ kind: 'offer' });
      assert.equal(third.number, second.number, 'the released number comes back once');
      assert.notEqual(third.number, first.number, 'a double release does not roll the counter back onto a held number');
      await h.api.numbers.release({ reservationId: third.reservationId });
      await h.api.numbers.release({ reservationId: first.reservationId });

      const saved = await draftOffer(h.api, { client: 'Gespeichert GmbH' });
      const reservations = await Promise.all([1, 2].map(() => h.api.numbers.reserve({ kind: 'offer' })));
      assert.ok(reservations.every((reservation) => reservation.number !== saved.number));
      for (const reservation of reservations) await h.api.numbers.release({ reservationId: reservation.reservationId });
      assert.equal((await h.api.numbers.release({ reservationId: 'does-not-exist' })).ok, true, 'releasing an unknown reservation is a no-op');
      const next = await h.api.numbers.reserve({ kind: 'offer' });
      assert.notEqual(next.number, saved.number, 'the number of a stored offer is never handed out again');
      await h.api.numbers.release({ reservationId: next.reservationId });
    });

    test('a reservation needs a known kind', async () => {
      assert.equal((await h.raw('POST', '/numbers/reserve', { kind: 'delivery_note' })).status, 400);
      assert.equal((await h.raw('POST', '/numbers/reserve', {})).status, 400);
      assert.equal((await h.raw('POST', '/numbers/release', {})).status, 400);
    });

    test('a reservation cannot be reused for another offer, another number or another kind', async () => {
      const first = await draftOffer(h.api, { client: 'Besitzer' });
      const reservation = await h.api.numbers.reserve({ kind: 'offer' });
      const draft = { ...first, id: randomUUID(), number: reservation.number, numberReservationId: reservation.reservationId };
      assert.equal((await saveOffer(draft, 'erster Beleg')).number, reservation.number);
      const thief = await h.raw('POST', '/offers', { reason: 'Diebstahl', reservationId: reservation.reservationId, offer: rawOffer(draft, { id: randomUUID() }) });
      assert.equal(thief.status, 409, thief.text);
      const wrongNumber = await h.api.numbers.reserve({ kind: 'offer' });
      const mismatch = await h.raw('POST', '/offers', { reason: 'falsche Nummer', reservationId: wrongNumber.reservationId, offer: rawOffer(first, { id: randomUUID(), number: 'ANG-9999-999' }) });
      assert.equal(mismatch.status, 409, mismatch.text);
      const invoiceReservation = await h.api.numbers.reserve({ kind: 'invoice' });
      const wrongKind = await h.raw('POST', '/offers', { reason: 'falsche Art', reservationId: invoiceReservation.reservationId, offer: rawOffer(first, { id: randomUUID(), number: invoiceReservation.number }) });
      assert.equal(wrongKind.status, 409, wrongKind.text);
      const unknown = await h.raw('POST', '/offers', { reason: 'unbekannt', reservationId: 'does-not-exist', offer: rawOffer(first, { id: randomUUID(), number: 'ANG-9999-998' }) });
      assert.equal(unknown.status, 409, unknown.text);
      for (const entry of [wrongNumber, invoiceReservation]) await h.api.numbers.release({ reservationId: entry.reservationId });
    });

    test('a duplicate offer number is a clean 409, not a database error', async () => {
      const first = await draftOffer(h.api, { client: 'Original' });
      const duplicate = await h.raw('POST', '/offers', { reason: 'doppelt', offer: rawOffer(first, { id: randomUUID() }) });
      assert.equal(duplicate.status, 409, duplicate.text);
      assert.ok(!/Failed query|insert into/i.test(duplicate.text), 'no SQL in the response');
    });
  });

  describe('drafts, statuses and validation', () => {
    test('a draft stays editable: content, validity and totals change, number and id do not, history records each save', async () => {
      const draft = await draftOffer(h.api, { client: 'Entwurf GmbH', items: [offerLine({ quantity: 1, total: 100 })] });
      const items = [offerLine({ quantity: 3, price: 100, total: 300 }), offerLine({ description: 'Zweite Position', quantity: 1, price: 50, total: 50, taxRate: 7 })];
      const taxSnapshot = calculateInvoiceTaxSnapshot({ items, taxMode: 'standard_vat' }, (await h.api.settings.get())!);
      const validUntil = addDays(today(), 30);
      const edited = await saveOffer({ ...draft, client: 'Entwurf GmbH & Co. KG', items, amount: taxSnapshot.grossAmount, taxSnapshot, dueDate: validUntil }, 'Preis angepasst');
      assert.equal(edited.id, draft.id);
      assert.equal(edited.number, draft.number);
      assert.equal(edited.status, 'draft');
      const stored = (await findOffer(draft.id))!;
      assert.equal(stored.client, 'Entwurf GmbH & Co. KG');
      assert.equal(stored.items.length, 2);
      assert.equal(stored.amount, 410.5);
      assert.equal(stored.taxSnapshot?.vatBreakdown?.length, 2);
      assert.equal(stored.dueDate, validUntil, 'the validity date is saved');
      const domain = (await serverOffer(draft.id))!;
      assert.equal(domain.validUntil, validUntil);
      assert.deepEqual(stored.history?.map((entry: { action: string }) => entry.action), ['offer.update (Preis angepasst)', 'offer.create (create)']);
    });

    test('status-only transitions remain legal, but an issued offer cannot return to draft', async () => {
      const offer = await draftOffer(h.api, { client: 'Status GmbH' });
      for (const status of ['open', 'accepted', 'declined', 'expired', 'cancelled'] as const) {
        const response = await h.raw('POST', '/offers', { reason: `Status ${status}`, offer: rawOffer(offer, { status }) });
        assert.equal(response.status, 200, `${status}: ${response.text}`);
        assert.equal((await serverOffer(offer.id))!.status, status);
      }
      const downgrade = await h.raw('POST', '/offers', { reason: 'zurück zum Entwurf', offer: rawOffer(offer, { status: 'draft' }) });
      assert.equal(downgrade.status, 409, downgrade.text);
      const bogus = await h.raw('POST', '/offers', { reason: 'unsinnig', offer: rawOffer(offer, { status: 'bogus' }) });
      assert.equal(bogus.status, 400);
      assert.equal((await serverOffer(offer.id))!.status, 'cancelled', 'a rejected save changes nothing');
    });

    test('an offer the portal declined refuses content changes through the typed client', async () => {
      const offer = await draftOffer(h.api, { client: 'Abgelehnt GmbH' });
      assert.equal((await h.raw('POST', '/offers', { reason: 'Portal: abgelehnt', offer: rawOffer(offer, { status: 'declined' }) })).status, 200);
      const listed = (await findOffer(offer.id))!;
      assert.equal(listed.status, 'declined');
      await assert.rejects(saveOffer({ ...listed, client: 'Abgelehnt GmbH (Notiz)' }, 'Nachbearbeitung'));
      assert.equal((await findOffer(offer.id))!.client, 'Abgelehnt GmbH');
    });

    test('a save without a reason, without a client or with broken items is a 400 and stores nothing', async () => {
      const offer = await draftOffer(h.api, { client: 'Validierung GmbH' });
      const base = rawOffer(offer);
      assert.equal((await h.raw('POST', '/offers', { reason: '', offer: base })).status, 400);
      assert.equal((await h.raw('POST', '/offers', { reason: '   ', offer: base })).status, 400);
      assert.equal((await h.raw('POST', '/offers', { reason: 'x', offer: { ...base, client: '' } })).status, 400);
      assert.equal((await h.raw('POST', '/offers', { reason: 'x', offer: { ...base, number: '' } })).status, 400, 'a number is required');
      assert.equal((await h.raw('POST', '/offers', { reason: 'x', offer: { ...base, items: [{ kind: 'bogus' }] } })).status, 400);
      assert.equal((await h.raw('POST', '/offers', { reason: 'x', offer: { ...base, validUntil: undefined } })).status, 400, 'validity is required');
      assert.equal((await h.raw('POST', '/offers', { reason: 'x', offer: { ...base, amount: 'viel' } })).status, 400);
      await assert.rejects(saveOffer({ ...offer, client: 'Ohne Grund' }, '   '));
      assert.equal((await findOffer(offer.id))!.client, 'Validierung GmbH');
    });

    test('malformed dates are rejected', async () => {
      const offer = await draftOffer(h.api, { client: 'Datum GmbH' });
      const badValidity = await h.raw('POST', '/offers', { reason: 'x', offer: rawOffer(offer, { validUntil: 'nope' }) });
      assert.equal(badValidity.status, 400);
      const badDate = await h.raw('POST', '/offers', { reason: 'x', offer: rawOffer(offer, { date: '31.02.2026' }) });
      assert.equal(badDate.status, 400);
    });

    test('a save from a stale copy keeps the portal publication and the recorded decision, and cannot change accepted content', async () => {
      const stale = await draftOffer(h.api, { client: 'Stale GmbH' });
      const token = newToken('stale');
      const publishedAt = new Date().toISOString();
      assert.equal((await h.raw('POST', '/offers', { reason: 'Portal: veröffentlicht', offer: rawOffer(stale, { status: 'open', share: { token, publishedAt } }) })).status, 200);
      const decided = { ...(await findOffer(stale.id))!, shareDecision: 'accepted' as const, acceptedAt: new Date().toISOString(), acceptedBy: 'Kunde' };
      await saveOffer(decided, 'Entscheidung erfasst');
      // The stale copy knows nothing of the publication or the decision; saving it unchanged must not erase them.
      await h.raw('POST', '/offers', { reason: 'Speichern aus altem Stand', offer: rawOffer(stale, { status: 'open' }) });
      let stored = (await serverOffer(stale.id))!;
      assert.equal(stored.share?.token, token, 'the portal token must survive');
      assert.equal(stored.share?.decision, 'accepted', 'the recorded decision must survive');
      // Changing what the customer accepted is refused, also from a stale copy.
      await assert.rejects(saveOffer({ ...stale, client: 'Stale GmbH (bearbeitet)' }, 'Bearbeitung aus altem Stand'));
      stored = (await serverOffer(stale.id))!;
      assert.equal(stored.client, 'Stale GmbH');
      assert.equal(stored.share?.decision, 'accepted');
    });

    test('the content an accepted offer was accepted with cannot be changed afterwards', async () => {
      const offer = await draftOffer(h.api, { client: 'Zusage GmbH' });
      const accepted = (await accept(offer)) as Record<string, any>;
      await assert.rejects(saveOffer({ ...accepted, items: [offerLine({ price: 999, total: 9990 })], amount: 11888.1 }, 'nachträglich teurer'));
      assert.equal((await findOffer(offer.id))!.amount, offer.amount);
    });

    test('creating, editing and deleting an offer lands in a verifiable audit chain', async () => {
      const offer = await draftOffer(h.api, { client: 'Audit GmbH' });
      await saveOffer({ ...offer, client: 'Audit GmbH 2' }, 'Audit-Änderung');
      await h.api.offers.delete({ id: offer.id, reason: 'Audit-Löschung' });
      const verify = await h.api.audit.verify();
      assert.equal(verify.ok, true, JSON.stringify(verify));
      const csv = await h.api.audit.exportCsv();
      for (const needle of ['offer.create', 'offer.update', 'offer.delete', 'Audit-Änderung', 'Audit-Löschung']) assert.ok(csv.includes(needle), `${needle} missing`);
    });
  });

  describe('deleting offers', () => {
    test('a draft offer is deletable, disappears from list and lookup, and the deletion needs a reason', async () => {
      const draft = await draftOffer(h.api, { client: 'Verwerfen GmbH' });
      await assert.rejects(h.api.offers.delete({ id: draft.id, reason: '' }));
      assert.equal((await h.raw('DELETE', `/offers/${draft.id}`, { reason: '   ' })).status, 400);
      assert.ok(await findOffer(draft.id), 'still there without a reason');
      await h.api.offers.delete({ id: draft.id, reason: 'Entwurf verworfen' });
      assert.equal(await findOffer(draft.id), undefined);
      assert.equal(await serverOffer(draft.id), null);
      const again = await h.raw('DELETE', `/offers/${draft.id}`, { reason: 'nochmal' });
      assert.equal(again.status, 404);
      assert.equal((await h.raw('DELETE', '/offers/never-existed', { reason: 'x' })).status, 404);
    });

    test('an offer that was converted into an invoice is refused with a clean message', async () => {
      const offer = await draftOffer(h.api, { client: 'Konvertiert GmbH' });
      await accept(offer);
      await h.api.documents.convertOfferToInvoice({ offerId: offer.id });
      const response = await h.raw('DELETE', `/offers/${offer.id}`, { reason: 'weg damit' });
      assert.equal(response.status, 409, response.text);
      assert.ok(!/Failed query|delete from/i.test(response.text), 'no SQL in the response');
      assert.ok(await findOffer(offer.id), 'the offer is still there');
    });

    test('an offer with an order confirmation cannot be deleted from under its chain', async () => {
      const { offer } = await orderFromOffer('Kette GmbH');
      const response = await h.raw('DELETE', `/offers/${offer.id}`, { reason: 'Angebot löschen' });
      assert.ok(response.status >= 400, `deleted: ${response.status}`);
      assert.ok(await findOffer(offer.id));
    });
  });

  describe('documents:createFromClient', () => {
    const clientWithDetails = async (overrides: Record<string, unknown> = {}) => {
      const id = randomUUID();
      const client = newClient({
        id, company: 'Adressen AG', email: 'allgemein@example.com',
        addresses: [
          { id: randomUUID(), clientId: id, label: 'Lager', kind: 'other', street: 'Lagerweg 3', zip: '20095', city: 'Hamburg', country: 'DE', isDefaultBilling: false, isDefaultShipping: false },
          { id: randomUUID(), clientId: id, label: 'Sitz', kind: 'billing', company: 'Adressen AG', street: 'Hauptstr. 9', zip: '10115', city: 'Berlin', country: 'DE', isDefaultBilling: true, isDefaultShipping: false },
          { id: randomUUID(), clientId: id, label: 'Werk', kind: 'shipping', street: 'Werkstr. 1', zip: '80331', city: 'München', country: 'DE', isDefaultBilling: false, isDefaultShipping: true },
        ],
        emails: [
          { id: randomUUID(), clientId: id, label: 'Allgemein', kind: 'general', email: 'allgemein@example.com', isDefaultGeneral: true, isDefaultBilling: false },
          { id: randomUUID(), clientId: id, label: 'Buchhaltung', kind: 'billing', email: 'buchhaltung@example.com', isDefaultGeneral: false, isDefaultBilling: true },
        ],
        projects: [
          { id: randomUUID(), clientId: id, name: 'Altprojekt', status: 'archived', budget: 0, startDate: '2025-01-01' },
          { id: randomUUID(), clientId: id, name: 'Allgemein', status: 'active', budget: 0, startDate: '2026-01-01' },
        ],
        ...overrides,
      });
      const saved = await h.api.clients.upsert({ client } as never);
      return { client: saved, projectId: saved.projects.find((project) => project.name === 'Allgemein')!.id };
    };

    test('an offer draft carries the client, number, billing e-mail, default addresses and the general project', async () => {
      const { client, projectId } = await clientWithDetails();
      const draft = await h.api.documents.createFromClient({ kind: 'offer', clientId: client.id });
      assert.equal(draft.clientId, client.id);
      assert.equal(draft.clientNumber, client.customerNumber);
      assert.equal(draft.client, 'Adressen AG');
      assert.equal(draft.clientEmail, 'buchhaltung@example.com', 'the billing e-mail wins over the general one');
      assert.equal(draft.clientAddress, 'Adressen AG\nHauptstr. 9\n10115 Berlin\nDE');
      assert.equal((draft.billingAddressJson as Record<string, string>).street, 'Hauptstr. 9');
      assert.equal((draft.shippingAddressJson as Record<string, string>).street, 'Werkstr. 1');
      assert.equal(draft.projectId, projectId, 'the non-archived general project');
      assert.match(draft.number, /^ANG-\d{4}-\d{3}$/);
      assert.ok(draft.numberReservationId);
      assert.equal(draft.status, 'draft');
      assert.equal(draft.amount, 0);
      assert.deepEqual(draft.items, []);
      assert.equal(draft.date, today());
      assert.equal(draft.dueDate, today(), 'an offer starts valid for the day it is created');
      assert.equal(await findOffer(draft.id), undefined, 'nothing is stored before the user saves');
      await h.api.numbers.release({ reservationId: draft.numberReservationId! });
    });

    test('an invoice draft gets an RE number and the payment term as due date', async () => {
      const { client } = await clientWithDetails({ company: 'Rechnung AG' });
      const settings = (await h.api.settings.get())!;
      const draft = await h.api.documents.createFromClient({ kind: 'invoice', clientId: client.id });
      assert.match(draft.number, /^RE-\d{4}-\d{3}$/);
      assert.equal(draft.dueDate, addDays(today(), settings.legal.paymentTermsDays));
      assert.equal(draft.client, 'Rechnung AG');
      await h.api.numbers.release({ reservationId: draft.numberReservationId! });
    });

    test('a client without address or e-mail records falls back to its plain fields', async () => {
      const client = newClient({ company: 'Schlicht GmbH', email: 'schlicht@example.com', address: 'Weg 1\n12345 Ort' });
      await h.api.clients.upsert({ client } as never);
      const draft = await h.api.documents.createFromClient({ kind: 'offer', clientId: client.id });
      assert.equal(draft.clientEmail, 'schlicht@example.com');
      assert.equal(draft.clientAddress, 'Weg 1\n12345 Ort');
      assert.equal(draft.billingAddressJson, undefined);
      assert.equal(draft.projectId, undefined);
      await h.api.numbers.release({ reservationId: draft.numberReservationId! });
    });

    test('saving the draft stores its address snapshots and finalizes the reserved number', async () => {
      const { client, projectId } = await clientWithDetails({ company: 'Snapshot AG' });
      const draft = await h.api.documents.createFromClient({ kind: 'offer', clientId: client.id });
      const items = [offerLine({ quantity: 2, total: 200 })];
      const taxSnapshot = calculateInvoiceTaxSnapshot({ items, taxMode: 'standard_vat' }, (await h.api.settings.get())!);
      const saved = await saveOffer({ ...draft, items, amount: taxSnapshot.grossAmount, taxSnapshot, taxMode: 'standard_vat', dueDate: addDays(today(), 14) }, 'aus Kunde erstellt');
      assert.equal(saved.number, draft.number);
      const stored = (await findOffer(draft.id))!;
      assert.equal((stored.billingAddressJson as Record<string, string>).city, 'Berlin');
      assert.equal((stored.shippingAddressJson as Record<string, string>).city, 'München');
      assert.equal(stored.projectId, projectId);
      assert.equal(stored.clientNumber, client.customerNumber);
      const next = await h.api.numbers.reserve({ kind: 'offer' });
      assert.equal(numberOf(next.number), numberOf(draft.number) + 1, 'the saved draft keeps its number');
      await h.api.numbers.release({ reservationId: next.reservationId });
    });

    test('the client and address snapshots of the offer travel through the whole chain', async () => {
      const { client, projectId } = await clientWithDetails({ company: 'Snapshot Kette AG' });
      const draft = await h.api.documents.createFromClient({ kind: 'offer', clientId: client.id });
      const items = [offerLine()];
      const taxSnapshot = calculateInvoiceTaxSnapshot({ items, taxMode: 'standard_vat' }, (await h.api.settings.get())!);
      const offer = await saveOffer({ ...draft, items, amount: taxSnapshot.grossAmount, taxSnapshot, taxMode: 'standard_vat', dueDate: addDays(today(), 14) }, 'aus Kunde erstellt');
      await accept(offer);
      const order = await issue({ operation: 'order_confirmation', offerId: offer.id, dueDate: addDays(today(), 7) });
      const advance = await settle(order, 'advance_invoice', 357, { servicePeriod: '2026-01-01 bis 2026-01-31' });
      const invoice = await h.api.documents.convertOfferToInvoice({ offerId: offer.id });
      for (const document of [order, advance, invoice]) {
        assert.equal(document.clientId, client.id, `${document.documentKind}: client id`);
        assert.equal(document.clientNumber, client.customerNumber);
        assert.equal(document.client, 'Snapshot Kette AG');
        assert.equal(document.clientEmail, 'buchhaltung@example.com');
        assert.equal(document.projectId, projectId);
        assert.equal((document.billingAddressJson as Record<string, string>).street, 'Hauptstr. 9');
        assert.equal((document.shippingAddressJson as Record<string, string>).street, 'Werkstr. 1');
      }
      assert.equal(order.dueDate, addDays(today(), 7), 'an explicit due date is kept');
      assert.equal(advance.dueDate, advance.date, 'without one the due date is the document date');
      assert.equal(advance.servicePeriod, '2026-01-01 bis 2026-01-31');
    });

    test('an unknown client is refused and a bad kind never reaches the server', async () => {
      await assert.rejects(h.api.documents.createFromClient({ kind: 'offer', clientId: 'does-not-exist' }), /Kunde nicht gefunden/);
      await assert.rejects(h.api.documents.createFromClient({ kind: 'delivery_note' as never, clientId: 'x' }));
      await assert.rejects(h.api.documents.createFromClient({ kind: 'offer', clientId: '' }));
    });
  });

  describe('documents:convertOfferToInvoice', () => {
    const variants: Array<{ name: string; taxMode: 'standard_vat' | 'reverse_charge_13b' | 'small_business_19_ustg'; taxMeta?: Record<string, unknown>; items: Array<Record<string, unknown>> }> = [
      {
        name: 'mixed rates, a discount, an optional and a text line', taxMode: 'standard_vat',
        items: [
          offerLine({ description: 'Beratung', quantity: 3, price: 99.99, total: 299.97, taxRate: 19 }),
          offerLine({ description: 'Buch', quantity: 1, price: 20, total: 20, taxRate: 7 }),
          offerLine({ description: 'Rabatt', quantity: 1, price: -30, total: -30, taxRate: 19 }),
          { kind: 'optional', description: 'Option, nicht beauftragt', quantity: 1, price: 500, total: 500, taxRate: 19 },
          { kind: 'text', description: 'Hinweis ohne Betrag', quantity: 0, price: 0, total: 0 },
        ],
      },
      { name: 'reverse charge with the buyer VAT id', taxMode: 'reverse_charge_13b', taxMeta: { buyerVatId: 'ATU12345678' }, items: [{ kind: 'item', description: 'Bauleistung', quantity: 1, price: 1000, total: 1000 }] },
      { name: 'Kleinunternehmer', taxMode: 'small_business_19_ustg', items: [offerLine({ quantity: 2, price: 250, total: 500 })] },
    ];

    for (const variant of variants) {
      test(`carries amounts, items, tax and addresses exactly: ${variant.name}`, async () => {
        const offer = await draftOffer(h.api, { client: `Konvert ${variant.taxMode}`, taxMode: variant.taxMode, taxMeta: variant.taxMeta, items: variant.items as never });
        await accept(offer);
        const source = (await findOffer(offer.id))!;
        const invoice = await h.api.documents.convertOfferToInvoice({ offerId: offer.id });
        const stored = (await h.api.invoices.list()).find((entry) => entry.id === invoice.id)!;
        assert.equal(stored.amount, source.amount);
        assert.deepEqual(plain(stored.items), plain(source.items));
        assert.deepEqual(plain(stored.taxSnapshot), plain(source.taxSnapshot));
        assert.equal(stored.taxMode, variant.taxMode);
        assert.deepEqual(plain(stored.taxMeta), plain(source.taxMeta));
        assert.equal(stored.client, source.client);
        assert.equal(stored.clientEmail, source.clientEmail);
        assert.equal(stored.clientAddress, source.clientAddress);
        assert.equal(stored.status, 'draft');
        assert.deepEqual(stored.payments, []);
      });
    }

    test('the invoice gets a new number, the dates of the conversion and a link back to the offer', async () => {
      const offer = await draftOffer(h.api, { client: 'Link GmbH', items: [offerLine()] });
      await accept(offer);
      const settings = (await h.api.settings.get())!;
      const invoice = await h.api.documents.convertOfferToInvoice({ offerId: offer.id });
      assert.match(invoice.number, /^RE-\d{4}-\d{3}$/);
      assert.notEqual(invoice.number, offer.number);
      assert.equal(invoice.sourceDocumentId, offer.id);
      assert.equal(invoice.rootDocumentId, invoice.id);
      assert.equal(invoice.documentKind, 'invoice');
      assert.equal(invoice.date, today());
      assert.equal(invoice.dueDate, addDays(today(), settings.legal.paymentTermsDays));
      assert.ok(invoice.history?.some((entry) => entry.action.includes(`Converted from offer ${offer.number}`)));
      assert.equal((await findOffer(offer.id))!.number, offer.number, 'the offer keeps its number');
      const next = await h.api.numbers.reserve({ kind: 'invoice' });
      assert.equal(numberOf(next.number), numberOf(invoice.number) + 1, 'the conversion consumed exactly one number');
      await h.api.numbers.release({ reservationId: next.reservationId });
    });

    test('converting twice, with a new request id or concurrently, yields the same single invoice', async () => {
      const offer = await draftOffer(h.api, { client: 'Doppelt GmbH' });
      await accept(offer);
      const invoiceId = randomUUID();
      const results = await Promise.all([
        h.raw('POST', '/documents/convert-offer', { offerId: offer.id, invoiceId }),
        h.raw('POST', '/documents/convert-offer', { offerId: offer.id, invoiceId }),
        h.raw('POST', '/documents/convert-offer', { offerId: offer.id, invoiceId: randomUUID() }),
      ]);
      for (const result of results) assert.equal(result.status, 200, result.text);
      assert.equal(new Set(results.map((result) => result.body.id)).size, 1, 'one invoice for all three requests');
      const again = await h.api.documents.convertOfferToInvoice({ offerId: offer.id });
      assert.equal(again.id, results[0]!.body.id);
      const invoices = (await h.api.invoices.list()).filter((entry) => entry.sourceDocumentId === offer.id);
      assert.equal(invoices.length, 1);
    });

    test('an unknown offer is a 404 and a malformed or foreign request id is refused', async () => {
      assert.equal((await h.raw('POST', '/documents/convert-offer', { offerId: 'does-not-exist', invoiceId: randomUUID() })).status, 404);
      assert.equal((await h.raw('POST', '/documents/convert-offer', { offerId: 'x', invoiceId: 'not-a-uuid' })).status, 400);
      assert.equal((await h.raw('POST', '/documents/convert-offer', { offerId: '', invoiceId: randomUUID() })).status, 400);
      await assert.rejects(h.api.documents.convertOfferToInvoice({ offerId: '' }));
      const offer = await draftOffer(h.api, { client: 'Kollision GmbH' });
      const other = await issueInvoice(h.api, { client: 'Fremde Rechnung' });
      const collision = await h.raw('POST', '/documents/convert-offer', { offerId: offer.id, invoiceId: other.id });
      assert.equal(collision.status, 409, collision.text);
      assert.equal((await h.api.invoices.list()).find((entry) => entry.id === other.id)!.client, 'Fremde Rechnung', 'the other document is untouched');
    });

    test('only an accepted offer can be converted', async () => {
      const declinedOffer = await draftOffer(h.api, { client: 'Abgelehnt GmbH' });
      await h.raw('POST', '/offers', { reason: 'Kunde lehnt ab', offer: rawOffer(declinedOffer, { status: 'declined', share: { decision: 'declined', acceptedAt: new Date().toISOString() } }) });
      const declined = await h.raw('POST', '/documents/convert-offer', { offerId: declinedOffer.id, invoiceId: randomUUID() });
      assert.equal(declined.status, 409, `declined offer: ${declined.status}`);
      const draftOnly = await draftOffer(h.api, { client: 'Nie gesendet GmbH' });
      const draft = await h.raw('POST', '/documents/convert-offer', { offerId: draftOnly.id, invoiceId: randomUUID() });
      assert.equal(draft.status, 409, `draft offer: ${draft.status}`);
    });

    test('the converted invoice is an ordinary draft: editable, issuable, then frozen', async () => {
      const offer = await draftOffer(h.api, { client: 'Ausstellen GmbH' });
      await accept(offer);
      const draft = await h.api.documents.convertOfferToInvoice({ offerId: offer.id });
      const edited = await h.api.invoices.upsert({ reason: 'Leistungsdatum ergänzt', invoice: { ...draft, servicePeriod: today() } });
      assert.equal(edited.servicePeriod, today());
      const open = await h.api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...edited, status: 'open' } });
      assert.equal(open.status, 'open');
      assert.equal(open.number, draft.number);
      assert.equal(open.sourceDocumentId, offer.id, 'the link to the offer survives issuing');
      await assert.rejects(h.api.invoices.upsert({ reason: 'später ändern', invoice: { ...open, items: [offerLine({ price: 1, total: 1 })] } }), /unverändert/);
    });
  });

  describe('order chain', () => {
    test('offer → order confirmation → delivery note → advance, partial and final invoice settle the order exactly', async () => {
      const { offer, order } = await orderFromOffer('Kette AG');
      assert.equal(order.documentKind, 'order_confirmation');
      assert.equal(order.status, 'open');
      assert.equal(order.sourceDocumentId, offer.id);
      assert.equal(order.rootDocumentId, order.id);
      assert.equal(order.amount, GROSS);
      assert.deepEqual(plain(order.items), plain((await offerOf(offer.id)).items));
      assert.deepEqual(plain(order.taxSnapshot), plain((await offerOf(offer.id)).taxSnapshot));
      assert.ok(order.numberReservationId === undefined || typeof order.numberReservationId === 'string');

      const delivery = await issue({ operation: 'delivery_note', orderId: order.id, reason: 'Lieferung' });
      assert.equal(delivery.documentKind, 'delivery_note');
      assert.equal(delivery.amount, 0, 'a delivery note bills nothing');
      assert.equal(delivery.sourceDocumentId, order.id);
      assert.equal(delivery.rootDocumentId, order.id);
      assert.deepEqual(plain(delivery.items), plain(order.items), 'it lists the order lines');

      const advance = await settle(order, 'advance_invoice', 357);
      const partial = await settle(order, 'partial_invoice', 119);
      const final = await settle(order, 'final_invoice', 714);
      assert.deepEqual([advance, partial, final].map((document) => document.documentKind), ['advance_invoice', 'partial_invoice', 'final_invoice']);
      assert.deepEqual([advance, partial, final].map((document) => document.amount), [357, 119, 714]);
      for (const document of [advance, partial, final]) {
        assert.equal(document.status, 'open', `${document.documentKind} is issued`);
        assert.equal(document.sourceDocumentId, order.id);
        assert.equal(document.rootDocumentId, order.id);
        assert.equal(document.client, 'Kette AG');
      }
      assert.equal(cents(advance.amount + partial.amount + final.amount), cents(order.amount), 'the invoices add up to the order');
      assert.equal(advance.items[0].quantity, 3, 'lines are prorated to the billed share');
      assert.equal(advance.items[0].total, 300);
      assert.equal(final.items[0].total, 600);

      const chain = await h.api.documents.chainList({ rootDocumentId: order.id } as never);
      assert.deepEqual(chain.map((document) => document.documentKind).sort(), ['advance_invoice', 'delivery_note', 'final_invoice', 'order_confirmation', 'partial_invoice']);
      const numbers = [order, delivery, advance, partial, final].map((document) => document.number as string);
      assert.equal(new Set(numbers).size, 5, `numbers are unique: ${numbers}`);
      assert.deepEqual(numbers.map(numberOf), [...numbers.map(numberOf)].sort((a, b) => a - b), 'numbers grow in issue order');
      const stored = await h.api.invoices.list();
      for (const document of chain) assert.ok(stored.some((entry) => entry.id === document.id), 'chain documents are ordinary invoices rows');
    });

    test('the final invoice must settle exactly the remainder and nothing can be billed beyond the order', async () => {
      const { order } = await orderFromOffer('Rest GmbH');
      await settle(order, 'advance_invoice', 357);
      await settle(order, 'partial_invoice', 119);
      await assert.rejects(settle(order, 'final_invoice', 100), /Schlussrechnung muss den offenen Auftragsbetrag \(714\.00 €\)/);
      await assert.rejects(settle(order, 'final_invoice', 800), /höher als der offene Auftragsbetrag \(714\.00 €\)/);
      await assert.rejects(settle(order, 'partial_invoice', 714.01), /höher als der offene Auftragsbetrag \(714\.00 €\)/);
      await assert.rejects(settle(order, 'advance_invoice', 5000), /höher als der offene Auftragsbetrag/);
      const final = await settle(order, 'final_invoice', 714);
      assert.equal(final.amount, 714);
      for (const kind of ['advance_invoice', 'partial_invoice', 'final_invoice'] as const) {
        await assert.rejects(settle(order, kind, 0.01), /höher als der offene Auftragsbetrag \(0\.00 €\)/, `${kind} after the order is fully billed`);
      }
      assert.equal((await h.api.documents.chainList({ rootDocumentId: order.id } as never)).filter((document) => document.documentKind === 'final_invoice').length, 1);
    });

    test('a final invoice without any earlier invoice bills the whole order', async () => {
      const { order } = await orderFromOffer('Direkt GmbH');
      await assert.rejects(settle(order, 'final_invoice', 1000), /Schlussrechnung muss den offenen Auftragsbetrag \(1190\.00 €\)/);
      const final = await settle(order, 'final_invoice', GROSS);
      assert.equal(final.amount, GROSS);
      assert.equal(final.items[0].total, 1000);
    });

    test('settlement amounts must be positive and a settlement needs an order confirmation', async () => {
      const { offer, order } = await orderFromOffer('Betrag GmbH');
      assert.equal((await issueRaw({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 0 })).status, 400);
      assert.equal((await issueRaw({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: -5 })).status, 400);
      assert.equal((await issueRaw({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 'viel' })).status, 400);
      assert.equal((await issueRaw({ operation: 'settlement_invoice', kind: 'invoice', orderId: order.id, amount: 10 })).status, 400, 'only advance, partial and final invoices');
      await assert.rejects(settle({ id: offer.id }, 'partial_invoice', 10), /Auftragsbestätigung nicht gefunden/, 'an offer is not an order');
      await assert.rejects(settle({ id: 'does-not-exist' }, 'partial_invoice', 10), /Auftragsbestätigung nicht gefunden/);
      const invoice = await issueInvoice(h.api, { client: 'Normale Rechnung' });
      await assert.rejects(settle(invoice, 'partial_invoice', 10), /Auftragsbestätigung nicht gefunden/, 'an ordinary invoice is not an order');
      assert.equal((await h.api.documents.chainList({ rootDocumentId: order.id } as never)).length, 1, 'nothing was issued');
    });

    test('an amount that rounds to zero cents is refused', async () => {
      const { order } = await orderFromOffer('Rundung GmbH');
      const response = await issueRaw({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 0.004 });
      assert.ok(response.status >= 400, `issued a ${response.body?.amount} EUR invoice`);
    });

    test('an order confirmation needs an accepted offer', async () => {
      const draftOnly = await draftOffer(h.api, { client: 'Unbestätigt GmbH' });
      await assert.rejects(issue({ operation: 'order_confirmation', offerId: draftOnly.id }), /Das Angebot muss angenommen sein, bevor eine Auftragsbestätigung/);
      const declined = await draftOffer(h.api, { client: 'Absage GmbH' });
      await h.raw('POST', '/offers', { reason: 'abgelehnt', offer: rawOffer(declined, { status: 'declined', share: { decision: 'declined', acceptedAt: new Date().toISOString() } }) });
      await assert.rejects(issue({ operation: 'order_confirmation', offerId: declined.id }), /muss angenommen sein/);
      await assert.rejects(issue({ operation: 'order_confirmation', offerId: 'does-not-exist' }), /Angebot nicht gefunden/);
      const viaStatus = await draftOffer(h.api, { client: 'Status akzeptiert GmbH' });
      await h.raw('POST', '/offers', { reason: 'Status', offer: rawOffer(viaStatus, { status: 'accepted' }) });
      const order = await issue({ operation: 'order_confirmation', offerId: viaStatus.id });
      assert.equal(order.documentKind, 'order_confirmation', 'status accepted is enough');
      for (const offer of [draftOnly, declined]) {
        const chain = await h.api.invoices.list();
        assert.ok(!chain.some((document) => document.sourceDocumentId === offer.id), 'nothing was issued for a refused offer');
      }
    });

    test('the same accepted offer cannot become a second order confirmation', async () => {
      const { offer } = await orderFromOffer('Doppelauftrag GmbH');
      const second = await issueRaw({ operation: 'order_confirmation', offerId: offer.id, reason: 'noch einmal' });
      assert.ok(second.status >= 400, 'a second order confirmation was issued');
    });

    test('a delivery note needs an order confirmation and corrections only touch finalized billing documents', async () => {
      const { order } = await orderFromOffer('Korrektur GmbH');
      const delivery = await issue({ operation: 'delivery_note', orderId: order.id });
      const invoice = await issueInvoice(h.api, { client: 'Normale Rechnung 2' });
      await assert.rejects(issue({ operation: 'delivery_note', orderId: invoice.id }), /Auftragsbestätigung nicht gefunden/);
      await assert.rejects(issue({ operation: 'delivery_note', orderId: delivery.id }), /Auftragsbestätigung nicht gefunden/, 'a delivery note is not an order');
      for (const source of [order, delivery]) {
        await assert.rejects(issue({ operation: 'correction', kind: 'credit_note', invoiceId: source.id }), /Auftragsbestätigungen und Lieferscheine können nicht korrigiert werden/);
        await assert.rejects(issue({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: source.id }), /Auftragsbestätigungen und Lieferscheine können nicht korrigiert werden/);
      }
      const unissued = await draftInvoice(h.api, { client: 'Entwurf Rechnung' });
      await assert.rejects(issue({ operation: 'correction', kind: 'credit_note', invoiceId: unissued.id }), /Nur gestellte Rechnungen können korrigiert werden/);
      await assert.rejects(issue({ operation: 'revision', invoiceId: unissued.id }), /Nur gestellte Rechnungen können überarbeitet werden/);
      await assert.rejects(issue({ operation: 'correction', kind: 'credit_note', invoiceId: 'does-not-exist' }), /Rechnung nicht gefunden/);
    });

    test('credit notes are capped at the invoice amount in total and a cancellation excludes them', async () => {
      const source = await issueInvoice(h.api, { client: 'Gutschrift AG', items: [offerLine({ quantity: 1, price: 100, total: 100 })] });
      assert.equal(source.amount, 119);
      const credit = (amount?: number) => issue({ operation: 'correction', kind: 'credit_note', invoiceId: source.id, ...(amount === undefined ? {} : { amount }) });
      const first = await credit(59.5) as Record<string, any>;
      assert.equal(first.documentKind, 'credit_note');
      assert.equal(first.amount, 59.5);
      assert.equal(first.sourceDocumentId, source.id);
      await assert.rejects(credit(60), /Alle Korrekturen zusammen wären höher als der Rechnungsbetrag \(119\.00 €\)/);
      await assert.rejects(issue({ operation: 'correction', kind: 'credit_note', invoiceId: source.id, amount: 120 }), /Der Korrekturbetrag ist höher als der Rechnungsbetrag/);
      await assert.rejects(issue({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: source.id }), /eine Stornorechnung ist nicht mehr möglich/);
      const rest = await credit(59.5) as Record<string, any>;
      assert.equal(rest.amount, 59.5);
      await assert.rejects(credit(0.01), /Alle Korrekturen zusammen wären höher/, 'fully credited');

      const other = await issueInvoice(h.api, { client: 'Storno AG' });
      await assert.rejects(issue({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: other.id, amount: 10 }), /Eine Stornorechnung muss die ursprüngliche Rechnung vollständig aufheben/);
      const cancellation = await issue({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: other.id });
      assert.equal(cancellation.documentKind, 'cancellation_invoice');
      assert.equal(cancellation.amount, other.amount);
      await assert.rejects(issue({ operation: 'correction', kind: 'credit_note', invoiceId: other.id, amount: 1 }), /eine Gutschrift ist nicht mehr möglich/);
      await assert.rejects(issue({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: other.id }), /eine Stornorechnung ist nicht mehr möglich/);
    });

    test('revisions of an issued invoice are drafts with the same content, numbered per source and listed under it', async () => {
      const source = await issueInvoice(h.api, { client: 'Revision Kette GmbH' });
      const first = await issue({ operation: 'revision', invoiceId: source.id, reason: 'Adresse falsch' });
      const second = await issue({ operation: 'revision', invoiceId: source.id, reason: 'Zweiter Versuch' });
      for (const revision of [first, second]) {
        assert.equal(revision.status, 'draft', 'a revision is issued explicitly later');
        assert.equal(revision.revisionOfId, source.id);
        assert.equal(revision.sourceDocumentId, source.id);
        assert.equal(revision.rootDocumentId, source.rootDocumentId ?? source.id);
        assert.equal(revision.amount, source.amount);
        assert.deepEqual(plain(revision.items), plain(source.items));
        assert.deepEqual(plain(revision.taxSnapshot), plain(source.taxSnapshot));
        assert.notEqual(revision.number, source.number);
      }
      assert.deepEqual([first.revisionNumber, second.revisionNumber], [1, 2]);
      const listed = await h.raw('GET', `/document-chain/${source.id}/revisions`);
      assert.deepEqual(listed.body.map((entry: { id: string }) => entry.id).sort(), [first.id, second.id].sort());
      assert.equal((await h.api.invoices.list()).find((entry) => entry.id === source.id)!.status, 'open', 'creating a revision leaves the source untouched');
    });

    test('cancelling an advance invoice gives its amount back to the order', async () => {
      const { order } = await orderFromOffer('Storno-Abschlag GmbH');
      const advance = await settle(order, 'advance_invoice', 357);
      await issue({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: advance.id, reason: 'Abschlag storniert' });
      const final = await issueRaw({ operation: 'settlement_invoice', kind: 'final_invoice', orderId: order.id, amount: GROSS, reason: 'Schluss nach Storno' });
      assert.equal(final.status, 200, final.text);
    });

    test('settlement invoices and partial credit notes carry the proportional tax snapshot', async () => {
      const { order } = await orderFromOffer('Steuer GmbH');
      const advance = await settle(order, 'advance_invoice', 357);
      assert.ok(advance.taxSnapshot, 'the advance invoice has a tax snapshot');
      assert.equal(advance.taxSnapshot.grossAmount, 357);
      assert.equal(advance.taxSnapshot.netAmount, 300);
      assert.equal(advance.taxSnapshot.vatAmount, 57);
      const source = await issueInvoice(h.api, { client: 'Teilgutschrift GmbH' });
      const credit = await issue({ operation: 'correction', kind: 'credit_note', invoiceId: source.id, amount: 11.9 });
      assert.equal(credit.taxSnapshot?.grossAmount, 11.9);
      assert.equal(credit.taxSnapshot?.vatAmount, 1.9);
    });

    test('mixed VAT settlements preserve a requested partial credit down to the cent', async () => {
      const offer = await draftOffer(h.api, { client: 'Mixed VAT cents', items: [
        { kind: 'item', description: 'Beratung', quantity: 1, price: 100, total: 100, taxRate: 19 },
        { kind: 'item', description: 'Service', quantity: 1, price: 20, total: 20, taxRate: 7 },
      ] });
      await accept(offer);
      const order = await issue({ operation: 'order_confirmation', offerId: offer.id });
      assert.equal(order.amount, 140.4);
      await settle(order, 'advance_invoice', 40);
      await settle(order, 'partial_invoice', 30);
      const final = await settle(order, 'final_invoice', 70.4);
      const credit = await issue({ operation: 'correction', kind: 'credit_note', invoiceId: final.id, amount: 20 });
      assert.equal(credit.amount, 20);
      assert.equal(credit.taxSnapshot?.grossAmount, 20);
      const stored = (await h.api.invoices.list()).find((invoice) => invoice.id === credit.id)!;
      assert.equal(stored.amount, 20, 'the persisted credit keeps the requested gross amount');
      assert.equal(Math.round((stored.taxSnapshot!.netAmount + stored.taxSnapshot!.vatAmount) * 100), 2000);
      for (const line of stored.items) {
        assert.equal(Math.round(line.quantity * line.price * 100), Math.round(line.total * 100));
      }
      if (product === 'pro') {
        const items = await h.raw('GET', '/accounting/open-items');
        const item = items.body.find((entry: { sourceId: string }) => entry.sourceId === final.id);
        assert.equal(item.allocatedAmount, 20);
        assert.equal(item.residualAmount, 50.4);
        const entries = (await h.raw('GET', '/accounting/journal?limit=5000')).body;
        const entry = entries.find((candidate: { sourceKey: string }) => candidate.sourceKey === `outgoing-correction:${credit.id}`);
        assert.ok(entry, 'the credit is posted');
        const sum = (key: 'debitAmount' | 'creditAmount') => Math.round(entry.lines.reduce((total: number, line: Record<string, number>) => total + line[key], 0) * 100);
        assert.equal(sum('debitAmount'), 2000);
        assert.equal(sum('creditAmount'), 2000);
      }
    });

    test('discounted partial credits preserve unit prices and reject an unrepresentable gross cent before saving', async () => {
      const offer = await draftOffer(h.api, { client: 'Discount cents', items: [
        { kind: 'item', description: 'Rabattierte Leistung', quantity: 1, price: 200, discountPercent: 50, total: 100, taxRate: 19 },
        { kind: 'item', description: 'Kostenlose Leistung', quantity: 1, price: 0, total: 0, taxRate: 19 },
      ] });
      await accept(offer);
      const order = await issue({ operation: 'order_confirmation', offerId: offer.id });
      const invoice = await settle(order, 'final_invoice', 119);
      const credit = await issue({ operation: 'correction', kind: 'credit_note', invoiceId: invoice.id, amount: 11.9 });
      assert.equal(credit.taxSnapshot?.grossAmount, 11.9);
      assert.equal(credit.items[0].price, 200);
      assert.equal(credit.items[0].discountPercent, 50);
      assert.equal(credit.items[0].quantity, 0.1);
      assert.equal(credit.items[1].total, 0);
      const before = (await h.api.invoices.list()).map((entry) => entry.id).sort();
      const refused = await issueRaw({ operation: 'correction', kind: 'credit_note', invoiceId: invoice.id, amount: 0.03 });
      assert.equal(refused.status, 422, refused.text);
      assert.match(refused.text, /nicht centgenau/);
      assert.deepEqual((await h.api.invoices.list()).map((entry) => entry.id).sort(), before);
    });

    // The Lite VAT report; Pro reports VAT from the journal (pro-reporting).
    if (product === 'lite') test('order confirmations and delivery notes never show up in the VAT report', async () => {
      const offer = await draftOffer(h.api, { client: 'USt GmbH', date: '2026-03-02', items: [offerLine()] });
      await accept(offer);
      const dated = { date: '2026-03-10', servicePeriod: '2026-03-10' };
      const order = await issue({ operation: 'order_confirmation', offerId: offer.id, ...dated });
      const delivery = await issue({ operation: 'delivery_note', orderId: order.id, ...dated });
      const report = await h.api.vat.getReport({ from: '2026-03-01', to: '2026-03-31' });
      const sourceIds = new Set(report.sources.map((source) => source.sourceId));
      assert.ok(!sourceIds.has(order.id), 'an order confirmation is not revenue');
      assert.ok(!sourceIds.has(delivery.id), 'a delivery note is not revenue');
      assert.ok(!report.issues.some((issueItem) => issueItem.sourceId === order.id || issueItem.sourceId === delivery.id), 'and raises no tax issue');
    });

    // The Lite VAT report; Pro reports VAT from the journal (pro-reporting).
    if (product === 'lite') test('an advance invoice appears in the VAT report with its output VAT', async () => {
      const offer = await draftOffer(h.api, { client: 'USt Abschlag GmbH', date: '2026-04-02', items: [offerLine()] });
      await accept(offer);
      const dated = { date: '2026-04-10', servicePeriod: '2026-04-10' };
      const order = await issue({ operation: 'order_confirmation', offerId: offer.id, ...dated });
      const advance = await settle(order, 'advance_invoice', 357, dated);
      const report = await h.api.vat.getReport({ from: '2026-04-01', to: '2026-04-30' });
      const issues = report.issues.filter((issueItem) => issueItem.sourceId === advance.id).map((issueItem) => issueItem.code);
      assert.ok(!issues.includes('TAX_SNAPSHOT_REQUIRED'), `the advance invoice is missing its tax split in the VAT report: ${issues}`);
      const advanceSources = report.sources.filter((source) => source.sourceId === advance.id);
      assert.equal(advanceSources.reduce((sum, source) => sum + source.taxCents, 0), 5700, 'the advance invoice carries 57,00 EUR output VAT');
    });

    test('rule violations of the chain are client errors, not server errors', async () => {
      const { order } = await orderFromOffer('Fehlercode GmbH');
      const draft = await draftOffer(h.api, { client: 'Fehlercode Entwurf' });
      const cases: Array<[string, { status: number }]> = [
        ['offer not accepted', await issueRaw({ operation: 'order_confirmation', offerId: draft.id })],
        ['unknown offer', await issueRaw({ operation: 'order_confirmation', offerId: 'nope' })],
        ['unknown order', await issueRaw({ operation: 'delivery_note', orderId: 'nope' })],
        ['over-settlement', await issueRaw({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 99999 })],
        ['unknown invoice', await issueRaw({ operation: 'correction', kind: 'credit_note', invoiceId: 'nope' })],
      ];
      const failures = cases.filter(([, response]) => response.status < 400 || response.status >= 500).map(([label, response]) => `${label} -> ${response.status}`);
      assert.deepEqual(failures, []);
    });

    test('chainList returns the whole chain from the root, nothing for an unknown root', async () => {
      const { order } = await orderFromOffer('Liste GmbH');
      const advance = await settle(order, 'advance_invoice', 119);
      const fromRoot = await h.api.documents.chainList({ rootDocumentId: order.id } as never);
      assert.deepEqual(fromRoot.map((document) => document.id).sort(), [advance.id, order.id].sort());
      assert.deepEqual(await h.api.documents.chainList({ rootDocumentId: 'does-not-exist' } as never), []);
      const revisions = await h.raw('GET', `/document-chain/${order.id}/revisions`);
      assert.equal(revisions.status, 200);
      assert.deepEqual(revisions.body, []);
      assert.ok((await h.raw('GET', '/document-chain/')).status >= 400, 'a missing root id is not a valid request');
    });

    test('chain documents are issued in one step: open, finalized and audited with their history', async () => {
      const { order } = await orderFromOffer('Verlauf GmbH', { reason: 'Auftrag erteilt' });
      const history = (order.history as Array<{ action: string }>).map((entry) => entry.action);
      assert.ok(history.some((entry) => entry.includes('invoice.chain.create') && entry.includes('Auftrag erteilt')));
      assert.ok(history.some((entry) => entry.includes('invoice.update') && entry.includes('finalisiert')));
      assert.equal((await h.api.audit.verify()).ok, true);
      const csv = await h.api.audit.exportCsv();
      assert.ok(csv.includes('invoice.chain.create'));
    });
  });

  describe('idempotent issuing', () => {
    test('replaying an operation id returns the recorded document and consumes no number', async () => {
      const { order } = await orderFromOffer('Replay GmbH');
      const operation = { operation: 'settlement_invoice', kind: 'advance_invoice', orderId: order.id, amount: 357, id: randomUUID(), reason: 'Abschlag' };
      const first = await issue(operation);
      const second = await issue(operation);
      assert.equal(second.id, first.id);
      assert.equal(second.number, first.number);
      assert.deepEqual(second.history, first.history);
      const raw = await issueRaw({ ...operation });
      assert.equal(raw.status, 200);
      assert.equal(raw.body.id, first.id);
      const chain = await h.api.documents.chainList({ rootDocumentId: order.id } as never);
      assert.equal(chain.filter((document) => document.documentKind === 'advance_invoice').length, 1, 'one advance invoice despite three requests');
      const next = await h.api.numbers.reserve({ kind: 'invoice' });
      assert.equal(numberOf(next.number), numberOf(first.number) + 1, 'replays consumed no number');
      await h.api.numbers.release({ reservationId: next.reservationId });
      await settle(order, 'partial_invoice', 119);
      const final = await settle(order, 'final_invoice', 714);
      assert.equal(final.amount, 714, 'the advance invoice was charged against the order exactly once');
    });

    test('a changed intent for the same operation id is a 409 that creates nothing', async () => {
      const { order } = await orderFromOffer('Intent GmbH');
      const operation = { operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 100, id: randomUUID(), date: today(), reason: 'Teil' };
      const first = await issue(operation);
      for (const change of [{ amount: 101 }, { date: addDays(today(), 1) }, { reason: 'anderer Grund' }, { kind: 'advance_invoice' }, { dueDate: addDays(today(), 30) }, { servicePeriod: today() }]) {
        const response = await h.raw('POST', '/document-chain/issue', { ...operation, ...change });
        assert.equal(response.status, 409, `${Object.keys(change)}: ${response.text}`);
        assert.match(response.body.message, /Issuance intent differs/);
      }
      assert.equal((await h.api.documents.chainList({ rootDocumentId: order.id } as never)).filter((document) => document.documentKind !== 'order_confirmation').length, 1);
      const replay = await issue(operation);
      assert.equal(replay.id, first.id, 'the original intent still replays');
    });

    test('concurrent identical requests produce one document and one number', async () => {
      const { order } = await orderFromOffer('Parallel GmbH');
      const operation = { operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 119, id: randomUUID(), date: today(), reason: 'parallel' };
      const results = await Promise.all([1, 2, 3, 4].map(() => h.raw('POST', '/document-chain/issue', operation)));
      for (const result of results) assert.equal(result.status, 200, result.text);
      assert.equal(new Set(results.map((result) => result.body.id)).size, 1);
      assert.equal(new Set(results.map((result) => result.body.number)).size, 1);
      assert.equal((await h.api.documents.chainList({ rootDocumentId: order.id } as never)).filter((document) => document.documentKind === 'partial_invoice').length, 1);
    });

    test('concurrent different settlements cannot exceed the order together', async () => {
      const { order } = await orderFromOffer('Wettlauf GmbH');
      const attempts = await Promise.all([1, 2, 3].map(() => issueRaw({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 600 })));
      const accepted = attempts.filter((attempt) => attempt.status === 200);
      assert.equal(accepted.length, 1, `only one 600 EUR settlement fits into 1190 EUR: ${attempts.map((attempt) => attempt.status)}`);
      const billed = (await h.api.documents.chainList({ rootDocumentId: order.id } as never)).filter((document) => document.documentKind === 'partial_invoice');
      assert.equal(billed.length, 1);
    });

    test('an operation id that already names another document is refused and that document is untouched', async () => {
      const { order } = await orderFromOffer('Kollision GmbH');
      const response = await h.raw('POST', '/document-chain/issue', { operation: 'delivery_note', id: order.id, orderId: order.id, date: today(), reason: 'Kollision' });
      assert.equal(response.status, 409, response.text);
      const invoice = await issueInvoice(h.api, { client: 'Besetzte Id' });
      const second = await issueRaw({ operation: 'delivery_note', id: invoice.id, orderId: order.id });
      assert.equal(second.status, 409);
      assert.equal((await h.api.invoices.list()).find((entry) => entry.id === invoice.id)!.client, 'Besetzte Id');
    });

    test('a failed issue leaves no number gap and no document, and the same id can be retried', async () => {
      const { order } = await orderFromOffer('Fehlversuch GmbH');
      const probe = await h.api.numbers.reserve({ kind: 'invoice' });
      await h.api.numbers.release({ reservationId: probe.reservationId });
      const id = randomUUID();
      const failing = await h.raw('POST', '/document-chain/issue', { operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 99999, id, date: today(), reason: 'zu viel' });
      assert.ok(failing.status >= 400);
      assert.equal((await h.api.invoices.list()).some((entry) => entry.id === id), false, 'nothing half-written');
      const retry = await h.raw('POST', '/document-chain/issue', { operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 119, id, date: today(), reason: 'jetzt richtig' });
      assert.equal(retry.status, 200, retry.text);
      assert.equal(retry.body.number, probe.number, 'the failed attempt burned no number');
      assert.equal(retry.body.id, id);
    });

    test('operations are validated before anything is reserved', async () => {
      const { order } = await orderFromOffer('Validierung Kette GmbH');
      assert.equal((await h.raw('POST', '/document-chain/issue', { operation: 'bogus', id: randomUUID(), date: today(), reason: 'x' })).status, 400);
      assert.equal((await h.raw('POST', '/document-chain/issue', { operation: 'delivery_note', id: randomUUID(), orderId: order.id, date: today(), reason: '' })).status, 400, 'a reason is required');
      assert.equal((await h.raw('POST', '/document-chain/issue', { operation: 'delivery_note', orderId: order.id, date: today(), reason: 'x' })).status, 400, 'an operation id is required');
      assert.equal((await h.raw('POST', '/document-chain/issue', { operation: 'delivery_note', id: '', orderId: order.id, date: today(), reason: 'x' })).status, 400);
      assert.equal((await h.raw('POST', '/document-chain/issue', { operation: 'delivery_note', id: randomUUID(), date: today(), reason: 'x' })).status, 400, 'an order id is required');
      assert.equal((await h.raw('POST', '/document-chain/issue', { operation: 'delivery_note', id: randomUUID(), orderId: order.id, reason: 'x' })).status, 400, 'a date is required');
      assert.equal((await h.raw('POST', '/document-chain/issue', { operation: 'delivery_note', id: randomUUID(), orderId: order.id, date: today(), reason: 'x', number: 'RE-CLIENT-CHOSEN' })).status, 200, 'a client-chosen number is ignored');
      await assert.rejects(h.api.documents.chainIssue({ operation: 'delivery_note', id: randomUUID(), orderId: order.id, date: today(), reason: '' } as never));
      assert.equal((await h.raw('POST', '/document-chain/issue')).status, 400);
    });
  });

  describe('access control', () => {
    test('offer, conversion, chain and portal routes refuse requests without the local token', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/offers'], ['GET', '/offers/x'], ['POST', '/offers', {}], ['DELETE', '/offers/x', { reason: 'x' }],
        ['POST', '/documents/convert-offer', { offerId: 'x', invoiceId: randomUUID() }],
        ['POST', '/document-chain/issue', {}], ['GET', '/document-chain/x'], ['GET', '/document-chain/x/revisions'],
        ['POST', '/numbers/reserve', { kind: 'offer' }], ['POST', '/portal/publish-offer', { offerId: 'x' }],
        ['POST', '/portal/publish-invoice', { invoiceId: 'x' }], ['POST', '/portal/sync-offer-status', { offerId: 'x' }],
        ['POST', '/portal/customer-access-link', { customerRef: 'x' }], ['GET', '/portal/health?baseUrl=http://127.0.0.1:1'],
      ];
      for (const [method, path, body] of routes) {
        const response = await fetch(`${h.connection.baseUrl}/api/v1/${product}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        assert.equal(response.status, 401, `${method} ${path} without a token`);
        const forged = await fetch(`${h.connection.baseUrl}/api/v1/${product}${path}`, { method, headers: { 'x-billme-local-token': 'wrong', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        assert.equal(forged.status, 401, `${method} ${path} with a wrong token`);
      }
    });
  });

  describe('legacy chain creation with a client-chosen number', () => {
    test('chainCreate stores a draft chain document with the number the caller chose', async () => {
      const { order } = await orderFromOffer('Legacy GmbH');
      const created = await h.api.documents.chainCreate({ operation: 'delivery_note', id: randomUUID(), number: `LS-IT-${randomUUID().slice(0, 6)}`, orderId: order.id, date: today(), reason: 'manuell' } as never);
      assert.equal(created.documentKind, 'delivery_note');
      assert.equal(created.status, 'draft');
      assert.equal(created.sourceDocumentId, order.id);
      assert.equal(created.rootDocumentId, order.id);
      await assert.rejects(h.api.documents.chainCreate({ operation: 'delivery_note', id: randomUUID(), number: 'LS-X', orderId: 'does-not-exist', date: today(), reason: 'x' } as never), /Auftragsbestätigung nicht gefunden/);
    });
  });

  describe('draft chain routes with a client-chosen number (CLI)', () => {
    const create = (operation: string, body: Record<string, unknown>) =>
      h.raw('POST', `/document-chain/${{ order_confirmation: 'order-confirmations', delivery_note: 'delivery-notes', settlement_invoice: 'settlement-invoices', correction: 'corrections', revision: 'revisions' }[operation]}`, { id: randomUUID(), number: `FREI-${randomUUID().slice(0, 8)}`, date: today(), reason: 'CLI', ...body });

    test('every operation stores a draft of its kind under its source; issuing it takes a reserved number', async () => {
      const offer = await draftOffer(h.api, { client: 'Entwurfskette', items: [offerLine()] });
      assert.equal((await create('order_confirmation', { offerId: offer.id })).status, 422, 'an offer must be accepted first');
      await accept(offer);
      const order = await create('order_confirmation', { offerId: offer.id });
      assert.equal(order.status, 200, order.text);
      assert.deepEqual([order.body.status, order.body.documentKind, order.body.sourceDocumentId], ['draft', 'order_confirmation', offer.id]);

      const { order: issuedOrder } = await orderFromOffer('Entwurfskette Auftrag');
      const advance = await create('settlement_invoice', { orderId: issuedOrder.id, kind: 'advance_invoice', amount: 119 });
      assert.equal(advance.status, 200, advance.text);
      assert.deepEqual([advance.body.status, advance.body.documentKind, advance.body.rootDocumentId], ['draft', 'advance_invoice', issuedOrder.id]);
      assert.equal((await create('settlement_invoice', { orderId: issuedOrder.id, kind: 'advance_invoice', amount: 999_999 })).status, 422, 'more than the order');

      const source = await issueInvoice(h.api, { client: 'Entwurfskette Rechnung' });
      const credit = await create('correction', { invoiceId: source.id, kind: 'credit_note', amount: 10 });
      assert.equal(credit.status, 200, credit.text);
      assert.deepEqual([credit.body.status, credit.body.documentKind, credit.body.sourceDocumentId], ['draft', 'credit_note', source.id]);
      const revision = await create('revision', { invoiceId: source.id });
      assert.equal(revision.status, 200, revision.text);
      assert.deepEqual([revision.body.status, revision.body.revisionOfId], ['draft', source.id]);
      assert.deepEqual((await h.raw('GET', `/document-chain/${source.id}/revisions`)).body.map((doc: { id: string }) => doc.id), [revision.body.id]);

      const next = await h.api.numbers.reserve({ kind: 'invoice' });
      await h.api.numbers.release({ reservationId: next.reservationId });
      const draft = (await h.api.invoices.list()).find((invoice) => invoice.id === credit.body.id)!;
      const issued = await h.api.invoices.upsert({ reason: 'Gutschrift stellen', invoice: { ...draft, status: 'open' } });
      assert.equal(issued.number, next.number, 'the free number of the draft is replaced by the next reserved one');
    });

    test('a used number, an unknown source, a missing reason and a draft source are refused and store nothing', async () => {
      const source = await issueInvoice(h.api, { client: 'Entwurfskette Fehler' });
      const before = (await h.api.invoices.list()).length;
      assert.equal((await create('correction', { invoiceId: source.id, kind: 'cancellation_invoice', number: source.number })).status, 409);
      assert.equal((await create('correction', { invoiceId: 'gibt-es-nicht', kind: 'credit_note', amount: 1 })).status, 404);
      assert.equal((await create('revision', { invoiceId: source.id, reason: ' ' })).status, 400);
      assert.equal((await create('correction', { invoiceId: source.id, kind: 'refund' })).status, 400);
      const draft = await draftInvoice(h.api, { client: 'Entwurf' });
      assert.equal((await create('revision', { invoiceId: draft.id })).status, 422, 'only finalized invoices can be revised');
      assert.equal((await h.api.invoices.list()).length, before + 1, 'only the draft of this test was added');
    });
  });

  describe('through the offer portal', () => {
    let portal: PortalHandle;
    let previousKey: string | undefined;
    before(async () => {
      portal = await startPortal({ suite: 'offers-portal', store: 'sqlite' });
      previousKey = process.env.PORTAL_API_KEY;
      process.env.PORTAL_API_KEY = portal.apiKey!;
      await setBaseUrl(portal.baseUrl);
    });
    after(async () => {
      if (previousKey === undefined) delete process.env.PORTAL_API_KEY; else process.env.PORTAL_API_KEY = previousKey;
      await setBaseUrl('');
      await portal.close();
    });

    const setBaseUrl = async (baseUrl: string) => {
      const settings = (await h.api.settings.get())!;
      await h.api.settings.set({ settings: { ...settings, portal: { baseUrl } } } as never);
    };
    const accepted = { decision: 'accepted', acceptedName: 'Max Kunde', acceptedEmail: 'Max.Kunde@Example.COM', decisionTextVersion: 'v1' };
    const declined = { decision: 'declined', acceptedName: 'Dora Dagegen', acceptedEmail: 'dora@example.com', decisionTextVersion: 'v1' };
    const customerDecides = (token: string, body: Record<string, unknown> = accepted) =>
      portal.request('POST', `/offers/${token}/decision`, { json: body, headers: { origin: portal.baseUrl } });
    const publishedOffer = async (client = 'Portal GmbH', input: Parameters<typeof draftOffer>[1] = {}) => {
      const offer = await draftOffer(h.api, { client, ...input });
      const publication = await h.api.portal.publishOffer({ offerId: offer.id });
      return { offer, publication };
    };
    const portalSnapshot = async (token: string) => (await portal.request('GET', `/offers/${token}`)).json;

    test('health answers for a running portal, and unreachable or insecure portals are explained', async () => {
      const health = await h.api.portal.health({ baseUrl: portal.baseUrl });
      assert.equal(health.ok, true);
      assert.ok(Number.isFinite(Date.parse(health.ts)));
      await assert.rejects(h.api.portal.health({ baseUrl: 'http://example.com' }), /https/);
      await assert.rejects(h.api.portal.health({ baseUrl: 'not a url' }), /ungültig/);
      await assert.rejects(h.api.portal.health({ baseUrl: 'http://127.0.0.1:1' }), /nicht erreichbar/);
    });

    test('publishing needs a configured portal and a known offer', async () => {
      const offer = await draftOffer(h.api, { client: 'Unkonfiguriert GmbH' });
      await setBaseUrl('');
      try {
        assert.equal((await h.raw('POST', '/portal/publish-offer', { offerId: offer.id })).status, 503);
        assert.equal((await h.raw('POST', '/portal/sync-offer-status', { offerId: offer.id })).status, 503);
        assert.equal((await h.raw('POST', '/portal/customer-access-link', { customerRef: 'client-x' })).status, 503);
      } finally { await setBaseUrl(portal.baseUrl); }
      await assert.rejects(h.api.portal.publishOffer({ offerId: 'does-not-exist' }), /not found/i);
      await assert.rejects(h.api.portal.syncOfferStatus({ offerId: 'does-not-exist' }), /not found/i);
      assert.equal((await h.raw('POST', '/portal/publish-offer', { offerId: '' })).status, 400);
      assert.equal((await h.raw('POST', '/portal/publish-offer', {})).status, 400);
    });

    test('a published offer reaches the portal as a snapshot without its token and is marked as published', async () => {
      const { offer, publication } = await publishedOffer('Snapshot Kunde GmbH', { items: [offerLine()] });
      assert.equal(publication.ok, true);
      assert.ok(publication.token.length >= 16);
      assert.equal(publication.publicUrl, `${portal.baseUrl}/offers/${publication.token}`);
      const stored = await offerOf(offer.id);
      assert.equal(stored.shareToken, publication.token);
      assert.ok(stored.sharePublishedAt && Math.abs(Date.parse(stored.sharePublishedAt) - Date.now()) < 60_000);
      assert.ok(stored.history?.some((entry: { action: string }) => entry.action.startsWith('offer.publish')));

      const onPortal = await portalSnapshot(publication.token);
      assert.equal(onPortal.snapshot.number, offer.number);
      assert.equal(onPortal.snapshot.client, 'Snapshot Kunde GmbH');
      assert.equal(onPortal.snapshot.amount, offer.amount);
      assert.equal(onPortal.snapshot.items.length, 1);
      assert.equal(onPortal.snapshot.validUntil, offer.dueDate);
      assert.equal(onPortal.expiresAt, offer.dueDate, 'the link expires with the offer');
      assert.equal(onPortal.decision, null);
      assert.ok(!JSON.stringify(onPortal.snapshot).includes(publication.token), 'the bearer token is not part of the stored snapshot');
      assert.equal(onPortal.snapshot.share?.token, undefined);
      const html = await portal.request('GET', `/offers/${publication.token}`, { headers: { accept: 'text/html' } });
      const page = await portal.request('GET', String(html.headers.location), { headers: { accept: 'text/html' } });
      assert.ok(page.text.includes(offer.number) && page.text.includes('Snapshot Kunde GmbH'));
    });

    test('publishing again keeps the token, even when two requests race, and an explicit expiry is honoured', async () => {
      const offer = await draftOffer(h.api, { client: 'Stabil GmbH' });
      const [a, b] = await Promise.all([h.api.portal.publishOffer({ offerId: offer.id }), h.api.portal.publishOffer({ offerId: offer.id })]);
      assert.equal(a.token, b.token);
      const later = await h.api.portal.publishOffer({ offerId: offer.id, expiresAt: '2099-01-01T00:00:00.000Z' });
      assert.equal(later.token, a.token);
      assert.equal((await portalSnapshot(a.token)).expiresAt, '2099-01-01T00:00:00.000Z');
    });

    test('the customer accepts on the portal and a sync brings name, time and status into the offer', async () => {
      const { offer, publication } = await publishedOffer('Zusage Kunde GmbH', { items: [offerLine()] });
      const before = await offerOf(offer.id);
      const none = await h.api.portal.syncOfferStatus({ offerId: offer.id });
      assert.deepEqual(none, { ok: true, decision: null, updated: false });
      assert.equal((await offerOf(offer.id)).status, before.status, 'nothing changes without a decision');

      const decided = await customerDecides(publication.token);
      assert.equal(decided.status, 200, decided.text);
      assert.equal((await offerOf(offer.id)).shareDecision, null, 'the desktop only learns of it on sync');

      const sync = await h.api.portal.syncOfferStatus({ offerId: offer.id });
      assert.equal(sync.updated, true);
      assert.equal(sync.decision?.decision, 'accepted');
      const stored = await offerOf(offer.id);
      assert.equal(stored.status, 'accepted');
      assert.equal(stored.shareDecision, 'accepted');
      assert.equal(stored.acceptedBy, 'Max Kunde');
      assert.equal(stored.acceptedEmail, 'max.kunde@example.com');
      assert.equal(stored.shareDecisionTextVersion, 'v1');
      assert.equal(stored.acceptedAt, decided.json.decision.decidedAt);
      assert.equal(stored.shareToken, publication.token, 'the publication stays');
      assert.ok(stored.history?.some((entry: { action: string }) => entry.action.startsWith('offer.portal_decision')));
      assert.equal(stored.amount, offer.amount, 'the offer content is unchanged');

      const again = await h.api.portal.syncOfferStatus({ offerId: offer.id });
      assert.equal(again.updated, false, 'the second sync changes nothing');
      assert.equal(again.decision?.decision, 'accepted');
      const csv = await h.api.audit.exportCsv();
      const decisionRows = csv.split('\n').filter((row) => row.includes(offer.id) && row.includes('offer.portal_decision'));
      assert.equal(decisionRows.length, 1, 'the decision is audited exactly once');
      assert.equal((await h.api.audit.verify()).ok, true);
    });

    test('the typed offer list keeps working after the portal accepted or declined an offer', async () => {
      const { offer, publication } = await publishedOffer('Listenbruch GmbH');
      assert.equal((await customerDecides(publication.token)).status, 200);
      await h.api.portal.syncOfferStatus({ offerId: offer.id });
      const list = await h.api.offers.list();
      assert.equal(list.find((entry) => entry.id === offer.id)?.shareDecision, 'accepted');
    });

    test('two syncs at the same time apply the decision once', async () => {
      const { offer, publication } = await publishedOffer('Parallel Sync GmbH');
      assert.equal((await customerDecides(publication.token)).status, 200);
      const results = await Promise.all([1, 2, 3].map(() => h.api.portal.syncOfferStatus({ offerId: offer.id })));
      assert.equal(results.filter((result) => result.updated).length, 1, 'exactly one sync wins');
      assert.ok(results.every((result) => result.decision?.decision === 'accepted'));
      const csv = await h.api.audit.exportCsv();
      assert.equal(csv.split('\n').filter((row) => row.includes(offer.id) && row.includes('offer.portal_decision')).length, 1, 'audited once');
    });

    test('a portal-accepted offer drives the order chain and the conversion', async () => {
      const { offer, publication } = await publishedOffer('Folge GmbH', { items: [offerLine()] });
      await customerDecides(publication.token);
      await h.api.portal.syncOfferStatus({ offerId: offer.id });
      const order = await h.api.documents.chainIssue({ operation: 'order_confirmation', id: randomUUID(), offerId: offer.id, date: today(), reason: 'Zusage per Portal' } as never);
      assert.equal(order.documentKind, 'order_confirmation');
      assert.equal(order.amount, GROSS);
      const invoice = await h.api.documents.convertOfferToInvoice({ offerId: offer.id });
      assert.equal(invoice.sourceDocumentId, offer.id);
    });

    test('a declined offer is recorded as declined and cannot open an order', async () => {
      const { offer, publication } = await publishedOffer('Absage Kunde GmbH');
      assert.equal((await customerDecides(publication.token, declined)).status, 200);
      const sync = await h.api.portal.syncOfferStatus({ offerId: offer.id });
      assert.equal(sync.updated, true);
      assert.equal(sync.decision?.decision, 'declined');
      const stored = await offerOf(offer.id);
      assert.equal(stored.status, 'declined');
      assert.equal(stored.shareDecision, 'declined');
      assert.equal(stored.acceptedBy, 'Dora Dagegen');
      await assert.rejects(h.api.documents.chainIssue({ operation: 'order_confirmation', id: randomUUID(), offerId: offer.id, date: today(), reason: 'trotzdem' } as never), /muss angenommen sein/);
    });

    test('a manually recorded decision is never overwritten by a later portal decision', async () => {
      const { offer, publication } = await publishedOffer('Manuell GmbH');
      const current = await offerOf(offer.id);
      await h.api.offers.upsert({ reason: 'Angebot manuell als angenommen markiert', offer: { ...current, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } } as never);
      assert.equal((await customerDecides(publication.token, declined)).status, 200);
      const sync = await h.api.portal.syncOfferStatus({ offerId: offer.id });
      assert.equal(sync.updated, false);
      assert.equal(sync.decision?.decision, 'declined', 'the portal still reports what the customer clicked');
      const stored = await offerOf(offer.id);
      assert.equal(stored.shareDecision, 'accepted', 'the recorded decision stands');
      assert.equal(stored.acceptedBy, null);
    });

    test('syncing needs a published offer', async () => {
      const offer = await draftOffer(h.api, { client: 'Unveröffentlicht GmbH' });
      const response = await h.raw('POST', '/portal/sync-offer-status', { offerId: offer.id });
      assert.equal(response.status, 409);
      assert.match(response.body.message, /not been published/);
    });

    test('an offer published with an expiry in the past cannot be decided and a sync finds nothing', async () => {
      const offer = await draftOffer(h.api, { client: 'Abgelaufen GmbH' });
      const publication = await h.api.portal.publishOffer({ offerId: offer.id, expiresAt: '2000-01-01T00:00:00.000Z' });
      const response = await customerDecides(publication.token);
      assert.equal(response.status, 410);
      const sync = await h.api.portal.syncOfferStatus({ offerId: offer.id });
      assert.deepEqual(sync, { ok: true, decision: null, updated: false });
      assert.notEqual((await offerOf(offer.id)).status, 'accepted');
    });

    test('an offer is still acceptable on its last day of validity', async () => {
      const { offer, publication } = await publishedOffer('Letzter Tag GmbH', { dueDate: today() });
      assert.equal((await offerOf(offer.id)).dueDate, today());
      const response = await customerDecides(publication.token);
      assert.equal(response.status, 200, `the offer is valid until ${today()} but the portal answered ${response.status}`);
    });

    test('a customer decision is not lost when the offer is published again', async () => {
      const { offer, publication } = await publishedOffer('Neu veröffentlicht GmbH');
      assert.equal((await customerDecides(publication.token)).status, 200);
      await h.api.portal.publishOffer({ offerId: offer.id });
      const sync = await h.api.portal.syncOfferStatus({ offerId: offer.id });
      assert.equal(sync.updated, true, 'the acceptance must still be there');
    });

    test('a rejected API key leaves the reserved token in place and the retry reuses it', async () => {
      const offer = await draftOffer(h.api, { client: 'Falscher Schlüssel GmbH' });
      process.env.PORTAL_API_KEY = 'wrong-key';
      try {
        await assert.rejects(h.api.portal.publishOffer({ offerId: offer.id }));
      } finally { process.env.PORTAL_API_KEY = portal.apiKey!; }
      const reserved = await offerOf(offer.id);
      assert.ok(reserved.shareToken, 'the token is reserved before the call');
      assert.equal(reserved.sharePublishedAt, null, 'but the offer is not marked as published');
      assert.equal((await portal.request('GET', `/offers/${reserved.shareToken}`)).status, 404, 'the portal stored nothing');
      const retried = await h.api.portal.publishOffer({ offerId: offer.id });
      assert.equal(retried.token, reserved.shareToken);
      assert.equal((await portal.request('GET', `/offers/${retried.token}`)).status, 200);
      assert.ok((await offerOf(offer.id)).sharePublishedAt);
    });

    test('a wrong API key is reported as such', async () => {
      const offer = await draftOffer(h.api, { client: 'Schlüsselfehler GmbH' });
      process.env.PORTAL_API_KEY = 'wrong-key';
      try {
        await assert.rejects(h.api.portal.publishOffer({ offerId: offer.id }), /API-Key ungültig/);
      } finally { process.env.PORTAL_API_KEY = portal.apiKey!; }
    });

    test('the raw bearer token is not written to the audit log', async () => {
      const { offer, publication } = await publishedOffer('Audit Token GmbH');
      await h.api.offers.upsert({ reason: 'nachbearbeitet', offer: await offerOf(offer.id) } as never);
      await customerDecides(publication.token);
      await h.api.portal.syncOfferStatus({ offerId: offer.id });
      const csv = await h.api.audit.exportCsv();
      const leaking = csv.split('\n').filter((row) => row.includes(publication.token)).map((row) => /offer\.[a-z_.]+/.exec(row)?.[0] ?? 'unknown');
      assert.deepEqual(leaking, [], 'only the token hash belongs into the audit trail');
      assert.ok(csv.includes('offer.publish'));
    });

    test('customer access links are scoped to the customer, expire with the portal and are revoked by rotation', async () => {
      const mine = newClient({ company: 'Link Kunde AG' });
      const other = newClient({ company: 'Fremd Kunde AG' });
      await h.api.clients.upsert({ client: mine } as never);
      await h.api.clients.upsert({ client: other } as never);
      const myOffer = await draftOffer(h.api, { client: mine.company, clientId: mine.id });
      const otherOffer = await draftOffer(h.api, { client: other.company, clientId: other.id });
      await h.api.portal.publishOffer({ offerId: myOffer.id });
      await h.api.portal.publishOffer({ offerId: otherOffer.id });

      const link = await h.api.portal.createCustomerAccessLink({ customerRef: mine.id, customerLabel: mine.company, expiresInDays: 7 });
      assert.ok(link.token.length >= 16);
      assert.equal(link.publicUrl, `${portal.baseUrl}/customers/${link.token}`);
      assert.ok(Math.abs((Date.parse(link.expiresAt) - Date.now()) / 86_400_000 - 7) < 0.01);
      const listing = await portal.request('GET', `/customers/${link.token}/documents`);
      assert.equal(listing.status, 200);
      assert.deepEqual(listing.json.items.map((item: { number: string }) => item.number), [myOffer.number], 'only this customer\'s offer');
      assert.equal(listing.json.items[0].status, 'Offen');
      assert.ok(!JSON.stringify(listing.json).includes(mine.id), 'the internal customer reference is not exposed');

      const rotated = await h.api.portal.rotateCustomerAccessLink({ customerRef: mine.id, customerLabel: mine.company, expiresInDays: 30 });
      assert.notEqual(rotated.token, link.token);
      const old = await portal.request('GET', `/customers/${link.token}/documents`);
      assert.equal(old.status, 403);
      assert.deepEqual(old.json, { error: 'revoked' });
      assert.equal((await portal.request('GET', `/customers/${rotated.token}/documents`)).status, 200);
      const otherLink = await h.api.portal.createCustomerAccessLink({ customerRef: other.id });
      assert.deepEqual((await portal.request('GET', `/customers/${otherLink.token}/documents`)).json.items.map((item: { number: string }) => item.number), [otherOffer.number]);
      assert.equal((await portal.request('GET', `/customers/${rotated.token}/documents`)).json.items.length, 1, 'rotating another customer\'s link changes nothing here');
    });

    test('access link requests are validated', async () => {
      await assert.rejects(h.api.portal.createCustomerAccessLink({ customerRef: '' } as never));
      assert.equal((await h.raw('POST', '/portal/customer-access-link', { customerRef: 'x', expiresInDays: 366 })).status, 400);
      assert.equal((await h.raw('POST', '/portal/customer-access-link', { customerRef: 'x', expiresInDays: 0 })).status, 400);
      assert.equal((await h.raw('POST', '/portal/customer-access-link', { customerRef: 'x', expiresInDays: 1.5 })).status, 400);
      assert.equal((await h.raw('POST', '/portal/customer-access-link/rotate', {})).status, 400);
    });

    test('a published invoice follows its payments and cannot be decided', async () => {
      const client = newClient({ company: 'Rechnung Portal AG' });
      await h.api.clients.upsert({ client } as never);
      const invoice = await issueInvoice(h.api, { client: client.company, clientId: client.id });
      const publication = await h.api.portal.publishInvoice({ invoiceId: invoice.id });
      assert.equal(publication.publicUrl, `${portal.baseUrl}/invoices/${publication.token}`);
      const snapshot = (await portal.request('GET', `/invoices/${publication.token}`)).json;
      assert.equal(snapshot.snapshot.number, invoice.number);
      assert.equal(snapshot.snapshot.amount, invoice.amount);
      assert.equal(snapshot.snapshot.status, 'open');
      assert.ok(Math.abs((Date.parse(snapshot.expiresAt) - Date.now()) / 86_400_000 - 365) < 0.1, 'invoices stay reachable for a year by default');
      assert.equal((await customerDecides(publication.token)).status, 404, 'an invoice has no decision');
      const link = await h.api.portal.createCustomerAccessLink({ customerRef: client.id });
      assert.equal((await portal.request('GET', `/customers/${link.token}/documents`)).json.items[0].status, 'Offen');

      await h.api.invoices.savePayment({ invoiceId: invoice.id, payment: { id: randomUUID(), date: today(), amount: invoice.amount, method: 'bank' }, reason: 'bezahlt' });
      const again = await h.api.portal.publishInvoice({ invoiceId: invoice.id });
      assert.equal(again.token, publication.token, 'the same link, refreshed');
      assert.equal((await portal.request('GET', `/invoices/${publication.token}`)).json.snapshot.status, 'paid');
      const paid = await portal.request('GET', `/customers/${link.token}/documents`);
      assert.equal(paid.json.items[0].status, 'Bezahlt');
      const page = await portal.request('GET', String(paid.json.items[0].url), { headers: { accept: 'text/html' } });
      assert.match(page.text, /Bezahlt/);
      assert.ok(!page.text.includes('<form'));
      await assert.rejects(h.api.portal.publishInvoice({ invoiceId: 'does-not-exist' }), /not found/i);
      assert.equal((await h.raw('POST', '/portal/publish-invoice', {})).status, 400);
    });

    test('portal calls are audited and the whole audit chain stays valid', async () => {
      const { offer } = await publishedOffer('Audit Portal GmbH');
      const csv = await h.api.audit.exportCsv();
      for (const action of ['offer.portal_token_reserved', 'offer.publish']) assert.ok(csv.includes(action), `${action} missing`);
      assert.ok(csv.includes(offer.id));
      assert.equal((await h.api.audit.verify()).ok, true);
    });
  });
});

describe('Pro: the order chain posts to the journal', () => {
  let p: ProHarness;
  before(async () => { p = await startPro(null, 'offers-pro'); });
  after(async () => { await p.close(); });

  const api = () => p.api as any;
  const issueP = (body: Record<string, unknown>) => api().documents.chainIssue({ id: randomUUID(), date: today(), reason: 'Test', ...body }) as Promise<Record<string, any>>;
  const journalFor = async (id: string, prefix = 'outgoing-invoice') => ((await api().pro.listJournalEntries({})) as Array<Record<string, any>>).filter((entry) => entry.sourceKey === `${prefix}:${id}`);
  const openItemFor = async (id: string) => ((await api().pro.listOpenItems()) as Array<Record<string, any>>).find((item) => item.sourceId === id);
  const sum = (lines: Array<Record<string, any>>, key: 'debitAmount' | 'creditAmount') => cents(lines.reduce((total, line) => total + line[key], 0));
  const cents = (value: number) => Math.round(value * 100);
  const proOrder = async () => {
    const offer = await draftOffer(api(), { client: 'Pro Kette GmbH', items: [offerLine()] });
    await api().offers.upsert({ reason: 'angenommen', offer: { ...offer, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } });
    const order = await issueP({ operation: 'order_confirmation', offerId: offer.id, reason: 'AB' });
    return { offer, order };
  };

  test('order confirmations and delivery notes stay out of the journal and the open items', async () => {
    const { order } = await proOrder();
    const delivery = await issueP({ operation: 'delivery_note', orderId: order.id, reason: 'LS' });
    for (const document of [order, delivery]) {
      assert.deepEqual(await journalFor(document.id), [], `${document.documentKind} is not posted`);
      assert.equal(await openItemFor(document.id), undefined);
    }
    assert.equal(order.status, 'open');
  });

  test('an advance invoice is posted once with its open item, and a replay does not post again', async () => {
    const { order } = await proOrder();
    const operation = { operation: 'settlement_invoice', kind: 'advance_invoice', orderId: order.id, amount: 357, id: randomUUID(), reason: 'Abschlag' };
    const advance = await issueP(operation);
    const entries = await journalFor(advance.id);
    assert.equal(entries.length, 1, 'one journal entry');
    assert.equal(entries[0]!.status, 'posted');
    assert.equal(entries[0]!.reference, advance.number);
    const item = await openItemFor(advance.id);
    assert.ok(item, 'an open item is created');
    assert.equal(item!.partyType, 'debtor');
    assert.equal(item!.documentNumber, advance.number);
    assert.equal(item!.status, 'open');
    assert.ok(advance.history.some((entry: { action: string }) => entry.action.startsWith('accounting_post')));
    const replay = await issueP(operation);
    assert.equal(replay.id, advance.id);
    assert.equal((await journalFor(advance.id)).length, 1, 'a replay posts nothing');
    assert.equal(((await api().pro.listOpenItems()) as Array<Record<string, any>>).filter((entry) => entry.sourceId === advance.id).length, 1);
    assert.equal(entries[0]!.lines.some((line: Record<string, any>) => line.accountNumber === '1776'), true, 'output VAT is booked');
  });

  test('the posting of an advance invoice matches its gross amount and VAT', async () => {
    const { order } = await proOrder();
    const advance = await issueP({ operation: 'settlement_invoice', kind: 'advance_invoice', orderId: order.id, amount: 357, reason: 'Abschlag' });
    const [entry] = await journalFor(advance.id);
    assert.equal(sum(entry!.lines, 'debitAmount'), cents(357), 'receivable debit');
    assert.equal(sum(entry!.lines, 'creditAmount'), cents(357), 'revenue plus VAT credit');
    const vat = entry!.lines.find((line: Record<string, any>) => line.accountNumber === '1776');
    assert.equal(vat.creditAmount, 57, 'output VAT');
    assert.equal((await openItemFor(advance.id))!.originalAmount, 357, 'open item = invoice amount');
  });

  test('all billing documents of an order together book exactly the order amount', async () => {
    const { order } = await proOrder();
    const documents = [
      await issueP({ operation: 'settlement_invoice', kind: 'advance_invoice', orderId: order.id, amount: 357, reason: 'Abschlag' }),
      await issueP({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 119, reason: 'Teil' }),
      await issueP({ operation: 'settlement_invoice', kind: 'final_invoice', orderId: order.id, amount: 714, reason: 'Schluss' }),
    ];
    let booked = 0;
    for (const document of documents) booked += (await openItemFor(document.id))!.originalAmount;
    assert.equal(cents(booked), cents(order.amount));
  });

  test('a credit note is posted as a correction against the source invoice and never exceeds it', async () => {
    const source = await issueInvoice(api(), { client: 'Pro Gutschrift GmbH' });
    const sourceItem = (await openItemFor(source.id))!;
    assert.equal(sourceItem.originalAmount, source.amount);
    const credit = await issueP({ operation: 'correction', kind: 'credit_note', invoiceId: source.id, amount: 23.8, reason: 'Preisnachlass' });
    assert.equal(credit.documentKind, 'credit_note');
    assert.equal((await journalFor(credit.id, 'outgoing-correction')).length, 1, 'the credit note is a posted correction');
    assert.ok((await openItemFor(source.id))!.allocatedAmount > 0, 'it is allocated against the source open item');
    const before = (await openItemFor(source.id))!.allocatedAmount;
    await assert.rejects(issueP({ operation: 'correction', kind: 'credit_note', invoiceId: source.id, amount: source.amount }), /Alle Korrekturen zusammen wären höher/);
    assert.equal((await openItemFor(source.id))!.allocatedAmount, before, 'a refused credit note changes nothing');
  });

  test('a partial credit note allocates its gross amount against the source open item', async () => {
    const source = await issueInvoice(api(), { client: 'Pro Teilgutschrift GmbH' });
    await issueP({ operation: 'correction', kind: 'credit_note', invoiceId: source.id, amount: 23.8, reason: 'Preisnachlass' });
    const after = (await openItemFor(source.id))!;
    assert.equal(cents(after.allocatedAmount), cents(23.8));
    assert.equal(cents(after.residualAmount), cents(source.amount - 23.8));
  });

  test('a cancellation invoice reverses the source: posted once and the source open item is settled', async () => {
    const source = await issueInvoice(api(), { client: 'Pro Storno GmbH' });
    const cancellation = await issueP({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: source.id, reason: 'Storno' });
    assert.equal(cancellation.documentKind, 'cancellation_invoice');
    assert.equal((await journalFor(cancellation.id, 'outgoing-correction')).length, 1);
    assert.equal((await openItemFor(source.id))!.allocatedAmount, source.amount);
  });

  test('a converted offer is a draft without postings; issuing it posts exactly its amount', async () => {
    const offer = await draftOffer(api(), { client: 'Pro Konvertiert GmbH', items: [offerLine()] });
    await api().offers.upsert({ reason: 'angenommen', offer: { ...offer, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } });
    const draft = await api().documents.convertOfferToInvoice({ offerId: offer.id });
    assert.equal(draft.status, 'draft');
    assert.deepEqual(await journalFor(draft.id), [], 'a draft is not posted');
    assert.equal(await openItemFor(draft.id), undefined);
    const open = await api().invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...draft, status: 'open' } });
    assert.equal(open.status, 'open');
    const [entry] = await journalFor(draft.id);
    assert.ok(entry, 'issuing posts the invoice');
    assert.equal(sum(entry!.lines, 'debitAmount'), cents(GROSS));
    assert.equal(sum(entry!.lines, 'creditAmount'), cents(GROSS));
    assert.equal((await openItemFor(draft.id))!.originalAmount, GROSS);
  });

  test('Pro keeps the same offer rules: accepted before the order, one invoice per offer, a replay returns the same order', async () => {
    const draft = await draftOffer(api(), { client: 'Pro Regeln GmbH' });
    await assert.rejects(issueP({ operation: 'order_confirmation', offerId: draft.id }), /muss angenommen sein/);
    const { order } = await proOrder();
    const operation = { operation: 'delivery_note', orderId: order.id, id: randomUUID(), date: today(), reason: 'LS' };
    const first = await issueP(operation);
    assert.equal((await issueP(operation)).id, first.id);
    const response = await p.raw('POST', '/document-chain/issue', { ...operation, date: today(), reason: 'anders' });
    assert.equal(response.status, 409);
    const offer = await draftOffer(api(), { client: 'Pro Doppelt GmbH' });
    await api().offers.upsert({ reason: 'angenommen', offer: { ...offer, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } });
    const a = await api().documents.convertOfferToInvoice({ offerId: offer.id });
    const b = await api().documents.convertOfferToInvoice({ offerId: offer.id });
    assert.equal(a.id, b.id);
  });
});

for (const product of PRODUCTS) test(`offers and the document chain survive an app restart, receipts included (${product})`, async (t) => {
  const first = await startProduct(product, null, 'offers-restart');
  const offer = await draftOffer(first.api, { client: 'Neustart GmbH', items: [offerLine()] });
  await first.api.offers.upsert({ reason: 'angenommen', offer: { ...offer, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } } as never);
  const orderOperation = { operation: 'order_confirmation', id: randomUUID(), offerId: offer.id, date: today(), reason: 'AB' };
  const order = await first.api.documents.chainIssue(orderOperation as never) as Record<string, any>;
  const advanceOperation = { operation: 'settlement_invoice', kind: 'advance_invoice', orderId: order.id, amount: 357, id: randomUUID(), date: today(), reason: 'Abschlag' };
  const advance = await first.api.documents.chainIssue(advanceOperation as never) as Record<string, any>;
  const converted = await draftOffer(first.api, { client: 'Neustart Konvertierung GmbH' });
  await first.api.offers.upsert({ reason: 'angenommen', offer: { ...converted, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } } as never);
  const invoice = await first.api.documents.convertOfferToInvoice({ offerId: converted.id });
  await first.close({ keepData: true });

  const second = await startProduct(product, t, 'offers-restart', first.userDataPath);
  const offers = await second.api.offers.list();
  assert.equal(offers.find((entry) => entry.id === offer.id)!.number, offer.number);
  assert.equal(offers.find((entry) => entry.id === offer.id)!.shareDecision, 'accepted');
  const chain = await second.api.documents.chainList({ rootDocumentId: order.id } as never);
  assert.deepEqual(chain.map((document) => document.id).sort(), [advance.id, order.id].sort());
  assert.equal(chain.find((document) => document.id === advance.id)!.amount, 357);

  const replay = await second.api.documents.chainIssue(advanceOperation as never) as Record<string, any>;
  assert.equal(replay.id, advance.id, 'the receipt of the first run is still honoured');
  assert.equal(replay.number, advance.number);
  const changed = await second.raw('POST', '/document-chain/issue', { ...advanceOperation, amount: 358 });
  assert.equal(changed.status, 409);
  assert.equal((await second.api.documents.convertOfferToInvoice({ offerId: converted.id })).id, invoice.id, 'the conversion is remembered');
  const settle = await second.api.documents.chainIssue({ operation: 'settlement_invoice', kind: 'partial_invoice', orderId: order.id, amount: 119, id: randomUUID(), date: today(), reason: 'Teil' } as never) as Record<string, any>;
  assert.equal(Number(settle.number.split('-').at(-1)), Number(invoice.number.split('-').at(-1)) + 1, 'numbering continues without a gap or reuse');
  const next = await second.api.numbers.reserve({ kind: 'offer' });
  assert.equal(Number(next.number.split('-').at(-1)), Number(converted.number.split('-').at(-1)) + 1);
  assert.equal((await second.api.audit.verify()).ok, true);
});
