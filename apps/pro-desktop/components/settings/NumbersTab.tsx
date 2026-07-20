import React from 'react';
import { FileDigit, HelpCircle } from 'lucide-react';
import { AppSettings } from '../../types';

interface NumbersTabProps {
  settings: AppSettings;
  updateNested: (section: keyof AppSettings, field: string, value: any) => void;
  nextInvoicePreview: string;
  nextCustomerPreview: string;
  parsePositiveInteger: (value: string, fallback: number, min?: number) => number;
}

export const NumbersTab: React.FC<NumbersTabProps> = ({
  settings,
  updateNested,
  nextInvoicePreview,
  nextCustomerPreview,
  parsePositiveInteger,
}) => {
  return (
    <div className="max-w-2xl space-y-8 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">Nummernkreise</h3>
        <p className="text-muted text-sm">Definieren Sie das Format für Ihre Rechnungs-, Angebots- und Kundennummern.</p>
      </div>

      <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle">
        <div className="flex justify-between items-start mb-6">
          <h4 className="font-bold flex items-center gap-2">
            <FileDigit size={18} /> Rechnungen
          </h4>
          <div className="bg-surface px-3 py-1 rounded-lg border border-border shadow-sm">
            <span className="text-xs font-bold text-muted uppercase mr-2">Vorschau:</span>
            <span className="font-mono font-bold">{nextInvoicePreview}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <label className="text-xs font-bold text-muted uppercase tracking-wide">Präfix Format</label>
              <div className="group relative">
                <HelpCircle size={12} className="text-muted cursor-help" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-foreground text-white text-xs p-2 rounded pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity ease-out z-10">
                  %Y = Aktuelles Jahr (z.B. 2023)
                </div>
              </div>
            </div>
            <input
              type="text"
              value={settings.numbers.invoicePrefix}
              onChange={(e) => updateNested('numbers', 'invoicePrefix', e.target.value)}
              className="w-full bg-surface border border-border rounded-lg p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Nächste Nummer</label>
            <input
              type="number"
              value={settings.numbers.nextInvoiceNumber}
              min={1}
              onChange={(e) => updateNested(
                'numbers',
                'nextInvoiceNumber',
                parsePositiveInteger(e.target.value, settings.numbers.nextInvoiceNumber),
              )}
              className="w-full bg-surface border border-border rounded-lg p-3 tabular-nums text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Mindestlänge (Padding)</label>
          <input
            type="range"
            min="1"
            max="6"
            step="1"
            value={settings.numbers.numberLength}
            onChange={(e) => updateNested(
              'numbers',
              'numberLength',
              parsePositiveInteger(e.target.value, settings.numbers.numberLength),
            )}
            className="w-full accent-black h-2 bg-canvas rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs font-bold text-muted mt-1">
            <span>1</span>
            <span>{settings.numbers.numberLength} Stellen (z.B. 001)</span>
            <span>6</span>
          </div>
        </div>
      </div>

      <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle opacity-70 hover:opacity-100 transition-opacity duration-150 ease-out">
        <div className="flex justify-between items-start mb-6">
          <h4 className="font-bold flex items-center gap-2">
            <FileDigit size={18} /> Angebote
          </h4>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Präfix Format</label>
            <input
              type="text"
              value={settings.numbers.offerPrefix}
              onChange={(e) => updateNested('numbers', 'offerPrefix', e.target.value)}
              className="w-full bg-surface border border-border rounded-lg p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Nächste Nummer</label>
            <input
              type="number"
              value={settings.numbers.nextOfferNumber}
              min={1}
              onChange={(e) => updateNested(
                'numbers',
                'nextOfferNumber',
                parsePositiveInteger(e.target.value, settings.numbers.nextOfferNumber),
              )}
              className="w-full bg-surface border border-border rounded-lg p-3 tabular-nums text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
            />
          </div>
        </div>
      </div>

      <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle opacity-70 hover:opacity-100 transition-opacity duration-150 ease-out">
        <div className="flex justify-between items-start mb-6">
          <h4 className="font-bold flex items-center gap-2">
            <FileDigit size={18} /> Kunden
          </h4>
          <div className="bg-surface px-3 py-1 rounded-lg border border-border shadow-sm">
            <span className="text-xs font-bold text-muted uppercase mr-2">Vorschau:</span>
            <span className="font-mono font-bold">{nextCustomerPreview}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Präfix Format</label>
            <input
              type="text"
              value={settings.numbers.customerPrefix}
              onChange={(e) => updateNested('numbers', 'customerPrefix', e.target.value)}
              className="w-full bg-surface border border-border rounded-lg p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Nächste Nummer</label>
            <input
              type="number"
              value={settings.numbers.nextCustomerNumber}
              min={1}
              onChange={(e) => updateNested(
                'numbers',
                'nextCustomerNumber',
                parsePositiveInteger(e.target.value, settings.numbers.nextCustomerNumber),
              )}
              className="w-full bg-surface border border-border rounded-lg p-3 tabular-nums text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Mindestlänge (Padding)</label>
          <input
            type="range"
            min="1"
            max="8"
            step="1"
            value={settings.numbers.customerNumberLength}
            onChange={(e) => updateNested(
              'numbers',
              'customerNumberLength',
              parsePositiveInteger(e.target.value, settings.numbers.customerNumberLength),
            )}
            className="w-full accent-black h-2 bg-canvas rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs font-bold text-muted mt-1">
            <span>1</span>
            <span>{settings.numbers.customerNumberLength} Stellen (z.B. 0001)</span>
            <span>8</span>
          </div>
        </div>
      </div>
    </div>
  );
};
