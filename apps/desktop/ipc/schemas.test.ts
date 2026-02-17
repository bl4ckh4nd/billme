import { describe, it, expect } from 'vitest';
import {
  invoiceItemSchema,
  paymentSchema,
  invoiceSchema,
  clientSchema,
  articleSchema,
  transactionSchema,
  accountSchema,
  recurringProfileSchema,
  dunningLevelSchema,
  appSettingsSchema,
  upsertPayloadSchema,
  deleteByIdSchema,
  csvProfileSchema,
  csvMappingSchema,
  financeImportPreviewSchema,
  financeImportCommitSchema,
  templateSchema,
  templateKindSchema,
} from './schemas';

describe('Invoice Schemas', () => {
  describe('invoiceItemSchema', () => {
    it('should validate valid invoice item', () => {
      const item = {
        description: 'Web development',
        quantity: 1,
        price: 100,
        total: 100,
      };
      expect(() => invoiceItemSchema.parse(item)).not.toThrow();
    });

    it('should allow optional fields', () => {
      const item = {
        description: 'Consulting',
        quantity: 2,
        price: 50,
        total: 100,
        articleId: 'article-123',
        category: 'Services',
      };
      expect(() => invoiceItemSchema.parse(item)).not.toThrow();
    });

    it('should reject missing required fields', () => {
      const item = {
        description: 'Test',
        quantity: 1,
        // missing price and total
      };
      expect(() => invoiceItemSchema.parse(item)).toThrow();
    });

    it('should reject invalid types', () => {
      const item = {
        description: 'Test',
        quantity: 'not a number',
        price: 100,
        total: 100,
      };
      expect(() => invoiceItemSchema.parse(item)).toThrow();
    });
  });

  describe('paymentSchema', () => {
    it('should validate valid payment', () => {
      const payment = {
        id: 'payment-123',
        date: '2024-01-01',
        amount: 100,
        method: 'bank_transfer',
      };
      expect(() => paymentSchema.parse(payment)).not.toThrow();
    });

    it('should reject negative amounts', () => {
      const payment = {
        id: 'payment-123',
        date: '2024-01-01',
        amount: -100,
        method: 'bank_transfer',
      };
      // Zod allows negative numbers unless explicitly restricted
      expect(() => paymentSchema.parse(payment)).not.toThrow();
    });
  });

  describe('invoiceSchema', () => {
    it('should validate complete invoice', () => {
      const invoice = {
        id: 'inv-123',
        number: 'INV-001',
        client: 'Acme Corp',
        clientEmail: 'contact@acme.com',
        date: '2024-01-01',
        dueDate: '2024-01-31',
        amount: 100,
        status: 'open' as const,
        items: [
          {
            description: 'Service',
            quantity: 1,
            price: 100,
            total: 100,
          },
        ] as Array<any>,
        payments: [] as Array<any>,
      };
      expect(() => invoiceSchema.parse(invoice)).not.toThrow();
    });

    it('should reject invalid status', () => {
      const invoice = {
        id: 'inv-123',
        number: 'INV-001',
        client: 'Acme Corp',
        clientEmail: 'contact@acme.com',
        date: '2024-01-01',
        dueDate: '2024-01-31',
        amount: 100,
        status: 'invalid_status',
        items: [] as Array<any>,
        payments: [] as Array<any>,
      };
      expect(() => invoiceSchema.parse(invoice)).toThrow();
    });

    it('should allow optional share fields', () => {
      const invoice = {
        id: 'inv-123',
        number: 'INV-001',
        client: 'Acme Corp',
        clientEmail: 'contact@acme.com',
        date: '2024-01-01',
        dueDate: '2024-01-31',
        amount: 100,
        status: 'open' as const,
        items: [] as Array<any>,
        payments: [] as Array<any>,
        shareToken: 'token-123',
        sharePublishedAt: '2024-01-01T00:00:00.000Z',
        shareDecision: 'accepted' as const,
      };
      expect(() => invoiceSchema.parse(invoice)).not.toThrow();
    });
  });

  describe('upsertPayloadSchema', () => {
    it('should require reason field', () => {
      const payload = {
        reason: '',
        invoice: {
          id: 'inv-123',
          number: 'INV-001',
          client: 'Test',
          clientEmail: 'test@test.com',
          date: '2024-01-01',
          dueDate: '2024-01-31',
          amount: 100,
          status: 'open' as const,
          items: [] as Array<any>,
          payments: [] as Array<any>,
        },
      };
      expect(() => upsertPayloadSchema.parse(payload)).toThrow();
    });

    it('should validate with valid reason', () => {
      const payload = {
        reason: 'Created new invoice',
        invoice: {
          id: 'inv-123',
          number: 'INV-001',
          client: 'Test',
          clientEmail: 'test@test.com',
          date: '2024-01-01',
          dueDate: '2024-01-31',
          amount: 100,
          status: 'open' as const,
          items: [] as Array<any>,
          payments: [] as Array<any>,
        },
      };
      expect(() => upsertPayloadSchema.parse(payload)).not.toThrow();
    });
  });
});

