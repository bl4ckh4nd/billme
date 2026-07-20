import React from 'react';
import { CheckCircle } from 'lucide-react';
import { AppSettings } from '../../types';

interface LegalTabProps {
  settings: AppSettings;
  updateNested: (section: keyof AppSettings, field: string, value: any) => void;
}

export const LegalTab: React.FC<LegalTabProps> = ({ settings, updateNested }) => {
  return (
    <div className="max-w-2xl space-y-8 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">Rechtliches & Texte</h3>
        <p className="text-muted text-sm">Steuerliche Einstellungen und Standardtexte.</p>
      </div>

      <div
        className="bg-surface border-2 border-border-subtle rounded-xl p-6 hover:border-foreground transition-colors duration-200 ease-out cursor-pointer"
        onClick={() => updateNested('legal', 'smallBusinessRule', !settings.legal.smallBusinessRule)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div
              className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.legal.smallBusinessRule ? 'bg-foreground border-foreground' : 'border-border'}`}
            >
              {settings.legal.smallBusinessRule && <CheckCircle size={14} className="text-accent" />}
            </div>
            <div>
              <h4 className="font-bold text-sm">Kleinunternehmerregelung anwenden</h4>
              <p className="text-xs text-muted mt-1">Keine Umsatzsteuerberechnung gem. § 19 UStG.</p>
            </div>
          </div>
        </div>
      </div>

      <div
        className="bg-surface border-2 border-border-subtle rounded-xl p-6 hover:border-foreground transition-colors duration-200 ease-out cursor-pointer"
        onClick={() => updateNested('eInvoice', 'enabled', !settings.eInvoice.enabled)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div
              className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.eInvoice.enabled ? 'bg-foreground border-foreground' : 'border-border'}`}
            >
              {settings.eInvoice.enabled && <CheckCircle size={14} className="text-accent" />}
            </div>
            <div>
              <h4 className="font-bold text-sm">ZUGFeRD Export für Rechnungen aktivieren</h4>
              <p className="text-xs text-muted mt-1">
                Exportiert Rechnungen als ZUGFeRD EN16931 (Profil {settings.eInvoice.profile}, Version {settings.eInvoice.version}).
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className={settings.legal.smallBusinessRule ? 'opacity-30 pointer-events-none' : ''}>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Standard Umsatzsteuer (%)</label>
          <input
            type="number"
            value={settings.legal.defaultVatRate}
            onChange={(e) => updateNested('legal', 'defaultVatRate', parseFloat(e.target.value))}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-bold text-foreground tabular-nums focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Zahlungsziel (Tage)</label>
          <input
            type="number"
            value={settings.legal.paymentTermsDays}
            onChange={(e) => updateNested('legal', 'paymentTermsDays', parseInt(e.target.value))}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-bold text-foreground tabular-nums focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
      </div>

      <div className="bg-surface border border-border-subtle rounded-xl p-6">
        <h4 className="font-bold text-sm mb-2">Umsatzsteuer-Basis (Dashboard)</h4>
        <p className="text-xs text-muted mb-4">
          Soll: basiert auf gestellten Rechnungen (Status ≠ Entwurf) nach Rechnungsdatum. Ist: basiert auf erfassten Zahlungen nach Zahlungsdatum.
        </p>
        <div className="flex items-center gap-2 bg-canvas p-1.5 rounded-full border border-border w-fit">
          {(['soll', 'ist'] as const).map((m) => (
            <button
              key={m}
              onClick={() => updateNested('legal', 'taxAccountingMethod', m)}
              className={`px-5 py-2 rounded-full text-xs font-bold transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out ${
                (settings.legal.taxAccountingMethod ?? 'soll') === m
                  ? 'bg-foreground text-white shadow-md'
                  : 'text-muted hover:bg-surface hover:text-foreground hover:shadow-sm'
              }`}
            >
              {m === 'soll' ? 'Soll' : 'Ist'}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border-subtle pt-6">
        <h4 className="font-bold text-sm mb-4">Standardtexte</h4>

        <div className="mb-6">
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Einleitungstext (Standard)</label>
          <textarea
            value={settings.legal.defaultIntroText}
            onChange={(e) => updateNested('legal', 'defaultIntroText', e.target.value)}
            rows={3}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none transition-shadow duration-200 ease-out"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Fußzeilentext (Zusatz)</label>
          <textarea
            value={settings.legal.defaultFooterText}
            onChange={(e) => updateNested('legal', 'defaultFooterText', e.target.value)}
            rows={2}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none transition-shadow duration-200 ease-out"
          />
        </div>
      </div>
    </div>
  );
};
