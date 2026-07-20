import React from 'react';
import { CheckCircle, Megaphone, AlertTriangle, Repeat } from 'lucide-react';
import { AppSettings, DunningLevel } from '../../types';

interface DunningTabProps {
  settings: AppSettings;
  updateNested: (section: keyof AppSettings, field: string, value: any) => void;
  updateDunningLevel: (index: number, field: keyof DunningLevel, value: any) => void;
  updateAutomation: (field: string, value: any) => void;
  dunningRunning: boolean;
  handleManualDunningRun: () => Promise<void>;
  previewModalOpen: boolean;
  setPreviewModalOpen: (v: boolean) => void;
  previewLevelIndex: number | null;
  setPreviewLevelIndex: (v: number | null) => void;
  calculateNextRun: (runTime: string) => string;
}

export const DunningTab: React.FC<DunningTabProps> = ({
  settings,
  updateAutomation,
  updateDunningLevel,
  dunningRunning,
  handleManualDunningRun,
  setPreviewModalOpen,
  setPreviewLevelIndex,
  calculateNextRun,
}) => {
  const dunningEnabled = settings.automation?.dunningEnabled ?? false;
  const activeLevelCount = settings.dunning.levels.filter(l => l.enabled).length;
  const totalLevels = settings.dunning.levels.length;

  return (
    <div className="max-w-4xl space-y-6 animate-enter">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-xl font-bold mb-1">Mahnwesen</h3>
          <p className="text-muted text-sm">Automatische Zahlungserinnerungen und Mahnungen</p>
        </div>
      </div>

      {/* Master Enable/Disable Toggle */}
      <div
        className="bg-surface border-2 border-border-subtle rounded-xl p-6 hover:border-foreground transition-colors duration-150 ease-out cursor-pointer"
        onClick={() => updateAutomation('dunningEnabled', !dunningEnabled)}
      >
        <div className="flex items-center gap-4">
          <div
            className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${dunningEnabled ? 'bg-foreground border-foreground' : 'border-border'}`}
          >
            {dunningEnabled && <CheckCircle size={14} className="text-accent" />}
          </div>
          <div>
            <h4 className="font-bold text-sm">Mahnwesen aktivieren</h4>
            <p className="text-xs text-muted mt-1">Automatische Zahlungserinnerungen für überfällige Rechnungen</p>
          </div>
        </div>
      </div>

      {/* Email Provider Warning (if not configured) */}
      {dunningEnabled && settings.email.provider === 'none' && (
        <div className="bg-warning-bg border border-warning-border rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-foreground">E-Mail-Provider erforderlich</p>
            <p className="text-xs text-warning mt-1">
              Konfigurieren Sie SMTP oder Resend im E-Mail-Tab, um Mahnungen versenden zu können.
            </p>
          </div>
        </div>
      )}

      {/* Automation Settings Card (only when enabled) */}
      {dunningEnabled && (
        <div className="bg-surface-muted border border-border rounded-xl p-6 space-y-5">
          <h4 className="font-bold flex items-center gap-2">
            <Megaphone size={18} /> Automatisierung
          </h4>

          {/* Schedule Time */}
          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Tägliche Ausführung um</label>
            <input
              type="time"
              value={settings.automation?.dunningRunTime ?? '09:00'}
              onChange={(e) => updateAutomation('dunningRunTime', e.target.value)}
              className="w-48 bg-surface border border-border rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
            />
          </div>

          {/* Status Display */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface border border-border-subtle rounded-lg p-3">
              <label className="block text-[10px] font-bold text-muted uppercase tracking-wide mb-1">Letzter Lauf</label>
              <p className="text-sm font-bold text-foreground">
                {settings.automation?.lastDunningRun
                  ? new Date(settings.automation.lastDunningRun).toLocaleDateString('de-DE', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit'
                    })
                  : 'Noch nie'}
              </p>
            </div>
            <div className="bg-surface border border-border-subtle rounded-lg p-3">
              <label className="block text-[10px] font-bold text-muted uppercase tracking-wide mb-1">Nächster Lauf</label>
              <p className="text-sm font-bold text-foreground">
                {calculateNextRun(settings.automation?.dunningRunTime ?? '09:00')}
              </p>
            </div>
          </div>

          {/* Manual Trigger */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleManualDunningRun();
            }}
            disabled={dunningRunning || settings.email.provider === 'none' || activeLevelCount === 0}
            className="w-full px-4 py-3 bg-warning text-white rounded-xl hover:bg-warning/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150 ease-out text-sm font-bold flex items-center justify-center gap-2"
          >
            <Megaphone size={16} />
            {dunningRunning ? 'Läuft...' : 'Jetzt manuell ausführen'}
          </button>
        </div>
      )}

      {/* Dunning Levels Configuration (only when enabled) */}
      {dunningEnabled && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-bold">Mahnstufen</h4>
            <p className="text-sm text-muted">
              {activeLevelCount} von {totalLevels} aktiv
            </p>
          </div>

          {settings.dunning.levels.map((level, index) => (
            <div
              key={level.id}
              className={`bg-surface border rounded-xl overflow-hidden transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out ${
                level.enabled ? 'border-border hover:border-border' : 'border-border-subtle opacity-50'
              }`}
            >
              {/* Header with inline toggle */}
              <div className="bg-surface-muted px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Individual Enable Toggle */}
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={level.enabled}
                      onChange={(e) => updateDunningLevel(index, 'enabled', e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-canvas peer-focus:ring-2 peer-focus:ring-accent rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-[background-color,border-color,color,box-shadow,transform,opacity] peer-checked:bg-foreground"></div>
                  </label>

                  <span className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs ${
                    level.enabled ? 'bg-foreground text-white' : 'bg-canvas text-muted'
                  }`}>
                    {level.id}
                  </span>
                  <h5 className="font-bold text-sm">{level.name}</h5>
                </div>

                {/* Quick edit inline */}
                <div className="flex items-center gap-4 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted font-medium">nach</span>
                    <input
                      type="number"
                      value={level.daysAfterDueDate}
                      onChange={(e) => updateDunningLevel(index, 'daysAfterDueDate', Number(e.target.value))}
                      disabled={!level.enabled}
                      className="w-14 bg-surface border border-border rounded px-2 py-1 text-center font-bold tabular-nums focus:ring-2 focus:ring-accent outline-none disabled:opacity-50 transition-shadow duration-150 ease-out"
                    />
                    <span className="text-muted font-medium">Tagen</span>
                  </div>
                  <div className="h-4 w-px bg-border"></div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted font-medium">Gebühr</span>
                    <input
                      type="number"
                      step="0.01"
                      value={level.fee}
                      onChange={(e) => updateDunningLevel(index, 'fee', Number(e.target.value))}
                      disabled={!level.enabled}
                      className="w-16 bg-surface border border-border rounded px-2 py-1 text-center font-bold tabular-nums focus:ring-2 focus:ring-accent outline-none disabled:opacity-50 transition-shadow duration-150 ease-out"
                    />
                    <span className="text-muted font-medium">€</span>
                  </div>
                </div>
              </div>

              {/* Content (subject + text) */}
              {level.enabled && (
                <div className="p-4 space-y-3">
                  <div>
                    <label className="block text-[10px] font-bold text-muted mb-1.5 uppercase tracking-wide">Betreff</label>
                    <input
                      type="text"
                      value={level.subject}
                      onChange={(e) => updateDunningLevel(index, 'subject', e.target.value)}
                      className="w-full bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
                      placeholder="z.B. Zahlungserinnerung für Rechnung %N"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wide">Einleitungstext</label>
                      <button
                        onClick={() => {
                          setPreviewLevelIndex(index);
                          setPreviewModalOpen(true);
                        }}
                        className="px-2.5 py-1 bg-canvas hover:bg-canvas/80 text-muted rounded text-[10px] font-bold transition-colors duration-150 ease-out"
                      >
                        Vorschau
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={level.text}
                      onChange={(e) => updateDunningLevel(index, 'text', e.target.value)}
                      className="w-full bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none transition-shadow duration-150 ease-out"
                      placeholder="z.B. leider haben wir noch keinen Zahlungseingang für die Rechnung %N vom %D über %A erhalten..."
                    />
                    <div className="mt-1.5 flex items-center justify-between">
                      <div className="flex flex-wrap gap-1">
                        {[
                          { code: '%N', label: 'Nr.', present: level.text.includes('%N') },
                          { code: '%D', label: 'Datum', present: level.text.includes('%D') },
                          { code: '%A', label: 'Betrag', present: level.text.includes('%A') },
                          { code: '%C', label: 'Kunde', present: level.text.includes('%C') },
                        ].map((ph) => (
                          <button
                            key={ph.code}
                            onClick={() => {
                              const textarea = document.querySelector(`textarea[value="${level.text}"]`) as HTMLTextAreaElement;
                              if (textarea) {
                                const start = textarea.selectionStart;
                                const end = textarea.selectionEnd;
                                const newText = level.text.substring(0, start) + ph.code + level.text.substring(end);
                                updateDunningLevel(index, 'text', newText);
                                setTimeout(() => {
                                  textarea.focus();
                                  textarea.setSelectionRange(start + ph.code.length, start + ph.code.length);
                                }, 0);
                              }
                            }}
                            className={`px-1.5 py-1 rounded text-[10px] font-bold transition-colors duration-150 ease-out ${
                              ph.present
                                ? 'bg-success-bg text-success'
                                : 'bg-canvas text-muted hover:bg-canvas/80'
                            }`}
                            title={`${ph.label} einfügen`}
                          >
                            {ph.code}
                          </button>
                        ))}
                      </div>
                      {(!level.text.includes('%N') || !level.text.includes('%A')) && (
                        <div className="flex items-center gap-1 text-warning">
                          <AlertTriangle size={12} />
                          <span className="text-[10px] font-medium">%N und %A empfohlen</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Disabled State Message */}
      {!dunningEnabled && (
        <div className="text-center py-12 text-muted">
          <Megaphone size={48} className="mx-auto mb-4 opacity-30" />
          <p>Aktivieren Sie das Mahnwesen, um Mahnstufen zu konfigurieren</p>
        </div>
      )}

      {/* Recurring Invoices Section */}
      <div className="border-t border-border pt-8 mt-8">
        <div className="mb-6">
          <h3 className="text-xl font-bold mb-1 flex items-center gap-2">
            <Repeat size={22} /> Automatische Abo-Rechnungen
          </h3>
          <p className="text-muted text-sm">Automatische Generierung wiederkehrender Rechnungen</p>
        </div>

        {/* Master Enable/Disable Toggle */}
        <div
          className="bg-surface border-2 border-border-subtle rounded-xl p-6 hover:border-foreground transition-colors duration-150 ease-out cursor-pointer"
          onClick={() => updateAutomation('recurringEnabled', !settings.automation.recurringEnabled)}
        >
          <div className="flex items-center gap-4">
            <div
              className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.automation.recurringEnabled ? 'bg-foreground border-foreground' : 'border-border'}`}
            >
              {settings.automation.recurringEnabled && <CheckCircle size={14} className="text-accent" />}
            </div>
            <div>
              <h4 className="font-bold text-sm">Automatische Generierung aktivieren</h4>
              <p className="text-xs text-muted mt-1">Abo-Rechnungen werden automatisch zum festgelegten Zeitpunkt erstellt</p>
            </div>
          </div>
        </div>

        {/* Automation Settings Card (only when enabled) */}
        {settings.automation.recurringEnabled && (
          <div className="bg-surface-muted border border-border rounded-xl p-6 space-y-5 mt-4">
            <h4 className="font-bold flex items-center gap-2">
              <Repeat size={18} /> Automatisierung
            </h4>

            {/* Schedule Time */}
            <div>
              <label className="block text-xs font-bold text-muted mb-2 uppercase tracking-wide">Tägliche Ausführung um</label>
              <input
                type="time"
                value={settings.automation?.recurringRunTime ?? '03:00'}
                onChange={(e) => updateAutomation('recurringRunTime', e.target.value)}
                className="w-48 bg-surface border border-border rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
              />
              <p className="text-xs text-muted mt-2">
                Empfohlen: 03:00 Uhr (nachts, um Konflikte mit Mahnlauf zu vermeiden)
              </p>
            </div>

            {/* Status Display */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-surface border border-border-subtle rounded-lg p-3">
                <label className="block text-[10px] font-bold text-muted uppercase tracking-wide mb-1">Letzter Lauf</label>
                <p className="text-sm font-bold text-foreground">
                  {settings.automation?.lastRecurringRun
                    ? new Date(settings.automation.lastRecurringRun).toLocaleDateString('de-DE', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit'
                      })
                    : 'Noch nie'}
                </p>
              </div>
              <div className="bg-surface border border-border-subtle rounded-lg p-3">
                <label className="block text-[10px] font-bold text-muted uppercase tracking-wide mb-1">Nächster Lauf</label>
                <p className="text-sm font-bold text-foreground">
                  {calculateNextRun(settings.automation?.recurringRunTime ?? '03:00')}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