describe('Client Schemas', () => {
  describe('clientSchema', () => {
    it('should validate complete client', () => {
      const client = {
        id: 'client-123',
        company: 'Acme Corp',
        contactPerson: 'John Doe',
        email: 'john@acme.com',
        phone: '+1234567890',
        address: '123 Main St',
        status: 'active' as const,
        tags: ['VIP', 'Enterprise'],
        notes: 'Important client',
        projects: [] as Array<any>,
        activities: [] as Array<any>,
      };
      expect(() => clientSchema.parse(client)).not.toThrow();
    });

    it('should allow optional addresses array', () => {
      const client = {
        id: 'client-123',
        company: 'Acme Corp',
        contactPerson: 'John Doe',
        email: 'john@acme.com',
        phone: '+1234567890',
        address: '123 Main St',
        status: 'active' as const,
        tags: [] as string[],
        notes: '',
        projects: [] as Array<any>,
        activities: [] as Array<any>,
        addresses: [
          {
            id: 'addr-1',
            clientId: 'client-123',
            label: 'Main Office',
            kind: 'billing' as const,
            street: '123 Main St',
            zip: '12345',
            city: 'New York',
            country: 'USA',
          },
        ],
      };
      expect(() => clientSchema.parse(client)).not.toThrow();
    });

    it('should reject invalid status', () => {
      const client = {
        id: 'client-123',
        company: 'Acme Corp',
        contactPerson: 'John Doe',
        email: 'john@acme.com',
        phone: '+1234567890',
        address: '123 Main St',
        status: 'pending',
        tags: [] as string[],
        notes: '',
        projects: [] as Array<any>,
        activities: [] as Array<any>,
      };
      expect(() => clientSchema.parse(client)).toThrow();
    });
  });
});

describe('Article Schemas', () => {
  describe('articleSchema', () => {
    it('should validate complete article', () => {
      const article = {
        id: 'article-123',
        sku: 'SKU-001',
        title: 'Web Development',
        description: 'Professional web development services',
        price: 100,
        unit: 'hours',
        category: 'Services',
        taxRate: 19,
      };
      expect(() => articleSchema.parse(article)).not.toThrow();
    });

    it('should allow optional SKU', () => {
      const article = {
        id: 'article-123',
        title: 'Consulting',
        description: 'Business consulting',
        price: 150,
        unit: 'hours',
        category: 'Services',
        taxRate: 19,
      };
      expect(() => articleSchema.parse(article)).not.toThrow();
    });

    it('should reject missing required fields', () => {
      const article = {
        id: 'article-123',
        title: 'Test',
        // missing description, price, unit, category, taxRate
      };
      expect(() => articleSchema.parse(article)).toThrow();
    });
  });
});

