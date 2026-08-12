import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SETTINGS } from '../data/mockData';

const {
  listRecurringProfilesMock,
  upsertRecurringProfileMock,
  getClientMock,
  upsertInvoiceMock,
  ensureDefaultProjectMock,
  finalizeNumberMock,
  releaseNumberMock,
  reserveNumberMock,
  loggerInfoMock,
  loggerErrorMock,
  uuidMock,
} = vi.hoisted(() => ({
  listRecurringProfilesMock: vi.fn(),
  upsertRecurringProfileMock: vi.fn(),
  getClientMock: vi.fn(),
  upsertInvoiceMock: vi.fn(),
  ensureDefaultProjectMock: vi.fn(),
  finalizeNumberMock: vi.fn(),
  releaseNumberMock: vi.fn(),
  reserveNumberMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  uuidMock: vi.fn(() => 'invoice-uuid'),
}));

vi.mock('../db/recurringRepo', () => ({
  listRecurringProfiles: listRecurringProfilesMock,
  upsertRecurringProfile: upsertRecurringProfileMock,
}));

vi.mock('../db/clientsRepo', () => ({
  getClient: getClientMock,
}));

vi.mock('../db/invoicesRepo', () => ({
  upsertInvoice: upsertInvoiceMock,
  finalizeOutgoingInvoice: finalizeNumberMock,
}));

vi.mock('../db/projectsRepo', () => ({
  ensureDefaultProjectForClient: ensureDefaultProjectMock,
}));

vi.mock('../db/numberingRepo', () => ({
  finalizeNumber: finalizeNumberMock,
  releaseNumber: releaseNumberMock,
  reserveNumber: reserveNumberMock,
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: loggerInfoMock,
    error: loggerErrorMock,
  },
}));

vi.mock('uuid', () => ({
  v4: uuidMock,
}));

import {
  calculateNextRun,
  generateInvoiceFromProfile,
  processRecurringRun,
} from './recurringService';

const settings = structuredClone(MOCK_SETTINGS);
const makeClient = () => ({
  id: 'client-1',
  customerNumber: 'KD-0001',
  company: 'Acme GmbH',
  contactPerson: 'Alice',
  email: 'fallback@acme.example',
  phone: '+49',
  address: 'Fallback Str. 1',
  status: 'active',
  tags: [],
  notes: '',
  projects: [],
  activities: [],
  addresses: [
    {
      id: 'addr-billing',
      clientId: 'client-1',
      label: 'HQ',
      kind: 'billing',
      company: 'Acme GmbH',
      contactPerson: 'Alice',
      street: 'Main Street 1',
      line2: '2nd floor',
      zip: '12345',
      city: 'Berlin',
      country: 'DE',
      isDefaultBilling: true,
    },
    {
      id: 'addr-shipping',
      clientId: 'client-1',
      label: 'Warehouse',
      kind: 'shipping',
      street: 'Storage 9',
      zip: '67890',
      city: 'Hamburg',
      country: 'DE',
      isDefaultShipping: true,
    },
  ],
  emails: [
    {
      id: 'mail-1',
      clientId: 'client-1',
      label: 'billing',
      kind: 'billing',
      email: 'billing@acme.example',
      isDefaultBilling: true,
    },
  ],
});

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  clientId: 'client-1',
  active: true,
  name: 'Maintenance',
  interval: 'monthly',
  nextRun: '2026-05-10',
  amount: 0,
  items: [
    { description: 'Service A', quantity: 2, price: 50, total: 0 },
    { description: 'Service B', quantity: 1, price: 25, total: 25 },
  ],
  ...overrides,
});

