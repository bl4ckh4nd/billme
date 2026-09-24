import { useId } from 'react';
import { X, CheckCircle2, AlertTriangle, XCircle, FileText, Mail, Euro } from 'lucide-react';
import { Modal } from '@billme/ui';

interface DunningResult {
  processedInvoices: number;
  emailsSent: number;
  feesApplied: number;
  errors: Array<{ invoiceNumber: string; error: string }>;
}

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

  // Determine icon and color based on result
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
      className="flex max-h-[85vh] max-w-3xl flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-6">
        <div className="flex items-center gap-3">
          <IconComponent size={24} className={iconColor} aria-hidden="true" />
          <div>
            <h2 id={titleId} className="text-xl font-semibold text-foreground">{statusMessage}</h2>
            <p className="mt-1 text-sm text-muted">
              Ergebnis des manuellen Mahnlaufs
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dialog schließen"
          onClick={onClose}
          className="p-2 text-muted hover:bg-surface-muted rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-4">
          {/* Processed Invoices */}
          <div className="bg-surface-muted rounded-lg p-4 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <FileText size={20} className="text-muted" aria-hidden="true" />
              <span className="text-sm font-medium text-muted">Geprüfte Rechnungen</span>
            </div>
            <p className="text-3xl font-semibold text-foreground">{result.processedInvoices}</p>
          </div>

          {/* Emails Sent */}
          <div className="bg-success-bg rounded-lg p-4 border border-success-border">
            <div className="flex items-center gap-2 mb-2">
              <Mail size={20} className="text-success-text" aria-hidden="true" />
              <span className="text-sm font-medium text-success-text">E-Mails versendet</span>
            </div>
            <p className="text-3xl font-semibold text-success-text">{result.emailsSent}</p>
          </div>

          {/* Fees Applied */}
          <div className="bg-info-bg rounded-lg p-4 border border-info-border">
            <div className="flex items-center gap-2 mb-2">
              <Euro size={20} className="text-info-text" aria-hidden="true" />
              <span className="text-sm font-medium text-info-text">Mahngebühren</span>
            </div>
            <p className="text-3xl font-semibold text-info-text">{result.feesApplied}</p>
          </div>
        </div>

        {/* Success Message */}
        {hasSuccesses && !noInvoices && (
          <div className="bg-success-bg border border-success-border rounded-lg p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 size={20} className="text-success-text mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-sm font-medium text-success-text">
                  {result.emailsSent === 1
                    ? 'Eine Mahnung wurde erfolgreich versendet.'
                    : `${result.emailsSent} Mahnungen wurden erfolgreich versendet.`}
                </p>
                {result.feesApplied > 0 && (
                  <p className="text-sm text-success-text mt-1">
                    {result.feesApplied === 1
                      ? 'Eine Mahngebühr wurde automatisch hinzugefügt.'
                      : `${result.feesApplied} Mahngebühren wurden automatisch hinzugefügt.`}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* No Invoices Message */}
        {noInvoices && (
          <div className="bg-surface-muted border border-border rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="text-muted mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">
                  Keine überfälligen Rechnungen gefunden.
                </p>
                <p className="text-sm text-muted mt-1">
                  Es gibt aktuell keine Rechnungen, für die eine Mahnung fällig wäre.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Error List */}
        {hasErrors && (
          <div className="bg-error-bg border border-error-border rounded-lg p-4">
            <div className="flex items-start gap-3">
              <XCircle size={20} className="text-error-text mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-sm font-medium text-error-text mb-3">
                  {result.errors.length === 1
                    ? 'Ein Fehler ist aufgetreten:'
                    : `${result.errors.length} Fehler sind aufgetreten:`}
                </p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {result.errors.slice(0, 50).map((err, idx) => (
                    <div key={idx} className="bg-surface rounded-sm border border-error-border p-3">
                      <p className="text-sm font-medium text-error-text">
                        Rechnung: {err.invoiceNumber}
                      </p>
                      <p className="text-sm text-error-text mt-1">{err.error}</p>
                    </div>
                  ))}
                  {result.errors.length > 50 && (
                    <p className="text-sm text-error-text italic">
                      ... und {result.errors.length - 50} weitere Fehler
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Additional Info */}
        {!noInvoices && (
          <div className="bg-info-bg border border-info-border rounded-lg p-4">
            <h3 className="text-sm font-semibold text-info-text mb-2">
              Informationen zum Mahnprozess:
            </h3>
            <ul className="text-sm text-info-text space-y-1 list-disc list-inside">
              <li>Mahnungen werden automatisch basierend auf den konfigurierten Mahnstufen versendet</li>
              <li>Mahngebühren werden automatisch zur Rechnungssumme hinzugefügt</li>
              <li>Jede versendete Mahnung wird in der Mahnhistorie protokolliert</li>
              <li>Sie können den automatischen Mahnlauf in den Einstellungen konfigurieren</li>
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 border-t border-border p-6">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-dark-base px-4 py-2 text-background transition-colors hover:bg-dark-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
        >
          Schließen
        </button>
      </div>
    </Modal>
  );
};