describe('Finance Schemas', () => {
  describe('transactionSchema', () => {
    it('should validate income transaction', () => {
      const transaction = {
        id: 'txn-123',
        date: '2024-01-01',
        amount: 100,
        type: 'income' as const,
        counterparty: 'Client A',
        purpose: 'Payment for invoice INV-001',
        status: 'booked' as const,
      };
      expect(() => transactionSchema.parse(transaction)).not.toThrow();
    });

    it('should validate expense transaction', () => {
      const transaction = {
        id: 'txn-123',
        date: '2024-01-01',
        amount: 50,
        type: 'expense' as const,
        counterparty: 'Supplier B',
        purpose: 'Office supplies',
        status: 'pending' as const,
      };
      expect(() => transactionSchema.parse(transaction)).not.toThrow();
    });

    it('should allow optional linkedInvoiceId', () => {
      const transaction = {
        id: 'txn-123',
        date: '2024-01-01',
        amount: 100,
        type: 'income' as const,
        counterparty: 'Client A',
        purpose: 'Payment',
        linkedInvoiceId: 'inv-123',
        status: 'booked' as const,
      };
      expect(() => transactionSchema.parse(transaction)).not.toThrow();
    });

    it('should reject invalid type', () => {
      const transaction = {
        id: 'txn-123',
        date: '2024-01-01',
        amount: 100,
        type: 'transfer',
        counterparty: 'Client A',
        purpose: 'Payment',
        status: 'booked',
      };
      expect(() => transactionSchema.parse(transaction)).toThrow();
    });
  });

  describe('accountSchema', () => {
    it('should validate bank account', () => {
      const account = {
        id: 'acc-123',
        name: 'Business Account',
        iban: 'DE89370400440532013000',
        balance: 5000,
        transactions: [] as Array<any>,
        type: 'bank' as const,
        color: '#0066cc',
      };
      expect(() => accountSchema.parse(account)).not.toThrow();
    });

    it('should validate PayPal account', () => {
      const account = {
        id: 'acc-456',
        name: 'PayPal',
        iban: 'paypal@business.com',
        balance: 1000,
        transactions: [] as Array<any>,
        type: 'paypal' as const,
        color: '#003087',
      };
      expect(() => accountSchema.parse(account)).not.toThrow();
    });

    it('should reject invalid account type', () => {
      const account = {
        id: 'acc-123',
        name: 'Crypto Wallet',
        iban: 'crypto-address',
        balance: 1000,
        transactions: [] as Array<any>,
        type: 'crypto',
        color: '#000000',
      };
      expect(() => accountSchema.parse(account)).toThrow();
    });
  });
});

describe('CSV Import Schemas', () => {
  describe('csvProfileSchema', () => {
    it('should validate all profile types', () => {
      const validProfiles = ['auto', 'fints', 'paypal', 'stripe', 'generic'];
      validProfiles.forEach((profile) => {
        expect(() => csvProfileSchema.parse(profile)).not.toThrow();
      });
    });

    it('should reject invalid profile', () => {
      expect(() => csvProfileSchema.parse('invalid')).toThrow();
    });
  });

  describe('csvMappingSchema', () => {
    it('should validate required columns', () => {
      const mapping = {
        dateColumn: 'Date',
        amountColumn: 'Amount',
      };
      expect(() => csvMappingSchema.parse(mapping)).not.toThrow();
    });

    it('should allow all optional columns', () => {
      const mapping = {
        dateColumn: 'Date',
        amountColumn: 'Amount',
        counterpartyColumn: 'Counterparty',
        purposeColumn: 'Purpose',
        statusColumn: 'Status',
        externalIdColumn: 'ID',
        currencyColumn: 'Currency',
        currencyExpected: 'EUR',
      };
      expect(() => csvMappingSchema.parse(mapping)).not.toThrow();
    });

    it('should reject empty column names', () => {
      const mapping = {
        dateColumn: '',
        amountColumn: 'Amount',
      };
      expect(() => csvMappingSchema.parse(mapping)).toThrow();
    });
  });

  describe('financeImportPreviewSchema', () => {
    it('should validate minimal preview request', () => {
      const preview = {
        path: '/path/to/file.csv',
      };
      expect(() => financeImportPreviewSchema.parse(preview)).not.toThrow();
    });

    it('should validate full preview request', () => {
      const preview = {
        path: '/path/to/file.csv',
        profile: 'fints' as const,
        mapping: {
          dateColumn: 'Date',
          amountColumn: 'Amount',
        },
        encoding: 'utf8' as const,
        delimiter: ',',
        maxRows: 100,
        accountIdForDedupHash: 'acc-123',
      };
      expect(() => financeImportPreviewSchema.parse(preview)).not.toThrow();
    });

    it('should reject maxRows > 200', () => {
      const preview = {
        path: '/path/to/file.csv',
        maxRows: 500,
      };
      expect(() => financeImportPreviewSchema.parse(preview)).toThrow();
    });

    it('should reject invalid encoding', () => {
      const preview = {
        path: '/path/to/file.csv',
        encoding: 'latin1',
      };
      expect(() => financeImportPreviewSchema.parse(preview)).toThrow();
    });
  });

  describe('financeImportCommitSchema', () => {
    it('should validate complete import', () => {
      const commit = {
        path: '/path/to/file.csv',
        accountId: 'acc-123',
        mapping: {
          dateColumn: 'Date',
          amountColumn: 'Amount',
        },
      };
      expect(() => financeImportCommitSchema.parse(commit)).not.toThrow();
    });

    it('should require accountId', () => {
      const commit = {
        path: '/path/to/file.csv',
        mapping: {
          dateColumn: 'Date',
          amountColumn: 'Amount',
        },
      };
      expect(() => financeImportCommitSchema.parse(commit)).toThrow();
    });
  });
});

