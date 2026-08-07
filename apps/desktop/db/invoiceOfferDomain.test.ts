import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Client, Invoice, RecurringProfile } from '../types';
import { bootstrapSql } from './bootstrap';
import { createInvoiceFromOffer, getInvoice, upsertInvoice } from './invoicesRepo';
import { getClient, upsertClient } from './clientsRepo';
import { listRecurringProfiles, upsertRecurringProfile } from './recurringRepo';
import {
  applyOfferDecision,
  getOffer,
  listOffersPendingPortalSync,
  markOfferPublished,
  publishOfferToPortal,
  syncPublishedOfferDecisionFromPortal,
  upsertOffer,
} from './offersRepo';
import { setSettings } from './settingsRepo';

const createDb = () => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  setSettings(db, {
    company: {
      name: 'Billme',
      owner: 'Owner',
      street: 'Street 1',
      zip: '12345',
      city: 'Berlin',
      email: 'owner@example.com',
      phone: '',
      website: '',
    },
    catalog: { categories: [] },
    finance: {
      bankName: '',
      iban: '',
      bic: '',
      taxId: '',
      vatId: '',
      registerCourt: '',
    },
    numbers: {
      invoicePrefix: 'RE-%Y-',
      nextInvoiceNumber: 1,
      numberLength: 3,
      offerPrefix: 'ANG-%Y-',
      nextOfferNumber: 1,
      customerPrefix: 'KD-',
      nextCustomerNumber: 1,
      customerNumberLength: 4,
    },
    dunning: { levels: [] },
    legal: {
      smallBusinessRule: false,
      defaultVatRate: 19,
      taxAccountingMethod: 'soll',
      paymentTermsDays: 14,
      defaultIntroText: '',
      defaultFooterText: '',
    },
    portal: { baseUrl: 'https://portal.example.test' },
    eInvoice: {
      enabled: false,
      standard: 'zugferd-en16931',
      profile: 'EN16931',
      version: '2.3',
    },
    email: {
      provider: 'none',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      fromName: '',
      fromEmail: '',
    },
    automation: {
      dunningEnabled: false,
      dunningRunTime: '09:00',
      recurringEnabled: false,
      recurringRunTime: '03:00',
    },
    dashboard: {
      monthlyRevenueGoal: 0,
      dueSoonDays: 7,
      topCategoriesLimit: 5,
      recentPaymentsLimit: 5,
      topClientsLimit: 5,
    },
  });
  return db;
};

