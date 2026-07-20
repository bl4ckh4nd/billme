import React from 'react';
import { AppSettings } from '../../types';
import { ipc } from '../../ipc/client';

interface PortalTabProps {
  settings: AppSettings;
  updateNested: (section: keyof AppSettings, field: string, value: any) => void;
  portalApiKey: string;
  setPortalApiKey: (v: string) => void;
  setPortalApiKeyTouched: (v: boolean) => void;
  portalApiKeyConfigured: boolean;
  portalTestStatus: string | null;
  setPortalTestStatus: (v: string | null) => void;
}

export const PortalTab: React.FC<PortalTabProps> = ({
  settings,
  updateNested,
  portalApiKey,
  setPortalApiKey,
  setPortalApiKeyTouched,
  portalApiKeyConfigured,
  portalTestStatus,
  setPortalTestStatus,
}) => {
  return (
    <div className="max-w-2xl space-y-8 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">Offer Portal</h3>
        <p className="text-muted text-sm">Angebotslinks veröffentlichen und Status synchronisieren.</p>
      </div>

      <div className="bg-surface border-2 border-border-subtle rounded-xl p-6 space-y-6">
        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Portal Base URL</label>
          <input
            type="text"
            value={settings.portal.baseUrl}
            onChange={(e) => updateNested('portal', 'baseUrl', e.target.value)}
            placeholder="https://offers.example.com"
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-bold text-foreground focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
          />
          <p className="text-xs text-muted mt-2">Tipp: Setup-Seite im Portal: <span className="font-mono">/admin/setup</span></p>
        </div>

        <div>
          <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Publish API Key (optional)</label>
          <input
            type="password"
            value={portalApiKey}
            onChange={(e) => {
              setPortalApiKey(e.target.value);
              setPortalApiKeyTouched(true);
            }}
            placeholder={
              portalApiKeyConfigured
                ? '(gespeichert im OS Keychain, zum Ersetzen eingeben)'
                : '(im OS Keychain gespeichert)'
            }
            className="w-full bg-surface-muted border border-border rounded-lg p-4 font-bold text-foreground focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
          />
        </div>

        <div className="flex flex-col sm:flex-row gap-3 items-center">
          <button
            onClick={async () => {
              try {
                setPortalTestStatus('Prüfe Verbindung...');
                const baseUrl = settings.portal.baseUrl.trim();
                if (!baseUrl) throw new Error('Base URL fehlt');
                const res = await ipc.portal.health({ baseUrl });
                setPortalTestStatus(res.ok ? `OK (${res.ts})` : 'Fehler');
              } catch (e) {
                setPortalTestStatus(`Fehler: ${String(e)}`);
              }
            }}
            className="px-5 py-3 rounded-xl font-bold bg-surface border border-border hover:bg-surface-muted transition-colors duration-150 ease-out w-full sm:w-auto"
          >
            Verbindung testen
          </button>
          <div className="flex-1 text-sm font-medium text-muted w-full">
            {portalTestStatus}
          </div>
        </div>
      </div>
    </div>
  );
};
