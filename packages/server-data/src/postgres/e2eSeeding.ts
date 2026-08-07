import type {
  AccountSuggestionRule,
  LedgerAccount,
  TaxCaseAccountMapping,
} from '@billme/accounting-shared';
import { createSingleTenantScope, type Client, type Invoice, type Offer, type RecurringProfile } from '@billme/server-core';
import {
  createPostgresClientRepository,
  createPostgresInvoiceRepository,
  createPostgresOfferRepository,
  createPostgresRecurringProfileRepository,
  saveServerSettings,
} from './billing.js';
import type { PostgresQueryable } from './connection.js';
import {
  saveServerAccountKeyword,
  saveServerAccountSuggestionRule,
  saveServerActiveTemplates,
  saveServerArticle,
  saveServerBankAccount,
  saveServerBankTransaction,
  saveServerLedgerAccount,
  saveServerProWorkflowEntry,
  saveServerTaxCase,
  saveServerTaxCaseAccountMapping,
  saveServerTemplate,
  type ServerAccountKeywordRecord,
  type ServerActiveTemplatesRecord,
  type ServerArticleRecord,
  type ServerBankAccountRecord,
  type ServerBankTransactionRecord,
  type ServerProWorkflowRecord,
  type ServerTaxCaseRecord,
  type ServerTemplateRecord,
} from './proAccounting.js';

const DEFAULT_TIMESTAMP = '2026-03-20T09:00:00.000Z';

type ServerModeSettings = {
  company: {
    name: string;
    owner: string;
    street: string;
    zip: string;
    city: string;
    email: string;
    phone: string;
    website: string;
  };
  catalog: {
    categories: Array<{ id: string; name: string }>;
  };
  finance: {
    bankName: string;
    iban: string;
    bic: string;
    taxId: string;
    vatId: string;
    registerCourt: string;
  };
  numbers: {
    invoicePrefix: string;
    nextInvoiceNumber: number;
    numberLength: number;
    offerPrefix: string;
    nextOfferNumber: number;
    customerPrefix: string;
    nextCustomerNumber: number;
    customerNumberLength: number;
  };
  dunning: {
    levels: Array<{
      id: number;
      name: string;
      enabled: boolean;
      daysAfterDueDate: number;
      fee: number;
      subject: string;
      text: string;
    }>;
  };
  legal: {
    smallBusinessRule: boolean;
    defaultVatRate: number;
    taxAccountingMethod: 'soll' | 'ist';
    paymentTermsDays: number;
    defaultIntroText: string;
    defaultFooterText: string;
  };
  portal: {
    baseUrl: string;
  };
  eInvoice: {
    enabled: boolean;
    standard: 'zugferd-en16931';
    profile: 'EN16931';
    version: '2.3';
  };
  email: {
    provider: 'none' | 'smtp' | 'resend';
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    fromName: string;
    fromEmail: string;
  };
  automation: {
    dunningEnabled: boolean;
    dunningRunTime: string;
    recurringEnabled: boolean;
    recurringRunTime: string;
  };
  dashboard: {
    monthlyRevenueGoal: number;
    dueSoonDays: number;
    topCategoriesLimit: number;
    recentPaymentsLimit: number;
    topClientsLimit: number;
  };
  onboardingCompleted: boolean;
};

export interface ServerModeSeedOptions {
  tenantId: string;
  namespace?: string;
  now?: string;
}

export interface ServerModeBillingSeed {
  namespace: string;
  tenantId: string;
  settings: ServerModeSettings;
  clients: Client[];
  invoices: Invoice[];
  offers: Offer[];
  recurringProfiles: RecurringProfile[];
}

export interface ServerModeLiteTenantSeed extends ServerModeBillingSeed {
  product: 'lite';
}

export interface ServerModeProTenantSeed extends ServerModeBillingSeed {
  product: 'pro';
  ledgerAccounts: LedgerAccount[];
  taxCases: ServerTaxCaseRecord[];
  accountKeywords: ServerAccountKeywordRecord[];
  articles: ServerArticleRecord[];
  bankAccounts: ServerBankAccountRecord[];
  bankTransactions: ServerBankTransactionRecord[];
  templates: ServerTemplateRecord[];
  activeTemplates: ServerActiveTemplatesRecord;
  workflowEntries: ServerProWorkflowRecord[];
  taxCaseAccountMappings: TaxCaseAccountMapping[];
  accountSuggestionRules: AccountSuggestionRule[];
}

