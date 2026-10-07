import { randomUUID } from 'node:crypto';
import type { BillmeApi } from '@billme/desktop-contracts/api';
import { calculateInvoiceTaxSnapshot } from '@billme/server-core';

type Invoice = Awaited<ReturnType<BillmeApi['invoices']['upsert']>>;
type Item = Invoice['items'][number];

/** The local calendar day, as the app dates documents (UTC would be the day before shortly after midnight in Germany). */
export const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type DocumentInput = {
  client?: string;
  clientId?: string;
  clientEmail?: string;
  items?: Item[];
  taxMode?: Invoice['taxMode'];
  taxMeta?: Invoice['taxMeta'];
  date?: string;
  dueDate?: string;
};

/** Pro posts every issued invoice; zero-VAT modes need the DATEV evidence the Pro editor asks for. */
export const datevEvidence = (product: 'lite' | 'pro'): Partial<NonNullable<Invoice['taxMeta']>> =>
  product === 'pro' ? { datevEvidenceType: 'Rechnung', datevEvidenceReference: 'Nachweis-1', datevSachverhaltLl: '1' } as never : {};

const defaultItems = (): Item[] => [{ kind: 'item', description: 'Beratung', quantity: 2, price: 100, total: 200, taxRate: 19 }];

/** What the renderer does on "Neue Rechnung/Angebot": reserve a number, price with the user's settings. */
const buildDocument = async (api: Pick<BillmeApi, 'numbers' | 'settings'>, kind: 'invoice' | 'offer', input: DocumentInput) => {
  const settings = await api.settings.get();
  if (!settings) throw new Error('settings missing: the backend seeds defaults on first start');
  const reservation = await api.numbers.reserve({ kind });
  const items = input.items ?? defaultItems();
  const taxMode = input.taxMode ?? 'standard_vat';
  const taxSnapshot = calculateInvoiceTaxSnapshot({ items, taxMode, taxMeta: input.taxMeta }, settings);
  return {
    id: randomUUID(),
    number: reservation.number,
    numberReservationId: reservation.reservationId,
    client: input.client ?? 'Muster GmbH',
    clientId: input.clientId,
    clientEmail: input.clientEmail ?? 'kunde@example.com',
    clientAddress: 'Hauptstraße 1\n10115 Berlin',
    date: input.date ?? today(),
    dueDate: input.dueDate ?? addDays(input.date ?? today(), 14),
    amount: taxSnapshot.grossAmount,
    status: 'draft' as const,
    items,
    payments: [],
    history: [],
    taxMode,
    taxMeta: input.taxMeta,
    taxSnapshot,
  };
};

export const draftInvoice = async (api: BillmeApi, input: DocumentInput = {}): Promise<Invoice> =>
  api.invoices.upsert({ reason: 'create', invoice: await buildDocument(api, 'invoice', input) });

export const issueInvoice = async (api: BillmeApi, input: DocumentInput = {}): Promise<Invoice> => {
  const draft = await draftInvoice(api, input);
  return api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...draft, status: 'open' } });
};

export const draftOffer = async (api: BillmeApi, input: DocumentInput = {}): Promise<Awaited<ReturnType<BillmeApi['offers']['upsert']>>> =>
  api.offers.upsert({ reason: 'create', offer: await buildDocument(api, 'offer', input) } as never);

export const newClient = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  company: 'Kunde AG',
  contactPerson: 'Erika Beispiel',
  email: 'erika@example.com',
  phone: '+49 30 123456',
  address: 'Hauptstraße 1\n10115 Berlin',
  status: 'active' as const,
  tags: [],
  notes: '',
  projects: [],
  activities: [],
  ...overrides,
});

/** What onboarding asks for: §14 UStG refuses invoices from a seller without name, address and tax number. */
export const ISSUER = {
  company: { name: 'Muster GmbH', street: 'Musterweg 1', zip: '10115', city: 'Berlin', email: 'info@muster.example' },
  finance: { taxId: '12/345/67890', vatId: 'DE123456789' },
};

/** Runs `body` with the Kleinunternehmerregelung switched on, then restores the settings. Only §19 tenants may issue under §19. */
export const asSmallBusiness = async (api: Pick<BillmeApi, 'settings'>, body: () => Promise<void>) => {
  const toggle = async (smallBusinessRule: boolean) => {
    // Re-read: the settings carry the number counters, which `body` may have advanced.
    const settings = (await api.settings.get())!;
    await api.settings.set({ settings: { ...settings, legal: { ...settings.legal, smallBusinessRule } } });
  };
  await toggle(true);
  try { await body(); } finally { await toggle(false); }
};
