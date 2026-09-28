import { Account } from '../types';

export const mockAccounts: Account[] = [
  { id: '1200', number: '1200', name: 'Bank', type: 'Asset', keywords: ['Girokonto', 'Sparkasse'] },
  { id: '1000', number: '1000', name: 'Kasse', type: 'Asset', keywords: ['Bargeld', 'Bar'] },
  {
    id: '4400',
    number: '4400',
    name: 'Erlöse 19% USt',
    type: 'Revenue',
    defaultTaxCode: 'USt19',
    keywords: ['Umsatz', 'Einnahmen', 'Verkauf'],
  },
  {
    id: '8400',
    number: '8400',
    name: 'Erlöse 19% USt (SKR03)',
    type: 'Revenue',
    defaultTaxCode: 'USt19',
    keywords: ['SKR03', 'Umsatz'],
  },
  {
    id: '4930',
    number: '4930',
    name: 'Bürobedarf',
    type: 'Expense',
    defaultTaxCode: 'VSt19',
    keywords: ['Stifte', 'Papier', 'Schreibtisch'],
  },
  {
    id: '4530',
    number: '4530',
    name: 'Laufende Kfz-Betriebskosten',
    type: 'Expense',
    defaultTaxCode: 'VSt19',
    keywords: ['Gas', 'Benzin', 'Tanken', 'Auto', 'Diesel'],
  },
  {
    id: '4980',
    number: '4980',
    name: 'Betriebsbedarf',
    type: 'Expense',
    defaultTaxCode: 'VSt19',
    keywords: ['Werkzeug', 'Material'],
  },
];
