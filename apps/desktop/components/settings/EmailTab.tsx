import React from 'react';
import { AppSettings } from '../../types';

interface EmailTabProps {
  settings: AppSettings;
  updateNested: (section: keyof AppSettings, field: string, value: any) => void;
  smtpPassword: string;
  setSmtpPassword: (v: string) => void;
  smtpPasswordConfigured: boolean;
  setSmtpPasswordTouched: (v: boolean) => void;
  resendApiKey: string;
  setResendApiKey: (v: string) => void;
  resendApiKeyConfigured: boolean;
  setResendApiKeyTouched: (v: boolean) => void;
  emailTestStatus: { success: boolean; message: string } | null;
  setEmailTestStatus: (v: { success: boolean; message: string } | null) => void;
  emailTesting: boolean;
  handleEmailTest: () => Promise<void>;
}

export const EmailTab: React.FC<EmailTabProps> = ({
  settings,
  updateNested,
  smtpPassword,
  setSmtpPassword,
  smtpPasswordConfigured,
  setSmtpPasswordTouched,
  resendApiKey,
  setResendApiKey,
  resendApiKeyConfigured,
  setResendApiKeyTouched,
  emailTestStatus,
  setEmailTestStatus,
  emailTesting,
  handleEmailTest,
}) => {
  return (
    <div className="max-w-3xl space-y-8 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">E-Mail Konfiguration</h3>
        <p className="text-muted text-sm">Konfigurieren Sie SMTP oder Resend für den E-Mail-Versand.</p>
      </div>

      {/* Provider Selection */}
      <div className="bg-surface border border-border rounded-xl p-6">
        <h4 className="font-bold mb-4">E-Mail-Anbieter</h4>
        <div className="flex gap-3">
          <button
            onClick={() => updateNested('email', 'provider', 'none')}
            className={`flex-1 p-4 rounded-lg border-2 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out ${
              settings.email.provider === 'none'
                ? 'border-accent bg-accent/10'
                : 'border-border hover:border-muted/50'
            }`}
          >
            <div className="font-semibold">Kein Versand</div>
            <div className="text-xs text-muted mt-1">E-Mails deaktiviert</div>
          </button>
          <button
            onClick={() => updateNested('email', 'provider', 'smtp')}
            className={`flex-1 p-4 rounded-lg border-2 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out ${
              settings.email.provider === 'smtp'
                ? 'border-accent bg-accent/10'
                : 'border-border hover:border-muted/50'
            }`}
          >
            <div className="font-semibold">SMTP</div>
            <div className="text-xs text-muted mt-1">Eigener Mail-Server</div>
          </button>
          <button
            onClick={() => updateNested('email', 'provider', 'resend')}
            className={`flex-1 p-4 rounded-lg border-2 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out ${
              settings.email.provider === 'resend'
                ? 'border-accent bg-accent/10'
                : 'border-border hover:border-muted/50'
            }`}
          >
            <div className="font-semibold">Resend</div>
            <div className="text-xs text-muted mt-1">Transactional API</div>
          </button>
        </div>
      </div>

      {/* SMTP Configuration */}
      {settings.email.provider === 'smtp' && (
        <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
          <h4 className="font-bold">SMTP-Konfiguration</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-muted mb-2">Server (Host)</label>
              <input
                type="text"
                value={settings.email.smtpHost}
                onChange={(e) => updateNested('email', 'smtpHost', e.target.value)}
                placeholder="smtp.example.com"
                className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-muted mb-2">Port</label>
              <input
                type="number"
                value={settings.email.smtpPort}
                onChange={(e) => updateNested('email', 'smtpPort', Number(e.target.value))}
                placeholder="587"
                className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium tabular-nums focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.email.smtpSecure}
                onChange={(e) => updateNested('email', 'smtpSecure', e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm font-medium">SSL/TLS verwenden (empfohlen für Port 465)</span>
            </label>
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2">Benutzername</label>
            <input
              type="text"
              value={settings.email.smtpUser}
              onChange={(e) => updateNested('email', 'smtpUser', e.target.value)}
              placeholder="user@example.com"
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2">Passwort</label>
          <input
            type="password"
            value={smtpPassword}
            onChange={(e) => {
              setSmtpPassword(e.target.value);
              setSmtpPasswordTouched(true);
            }}
            placeholder={smtpPasswordConfigured ? '•••••••• (gespeichert)' : '••••••••'}
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
            <p className="text-xs text-muted mt-1">Wird sicher im System-Keychain gespeichert</p>
          </div>
          <div>
            <button
              onClick={handleEmailTest}
              disabled={
                emailTesting ||
                !settings.email.smtpHost ||
                !settings.email.smtpUser ||
                (!smtpPassword && !smtpPasswordConfigured)
              }
              className="px-4 py-2 bg-info text-white rounded-lg hover:bg-info/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 ease-out"
            >
              {emailTesting ? 'Teste Verbindung...' : 'Verbindung testen'}
            </button>
            {emailTestStatus && (
              <div className={`mt-3 p-3 rounded-lg ${emailTestStatus.success ? 'bg-success-bg text-success' : 'bg-error-bg text-error'}`}>
                <p className="text-sm font-medium">{emailTestStatus.message}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resend Configuration */}
      {settings.email.provider === 'resend' && (
        <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
          <h4 className="font-bold">Resend API-Konfiguration</h4>
          <div>
            <label className="block text-xs font-bold text-muted mb-2">API-Key</label>
            <input
              type="password"
              value={resendApiKey}
              onChange={(e) => {
                setResendApiKey(e.target.value);
                setResendApiKeyTouched(true);
                // Real-time format validation
                if (e.target.value && !e.target.value.startsWith('re_')) {
                  setEmailTestStatus({
                    success: false,
                    message: 'Warnung: Resend API-Keys beginnen üblicherweise mit "re_"',
                  });
                } else {
                  setEmailTestStatus(null);
                }
              }}
              placeholder={resendApiKeyConfigured ? 're_*** (gespeichert)' : 're_***'}
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
            <p className="text-xs text-muted mt-1">Wird sicher im System-Keychain gespeichert</p>
          </div>
          <div>
            <button
              onClick={handleEmailTest}
              disabled={emailTesting || (!resendApiKey && !resendApiKeyConfigured)}
              className="px-4 py-2 bg-info text-white rounded-lg hover:bg-info/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 ease-out"
            >
              {emailTesting ? 'Teste API-Key...' : 'API-Key testen'}
            </button>
            {emailTestStatus && (
              <div className={`mt-3 p-3 rounded-lg ${emailTestStatus.success ? 'bg-success-bg text-success' : 'bg-error-bg text-error'}`}>
                <p className="text-sm font-medium">{emailTestStatus.message}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sender Information */}
      {settings.email.provider !== 'none' && (
        <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
          <h4 className="font-bold">Absender-Informationen</h4>
          <div>
            <label className="block text-xs font-bold text-muted mb-2">Absender-Name</label>
            <input
              type="text"
              value={settings.email.fromName}
              onChange={(e) => updateNested('email', 'fromName', e.target.value)}
              placeholder={settings.company.name || 'Meine Firma'}
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-2">Absender-E-Mail</label>
            <input
              type="email"
              value={settings.email.fromEmail}
              onChange={(e) => updateNested('email', 'fromEmail', e.target.value)}
              placeholder={settings.company.email || 'info@example.com'}
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-200 ease-out"
            />
          </div>
        </div>
      )}
    </div>
  );
};
