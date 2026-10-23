import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Input, Switch } from '@billme/ui';
import { SettingsCard } from '@billme/desktop-renderer/components/SettingsView';
import type { IpcArgs, IpcResult } from '@billme/desktop-contracts-pro/contract';
import { ipc } from '../ipc/client';

type BookingSettings = IpcResult<'pro:getBookingSettings'>;

/** Einstellungen › Buchhaltung › Umbuchungen: detection, window and the two auto-post switches. Saves each change at once. */
export const ProTransferSettings: React.FC = () => {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['pro', 'booking-settings'], queryFn: () => ipc.pro.getBookingSettings() });
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [windowDraft, setWindowDraft] = React.useState<string | null>(null);

  const save = async (patch: IpcArgs<'pro:saveBookingSettings'>) => {
    setSaveError(null);
    try {
      const next: BookingSettings = await ipc.pro.saveBookingSettings(patch);
      queryClient.setQueryData(['pro', 'booking-settings'], next);
      // Suggestions in Bankabgleich and Buchen depend on these switches.
      void queryClient.invalidateQueries({ queryKey: ['pro'] });
      void queryClient.invalidateQueries({ queryKey: ['pro-accounting'] });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Einstellung konnte nicht gespeichert werden.');
    }
  };

  if (error) return <SettingsCard title="Umbuchungen"><p className="text-control text-error-text" role="alert">Einstellungen konnten nicht geladen werden.</p></SettingsCard>;
  if (!data) return <SettingsCard title="Umbuchungen"><p className="text-control text-muted" role="status">Wird geladen …</p></SettingsCard>;

  const commitWindow = () => {
    if (windowDraft === null) return;
    const days = Number(windowDraft);
    setWindowDraft(null);
    if (Number.isInteger(days) && days !== data.transferWindowDays) void save({ transferWindowDays: days });
  };

  return (
    <>
      <SettingsCard title="Umbuchungen erkennen" subtitle="Geld zwischen Ihren eigenen Konten, etwa Giro an Kreditkarte oder PayPal. Gebucht wird über Geldtransit, ohne Steuer und ohne Beleg.">
        <Switch
          checked={data.transferDetection}
          onCheckedChange={(checked) => void save({ transferDetection: checked })}
          label="Umbuchungen vorschlagen"
          description="Sicher, wenn die Gegen-IBAN eines Ihrer Konten ist. Wahrscheinlich bei Gegenbetrag auf einem anderen eigenen Konto im Zeitfenster."
        />
        <Input
          type="number"
          min={0}
          max={31}
          label="Zeitfenster in Tagen"
          hint="Wie weit die beiden Seiten auseinanderliegen dürfen. Ältere Kandidaten erscheinen nur unter Ausnahmen › Geldtransit offen."
          value={windowDraft ?? String(data.transferWindowDays)}
          disabled={!data.transferDetection}
          onChange={(event) => setWindowDraft(event.target.value)}
          onBlur={commitWindow}
          onKeyDown={(event) => { if (event.key === 'Enter') commitWindow(); }}
        />
      </SettingsCard>
      <SettingsCard title="Automatisch buchen" subtitle="Aus ist der Standard. Festgeschriebene Monate werden nie automatisch gebucht.">
        <Switch
          checked={data.autoPostTransfers}
          onCheckedChange={(checked) => void save({ autoPostTransfers: checked })}
          label="Sichere Umbuchungen beim Import buchen"
          description="Nur Paare, deren Gegen-IBAN eines Ihrer Konten ist und deren Gegenseite schon importiert ist."
        />
        <Switch
          checked={data.autoPostRules}
          onCheckedChange={(checked) => void save({ autoPostRules: checked })}
          label="Regeltreffer beim Import buchen"
          description="Nur Regeln, bei denen „Automatisch buchen“ an ist, und nur unveränderte Entwürfe ohne Prüfhinweis."
        />
        {saveError && <p className="text-control text-error-text" role="alert">{saveError}</p>}
      </SettingsCard>
    </>
  );
};