describe('recurringService integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T09:00:00.000Z'));

    listRecurringProfilesMock.mockReset();
    upsertRecurringProfileMock.mockReset();
    getClientMock.mockReset();
    upsertInvoiceMock.mockReset();
    ensureDefaultProjectMock.mockReset();
    finalizeNumberMock.mockReset();
    releaseNumberMock.mockReset();
    reserveNumberMock.mockReset();
    loggerInfoMock.mockReset();
    loggerErrorMock.mockReset();
    uuidMock.mockClear();

    reserveNumberMock.mockReturnValue({ reservationId: 'res-1', number: 'RE-2026-001' });
    ensureDefaultProjectMock.mockReturnValue({ id: 'project-1' });
    getClientMock.mockReturnValue(makeClient());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates invoice from recurring profile and finalizes reservation', () => {
    const invoice = generateInvoiceFromProfile({} as any, makeProfile() as any, settings as any);

    expect(invoice.id).toBe('invoice-uuid');
    expect(invoice.number).toBe('RE-2026-001');
    expect(invoice.projectId).toBe('project-1');
    expect(invoice.clientEmail).toBe('billing@acme.example');
    expect(invoice.clientAddress).toContain('Acme GmbH');
    expect(invoice.clientAddress).toContain('Main Street 1');
    expect(invoice.amount).toBeCloseTo(148.75, 5);
    expect(upsertInvoiceMock).toHaveBeenCalledWith(
      {} as any,
      expect.objectContaining({ number: 'RE-2026-001' }),
      'Auto-generated from recurring profile profile-1',
    );
    expect(finalizeNumberMock).toHaveBeenCalledWith({} as any, 'res-1', 'invoice-uuid');
    expect(releaseNumberMock).not.toHaveBeenCalled();
  });

  it('uses net total when small business rule is active', () => {
    const smallBusinessSettings = {
      ...settings,
      legal: { ...settings.legal, smallBusinessRule: true, defaultVatRate: 19 },
    };

    const invoice = generateInvoiceFromProfile({} as any, makeProfile() as any, smallBusinessSettings as any);
    expect(invoice.amount).toBe(125);
  });

  it('uses fallback contact fields when structured addresses and emails are missing', () => {
    getClientMock.mockReturnValue({
      ...makeClient(),
      addresses: [],
      emails: [],
    });

    const invoice = generateInvoiceFromProfile({} as any, makeProfile() as any, settings as any);

    expect(invoice.clientEmail).toBe('fallback@acme.example');
    expect(invoice.clientAddress).toBe('Fallback Str. 1');
    expect(invoice.billingAddressJson).toBeUndefined();
    expect(invoice.shippingAddressJson).toBeUndefined();
  });

  it('uses kind-based address and general email fallbacks when defaults are absent', () => {
    getClientMock.mockReturnValue({
      ...makeClient(),
      addresses: [
        {
          id: 'addr-billing-kind',
          clientId: 'client-1',
          label: 'Billing',
          kind: 'billing',
          street: 'Billing St. 7',
          zip: '10000',
          city: 'Berlin',
          country: 'DE',
        },
        {
          id: 'addr-shipping-kind',
          clientId: 'client-1',
          label: 'Shipping',
          kind: 'shipping',
          street: 'Shipping St. 8',
          zip: '20000',
          city: 'Hamburg',
          country: 'DE',
        },
      ],
      emails: [
        {
          id: 'mail-general',
          clientId: 'client-1',
          label: 'general',
          kind: 'general',
          email: 'general@acme.example',
          isDefaultGeneral: true,
        },
      ],
    });

    const invoice = generateInvoiceFromProfile({} as any, makeProfile() as any, settings as any);

    expect(invoice.clientEmail).toBe('general@acme.example');
    expect(invoice.clientAddress).toContain('Billing St. 7');
    expect(invoice.shippingAddressJson).toEqual(
      expect.objectContaining({
        street: 'Shipping St. 8',
      }),
    );
  });

  it('normalizes invalid item values and guards non-finite invoice totals', () => {
    const badProfile = makeProfile({
      items: [{
        description: 'Invalid',
        quantity: 'x',
        price: 'y',
        total: Number.POSITIVE_INFINITY,
      }],
    });

    const invoice = generateInvoiceFromProfile({} as any, badProfile as any, settings as any);

    expect(invoice.items[0]).toEqual(expect.objectContaining({
      quantity: 0,
      price: 0,
      total: Number.POSITIVE_INFINITY,
    }));
    expect(invoice.amount).toBe(0);
  });

  it('supports all recurrence intervals in invoice generation', () => {
    for (const interval of ['daily', 'quarterly', 'yearly'] as const) {
      const invoice = generateInvoiceFromProfile(
        {} as any,
        makeProfile({ interval }) as any,
        settings as any,
      );
      expect(invoice.servicePeriod).toBe('2026-05-10');
    }
  });

  it('throws when client is missing', () => {
    getClientMock.mockReturnValue(null);

    expect(() => generateInvoiceFromProfile({} as any, makeProfile() as any, settings as any))
      .toThrow('Client client-1 not found');
    expect(reserveNumberMock).not.toHaveBeenCalled();
  });

  it('throws when client is inactive', () => {
    getClientMock.mockReturnValue({ ...makeClient(), status: 'inactive' });

    expect(() => generateInvoiceFromProfile({} as any, makeProfile() as any, settings as any))
      .toThrow('Client client-1 is not active');
    expect(reserveNumberMock).not.toHaveBeenCalled();
  });

  it('releases reservation when persistence fails', () => {
    upsertInvoiceMock.mockImplementation(() => {
      throw new Error('persist failed');
    });

    expect(() => generateInvoiceFromProfile({} as any, makeProfile() as any, settings as any))
      .toThrow('persist failed');
    expect(releaseNumberMock).toHaveBeenCalledWith({} as any, 'res-1');
    expect(finalizeNumberMock).not.toHaveBeenCalled();
  });

  it('still rethrows original error if releasing reservation fails', () => {
    upsertInvoiceMock.mockImplementation(() => {
      throw new Error('persist failed');
    });
    releaseNumberMock.mockImplementation(() => {
      throw new Error('release failed');
    });

    expect(() => generateInvoiceFromProfile({} as any, makeProfile() as any, settings as any))
      .toThrow('persist failed');
  });

  it('processes due profiles, deactivates on endDate, and records errors', async () => {
    getClientMock.mockImplementation((_db: unknown, clientId: string) =>
      clientId === 'missing-client' ? null : makeClient(),
    );
    listRecurringProfilesMock.mockReturnValue([
      makeProfile({ id: 'due-ok', name: 'Due OK', interval: 'weekly', nextRun: '2026-05-10' }),
      makeProfile({
        id: 'deactivate',
        name: 'Deactivate',
        nextRun: '2026-05-10',
        endDate: '2026-05-15',
      }),
      makeProfile({
        id: 'error',
        name: 'Error profile',
        clientId: 'missing-client',
        nextRun: '2026-05-09',
      }),
      makeProfile({ id: 'future', nextRun: '2026-05-11', name: 'Future' }),
      makeProfile({ id: 'inactive', active: false, name: 'Inactive' }),
      makeProfile({ id: 'ended', endDate: '2026-05-10', name: 'Ended same day' }),
    ]);

    const result = await processRecurringRun({} as any, settings as any);

    expect(result.generated).toBe(2);
    expect(result.deactivated).toBe(1);
    expect(result.errors).toEqual([
      { profileName: 'Error profile', error: 'Client missing-client not found' },
    ]);
    expect(upsertRecurringProfileMock).toHaveBeenCalledTimes(2);

    const updated = upsertRecurringProfileMock.mock.calls.map(([, profile]) => profile);
    expect(updated.find((p) => p.id === 'due-ok')).toEqual(
      expect.objectContaining({
        active: true,
        lastRun: '2026-05-10',
        nextRun: '2026-05-17',
      }),
    );
    expect(updated.find((p) => p.id === 'deactivate')).toEqual(
      expect.objectContaining({
        active: false,
        lastRun: '2026-05-10',
        nextRun: '2026-05-15',
      }),
    );
  });

  it('throws for unsupported interval', () => {
    expect(() => calculateNextRun('2026-01-01', 'hourly' as any)).toThrow('Unsupported interval');
  });

  it('throws when invoice generation receives unsupported interval', () => {
    expect(() =>
      generateInvoiceFromProfile(
        {} as any,
        makeProfile({ interval: 'hourly' as any }) as any,
        settings as any,
      ),
    ).toThrow('Unsupported interval');
  });
});
