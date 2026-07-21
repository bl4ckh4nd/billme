type InvoiceItemLike = {
  description?: string;
  quantity?: number;
  price?: number;
  total?: number;
  unit?: string;
  discountPercent?: number;
  taxRate?: number;
};

export type InvoiceLike = {
  number: string;
  date?: string;
  dueDate?: string;
  servicePeriod?: string;
  client: string;
  clientNumber?: string;
  clientAddress?: string;
  clientEmail?: string;
  taxMode?:
    | 'standard_vat'
    | 'small_business_19_ustg'
    | 'reverse_charge_13b'
    | 'intra_eu_supply_6a'
    | 'intra_eu_service_reverse_charge'
    | 'export_third_country'
    | 'vat_exempt_4_ustg'
    | 'non_taxable_outside_scope';
  taxMeta?: {
    legalReference?: string;
    exemptionReasonOverride?: string;
    buyerVatId?: string;
    sellerVatId?: string;
  };
  taxSnapshot?: {
    vatRateApplied: number;
    vatAmount: number;
    netAmount: number;
    grossAmount: number;
    einvoiceCategoryCode: 'S' | 'E' | 'AE' | 'O';
    label?: string;
    vatBreakdown?: Array<{ rate: number; netAmount: number; vatAmount: number }>;
  };
  items: InvoiceItemLike[];
};

export type AppSettingsLike = {
  legal: {
    smallBusinessRule?: boolean;
    defaultVatRate: number;
  };
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
  finance: {
    bankName: string;
    iban: string;
    bic: string;
    taxId: string;
    vatId: string;
  };
};

export interface VariableDefinition {
  key: string;
  label: string;
  description: string;
}

export const VARIABLE_GROUPS = [
  {
    title: 'Rechnung',
    variables: [
      { key: 'invoice.number', label: 'Nummer', description: 'Rechnungsnummer' },
      { key: 'invoice.date', label: 'Datum', description: 'Rechnungsdatum' },
      { key: 'invoice.dueDate', label: 'Fälligkeit', description: 'Fälligkeitsdatum' },
      { key: 'invoice.servicePeriod', label: 'Leistungszeitraum', description: 'Datum der Leistung' },
    ]
  },
  {
    title: 'Kunde',
    variables: [
      { key: 'client.company', label: 'Firma', description: 'Firmenname des Kunden' },
      { key: 'client.number', label: 'Kundennummer', description: 'Kundennummer (falls vorh.)' },
      { key: 'client.address', label: 'Adresse', description: 'Volle Anschrift mit Umbruch' },
      { key: 'client.email', label: 'E-Mail', description: 'E-Mail Adresse' },
    ]
  },
  {
    title: 'Meine Firma',
    variables: [
      { key: 'my.name', label: 'Name', description: 'Firmenname' },
      { key: 'my.owner', label: 'Inhaber', description: 'Geschäftsführer/Inhaber' },
      { key: 'my.address_line', label: 'Adresszeile', description: 'Einzeilige Adresse (für Fenster)' },
      { key: 'my.street', label: 'Straße', description: 'Straße und Hausnummer' },
      { key: 'my.zip', label: 'PLZ', description: 'Postleitzahl' },
      { key: 'my.city', label: 'Stadt', description: 'Stadt' },
      { key: 'my.email', label: 'E-Mail', description: 'Firmen E-Mail' },
      { key: 'my.phone', label: 'Telefon', description: 'Telefonnummer' },
      { key: 'my.website', label: 'Webseite', description: 'Webseite URL' },
    ]
  },
  {
    title: 'Finanzen',
    variables: [
      { key: 'my.bank', label: 'Bank Name', description: 'Name der Bank' },
      { key: 'my.iban', label: 'IBAN', description: 'IBAN' },
      { key: 'my.bic', label: 'BIC', description: 'BIC' },
      { key: 'my.taxId', label: 'Steuernummer', description: 'Steuernummer' },
      { key: 'my.vatId', label: 'USt-IdNr', description: 'Umsatzsteuer-ID' },
    ]
  },
  {
    title: 'Summen',
    variables: [
      { key: 'total.net', label: 'Netto', description: 'Nettosumme' },
      { key: 'total.tax', label: 'MwSt Betrag', description: 'Steuerbetrag' },
      { key: 'total.gross', label: 'Brutto', description: 'Gesamtsumme' },
      { key: 'total.taxRate', label: 'Steuersatz', description: 'z.B. 19%' },
    ]
  }
];

