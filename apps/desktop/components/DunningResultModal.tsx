import { X, CheckCircle2, AlertTriangle, XCircle, FileText, Mail, Euro } from 'lucide-react';

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
  if (!isOpen || !result) return null;

  const hasErrors = result.errors.length > 0;
  const hasSuccesses = result.emailsSent > 0;
  const noInvoices = result.processedInvoices === 0;

  // Determine icon and color based on result
  let IconComponent = CheckCircle2;
  let iconColor = 'text-success';
  let statusMessage = 'Mahnlauf erfolgreich abgeschlossen';

  if (noInvoices) {
    IconComponent = AlertTriangle;
    iconColor = 'text-gray-500';
    statusMessage = 'Keine überfälligen Rechnungen';
  } else if (hasErrors && !hasSuccesses) {
    IconComponent = XCircle;
    iconColor = 'text-error';
    statusMessage = 'Mahnlauf fehlgeschlagen';
  } else if (hasErrors && hasSuccesses) {
    IconComponent = AlertTriangle;
    iconColor = 'text-orange-500';
    statusMessage = 'Mahnlauf teilweise erfolgreich';
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-[90%] max-w-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <IconComponent size={28} className={iconColor} />
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{statusMessage}</h2>
              <p className="text-sm text-gray-500 mt-1">
                Ergebnis des manuellen Mahnlaufs
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-3 gap-4">
            {/* Processed Invoices */}
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <FileText size={20} className="text-gray-600" />
                <span className="text-sm font-medium text-gray-600">Geprüfte Rechnungen</span>
              </div>
              <p className="text-3xl font-bold text-gray-900">{result.processedInvoices}</p>
            </div>

            {/* Emails Sent */}
            <div className="bg-success-bg rounded-lg p-4 border border-success/30">
              <div className="flex items-center gap-2 mb-2">
                <Mail size={20} className="text-success" />
                <span className="text-sm font-medium text-success">E-Mails versendet</span>
              </div>
              <p className="text-3xl font-bold text-success">{result.emailsSent}</p>
            </div>

            {/* Fees Applied */}
            <div className="bg-info-bg rounded-lg p-4 border border-info/30">
              <div className="flex items-center gap-2 mb-2">
                <Euro size={20} className="text-info" />
                <span className="text-sm font-medium text-info">Mahngebühren</span>
              </div>
              <p className="text-3xl font-bold text-info">{result.feesApplied}</p>
            </div>
          </div>

          {/* Success Message */}
          {hasSuccesses && !noInvoices && (
            <div className="bg-success-bg border border-success/30 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 size={20} className="text-success mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-success">
                    {result.emailsSent === 1
                      ? 'Eine Mahnung wurde erfolgreich versendet.'
                      : `${result.emailsSent} Mahnungen wurden erfolgreich versendet.`}
                  </p>
                  {result.feesApplied > 0 && (
                    <p className="text-sm text-success mt-1">
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
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle size={20} className="text-gray-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">
                    Keine überfälligen Rechnungen gefunden.
                  </p>
                  <p className="text-sm text-gray-600 mt-1">
                    Es gibt aktuell keine Rechnungen, für die eine Mahnung fällig wäre.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Error List */}
          {hasErrors && (
            <div className="bg-error-bg border border-error/30 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <XCircle size={20} className="text-error mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-error mb-3">
                    {result.errors.length === 1
                      ? 'Ein Fehler ist aufgetreten:'
                      : `${result.errors.length} Fehler sind aufgetreten:`}
                  </p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {result.errors.slice(0, 50).map((err, idx) => (
                      <div key={idx} className="bg-white rounded border border-error/30 p-3">
                        <p className="text-sm font-medium text-error">
                          Rechnung: {err.invoiceNumber}
                        </p>
                        <p className="text-sm text-error mt-1">{err.error}</p>
                      </div>
                    ))}
                    {result.errors.length > 50 && (
                      <p className="text-sm text-error italic">
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
            <div className="bg-info-bg border border-info/30 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-info mb-2">
                Informationen zum Mahnprozess:
              </h3>
              <ul className="text-sm text-info space-y-1 list-disc list-inside">
                <li>Mahnungen werden automatisch basierend auf den konfigurierten Mahnstufen versendet</li>
                <li>Mahngebühren werden automatisch zur Rechnungssumme hinzugefügt</li>
                <li>Jede versendete Mahnung wird in der Mahnhistorie protokolliert</li>
                <li>Sie können den automatischen Mahnlauf in den Einstellungen konfigurieren</li>
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
