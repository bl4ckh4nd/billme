import React from 'react';
import { Landmark } from 'lucide-react';
import { AppSettings } from '../../types';

interface FinanceTabProps {
  settings: AppSettings;
  updateNested: (section: keyof AppSettings, field: string, value: any) => void;
}

export const FinanceTab: React.FC<FinanceTabProps> = ({ settings, updateNested }) => {
  return (
    <div className="max-w-2xl space-y-8 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">Bankverbindung & Steuer</h3>
        <p className="text-muted text-sm">Wichtig für den Zahlungsverkehr und die Pflichtangaben auf der Rechnung.</p>
      </div>

      <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle">
        <h4 className="font-bold mb-4 flex items-center gap-2 text-sm uppercase">
          <Landmark size={16} /> Bankkonto
        </h4>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-muted mb-2">Bankname</label>
            <input
              type="text"
              value={settings.finance.bankName}
              onChange={(e) => updateNested('finance', 'bankName', e.target.value)}
              className="w-full bg-surface border border-border rounded-lg p-3 text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-muted mb-2">IBAN</label>
              <input
                type="text"
                value={settings.finance.iban}
                onChange={(e) => updateNested('finance', 'iban', e.target.value)}
                className="w-full bg-surface border border-border rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-muted mb-2">BIC</label>
              <input
                type="text"
                value={settings.finance.bic}
                onChange={(e) => updateNested('finance', 'bic', e.target.value)}
                className="w-full bg-surface border border-border rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Steuernummer</label>
          <input
            type="text"
            value={settings.finance.taxId}
            onChange={(e) => updateNested('finance', 'taxId', e.target.value)}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">USt-IdNr.</label>
          <input
            type="text"
            value={settings.finance.vatId}
            onChange={(e) => updateNested('finance', 'vatId', e.target.value)}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Registergericht / HRB</label>
        <input
          type="text"
          value={settings.finance.registerCourt}
          onChange={(e) => updateNested('finance', 'registerCourt', e.target.value)}
          placeholder="z.B. Amtsgericht Berlin HRB 12345"
          className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
        />
      </div>
    </div>
  );
};
