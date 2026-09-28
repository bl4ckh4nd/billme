import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  billingLineItemSchema,
  createSingleTenantScope,
  type AuditEntry,
  type Invoice,
  type Offer,
} from '../index.js';
import {
  applyOfferDecision,
  createInvoiceFromOffer,
  listOffersPendingPortalSync,
  publishOffer,
  publishOfferToPortal,
  syncPublishedOfferDecisionsFromPortal,
  upsertOffer,
} from './invoice-offer.js';

const scope = createSingleTenantScope('default', 'lite');

const createInMemoryOfferDependencies = () => {
  const offers = new Map<string, Offer>();
  const invoices = new Map<string, Invoice>();
  const auditEntries: AuditEntry[] = [];

  return {
    dependencies: {
      offerRepo: {
        list: () => Array.from(offers.values()),
        getById: (_scope: typeof scope, id: string) => offers.get(id) ?? null,
        save: (_scope: typeof scope, offer: Offer) => {
          offers.set(offer.id, offer);
          return offer;
        },
        remove: (_scope: typeof scope, id: string) => {
          offers.delete(id);
        },
      },
      invoiceRepo: {
        list: () => Array.from(invoices.values()),
        getById: (_scope: typeof scope, id: string) => invoices.get(id) ?? null,
        save: (_scope: typeof scope, invoice: Invoice) => {
          invoices.set(invoice.id, invoice);
          return invoice;
        },
        remove: (_scope: typeof scope, id: string) => {
          invoices.delete(id);
        },
      },
      auditLog: {
        append: (_scope: typeof scope, entry: Omit<AuditEntry, 'sequence' | 'hash'>) => {
          const stored: AuditEntry = {
            ...entry,
            sequence: auditEntries.length + 1,
            hash: `hash-${auditEntries.length + 1}`,
          };
          auditEntries.push(stored);
          return stored;
        },
        listBySubject: (_scope: typeof scope, subject: { entityType: string; entityId: string }) => {
          return auditEntries
            .filter((entry) => entry.subject.entityType === subject.entityType && entry.subject.entityId === subject.entityId)
            .slice()
            .reverse();
        },
      },
    },
    invoices,
  };
};

const baseOffer: Offer = {
  kind: 'offer',
  tenantId: scope.tenantId,
  id: 'offer-1',
  clientId: 'client-1',
  clientNumber: 'KD-0001',
  projectId: 'project-1',
  number: 'ANG-2025-001',
  client: 'ACME GmbH',
  clientEmail: 'billing@acme.test',
  clientAddress: 'Main Street 1',
  taxMode: 'standard_vat',
  date: '2025-01-10',
  validUntil: '2025-01-24',
  amount: 119,
  status: 'draft',
  items: [
    billingLineItemSchema.parse({
      description: 'Consulting',
      quantity: 1,
      price: 100,
      total: 100,
      articleId: 'article-1',
      category: 'Services',
    }),
  ],
  history: [],
};

describe('invoice-offer shared services', () => {
  it('tracks offer publication and portal decisions', () => {
    const { dependencies } = createInMemoryOfferDependencies();
    upsertOffer(scope, dependencies, {
      offer: baseOffer,
      reason: 'initial offer',
    });

    publishOffer(scope, dependencies, {
      offerId: baseOffer.id,
      token: 'share-token-1',
      publishedAt: '2025-01-11T10:00:00.000Z',
    });

    assert.deepEqual(listOffersPendingPortalSync(scope, dependencies), [
      { id: baseOffer.id, shareToken: 'share-token-1' },
    ]);

    const decided = applyOfferDecision(scope, dependencies, {
      offerId: baseOffer.id,
      decidedAt: '2025-01-12T08:30:00.000Z',
      decision: 'accepted',
      acceptedName: 'Jane Customer',
      acceptedEmail: 'jane@example.test',
      decisionTextVersion: 'v1',
    });

    assert.equal(decided.status, 'accepted');
    assert.equal(decided.share?.decision, 'accepted');
    assert.equal(decided.share?.acceptedBy, 'Jane Customer');
    assert.deepEqual(decided.history.map((entry) => entry.action), [
      'offer.portal_decision',
      'offer.publish',
      'offer.create (initial offer)',
    ]);
    assert.deepEqual(listOffersPendingPortalSync(scope, dependencies), []);
  });

  it('publishes and syncs offers through the portal gateway ports', async () => {
    const { dependencies } = createInMemoryOfferDependencies();
    upsertOffer(scope, dependencies, {
      offer: baseOffer,
      reason: 'initial offer',
    });

    const published = await publishOfferToPortal(scope, {
      ...dependencies,
      portalGateway: {
        publishOffer: async ({ offer, expiresAt }) => {
          assert.equal(offer.id, baseOffer.id);
          assert.equal(expiresAt, baseOffer.validUntil);
          return {
            token: 'share-token-2',
            publicUrl: 'https://portal.example.test/offers/share-token-2',
            publishedAt: '2025-01-11T10:00:00.000Z',
          };
        },
      },
    }, {
      offerId: baseOffer.id,
    });

    assert.equal(published.token, 'share-token-2');
    assert.equal(published.offer.share?.token, 'share-token-2');

    const decisions: Array<{ offerId: string; decision: string }> = [];
    const updated = await syncPublishedOfferDecisionsFromPortal(scope, {
      ...dependencies,
      portalGateway: {
        getOfferStatus: async (shareToken) => ({
          decision: shareToken === 'share-token-2'
            ? {
                decidedAt: '2025-01-12T08:30:00.000Z',
                decision: 'accepted',
                acceptedName: 'Jane Customer',
                acceptedEmail: 'jane@example.test',
                decisionTextVersion: 'v1',
              }
            : null,
        }),
      },
    }, {
      onDecisionApplied: ({ offer, decision }) => {
        decisions.push({ offerId: offer.id, decision: decision.decision });
      },
    });

    assert.equal(updated, 1);
    assert.deepEqual(decisions, [{ offerId: baseOffer.id, decision: 'accepted' }]);
    assert.deepEqual(listOffersPendingPortalSync(scope, dependencies), []);
  });

  it('creates invoice snapshots from offers', () => {
    const { dependencies, invoices } = createInMemoryOfferDependencies();
    upsertOffer(scope, dependencies, {
      offer: baseOffer,
      reason: 'initial offer',
    });

    const invoice = createInvoiceFromOffer(scope, dependencies, {
      offerId: baseOffer.id,
      invoiceId: 'invoice-1',
      invoiceNumber: 'RE-2025-001',
      invoiceDate: '2025-01-15',
      dueDate: '2025-01-29',
    });

    assert.equal(invoice.id, 'invoice-1');
    assert.equal(invoice.client, baseOffer.client);
    assert.deepEqual(invoice.items, baseOffer.items);
    assert.deepEqual(invoice.payments, []);
    assert.equal(invoice.status, 'draft');
    assert.equal(invoices.get('invoice-1')?.number, 'RE-2025-001');
    assert.ok((invoice.history[0]?.action).includes('Converted from offer ANG-2025-001'));
  });
});