const sanitizeNamespace = (value: string | undefined): string => {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized && normalized.length > 0 ? normalized : 'e2e';
};

const seedTag = (namespace: string): string => {
  const compact = namespace.replace(/-/g, '').toUpperCase();
  if (compact.length === 0) {
    return 'E2E';
  }
  if (compact.length <= 8) {
    return compact;
  }
  return `${compact.slice(0, 4)}${compact.slice(-4)}`;
};

const seedId = (namespace: string, ...parts: string[]): string => [namespace, ...parts].join('-');

const buildSettings = (
  namespace: string,
  product: 'lite' | 'pro',
): ServerModeSettings => {
  const tag = seedTag(namespace);
  return {
    company: {
      name: `Billme ${product === 'pro' ? 'Pro ' : ''}${tag} GmbH`,
      owner: `${product === 'pro' ? 'Pro' : 'Lite'} Owner`,
      street: 'Teststrasse 1',
      zip: '10115',
      city: 'Berlin',
      email: `${product}.${namespace}@billme-e2e.local`,
      phone: '+49 30 12345678',
      website: `https://${namespace}.billme-e2e.local`,
    },
    catalog: {
      categories: [
        { id: seedId(namespace, 'category', 'consulting'), name: 'Consulting' },
        { id: seedId(namespace, 'category', 'service'), name: 'Service' },
      ],
    },
    finance: {
      bankName: 'Billme Testbank',
      iban: 'DE12100500001234567890',
      bic: 'BELADEBEXXX',
      taxId: '12/345/67890',
      vatId: 'DE123456789',
      registerCourt: 'Amtsgericht Berlin HRB 123456',
    },
    numbers: {
      invoicePrefix: `RE-${tag}-`,
      nextInvoiceNumber: 301,
      numberLength: 3,
      offerPrefix: `ANG-${tag}-`,
      nextOfferNumber: 201,
      customerPrefix: `KD-${tag}-`,
      nextCustomerNumber: 3,
      customerNumberLength: 3,
    },
    dunning: {
      levels: [
        {
          id: 1,
          name: 'Zahlungserinnerung',
          enabled: true,
          daysAfterDueDate: 7,
          fee: 0,
          subject: 'Zahlungserinnerung Rechnung %N',
          text: 'Bitte begleichen Sie die offene Rechnung %N.',
        },
      ],
    },
    legal: {
      smallBusinessRule: false,
      defaultVatRate: 19,
      taxAccountingMethod: 'soll',
      paymentTermsDays: 14,
      defaultIntroText: 'Vielen Dank fuer Ihren Auftrag.',
      defaultFooterText: 'Es gelten unsere AGB.',
    },
    portal: {
      baseUrl: '',
    },
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
      smtpSecure: true,
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
      monthlyRevenueGoal: 30000,
      dueSoonDays: 7,
      topCategoriesLimit: 5,
      recentPaymentsLimit: 5,
      topClientsLimit: 5,
    },
    onboardingCompleted: true,
  };
};

