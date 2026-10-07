import { useId } from 'react';
import { X, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { Button, IconButton, Metric, Modal } from '@billme/ui';

interface DunningResult {
  processedInvoices: number;
  emailsSent: number;
  feesApplied: number;
  errors: Array<{ invoiceNumber: string; error: string }>;
}

const tileClass = 'rounded-tile border border-border bg-surface px-4 py-3.5';
const bannerClass = 'flex items-start gap-2.5 rounded-control border px-3 py-2.5 text-control';

interface DunningResultModalProps {
  isOpen: boolean;
  onClose: () => void;
  result: DunningResult | null;
}

export const DunningResultModal = ({ isOpen, onClose, result }: DunningResultModalProps) => {
  const titleId = useId();

  if (!isOpen || !result) return null;

  const hasErrors = result.errors.length > 0;
  const hasSuccesses = result.emailsSent > 0;
  const noInvoices = result.processedInvoices === 0;

  let IconComponent = CheckCircle2;
  let iconColor = 'text-success-text';
  let statusMessage = 'Mahnlauf erfolgreich abgeschlossen';

  if (noInvoices) {
    IconComponent = AlertTriangle;
    iconColor = 'text-muted';
    statusMessage = 'Keine überfälligen Rechnungen';
  } else if (hasErrors && !hasSuccesses) {
    IconComponent = XCircle;
    iconColor = 'text-error-text';
    statusMessage = 'Mahnlauf fehlgeschlagen';
  } else if (hasErrors && hasSuccesses) {
    IconComponent = AlertTriangle;
    iconColor = 'text-warning-text';
    statusMessage = 'Mahnlauf teilweise erfolgreich';
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      titleId={titleId}
      className="flex max-h-[84vh] max-w-3xl flex-col overflow-hidden"
    >
      <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
        <IconComponent size={20} className={`mt-0.5 shrink-0 ${iconColor}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-title text-foreground">{statusMessage}</h2>
          <p className="text-caption text-muted">Ergebnis des manuellen Mahnlaufs</p>
        </div>
        <IconButton aria-label="Dialog schließen" tooltip={false} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4.5 pt-1 pb-4">
        <div className="grid grid-cols-3 gap-3">
          <Metric className={tileClass} marker="tick" label="Geprüfte Rechnungen" value={result.processedInvoices} />
          <Metric className={tileClass} marker="tick" tone="success" label="E-Mails versendet" value={result.emailsSent} />
          <Metric className={tileClass} marker="tick" tone="info" label="Mahngebühren" value={result.feesApplied} />
        </div>

        {hasSuccesses && !noInvoices && (
          <div className={`${bannerClass} border-success-border bg-success-bg text-success-text`}>
            <CheckCircle2 size={16} className="mt-px shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {result.emailsSent === 1
                  ? 'Eine Mahnung wurde erfolgreich versendet.'
                  : `${result.emailsSent} Mahnungen wurden erfolgreich versendet.`}
              </p>
              {result.feesApplied > 0 && (
                <p className="mt-0.5">
                  {result.feesApplied === 1
                    ? 'Eine Mahngebühr wurde automatisch hinzugefügt.'
                    : `${result.feesApplied} Mahngebühren wurden automatisch hinzugefügt.`}
                </p>
              )}
            </div>
          </div>
        )}

        {noInvoices && (
          <div className={`${bannerClass} border-border bg-surface-muted text-foreground`}>
            <AlertTriangle size={16} className="mt-px shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Keine überfälligen Rechnungen gefunden.</p>
              <p className="mt-0.5 text-muted">
                Es gibt aktuell keine Rechnungen, für die eine Mahnung fällig wäre.
              </p>
            </div>
          </div>
        )}

        {hasErrors && (
          <div className={`${bannerClass} border-error-border bg-error-bg text-error-text`}>
            <XCircle size={16} className="mt-px shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {result.errors.length === 1
                  ? 'Ein Fehler ist aufgetreten:'
                  : `${result.errors.length} Fehler sind aufgetreten:`}
              </p>
              <div className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto">
                {result.errors.slice(0, 50).map((err, idx) => (
                  <div key={idx} className="rounded-control border border-error-border bg-surface px-3 py-2">
                    <p className="font-medium">Rechnung: {err.invoiceNumber}</p>
                    <p className="mt-0.5">{err.error}</p>
                  </div>
                ))}
                {result.errors.length > 50 && (
                  <p className="italic">... und {result.errors.length - 50} weitere Fehler</p>
                )}
              </div>
            </div>
          </div>
        )}

        {!noInvoices && (
          <div className={`${bannerClass} flex-col border-info-border bg-info-bg text-info-text`}>
            <h3 className="font-semibold">Informationen zum Mahnprozess:</h3>
            <ul className="list-inside list-disc space-y-0.5">
              <li>Mahnungen werden automatisch basierend auf den konfigurierten Mahnstufen versendet</li>
              <li>Mahngebühren werden automatisch zur Rechnungssumme hinzugefügt</li>
              <li>Jede versendete Mahnung wird in der Mahnhistorie protokolliert</li>
              <li>Sie können den automatischen Mahnlauf in den Einstellungen konfigurieren</li>
            </ul>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
        <Button variant="secondary" onClick={onClose}>Schließen</Button>
      </div>
    </Modal>
  );
};
