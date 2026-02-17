import type { ClientAddress } from '../types';

export const formatAddressLines = (a: Pick<
  ClientAddress,
  'street' | 'line2' | 'zip' | 'city' | 'country' | 'company' | 'contactPerson'
>): string[] => {
  const lines: string[] = [];
  if (a.company) lines.push(a.company);
  if (a.contactPerson) lines.push(a.contactPerson);
  if (a.street) lines.push(a.street);
  if (a.line2) lines.push(a.line2);
  const cityLine = [a.zip, a.city].filter(Boolean).join(' ').trim();
  if (cityLine) lines.push(cityLine);
  if (a.country) lines.push(a.country);
  return lines;
};

export const formatAddressMultiline = (a: Pick<
  ClientAddress,
  'street' | 'line2' | 'zip' | 'city' | 'country' | 'company' | 'contactPerson'
>): string => {
  return formatAddressLines(a).join('\n');
};

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

export const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

