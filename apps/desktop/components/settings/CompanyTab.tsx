import React from 'react';
import { AppSettings } from '../../types';

interface CompanyTabProps {
  settings: AppSettings;
  updateNested: (section: keyof AppSettings, field: string, value: any) => void;
}

export const CompanyTab: React.FC<CompanyTabProps> = ({ settings, updateNested }) => {
  return (
    <div className="max-w-2xl space-y-8 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">Unternehmensdaten</h3>
        <p className="text-muted text-sm">Diese Informationen erscheinen im Kopf- und Fußbereich der Rechnung.</p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Firmenname</label>
          <input
            type="text"
            value={settings.company.name}
            onChange={(e) => updateNested('company', 'name', e.target.value)}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-bold text-foreground focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Inhaber / Geschäftsführer</label>
          <input
            type="text"
            value={settings.company.owner}
            onChange={(e) => updateNested('company', 'owner', e.target.value)}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Straße & Hausnr.</label>
            <input
              type="text"
              value={settings.company.street}
              onChange={(e) => updateNested('company', 'street', e.target.value)}
              className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">PLZ</label>
            <input
              type="text"
              value={settings.company.zip}
              onChange={(e) => updateNested('company', 'zip', e.target.value)}
              className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Stadt</label>
          <input
            type="text"
            value={settings.company.city}
            onChange={(e) => updateNested('company', 'city', e.target.value)}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
        <div className="border-t border-border-subtle my-4"></div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">E-Mail Adresse</label>
            <input
              type="email"
              value={settings.company.email}
              onChange={(e) => updateNested('company', 'email', e.target.value)}
              className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Telefon</label>
            <input
              type="text"
              value={settings.company.phone}
              onChange={(e) => updateNested('company', 'phone', e.target.value)}
              className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Webseite</label>
          <input
            type="text"
            value={settings.company.website}
            onChange={(e) => updateNested('company', 'website', e.target.value)}
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
          />
        </div>
      </div>
    </div>
  );
};
