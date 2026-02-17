
import React from 'react';
import { Invoice, AppSettings } from '../types';

// --- Configuration ---

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

// --- Helpers ---

const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

// --- Core Logic ---

/**
 * Replaces {{variable}} placeholders with actual data from Invoice and Settings.
 */
export const replacePlaceholders = (text: string, invoice: Invoice, settings: AppSettings): string => {
    if (!text) return '';

    // Calculate totals on the fly
    const net = invoice.items.reduce((acc, item) => acc + item.total, 0);
    const taxRate = settings.legal.defaultVatRate; // Simplified
    const tax = net * (taxRate / 100);
    const gross = net + tax;

    // Flatten data map
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

        'total.net': formatCurrency(net),
        'total.tax': formatCurrency(tax),
        'total.gross': formatCurrency(gross),
        'total.taxRate': `${taxRate}%`,
    };

    return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
        const val = dataMap[key.trim()];
        return val !== undefined ? val : match;
    });
};

/**
 * Renders text with visual "pills" for placeholders.
 * Used in the Canvas Editor to make variables look nice.
 */
export const renderTextWithPlaceholders = (text: string) => {
    if (!text) return null;
    
    const parts = text.split(/(\{\{[^}]+\}\})/g);
    
    return (
        <span>
            {parts.map((part, i) => {
                const match = part.match(/\{\{([^}]+)\}\}/);
                if (match) {
                    const key = match[1].trim();
                    // Find label
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