const formatDate = (dateString?: string) => {
  if (!dateString) return '';
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const toFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const calculateInvoiceItemTotal = (item: InvoiceItemLike): number => {
  const quantity = toFiniteNumber(item.quantity);
  const price = toFiniteNumber(item.price);
  if (quantity !== null && price !== null) {
    const discountPercent = Math.min(100, Math.max(0, toFiniteNumber(item.discountPercent) ?? 0));
    return round2(quantity * price * (1 - discountPercent / 100));
  }

  const total = toFiniteNumber(item.total);
  return total !== null ? round2(total) : 0;
};

export const getDefaultPaymentTermsText = (dueDate?: string): string => {
  const formattedDueDate = formatDate(dueDate);
  const paymentSentence = formattedDueDate
    ? `Bitte überweisen Sie den Betrag bis spätestens ${formattedDueDate} ohne Abzug auf das unten angegebene Konto.`
    : 'Bitte überweisen Sie den fälligen Betrag innerhalb von 14 Tagen auf das unten angegebene Konto.';
  return `${paymentSentence}\nEs gelten unsere AGB.`;
};

export const replacePlaceholders = (text: string, invoice: InvoiceLike, settings: AppSettingsLike): string => {
  if (!text) return '';

  const net = round2(invoice.items.reduce((acc, item) => acc + calculateInvoiceItemTotal(item), 0));
  const hasFreshStoredTaxSnapshot =
    invoice.taxSnapshot &&
    Math.abs(round2(invoice.taxSnapshot.netAmount) - net) < 0.005;
  const taxSnapshot =
    (hasFreshStoredTaxSnapshot ? invoice.taxSnapshot : undefined) ??
    (() => {
      const taxMode = settings.legal.smallBusinessRule
        ? 'small_business_19_ustg'
        : invoice.taxMode ?? 'standard_vat';
      if (taxMode === 'small_business_19_ustg') {
        return {
          vatRateApplied: 0,
          vatAmount: 0,
          netAmount: net,
          grossAmount: net,
          label: 'Keine Umsatzsteuer',
          einvoiceCategoryCode: 'E' as const,
        };
      }
      const zeroVatModes = new Set([
        'reverse_charge_13b',
        'intra_eu_supply_6a',
        'intra_eu_service_reverse_charge',
        'export_third_country',
        'vat_exempt_4_ustg',
        'non_taxable_outside_scope',
      ]);
      const defaultTaxRate = zeroVatModes.has(taxMode) ? 0 : Number(settings.legal.defaultVatRate) || 0;
      const netByRate = new Map<number, number>();
      for (const item of invoice.items) {
        const rate = zeroVatModes.has(taxMode) ? 0 : item.taxRate ?? defaultTaxRate;
        netByRate.set(rate, (netByRate.get(rate) ?? 0) + calculateInvoiceItemTotal(item));
      }
      const vatBreakdown = [...netByRate.entries()].map(([rate, netAmount]) => ({
        rate,
        netAmount: round2(netAmount),
        vatAmount: round2(netAmount * (rate / 100)),
      }));
      const vatRateApplied = vatBreakdown.length === 1 ? vatBreakdown[0]!.rate : defaultTaxRate;
      const vatAmount = round2(vatBreakdown.reduce((sum, entry) => sum + entry.vatAmount, 0));
      return {
        vatRateApplied,
        vatAmount,
        netAmount: net,
        grossAmount: round2(net + vatAmount),
        label: zeroVatModes.has(taxMode) ? 'Keine Umsatzsteuer' : `MwSt. ${vatRateApplied.toFixed(0)}%`,
        einvoiceCategoryCode: zeroVatModes.has(taxMode) ? 'E' : 'S',
        vatBreakdown,
      };
    })();

  const dataMap: Record<string, string> = {
    'invoice.number': invoice.number,
    'invoice.date': formatDate(invoice.date),
    'invoice.dueDate': formatDate(invoice.dueDate),
    'invoice.servicePeriod': invoice.servicePeriod ? formatDate(invoice.servicePeriod) : formatDate(invoice.date),
    'client.company': invoice.client,
    'client.number': invoice.clientNumber || '',
    'client.address': invoice.clientAddress || '',
    'client.email': invoice.clientEmail || '',
    'my.name': settings.company.name,
    'my.owner': settings.company.owner,
    'my.address_line': `${settings.company.name} | ${settings.company.street} | ${settings.company.zip} ${settings.company.city}`,
    'my.street': settings.company.street,
    'my.zip': settings.company.zip,
    'my.city': settings.company.city,
    'my.email': settings.company.email,
    'my.phone': settings.company.phone,
    'my.website': settings.company.website,
    'my.bank': settings.finance.bankName,
    'my.iban': settings.finance.iban,
    'my.bic': settings.finance.bic,
    'my.taxId': settings.finance.taxId,
    'my.vatId': settings.finance.vatId,
    'total.net': formatCurrency(taxSnapshot.netAmount),
    'total.tax': formatCurrency(taxSnapshot.vatAmount),
    'total.gross': formatCurrency(taxSnapshot.grossAmount),
    'total.taxRate': taxSnapshot.vatBreakdown && taxSnapshot.vatBreakdown.length > 1
      ? taxSnapshot.vatBreakdown.map((entry) => `${entry.rate}%`).join(' / ')
      : `${taxSnapshot.vatRateApplied}%`,
  };

  return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const val = dataMap[key.trim()];
    return val !== undefined ? val : match;
  });
};

export const renderTextWithPlaceholders = (text: string) => {
  if (!text) return null;

  const parts = text.split(/(\{\{[^}]+\}\})/g);

  return (
    <span>
      {parts.map((part, i) => {
        const match = part.match(/\{\{([^}]+)\}\}/);
        if (match) {
          const key = match[1].trim();
          let label = key;
          for (const group of VARIABLE_GROUPS) {
            const found = group.variables.find(v => v.key === key);
            if (found) {
              label = found.label;
              break;
            }
          }

          return (
            <span key={i} className="inline-flex items-center mx-0.5 align-baseline bg-indigo-50 border border-indigo-100 text-indigo-700 px-1.5 py-0 rounded text-[0.9em] font-medium select-none whitespace-nowrap" contentEditable={false}>
              {label}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
};
