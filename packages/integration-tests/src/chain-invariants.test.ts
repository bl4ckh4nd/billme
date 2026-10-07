import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { startHostedServer, uniqueEmail, type HostedServer } from './server-fixtures.js';
import { draftOffer, issueInvoice, today } from './fixtures.js';

/**
 * The document chain under random sequences of operations, through the hosted
 * API on Postgres (PGlite behind the wire front). Each run picks operations from
 * a seeded generator — including ones the rules must refuse — and after every
 * step checks rules that must hold for any sequence. A failure names the seed
 * and the steps so far; rerun one with CHAIN_SEED=<n>.
 *
 * How this can fail (each invariant below catches it):
 * - an answer of 500 instead of a refusal
 * - one offer billed twice (directly converted and through an order confirmation)
 * - an order billed beyond its amount, or with more than one final invoice
 * - a correction of an order confirmation, a delivery note or another correction;
 *   corrections of one invoice adding up to more than the invoice; a Storno that
 *   does not equal the whole invoice or follows another correction
 * - a payment on an order confirmation, delivery note or correction
 * - an issued document whose gross amount differs from its tax snapshot, or a
 *   snapshot whose net and VAT do not add up
 * - a delivery note with an amount
 * - a final invoice that does not list the whole order and deduct the earlier
 *   settlement invoices with their tax (§14 Abs. 5 UStG)
 * - order confirmations or delivery notes taking invoice numbers, duplicate
 *   numbers, a gap in the invoice range
 * - an invoice with an issued Storno that is not cancelled
 */

type Doc = {
  id: string; number: string; status: string; amount: number; documentKind?: string;
  sourceDocumentId?: string; rootDocumentId?: string; revisionOfId?: string;
  payments?: Array<{ amount: number }>;
  items: Array<{ kind?: string; description: string; price: number; quantity: number; total: number; taxRate?: number }>;
  taxSnapshot?: { netAmount: number; vatAmount: number; grossAmount: number; vatBreakdown?: Array<{ rate: number; netAmount: number; vatAmount: number }> };
};

const RECEIVABLE = ['invoice', 'advance_invoice', 'partial_invoice', 'final_invoice'];
const CORRECTION = ['credit_note', 'cancellation_invoice'];
const SETTLEMENT = ['advance_invoice', 'partial_invoice', 'final_invoice'];
const cents = (value: number) => Math.round(value * 100);
const kindOf = (doc: Doc) => doc.documentKind ?? 'invoice';

/** Small deterministic generator (mulberry32), so a failing sequence can be replayed. */
const generator = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <T,>(items: readonly T[]): T | undefined => (items.length ? items[Math.floor(next() * items.length)] : undefined),
    amount: (max: number) => Math.max(0.01, Math.round(next() * max * 100) / 100),
  };
};