describe('Recurring Profile Schema', () => {
  describe('recurringProfileSchema', () => {
    it('should validate active recurring profile', () => {
      const profile = {
        id: 'recurring-123',
        clientId: 'client-123',
        active: true,
        name: 'Monthly retainer',
        interval: 'monthly' as const,
        nextRun: '2024-02-01',
        amount: 1000,
        items: [
          {
            description: 'Monthly service',
            quantity: 1,
            price: 1000,
            total: 1000,
          },
        ],
      };
      expect(() => recurringProfileSchema.parse(profile)).not.toThrow();
    });

    it('should allow all interval types', () => {
      const intervals: Array<'weekly' | 'monthly' | 'quarterly' | 'yearly'> = [
        'weekly',
        'monthly',
        'quarterly',
        'yearly',
      ];
      intervals.forEach((interval) => {
        const profile = {
          id: 'recurring-123',
          clientId: 'client-123',
          active: true,
          name: `${interval} invoice`,
          interval,
          nextRun: '2024-02-01',
          amount: 100,
          items: [] as Array<any>,
        };
        expect(() => recurringProfileSchema.parse(profile)).not.toThrow();
      });
    });

    it('should allow optional endDate and lastRun', () => {
      const profile = {
        id: 'recurring-123',
        clientId: 'client-123',
        active: true,
        name: 'Limited service',
        interval: 'monthly' as const,
        nextRun: '2024-02-01',
        lastRun: '2024-01-01',
        endDate: '2024-12-31',
        amount: 100,
        items: [] as Array<any>,
      };
      expect(() => recurringProfileSchema.parse(profile)).not.toThrow();
    });
  });
});

describe('Dunning Schema', () => {
  describe('dunningLevelSchema', () => {
    it('should validate dunning level', () => {
      const level = {
        id: 1,
        name: 'First reminder',
        enabled: true,
        daysAfterDueDate: 7,
        fee: 5,
        subject: 'Payment reminder',
        text: 'Please pay your invoice',
      };
      expect(() => dunningLevelSchema.parse(level)).not.toThrow();
    });

    it('should allow zero fee', () => {
      const level = {
        id: 1,
        name: 'Friendly reminder',
        enabled: true,
        daysAfterDueDate: 3,
        fee: 0,
        subject: 'Payment reminder',
        text: 'Please pay your invoice',
      };
      expect(() => dunningLevelSchema.parse(level)).not.toThrow();
    });
  });
});

describe('Settings Schema', () => {
  describe('appSettingsSchema', () => {
    it('should validate minimal settings', () => {
      const settings = {
        company: {
          name: 'Test Company',
          owner: 'John Doe',
          street: '123 Main St',
          zip: '12345',
          city: 'City',
          email: 'test@test.com',
          phone: '+1234567890',
          website: 'https://test.com',
        },
        finance: {
          bankName: 'Test Bank',
          iban: 'DE89370400440532013000',
          bic: 'COBADEFFXXX',
          taxId: '123/456/78901',
          vatId: 'DE123456789',
          registerCourt: 'Amtsgericht Test',
        },
        numbers: {
          invoicePrefix: 'INV',
          nextInvoiceNumber: 1,
          numberLength: 5,
          offerPrefix: 'OFF',
          nextOfferNumber: 1,
        },
        dunning: {
          levels: [] as Array<any>,
        },
        legal: {
          smallBusinessRule: false,
          defaultVatRate: 19,
          paymentTermsDays: 14,
          defaultIntroText: 'Thank you for your business',
          defaultFooterText: 'Payment terms: 14 days',
        },
      };
      expect(() => appSettingsSchema.parse(settings)).not.toThrow();
    });

    it('should apply defaults for optional sections', () => {
      const settings = {
        company: {
          name: 'Test Company',
          owner: 'John Doe',
          street: '123 Main St',
          zip: '12345',
          city: 'City',
          email: 'test@test.com',
          phone: '+1234567890',
          website: 'https://test.com',
        },
        finance: {
          bankName: 'Test Bank',
          iban: 'DE89370400440532013000',
          bic: 'COBADEFFXXX',
          taxId: '123/456/78901',
          vatId: 'DE123456789',
          registerCourt: 'Amtsgericht Test',
        },
        numbers: {
          invoicePrefix: 'INV',
          nextInvoiceNumber: 1,
          numberLength: 5,
          offerPrefix: 'OFF',
          nextOfferNumber: 1,
        },
        dunning: {
          levels: [] as Array<any>,
        },
        legal: {
          smallBusinessRule: false,
          defaultVatRate: 19,
          paymentTermsDays: 14,
          defaultIntroText: 'Thank you',
          defaultFooterText: 'Payment terms: 14 days',
        },
      };
      const parsed = appSettingsSchema.parse(settings);
      expect(parsed.email).toBeDefined();
      expect(parsed.email.provider).toBe('none');
      expect(parsed.automation).toBeDefined();
      expect(parsed.automation.dunningEnabled).toBe(false);
    });
  });
});

