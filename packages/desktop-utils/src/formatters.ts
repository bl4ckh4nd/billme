export type AddressFormatInput = {
  street?: string;
  line2?: string;
  zip?: string;
  city?: string;
  country?: string;
  company?: string;
  contactPerson?: string;
};

export const formatAddressLines = (a: AddressFormatInput): string[] => {
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

export const formatAddressMultiline = (a: AddressFormatInput): string => {
  return formatAddressLines(a).join('\n');
};

const currencyFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const formatCurrency = (amount: number): string => currencyFormat.format(amount);

export const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  // format() throws on an invalid date where toLocaleDateString answered "Invalid Date".
  return Number.isNaN(date.getTime()) ? date.toLocaleDateString('de-DE') : dateFormat.format(date);
};
export const localIsoDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