const canRunNativeSqlite = (() => {
  try {
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const baseOffer: Invoice = {
  id: 'offer-1',
  clientId: 'client-1',
  clientNumber: 'KD-0001',
  projectId: 'project-1',
  number: 'ANG-2025-001',
  client: 'ACME GmbH',
  clientEmail: 'billing@acme.test',
  clientAddress: 'Main Street 1',
  billingAddressJson: { company: 'ACME GmbH', street: 'Main Street 1', zip: '12345', city: 'Berlin' },
  shippingAddressJson: { company: 'ACME GmbH', street: 'Delivery Street 2', zip: '12345', city: 'Berlin' },
  date: '2025-01-10',
  dueDate: '2025-01-24',
  amount: 119,
  status: 'draft' as Invoice['status'],
  items: [
    {
      description: 'Consulting',
      quantity: 1,
      price: 100,
      total: 100,
      articleId: 'article-1',
      category: 'Services',
    },
  ],
  payments: [],
  history: [],
};

describe.skipIf(!canRunNativeSqlite)('invoice/offer shared domain wrappers', () => {
  it('round-trips client tax profiles and invoice/offer/recurring tax snapshots', () => {
    const db = createDb();
    const client: Client = {
      id: 'client-tax-1',
      customerNumber: 'KD-0010',
      company: 'Alpen GmbH',
      contactPerson: 'Ada',
      email: 'billing@alpen.example',
      phone: '',
      address: 'Ringstraße 1, 1010 Wien, AT',
      status: 'active',
      tags: [],
      notes: '',
      projects: [],
      activities: [],
      taxProfile: {
        type: 'business',
        countryCode: 'AT',
        vatId: 'ATU12345678',
        vatIdValidation: 'valid',
        vatIdValidationAt: '2026-08-06T12:00:00.000Z',
      },
      addresses: [{ id: 'tax-address', clientId: 'client-tax-1', label: 'Rechnung', kind: 'billing', street: 'Ringstraße 1', zip: '1010', city: 'Wien', country: 'AT', isDefaultBilling: true, isDefaultShipping: true }],
      emails: [{ id: 'tax-email', clientId: 'client-tax-1', label: 'Buchhaltung', kind: 'billing', email: 'billing@alpen.example', isDefaultBilling: true, isDefaultGeneral: true }],
    };
    upsertClient(db, client);
    expect(getClient(db, client.id)?.taxProfile).toEqual(client.taxProfile);

    const taxMeta = { sellerCountryCode: 'DE', buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', taxRuleConfirmed: true };
    const taxSnapshot = { netAmount: 100, vatAmount: 0, grossAmount: 100, vatRateApplied: 0, einvoiceCategoryCode: 'AE' as const, label: 'EU-Leistung Reverse Charge', taxNotice: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)' };
    const invoice = { ...baseOffer, id: 'tax-invoice-1', number: 'RE-2025-010', status: 'draft' as Invoice['status'], taxMode: 'intra_eu_service_reverse_charge' as const, taxMeta, taxSnapshot };
    upsertInvoice(db, invoice, 'tax roundtrip');
    expect(getInvoice(db, invoice.id)).toMatchObject({ taxMode: invoice.taxMode, taxMeta, taxSnapshot });

    const offer = { ...baseOffer, taxMode: 'export_third_country' as const, taxMeta: { sellerCountryCode: 'DE', buyerCountryCode: 'CH', taxRuleConfirmed: true }, taxSnapshot: { ...taxSnapshot, einvoiceCategoryCode: 'G' as const, taxNotice: 'Steuerfreie Ausfuhrlieferung' } };
    upsertOffer(db, offer, 'offer tax roundtrip');
    expect(getOffer(db, offer.id)).toMatchObject({ taxMode: offer.taxMode, taxMeta: offer.taxMeta, taxSnapshot: offer.taxSnapshot });

    const recurring = { ...({ id: 'tax-profile-1', clientId: client.id, active: true, name: 'EU-Service', interval: 'monthly', nextRun: '2026-09-01', amount: 100, items: baseOffer.items } as RecurringProfile), taxMode: 'intra_eu_service_reverse_charge' };
    upsertRecurringProfile(db, recurring);
    expect((listRecurringProfiles(db)[0] as unknown as { taxMode?: string }).taxMode).toBe('intra_eu_service_reverse_charge');
  });

  it('publishes offers, tracks pending sync, and applies portal decisions with audit history', () => {
    const db = createDb();

    upsertOffer(db, { ...baseOffer }, 'initial offer');
    markOfferPublished(db, baseOffer.id, {
      token: 'share-token-1',
      publishedAt: '2025-01-11T10:00:00.000Z',
    });

    expect(listOffersPendingPortalSync(db)).toEqual([{ id: baseOffer.id, shareToken: 'share-token-1' }]);

    applyOfferDecision(db, baseOffer.id, {
      decidedAt: '2025-01-12T08:30:00.000Z',
      decision: 'accepted',
      acceptedName: 'Jane Customer',
      acceptedEmail: 'jane@example.test',
      decisionTextVersion: 'v1',
    });

    const offer = getOffer(db, baseOffer.id);
    expect(offer?.shareToken).toBe('share-token-1');
    expect(offer?.status).toBe('accepted');
    expect(offer?.shareDecision).toBe('accepted');
    expect(offer?.acceptedBy).toBe('Jane Customer');
    expect(offer?.acceptedEmail).toBe('jane@example.test');
    expect(listOffersPendingPortalSync(db)).toEqual([]);
    expect(offer?.history?.map((entry) => entry.action)).toEqual([
      'offer.portal_decision',
      'offer.publish',
      'offer.create (initial offer)',
    ]);
  });

  it('publishes and syncs offers through the shared portal gateway wrappers', async () => {
    const db = createDb();

    upsertOffer(db, { ...baseOffer }, 'initial offer');

    const published = await publishOfferToPortal(db, {
      offerId: baseOffer.id,
      portalGateway: {
        publishOffer: async ({ offer, expiresAt }) => {
          expect(offer.id).toBe(baseOffer.id);
          expect(expiresAt).toBe(baseOffer.dueDate);
          return {
            token: 'share-token-2',
            publicUrl: 'https://portal.example.test/offers/share-token-2',
            publishedAt: '2025-01-11T10:00:00.000Z',
          };
        },
      },
    });

    expect(published.token).toBe('share-token-2');
    expect(published.offer.shareToken).toBe('share-token-2');

    const synced = await syncPublishedOfferDecisionFromPortal(db, {
      offerId: baseOffer.id,
      portalGateway: {
        getOfferStatus: async () => ({
          decision: {
            decidedAt: '2025-01-12T08:30:00.000Z',
            decision: 'accepted',
            acceptedName: 'Jane Customer',
            acceptedEmail: 'jane@example.test',
            decisionTextVersion: 'v1',
          },
        }),
      },
    });

    expect(synced.updated).toBe(true);
    expect(synced.offer.shareDecision).toBe('accepted');
    expect(synced.offer.acceptedBy).toBe('Jane Customer');
  });

  it('creates invoices from offers through the shared domain flow', () => {
    const db = createDb();
    upsertOffer(db, { ...baseOffer }, 'initial offer');

    const invoice = createInvoiceFromOffer(db, baseOffer.id, 'invoice-1');
    const stored = getInvoice(db, invoice.id);

    expect(invoice.id).toBe('invoice-1');
    expect(invoice.client).toBe(baseOffer.client);
    expect(invoice.items).toEqual(baseOffer.items);
    expect(invoice.payments).toEqual([]);
    expect(invoice.status).toBe('draft');
    expect(stored?.number).toBe(invoice.number);
    expect(stored?.history?.[0]?.action).toContain('Converted from offer ANG-2025-001');
  });
});