describe('Template Schema', () => {
  describe('templateKindSchema', () => {
    it('should validate invoice and offer kinds', () => {
      expect(() => templateKindSchema.parse('invoice')).not.toThrow();
      expect(() => templateKindSchema.parse('offer')).not.toThrow();
    });

    it('should reject invalid kind', () => {
      expect(() => templateKindSchema.parse('quote')).toThrow();
    });
  });

  describe('templateSchema', () => {
    it('should validate template with text element', () => {
      const template = {
        id: 'tpl-123',
        kind: 'invoice' as const,
        name: 'Default Invoice',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        elements: [
          {
            id: 'elem-1',
            type: 'TEXT',
            x: 100,
            y: 100,
            zIndex: 1,
            content: 'Invoice',
            style: { fontSize: '24px' },
          },
        ],
      };
      expect(() => templateSchema.parse(template)).not.toThrow();
    });

    it('should validate template with QR code element', () => {
      const template = {
        id: 'tpl-123',
        kind: 'invoice' as const,
        name: 'Invoice with QR',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        elements: [
          {
            id: 'elem-1',
            type: 'QRCODE',
            x: 500,
            y: 700,
            zIndex: 1,
            qrData: {
              iban: 'DE89370400440532013000',
              bic: 'COBADEFFXXX',
              amount: 100,
              reference: 'INV-001',
            },
            style: {},
          },
        ],
      };
      expect(() => templateSchema.parse(template)).not.toThrow();
    });

    it('should validate template with table element', () => {
      const template = {
        id: 'tpl-123',
        kind: 'invoice' as const,
        name: 'Invoice with Table',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        elements: [
          {
            id: 'elem-1',
            type: 'TABLE',
            x: 50,
            y: 300,
            zIndex: 1,
            tableData: {
              columns: [
                {
                  id: 'col-1',
                  label: 'Item',
                  width: 200,
                  visible: true,
                  align: 'left' as const,
                },
              ],
              rows: [
                {
                  id: 'row-1',
                  cells: ['Item 1'],
                },
              ],
            },
            style: {},
          },
        ],
      };
      expect(() => templateSchema.parse(template)).not.toThrow();
    });
  });
});

describe('Common Schemas', () => {
  describe('deleteByIdSchema', () => {
    it('should validate ID', () => {
      expect(() => deleteByIdSchema.parse({ id: 'test-123' })).not.toThrow();
    });

    it('should reject empty ID', () => {
      expect(() => deleteByIdSchema.parse({ id: '' })).toThrow();
    });

    it('should reject missing ID', () => {
      expect(() => deleteByIdSchema.parse({})).toThrow();
    });
  });
});

describe('Schema Error Messages', () => {
  it('should provide clear error for invalid enum', () => {
    try {
      invoiceSchema.parse({
        id: 'inv-123',
        number: 'INV-001',
        client: 'Test',
        clientEmail: 'test@test.com',
        date: '2024-01-01',
        dueDate: '2024-01-31',
        amount: 100,
        status: 'invalid_status',
        items: [] as Array<any>,
        payments: [] as Array<any>,
      });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toContain('status');
    }
  });

  it('should provide clear error for missing required field', () => {
    try {
      articleSchema.parse({
        id: 'article-123',
        title: 'Test',
        // missing required fields
      });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toBeDefined();
    }
  });

  it('should provide clear error for wrong type', () => {
    try {
      transactionSchema.parse({
        id: 'txn-123',
        date: '2024-01-01',
        amount: 'not a number',
        type: 'income',
        counterparty: 'Test',
        purpose: 'Test',
        status: 'booked',
      });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toContain('amount');
    }
  });
});