const buildBillingSeed = (
  options: ServerModeSeedOptions,
  product: 'lite' | 'pro',
): ServerModeBillingSeed => {
  const namespace = sanitizeNamespace(options.namespace ?? `${product}-seed`);
  const now = options.now ?? DEFAULT_TIMESTAMP;
  const tag = seedTag(namespace);
  const settings = buildSettings(namespace, product);

  const clientAlphaId = seedId(namespace, 'client', 'alpha');
  const clientBetaId = seedId(namespace, 'client', 'beta');

  const clients: Client[] = [
    {
      id: clientAlphaId,
      tenantId: options.tenantId,
      customerNumber: `KD-${tag}-001`,
      company: 'Acme Industrie GmbH',
      contactPerson: 'Anna Accounting',
      email: `anna+${namespace}@acme.test`,
      phone: '+49 30 11111111',
      address: 'Musterweg 10, 10115 Berlin',
      status: 'active',
      tags: ['seed', 'vip'],
      notes: 'Created by deterministic server-mode seed',
      addresses: [
        {
          id: seedId(namespace, 'client', 'alpha', 'address', 'billing'),
          clientId: clientAlphaId,
          label: 'Rechnung',
          kind: 'billing',
          company: 'Acme Industrie GmbH',
          contactPerson: 'Anna Accounting',
          street: 'Musterweg 10',
          zip: '10115',
          city: 'Berlin',
          country: 'DE',
          isDefaultBilling: true,
          isDefaultShipping: false,
        },
      ],
      emails: [
        {
          id: seedId(namespace, 'client', 'alpha', 'email', 'billing'),
          clientId: clientAlphaId,
          label: 'Buchhaltung',
          kind: 'billing',
          email: `billing+${namespace}@acme.test`,
          isDefaultGeneral: true,
          isDefaultBilling: true,
        },
      ],
      projects: [
        {
          id: seedId(namespace, 'client', 'alpha', 'project', 'retainer'),
          clientId: clientAlphaId,
          code: 'RET-01',
          name: 'Retainer',
          status: 'active',
          budget: 3500,
          startDate: '2026-01-01',
          description: 'Monatliche Betreuung',
          createdAt: now,
          updatedAt: now,
        },
      ],
      activities: [
        {
          id: seedId(namespace, 'client', 'alpha', 'activity', 'kickoff'),
          clientId: clientAlphaId,
          type: 'note',
          content: 'Server-mode E2E seed',
          date: '2026-01-02',
          author: 'Billme E2E',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: clientBetaId,
      tenantId: options.tenantId,
      customerNumber: `KD-${tag}-002`,
      company: 'Beta Digital AG',
      contactPerson: 'Boris Buyer',
      email: `boris+${namespace}@beta.test`,
      phone: '+49 30 22222222',
      address: 'Torstrasse 5, 10119 Berlin',
      status: 'active',
      tags: ['seed'],
      notes: 'Created by deterministic server-mode seed',
      addresses: [],
      emails: [],
      projects: [],
      activities: [],
      createdAt: now,
      updatedAt: now,
    },
  ];

  const invoices: Invoice[] = [
    {
      kind: 'invoice',
      id: seedId(namespace, 'invoice', 'paid'),
      tenantId: options.tenantId,
      clientId: clientAlphaId,
      clientNumber: clients[0]?.customerNumber,
      projectId: clients[0]?.projects[0]?.id,
      number: `RE-${tag}-101`,
      client: clients[0]?.company ?? '',
      clientEmail: clients[0]?.email ?? '',
      clientAddress: clients[0]?.address,
      taxMode: 'standard_vat',
      date: '2026-01-15',
      dueDate: '2026-01-29',
      servicePeriod: '2026-01',
      amount: 1250,
      status: 'paid',
      dunningLevel: 0,
      items: [{ description: 'Implementierung Sprint 1', quantity: 10, price: 125, total: 1250 }],
      payments: [{ id: seedId(namespace, 'payment', 'paid'), date: '2026-01-20', amount: 1250, method: 'Bank' }],
      history: [{ date: '2026-01-15', action: 'Rechnung erstellt' }],
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: 'invoice',
      id: seedId(namespace, 'invoice', 'open'),
      tenantId: options.tenantId,
      clientId: clientBetaId,
      clientNumber: clients[1]?.customerNumber,
      number: `RE-${tag}-102`,
      client: clients[1]?.company ?? '',
      clientEmail: clients[1]?.email ?? '',
      clientAddress: clients[1]?.address,
      taxMode: 'standard_vat',
      date: '2026-02-10',
      dueDate: '2026-02-24',
      servicePeriod: '2026-02',
      amount: 1890,
      status: 'open',
      dunningLevel: 0,
      items: [{ description: 'Monatliche Betreuung', quantity: 1, price: 1890, total: 1890 }],
      payments: [],
      history: [{ date: '2026-02-10', action: 'Rechnung erstellt' }],
      createdAt: now,
      updatedAt: now,
    },
  ];

  const offers: Offer[] = [
    {
      kind: 'offer',
      id: seedId(namespace, 'offer', 'open'),
      tenantId: options.tenantId,
      clientId: clientBetaId,
      clientNumber: clients[1]?.customerNumber,
      number: `ANG-${tag}-201`,
      client: clients[1]?.company ?? '',
      clientEmail: clients[1]?.email ?? '',
      clientAddress: clients[1]?.address,
      taxMode: 'standard_vat',
      date: '2026-03-01',
      validUntil: '2026-03-15',
      amount: 990,
      status: 'open',
      items: [{ description: 'UX Audit', quantity: 1, price: 990, total: 990 }],
      history: [{ date: '2026-03-01', action: 'Angebot erstellt' }],
      createdAt: now,
      updatedAt: now,
    },
  ];

  const recurringProfiles: RecurringProfile[] = [
    {
      id: seedId(namespace, 'recurring', 'maintenance'),
      tenantId: options.tenantId,
      clientId: clientAlphaId,
      active: true,
      name: 'Wartungsvertrag Basis',
      interval: 'monthly',
      nextRun: '2026-04-01',
      amount: 150,
      taxMode: 'standard_vat',
      items: [{ description: 'Monatliche Wartung', quantity: 1, price: 150, total: 150 }],
      createdAt: now,
      updatedAt: now,
    },
  ];

  return {
    namespace,
    tenantId: options.tenantId,
    settings,
    clients,
    invoices,
    offers,
    recurringProfiles,
  };
};

export const buildServerModeLiteTenantSeed = (options: ServerModeSeedOptions): ServerModeLiteTenantSeed => ({
  product: 'lite',
  ...buildBillingSeed(options, 'lite'),
});

export const buildServerModeProTenantSeed = (options: ServerModeSeedOptions): ServerModeProTenantSeed => {
  const billingSeed = buildBillingSeed(options, 'pro');
  const namespace = billingSeed.namespace;
  const now = options.now ?? DEFAULT_TIMESTAMP;
  const bankAccountId = seedId(namespace, 'account', 'primary');
  const invoiceTemplateId = seedId(namespace, 'template', 'invoice');
  const offerTemplateId = seedId(namespace, 'template', 'offer');
  const workflowTransactionId = seedId(namespace, 'workflow', 'transaction');
  const workflowDraftId = seedId(namespace, 'workflow', 'draft');

  return {
    product: 'pro',
    ...billingSeed,
    ledgerAccounts: [
      {
        id: seedId(namespace, 'ledger', '1200'),
        chart: 'SKR03',
        accountNumber: '1200',
        name: 'Bank',
        source: 'server-mode-e2e',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: seedId(namespace, 'ledger', '3125'),
        chart: 'SKR03',
        accountNumber: '3125',
        name: 'Fremdleistungen',
        source: 'server-mode-e2e',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: seedId(namespace, 'ledger', '8400'),
        chart: 'SKR03',
        accountNumber: '8400',
        name: 'Erlöse 19% USt',
        source: 'server-mode-e2e',
        createdAt: now,
        updatedAt: now,
      },
    ],
    taxCases: [
      {
        key: 'DE_STD_19',
        label: 'Deutschland 19% Umsatzsteuer',
        mechanism: 'standard_vat',
        defaultRate: 19,
        requiresCounterpartyVatId: false,
        requiresCountry: false,
        requiresEvidence: false,
        active: true,
        updatedAt: now,
      },
      {
        key: 'DE_KU19',
        label: 'Kleinunternehmerregelung',
        mechanism: 'exempt',
        defaultRate: 0,
        requiresCounterpartyVatId: false,
        requiresCountry: false,
        requiresEvidence: false,
        active: true,
        updatedAt: now,
      },
    ],
    accountKeywords: [
      {
        id: seedId(namespace, 'keyword', 'hosting'),
        tenantId: options.tenantId,
        chart: 'SKR03',
        accountNumber: '3125',
        keyword: 'hosting',
        source: 'server-mode-e2e',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    articles: [
      {
        id: seedId(namespace, 'article', 'consulting'),
        tenantId: options.tenantId,
        sku: 'CONS-001',
        title: 'Senior Consulting',
        description: 'Beratung pro Stunde',
        price: 150,
        unit: 'Std',
        category: 'Consulting',
        taxRate: 19,
      },
      {
        id: seedId(namespace, 'article', 'support'),
        tenantId: options.tenantId,
        sku: 'SUP-001',
        title: 'Support Paket',
        description: 'Monatliche Betreuung',
        price: 1890,
        unit: 'Paket',
        category: 'Service',
        taxRate: 19,
      },
    ],
    bankAccounts: [
      {
        id: bankAccountId,
        tenantId: options.tenantId,
        name: 'Hauptkonto',
        iban: 'DE12345678901234567890',
        balance: 124500,
        defaultSkrAccountNumber: '1200',
        type: 'bank',
        color: 'bg-white',
      },
    ],
    bankTransactions: [
      {
        id: seedId(namespace, 'transaction', 'income'),
        tenantId: options.tenantId,
        accountId: bankAccountId,
        date: '2026-02-12',
        amount: 1890,
        type: 'income',
        counterparty: 'Beta Digital AG',
        purpose: 'Rechnungsausgleich',
        linkedInvoiceId: billingSeed.invoices[1]?.id,
        status: 'booked',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: workflowTransactionId,
        tenantId: options.tenantId,
        accountId: bankAccountId,
        date: '2026-03-05',
        amount: -119,
        type: 'expense',
        counterparty: 'Hosting Partner GmbH',
        purpose: 'Managed hosting',
        status: 'booked',
        createdAt: now,
        updatedAt: now,
      },
    ],
    templates: [
      {
        id: invoiceTemplateId,
        tenantId: options.tenantId,
        kind: 'invoice',
        name: 'Server-mode Rechnung',
        elementsJson: JSON.stringify([
          {
            id: seedId(namespace, 'template', 'invoice', 'title'),
            type: 'text',
            x: 40,
            y: 32,
            zIndex: 1,
            content: 'Rechnung',
            style: { fontSize: 24, fontWeight: 700 },
          },
        ]),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: offerTemplateId,
        tenantId: options.tenantId,
        kind: 'offer',
        name: 'Server-mode Angebot',
        elementsJson: JSON.stringify([
          {
            id: seedId(namespace, 'template', 'offer', 'title'),
            type: 'text',
            x: 40,
            y: 32,
            zIndex: 1,
            content: 'Angebot',
            style: { fontSize: 24, fontWeight: 700 },
          },
        ]),
        createdAt: now,
        updatedAt: now,
      },
    ],
    activeTemplates: {
      tenantId: options.tenantId,
      id: 1,
      invoiceTemplateId,
      offerTemplateId,
    },
    workflowEntries: [
      {
        tenantId: options.tenantId,
        transactionId: workflowTransactionId,
        transactionJson: JSON.stringify({
          id: workflowTransactionId,
          date: '2026-03-05',
          amount: -119,
          type: 'expense',
          counterparty: 'Hosting Partner GmbH',
          purpose: 'Managed hosting',
          status: 'booked',
          accountId: bankAccountId,
          suggestedAccountNumber: '3125',
          suggestionReason: 'Seed rule matched hosting vendor',
          suggestionLayer: 'rule',
          suggestionConfidence: 0.99,
        }),
        draftJson: JSON.stringify({
          id: workflowDraftId,
          tenantId: options.tenantId,
          transactionId: workflowTransactionId,
          workflowStatus: 'ready_for_review',
          postingDate: '2026-03-05',
          bookingText: 'Managed hosting',
          period: '2026-03',
          fiscalYear: 2026,
          lines: [
            {
              id: seedId(namespace, 'workflow', 'line', 'expense'),
              accountNumber: '3125',
              debitAmount: 100,
              creditAmount: 0,
            },
            {
              id: seedId(namespace, 'workflow', 'line', 'vat'),
              accountNumber: '1200',
              debitAmount: 0,
              creditAmount: 119,
              taxCaseKey: 'DE_STD_19',
              taxRate: 19,
              netAmount: 100,
              taxAmount: 19,
              grossAmount: 119,
            },
          ],
          validationIssues: [],
          updatedAt: now,
        }),
        updatedAt: now,
      },
    ],
    taxCaseAccountMappings: [
      {
        id: seedId(namespace, 'tax-mapping', 'output'),
        chart: 'SKR03',
        taxCaseKey: 'DE_STD_19',
        role: 'output_tax',
        accountNumber: '1776',
        updatedAt: now,
      },
      {
        id: seedId(namespace, 'tax-mapping', 'datev'),
        chart: 'SKR03',
        taxCaseKey: 'DE_STD_19',
        role: 'datev_bu',
        accountNumber: '8400',
        datevBuKey: '81',
        updatedAt: now,
      },
    ],
    accountSuggestionRules: [
      {
        id: seedId(namespace, 'rule', 'hosting'),
        tenantId: options.tenantId,
        chart: 'SKR03',
        priority: 10,
        field: 'counterparty',
        operator: 'contains',
        value: 'Hosting',
        targetAccountNumber: '3125',
        flowType: 'expense',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
};

const applyServerModeBillingSeed = async (
  db: PostgresQueryable,
  product: 'lite' | 'pro',
  seed: ServerModeBillingSeed,
): Promise<void> => {
  const scope = createSingleTenantScope(seed.tenantId, product);
  const clientRepo = createPostgresClientRepository(db);
  const invoiceRepo = createPostgresInvoiceRepository(db);
  const offerRepo = createPostgresOfferRepository(db);
  const recurringProfileRepo = createPostgresRecurringProfileRepository(db);
  const now = seed.clients[0]?.createdAt ?? DEFAULT_TIMESTAMP;
  await saveServerSettings(db, {
    tenantId: seed.tenantId,
    settingsJson: JSON.stringify(seed.settings),
    createdAt: now,
    updatedAt: now,
  });
  for (const client of seed.clients) {
    await clientRepo.save(scope, client);
  }
  for (const invoice of seed.invoices) {
    await invoiceRepo.save(scope, invoice);
  }
  for (const offer of seed.offers) {
    await offerRepo.save(scope, offer);
  }
  for (const profile of seed.recurringProfiles) {
    await recurringProfileRepo.save(scope, profile);
  }
};

export const applyServerModeLiteTenantSeed = async (
  db: PostgresQueryable,
  seed: ServerModeLiteTenantSeed,
): Promise<ServerModeLiteTenantSeed> => {
  await applyServerModeBillingSeed(db, 'lite', seed);
  return seed;
};

export const applyServerModeProTenantSeed = async (
  db: PostgresQueryable,
  seed: ServerModeProTenantSeed,
): Promise<ServerModeProTenantSeed> => {
  await applyServerModeBillingSeed(db, 'pro', seed);
  for (const account of seed.ledgerAccounts) {
    await saveServerLedgerAccount(db, account);
  }
  for (const taxCase of seed.taxCases) {
    await saveServerTaxCase(db, taxCase);
  }
  for (const keyword of seed.accountKeywords) {
    await saveServerAccountKeyword(db, keyword);
  }
  for (const article of seed.articles) {
    await saveServerArticle(db, article);
  }
  for (const account of seed.bankAccounts) {
    await saveServerBankAccount(db, account);
  }
  for (const transaction of seed.bankTransactions) {
    await saveServerBankTransaction(db, transaction);
  }
  for (const template of seed.templates) {
    await saveServerTemplate(db, template);
  }
  await saveServerActiveTemplates(db, seed.activeTemplates);
  for (const workflowEntry of seed.workflowEntries) {
    await saveServerProWorkflowEntry(db, workflowEntry);
  }
  for (const mapping of seed.taxCaseAccountMappings) {
    await saveServerTaxCaseAccountMapping(db, mapping);
  }
  for (const rule of seed.accountSuggestionRules) {
    await saveServerAccountSuggestionRule(db, rule);
  }
  return seed;
};

export const seedServerModeLiteTenant = async (
  db: PostgresQueryable,
  options: ServerModeSeedOptions,
): Promise<ServerModeLiteTenantSeed> => {
  return applyServerModeLiteTenantSeed(db, buildServerModeLiteTenantSeed(options));
};

export const seedServerModeProTenant = async (
  db: PostgresQueryable,
  options: ServerModeSeedOptions,
): Promise<ServerModeProTenantSeed> => {
  return applyServerModeProTenantSeed(db, buildServerModeProTenantSeed(options));
};