describe('document chain invariants under random operation sequences', () => {
  // Each seed gets its own database: the invariants read the whole document list after every step.
  let h: HostedServer;
  let token: string;
  const SEEDS = process.env.CHAIN_SEED ? [Number(process.env.CHAIN_SEED)] : [11, 29, 47, 83];
  const STEPS = Number(process.env.CHAIN_STEPS ?? 70);

  const freshServer = async (seed: number) => {
    h = await startHostedServer(`chain-invariants-${seed}`);
    token = (await h.bootstrap('lite', uniqueEmail('chain'), 'Kette')).token;
    await h.putSettings('lite', token);
  };
  after(async () => { await h?.close(); });

  const list = async () => (await h.http('GET', '/api/v1/lite/invoices', { token })).body as Doc[];
  const offers = async () => (await h.http('GET', '/api/v1/lite/offers', { token })).body as Array<{ id: string; status: string; share?: { decision?: string } }>;
  const chain = (body: Record<string, unknown>) =>
    h.http('POST', '/api/v1/lite/document-chain/issue', { token, body: { id: randomUUID(), date: today(), reason: 'Zufallsfolge', ...body } });

  const checkInvariants = (docs: Doc[], context: string) => {
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    const issued = docs.filter((doc) => doc.status !== 'draft');

    // Offers are billed once.
    const offerSources = new Map<string, Set<string>>();
    for (const doc of docs) {
      if (!doc.sourceDocumentId || byId.has(doc.sourceDocumentId)) continue;
      if (kindOf(doc) === 'order_confirmation' || (kindOf(doc) === 'invoice' && !doc.revisionOfId)) {
        const paths = offerSources.get(doc.sourceDocumentId) ?? new Set<string>();
        paths.add(kindOf(doc) === 'order_confirmation' ? 'order' : 'direct');
        offerSources.set(doc.sourceDocumentId, paths);
      }
    }
    for (const [offerId, paths] of offerSources) assert.ok(paths.size === 1, `${context}: offer ${offerId} billed twice (${[...paths]})`);

    const cancelled = new Set(issued.filter((doc) => kindOf(doc) === 'cancellation_invoice').map((doc) => doc.sourceDocumentId));
    for (const order of issued.filter((doc) => kindOf(doc) === 'order_confirmation')) {
      const settlements = issued.filter((doc) => doc.rootDocumentId === order.id && SETTLEMENT.includes(kindOf(doc)) && !cancelled.has(doc.id));
      const billed = settlements.reduce((sum, doc) => sum + cents(doc.amount), 0);
      assert.ok(billed <= cents(order.amount), `${context}: order ${order.number} billed ${billed / 100} of ${order.amount}`);
      const finals = settlements.filter((doc) => kindOf(doc) === 'final_invoice');
      assert.ok(finals.length <= 1, `${context}: order ${order.number} has ${finals.length} final invoices`);
      for (const final of finals) {
        const earlier = settlements.filter((doc) => doc.id !== final.id && kindOf(doc) !== 'final_invoice');
        const deductions = final.items.filter((line) => line.kind !== 'text' && line.price < 0);
        assert.ok(deductions.length >= earlier.length, `${context}: final ${final.number} deducts ${deductions.length} of ${earlier.length} earlier invoices`);
        for (const doc of earlier) {
          assert.ok(deductions.some((line) => line.description.includes(doc.number)), `${context}: final ${final.number} misses the deduction of ${doc.number}`);
        }
        const orderNet = cents(order.taxSnapshot?.netAmount ?? 0);
        const earlierNet = earlier.reduce((sum, doc) => sum + cents(doc.taxSnapshot?.netAmount ?? 0), 0);
        const finalNetBefore = issued.filter((doc) => doc.rootDocumentId === order.id && SETTLEMENT.includes(kindOf(doc)) && cancelled.has(doc.id));
        if (finalNetBefore.length === 0) {
          assert.equal(cents(final.taxSnapshot?.netAmount ?? 0), orderNet - earlierNet, `${context}: final ${final.number} net is not the order net minus the earlier invoices`);
        }
      }
    }

    for (const correction of issued.filter((doc) => CORRECTION.includes(kindOf(doc)))) {
      const source = byId.get(correction.sourceDocumentId ?? '');
      assert.ok(source, `${context}: correction ${correction.number} without a source`);
      assert.ok(RECEIVABLE.includes(kindOf(source!)), `${context}: ${correction.number} corrects a ${kindOf(source!)}`);
    }
    for (const source of issued.filter((doc) => RECEIVABLE.includes(kindOf(doc)))) {
      const corrections = issued.filter((doc) => doc.sourceDocumentId === source.id && CORRECTION.includes(kindOf(doc)));
      const total = corrections.reduce((sum, doc) => sum + cents(doc.amount), 0);
      assert.ok(total <= cents(source.amount), `${context}: ${source.number} corrected by ${total / 100} of ${source.amount}`);
      const stornos = corrections.filter((doc) => kindOf(doc) === 'cancellation_invoice');
      assert.ok(stornos.length <= 1, `${context}: ${source.number} has ${stornos.length} Stornos`);
      if (stornos.length === 1) {
        assert.equal(cents(stornos[0]!.amount), cents(source.amount), `${context}: Storno ${stornos[0]!.number} is not the whole invoice`);
        assert.equal(corrections.length, 1, `${context}: Storno of ${source.number} besides other corrections`);
        assert.equal(source.status, 'cancelled', `${context}: ${source.number} has a Storno but is ${source.status}`);
      }
    }

    for (const doc of docs) {
      if (!RECEIVABLE.includes(kindOf(doc))) assert.equal(doc.payments?.length ?? 0, 0, `${context}: payment on ${kindOf(doc)} ${doc.number}`);
      if (kindOf(doc) === 'delivery_note') assert.equal(doc.amount, 0, `${context}: delivery note ${doc.number} has an amount`);
      if (doc.status !== 'draft' && doc.taxSnapshot && doc.amount !== 0) {
        assert.equal(cents(doc.taxSnapshot.grossAmount), cents(doc.amount), `${context}: ${doc.number} amount ${doc.amount} ≠ snapshot ${doc.taxSnapshot.grossAmount}`);
        assert.equal(cents(doc.taxSnapshot.netAmount) + cents(doc.taxSnapshot.vatAmount), cents(doc.taxSnapshot.grossAmount), `${context}: ${doc.number} net + VAT ≠ gross`);
      }
    }

    const numbers = docs.map((doc) => doc.number);
    assert.equal(new Set(numbers).size, numbers.length, `${context}: duplicate numbers`);
    for (const doc of docs) {
      const expected = kindOf(doc) === 'order_confirmation' ? /^AB-/ : kindOf(doc) === 'delivery_note' ? /^LS-/ : /^RE-/;
      assert.match(doc.number, expected, `${context}: ${kindOf(doc)} ${doc.number} in the wrong range`);
    }
    const invoiceCounters = docs.filter((doc) => /^RE-/.test(doc.number)).map((doc) => Number(doc.number.split('-').at(-1))).sort((a, b) => a - b);
    invoiceCounters.forEach((counter, index) => assert.equal(counter, invoiceCounters[0]! + index, `${context}: gap in the invoice range at ${counter}`));
  };

  for (const seed of SEEDS) {
    test(`seed ${seed}: every rule holds after each of ${STEPS} random operations`, async () => {
      await h?.close();
      await freshServer(seed);
      const random = generator(seed);
      const log: string[] = [];
      const record = (label: string, status: number, text: string) => {
        log.push(`${label} → ${status}`);
        assert.ok(status < 500, `seed ${seed}, step ${log.length} ${label}: ${status} ${text.slice(0, 300)}\n${log.join('\n')}`);
      };
      const pickDoc = async (filter: (doc: Doc) => boolean) => random.pick((await list()).filter(filter));
      const items = () => {
        const lines = [{ kind: 'item', description: 'Leistung A', quantity: 1 + Math.floor(random.next() * 3), price: 50 + Math.floor(random.next() * 200), taxRate: 19 }];
        if (random.next() < 0.4) lines.push({ kind: 'item', description: 'Leistung B', quantity: 1, price: 10 + Math.floor(random.next() * 50), taxRate: 7 });
        return lines.map((line) => ({ ...line, total: line.quantity * line.price }));
      };

      const operations: Array<[string, () => Promise<void>]> = [
        ['Angebot', async () => {
          const offer = await draftOffer(h.liteApi(token), { client: `Kunde ${seed}`, items: items() as never });
          if (random.next() < 0.8) await h.liteApi(token).offers.upsert({ reason: 'angenommen', offer: { ...offer, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } } as never);
          record('Angebot', 200, '');
        }],
        ['Umwandeln', async () => {
          if (random.next() < 0.5) return;
          const offer = random.pick((await offers()).filter((candidate) => candidate.share?.decision === 'accepted' || random.next() < 0.2));
          if (!offer) return;
          const response = await h.http('POST', '/api/v1/lite/documents/convert-offer', { token, body: { offerId: offer.id, invoiceId: randomUUID() } });
          record('Umwandeln', response.status, response.text);
        }],
        ['Auftragsbestätigung', async () => {
          // Mostly accepted offers, so every seed reaches the order chain; sometimes any offer, to test the refusals.
          const all = await offers();
          const accepted = all.filter((candidate) => candidate.share?.decision === 'accepted');
          const offer = random.pick(random.next() < 0.8 && accepted.length ? accepted : all);
          if (!offer) return;
          const response = await chain({ operation: 'order_confirmation', offerId: offer.id });
          record('Auftragsbestätigung', response.status, response.text);
        }],
        ['Lieferschein', async () => {
          const source = await pickDoc((doc) => random.next() < 0.85 ? kindOf(doc) === 'order_confirmation' : true);
          if (!source) return;
          const response = await chain({ operation: 'delivery_note', orderId: source.id });
          record(`Lieferschein zu ${kindOf(source)}`, response.status, response.text);
        }],
        ['Abrechnung', async () => {
          const source = await pickDoc((doc) => kindOf(doc) === 'order_confirmation');
          if (!source) return;
          const kind = random.pick(SETTLEMENT)!;
          const docs = await list();
          const billed = docs.filter((doc) => doc.rootDocumentId === source.id && SETTLEMENT.includes(kindOf(doc)) && doc.status !== 'draft')
            .reduce((sum, doc) => sum + doc.amount, 0);
          const remaining = Math.max(0.01, Math.round((source.amount - billed) * 100) / 100);
          const amount = kind === 'final_invoice' && random.next() < 0.7 ? remaining : random.amount(source.amount * 0.6);
          const response = await chain({ operation: 'settlement_invoice', orderId: source.id, kind, amount });
          record(`${kind} ${amount}`, response.status, response.text);
        }],
        ['Rechnung', async () => {
          await issueInvoice(h.liteApi(token), { client: `Kunde ${seed}`, items: items() as never });
          record('Rechnung', 200, '');
        }],
        ['Zahlung', async () => {
          const target = await pickDoc((doc) => doc.status !== 'draft');
          if (!target) return;
          const response = await h.http('POST', `/api/v1/lite/invoices/${target.id}/payments`, { token, body: { reason: 'Zahlung', payment: { id: randomUUID(), date: today(), amount: random.amount(Math.max(1, target.amount)), method: 'Überweisung' } } });
          record(`Zahlung auf ${kindOf(target)}`, response.status, response.text);
        }],
        ['Gutschrift', async () => {
          const source = await pickDoc((doc) => doc.status !== 'draft');
          if (!source) return;
          const response = await chain({ operation: 'correction', kind: 'credit_note', invoiceId: source.id, amount: random.amount(Math.max(1, source.amount * 0.7)) });
          record(`Gutschrift auf ${kindOf(source)}`, response.status, response.text);
        }],
        ['Storno', async () => {
          const source = await pickDoc((doc) => doc.status !== 'draft');
          if (!source) return;
          const response = await chain({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: source.id });
          record(`Storno von ${kindOf(source)}`, response.status, response.text);
        }],
        ['Revision', async () => {
          const source = await pickDoc((doc) => doc.status !== 'draft');
          if (!source) return;
          const response = await chain({ operation: 'revision', invoiceId: source.id });
          record(`Revision von ${kindOf(source)} ${source.status}`, response.status, response.text);
          if (response.status === 200 && random.next() < 0.7) {
            const revision = (await list()).find((doc) => doc.id === response.body.id)!;
            const issuedRevision = await h.http('POST', '/api/v1/lite/invoices', { token, body: { reason: 'Revision gestellt', invoice: { ...revision, status: 'open' }, reservationId: response.body.numberReservationId } });
            record('Revision stellen', issuedRevision.status, issuedRevision.text);
          }
        }],
      ];

      for (let step = 1; step <= STEPS; step += 1) {
        const [name, run] = random.pick(operations)!;
        await run();
        checkInvariants(await list(), `seed ${seed}, step ${step} (${name})\n${log.join('\n')}`);
      }
      const docs = await list();
      assert.ok(docs.some((doc) => kindOf(doc) === 'order_confirmation'), 'the run reached the order chain');
      assert.ok(docs.some((doc) => CORRECTION.includes(kindOf(doc))), 'the run reached corrections');
      assert.ok(log.some((entry) => / → 4\d\d$/.test(entry)), 'the run tried something the rules refuse');
    });
  }
});
