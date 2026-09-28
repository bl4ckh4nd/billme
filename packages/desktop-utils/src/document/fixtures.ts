import type { TemplateKind } from '@billme/server-core/domain';
import type { AppSettingsLike, InvoiceLike } from '../placeholders';
import type { DocumentRenderInput } from './viewModel';

/** Sample data for the template gallery and the template editor preview. */
export const SAMPLE_SETTINGS: AppSettingsLike = {
  legal: { smallBusinessRule: false, defaultVatRate: 19, countryCode: 'DE' },
  company: {
    name: 'Holzwerk Brandt GmbH',
    owner: 'Jana Brandt',
    street: 'Sägewerkstraße 12',
    zip: '14482',
    city: 'Potsdam',
    email: 'buero@holzwerk-brandt.de',
    phone: '0331 204 88 10',
    website: 'holzwerk-brandt.de',
  },
  finance: {
    bankName: 'Mittelbrandenburgische Sparkasse',
    iban: 'DE12 1605 0000 1000 2345 67',
    bic: 'WELADED1PMB',
    taxId: '046/123/45678',
    vatId: 'DE298765432',
    registerCourt: 'Amtsgericht Potsdam HRB 31415',
  },
};

type Item = InvoiceLike['items'][number];
const item = (description: string, quantity: number, price: number, extra: Partial<Item> = {}): Item => ({
  kind: 'item', description, quantity, price, total: quantity * price, taxRate: 19, ...extra,
});

const WORKSHOP_ITEMS: Item[] = [
  { kind: 'group', description: 'Einbauschrank Flur', quantity: 0, price: 0, total: 0 },
  item('Aufmaß und Planung vor Ort', 3, 68, { kind: 'time', unit: 'Std.' }),
  item('Korpus Eiche massiv, geölt, 2 Türen mit Push-to-open', 1, 2480, { unit: 'Stk.' }),
  item('Montage inkl. Anpassung an Dachschräge', 6, 62, { kind: 'time', unit: 'Std.' }),
  { kind: 'summary', description: 'Zwischensumme Einbauschrank', quantity: 0, price: 0, total: 0 },
  { kind: 'group', description: 'Zubehör', quantity: 0, price: 0, total: 0 },
  item('LED-Innenbeleuchtung mit Türkontakt', 2, 89, { unit: 'Stk.', discountPercent: 10 }),
  { kind: 'optional', description: 'Nachölen nach 12 Monaten', quantity: 1, price: 145, total: 0, optionNote: 'nur auf Wunsch', taxRate: 19 },
];

const LONG_ITEMS: Item[] = Array.from({ length: 40 }, (_, index) =>
  item(
    index % 7 === 3
      ? `Position ${index + 1}: Fensterbank Eiche, Sondermaß nach Aufmaß, Kanten gefast und zweifach geölt, inklusive Montagematerial`
      : `Position ${index + 1}: Leistenmaterial Eiche 18×40 mm`,
    (index % 5) + 1,
    12.5 + index * 3.25,
    { unit: index % 3 === 0 ? 'lfm' : 'Stk.' },
  ),
);

const baseDocument = (overrides: Partial<InvoiceLike>): InvoiceLike => ({
  number: 'RE-2026-0147',
  date: '2026-09-24',
  dueDate: '2026-10-08',
  servicePeriod: '2026-09-19',
  client: 'Kanzlei Weber & Partner',
  clientNumber: 'KD-1042',
  clientAddress: 'z. Hd. Frau Dr. Weber\nLindenallee 8\n10785 Berlin',
  items: WORKSHOP_ITEMS,
  ...overrides,
});

export type SampleTaxCase = 'standard' | 'small_business' | 'reverse_charge' | 'mixed';

const MIXED_ITEMS: Item[] = [
  item('Fachbuch „Massivholz im Innenausbau“', 2, 49, { unit: 'Stk.', taxRate: 7 }),
  item('Workshop Oberflächenbehandlung', 1, 390, { unit: 'Tag' }),
  item('Hartwachsöl 2,5 l', 3, 64.5, { unit: 'Stk.' }),
];

export const sampleRenderInput = (
  kind: TemplateKind,
  options: { longItems?: boolean; tax?: SampleTaxCase } = {},
): Omit<DocumentRenderInput, 'template'> => {
  if (options.tax && options.tax !== 'standard') {
    const smallBusiness = options.tax === 'small_business';
    return {
      kind,
      settings: { ...SAMPLE_SETTINGS, legal: { ...SAMPLE_SETTINGS.legal, smallBusinessRule: smallBusiness } },
      document: baseDocument({
        documentKind: 'invoice',
        items: options.tax === 'mixed' ? MIXED_ITEMS : WORKSHOP_ITEMS,
        ...(options.tax === 'reverse_charge'
          ? { client: 'Snickeri Lindqvist AB', clientAddress: 'Hantverkargatan 4\n112 21 Stockholm\nSCHWEDEN', taxMode: 'intra_eu_service_reverse_charge' as const, taxMeta: { buyerVatId: 'SE556677889901' } }
          : {}),
      }),
    };
  }
  const items = options.longItems ? LONG_ITEMS : WORKSHOP_ITEMS;
  switch (kind) {
    case 'offer':
      return { kind, settings: SAMPLE_SETTINGS, document: baseDocument({ number: 'AN-2026-0088', dueDate: '2026-10-24', items }) };
    case 'order_confirmation':
      return { kind, settings: SAMPLE_SETTINGS, document: baseDocument({ number: 'AB-2026-0031', documentKind: 'order_confirmation', items }) };
    case 'delivery_note':
      return { kind, settings: SAMPLE_SETTINGS, document: baseDocument({ number: 'LS-2026-0052', documentKind: 'delivery_note', items }) };
    case 'credit_note':
      return {
        kind,
        settings: SAMPLE_SETTINGS,
        document: baseDocument({
          number: 'GS-2026-0007',
          documentKind: 'credit_note',
          items: [item('Gutschrift Preisminderung Kratzer an Tür links', 1, -120, { unit: 'pauschal' })],
        }),
        source: { number: 'RE-2026-0147', date: '2026-09-24', documentKind: 'invoice' },
      };
    case 'dunning':
      return {
        kind,
        settings: SAMPLE_SETTINGS,
        document: baseDocument({ date: '2026-08-12', dueDate: '2026-08-26' }),
        dunning: { levelName: '1. Mahnung', date: '2026-09-24', payUntil: '2026-10-01', fee: 5, originalAmount: 3752.83, daysOverdue: 29 },
      };
    default:
      return { kind, settings: SAMPLE_SETTINGS, document: baseDocument({ documentKind: 'invoice', items }) };
  }
};
