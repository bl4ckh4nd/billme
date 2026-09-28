import type { TaxCaseKey } from '../types';

export interface BookingTemplate {
  label: string;
  /** Payment direction the template fits: `out` books an expense, `in` a revenue. */
  direction: 'in' | 'out';
  /** Counter account booked against the bank line, with the gross amount and its tax case. */
  accountId: string;
  taxCaseKey?: TaxCaseKey;
}

// ponytail: static presets per chart; replace with user-defined templates once they get a store.
export const BOOKING_TEMPLATES: Record<'SKR03' | 'SKR04', BookingTemplate[]> = {
  SKR03: [
    { label: 'Wareneingang 19 %', direction: 'out', accountId: '3400', taxCaseKey: 'DE_STD_19' },
    { label: 'Bürobedarf', direction: 'out', accountId: '4930', taxCaseKey: 'DE_STD_19' },
    { label: 'Miete', direction: 'out', accountId: '4210' },
    { label: 'Erlöse 19 %', direction: 'in', accountId: '8400', taxCaseKey: 'DE_STD_19' },
  ],
  SKR04: [
    { label: 'Wareneingang 19 %', direction: 'out', accountId: '5400', taxCaseKey: 'DE_STD_19' },
    { label: 'Bürobedarf', direction: 'out', accountId: '6815', taxCaseKey: 'DE_STD_19' },
    { label: 'Miete', direction: 'out', accountId: '6310' },
    { label: 'Erlöse 19 %', direction: 'in', accountId: '4400', taxCaseKey: 'DE_STD_19' },
  ],
};
