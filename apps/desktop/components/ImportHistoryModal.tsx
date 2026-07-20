import { useState } from 'react';
import { X, AlertTriangle, FileText, Calendar, CheckCircle2, XCircle, Undo2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { formatCurrency } from '../utils/formatters';

interface ImportHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountId?: string;
}

export const ImportHistoryModal = ({ isOpen, onClose, accountId }: ImportHistoryModalProps) => {
  const queryClient = useQueryClient();
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

  const batchesQuery = useQuery({
    queryKey: ['importBatches', accountId],
    queryFn: () => ipc.finance.listImportBatches({ accountId }),
    enabled: isOpen,
  });

  const detailsQuery = useQuery({
    queryKey: ['importBatchDetails', selectedBatchId],
    queryFn: () => ipc.finance.getImportBatchDetails({ batchId: selectedBatchId! }),
    enabled: !!selectedBatchId,
  });

  const rollbackMutation = useMutation({
    mutationFn: ({ batchId, reason }: { batchId: string; reason: string }) =>
      ipc.finance.rollbackImportBatch({ batchId, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['importBatches'] });
      queryClient.invalidateQueries({ queryKey: ['importBatchDetails'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      setShowRollbackConfirm(false);
      setRollbackReason('');
      setSelectedBatchId(null);
    },
  });

  const handleRollback = () => {
    if (!selectedBatchId || !rollbackReason.trim() || rollbackReason.trim().length < 10) return;
    rollbackMutation.mutate({ batchId: selectedBatchId, reason: rollbackReason });
  };

  const isReasonValid = rollbackReason.trim().length >= 10;

  if (!isOpen) return null;

  const batches = batchesQuery.data ?? [];
  const details = detailsQuery.data;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface rounded-2xl shadow-2xl w-[95%] h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div>
            <h2 className="text-xl font-black text-foreground">Import-Historie</h2>
            <p className="text-sm text-muted mt-1">
              Übersicht aller CSV-Importe mit Rollback-Möglichkeit
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-canvas rounded-lg transition-colors ease-out"
          >
            <X size={20} className="text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Batch List */}
          <div className="w-1/3 border-r border-border overflow-y-auto p-4 space-y-2">
            {batchesQuery.isLoading && (
              <div className="text-center py-8 text-muted">Lade Import-Historie...</div>
            )}

            {batches.length === 0 && !batchesQuery.isLoading && (
              <div className="text-center py-8 text-muted">
                <FileText size={32} className="mx-auto mb-2 opacity-50" />
                <p>Keine Importe vorhanden</p>
              </div>
            )}

            {batches.map((batch) => (
              <button
                key={batch.id}
                onClick={() => setSelectedBatchId(batch.id)}
                className={`w-full text-left p-4 rounded-lg border-2 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out ${
                  selectedBatchId === batch.id
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-muted'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate">{batch.fileName}</p>
                    <p className="text-xs text-muted mt-1">
                      <Calendar size={12} className="inline mr-1" />
                      {new Date(batch.createdAt).toLocaleString('de-DE')}
                    </p>
                  </div>
                  {batch.rolledBackAt && (
                    <span className="ml-2 px-2 py-1 bg-error-bg text-error text-xs rounded-full whitespace-nowrap">
                      Rückgängig
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 text-xs mt-2">
                  <span className="flex items-center text-success">
                    <CheckCircle2 size={12} className="mr-1" />
                    {batch.importedCount} importiert
                  </span>
                  {batch.skippedCount > 0 && (
                    <span className="flex items-center text-muted">
                      <XCircle size={12} className="mr-1" />
                      {batch.skippedCount} übersprungen
                    </span>
                  )}
                </div>

                <div className="mt-2 text-xs text-muted">
                  Profil: <span className="font-medium">{batch.profile}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Right: Batch Details */}
          <div className="flex-1 overflow-y-auto p-6">
            {!selectedBatchId && (
              <div className="flex items-center justify-center h-full text-muted">
                <div className="text-center">
                  <FileText size={48} className="mx-auto mb-3 opacity-30" />
                  <p>Wähle einen Import aus der Liste</p>
                </div>
              </div>
            )}

            {selectedBatchId && detailsQuery.isLoading && (
              <div className="text-center py-8 text-muted">Lade Details...</div>
            )}

            {details && (
              <div className="space-y-6">
                {/* Batch Info */}
                <div className="bg-surface-muted rounded-lg p-4">
                  <h3 className="font-semibold text-foreground mb-3">Import-Details</h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-muted">Dateiname</p>
                      <p className="font-medium">{details.batch.fileName}</p>
                    </div>
                    <div>
                      <p className="text-muted">Profil</p>
                      <p className="font-medium">{details.batch.profile}</p>
                    </div>
                    <div>
                      <p className="text-muted">Importiert am</p>
                      <p className="font-medium">
                        {new Date(details.batch.createdAt).toLocaleString('de-DE')}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted">Status</p>
                      {details.batch.rolledBackAt ? (
                        <p className="font-medium text-error">Rückgängig gemacht</p>
                      ) : (
                        <p className="font-medium text-success">Aktiv</p>
                      )}
                    </div>
                  </div>

                  {details.batch.rolledBackAt && (
                    <div className="mt-3 pt-3 border-t border-border">
                      <p className="text-muted text-sm">Grund für Rollback</p>
                      <p className="font-medium text-sm">{details.batch.rollbackReason}</p>
                      <p className="text-xs text-muted mt-1">
                        Rückgängig gemacht am:{' '}
                        {new Date(details.batch.rolledBackAt).toLocaleString('de-DE')}
                      </p>
                    </div>
                  )}

                  <div className="mt-3 pt-3 border-t border-border flex items-center gap-4 text-sm">
                    <span className="flex items-center text-success">
                      <CheckCircle2 size={14} className="mr-1" />
                      {details.batch.importedCount} importiert
                    </span>
                    {details.batch.skippedCount > 0 && (
                      <span className="flex items-center text-muted">
                        <XCircle size={14} className="mr-1" />
                        {details.batch.skippedCount} übersprungen
                      </span>
                    )}
                    {details.linkedInvoiceCount > 0 && (
                      <span className="flex items-center text-info">
                        🔗 {details.linkedInvoiceCount} mit Rechnungen verknüpft
                      </span>
                    )}
                  </div>
                </div>

                {/* Transaction Preview */}
                <div>
                  <h3 className="font-semibold text-foreground mb-3">
                    Transaktionen (Vorschau)
                  </h3>
                  <div className="border border-border rounded-lg overflow-hidden">
                    <div className="max-h-64 overflow-y-auto">
                      {details.transactions.length === 0 ? (
                        <div className="text-center py-4 text-muted text-sm">
                          Keine Transaktionen vorhanden
                        </div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead className="bg-surface-muted border-b border-border">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium text-muted">
                                Datum
                              </th>
                              <th className="text-left px-3 py-2 font-medium text-muted">
                                Gegenseite
                              </th>
                              <th className="text-left px-3 py-2 font-medium text-muted">
                                Verwendungszweck
                              </th>
                              <th className="text-right px-3 py-2 font-medium text-muted">
                                Betrag
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border-subtle">
                            {details.transactions.map((tx) => (
                              <tr key={tx.id} className="hover:bg-surface-muted">
                                <td className="px-3 py-2 text-muted">
                                  {new Date(tx.date).toLocaleDateString('de-DE')}
                                </td>
                                <td className="px-3 py-2 font-medium text-foreground">
                                  {tx.counterparty}
                                </td>
                                <td className="px-3 py-2 text-muted truncate max-w-xs">
                                  {tx.purpose}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-medium ${
                                    tx.type === 'income' ? 'text-success' : 'text-error'
                                  }`}
                                >
                                  {tx.type === 'income' ? '+' : '-'}
                                  {formatCurrency(Math.abs(tx.amount))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted mt-2">
                    Zeigt maximal 50 Transaktionen
                  </p>
                </div>

                {/* Rollback Section */}
                {!details.batch.rolledBackAt && (
                  <div className="border-t border-border pt-6">
                    {!details.canRollback && (
                      <div className="bg-warning-bg border border-warning-border rounded-lg p-4">
                        <div className="flex items-start gap-3">
                          <AlertTriangle size={20} className="text-warning mt-0.5" />
                          <div className="flex-1">
                            <p className="font-medium text-foreground">
                              Rollback nicht möglich
                            </p>
                            <p className="text-sm text-warning mt-1">
                              {details.linkedInvoiceCount} Transaktion(en) sind bereits mit
                              Rechnungen verknüpft. Bitte löse zuerst die Verknüpfungen.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {details.canRollback && !showRollbackConfirm && (
                      <button
                        onClick={() => setShowRollbackConfirm(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-error-bg text-error rounded-lg hover:bg-error-bg/80 transition-colors ease-out font-medium"
                      >
                        <Undo2 size={16} />
                        Import rückgängig machen
                      </button>
                    )}

                    {details.canRollback && showRollbackConfirm && (
                      <div className="bg-error-bg border border-error/30 rounded-lg p-4">
                        <div className="flex items-start gap-3 mb-4">
                          <AlertTriangle size={20} className="text-error mt-0.5" />
                          <div className="flex-1">
                            <p className="font-medium text-error">
                              Import wirklich rückgängig machen?
                            </p>
                            <p className="text-sm text-error mt-1">
                              Dies ist eine unwiderrufliche Aktion. Bitte prüfen Sie die Auswirkungen:
                            </p>
                          </div>
                        </div>

                        {/* Impact Preview */}
                        <div className="bg-surface border border-error/30 rounded-lg p-3 mb-4 space-y-2">
                          <p className="text-sm font-semibold text-foreground">Auswirkungen:</p>
                          <div className="flex items-center gap-2 text-sm">
                            <XCircle size={14} className="text-error" />
                            <span className="text-foreground">
                              <strong>{details.batch.importedCount}</strong> Transaktionen werden gelöscht
                            </span>
                          </div>
                          {details.linkedInvoiceCount > 0 && (
                            <div className="flex items-center gap-2 text-sm">
                              <CheckCircle2 size={14} className="text-success" />
                              <span className="text-foreground">
                                <strong>{details.linkedInvoiceCount}</strong> verknüpfte Transaktion(en) bleiben geschützt
                              </span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-sm">
                            <AlertTriangle size={14} className="text-warning" />
                            <span className="text-foreground">
                              Dieser Import wird als rückgängig gemacht markiert
                            </span>
                          </div>
                        </div>

                        <div className="mb-4">
                          <label className="block text-sm font-medium text-foreground mb-2">
                            Grund für Rollback (mindestens 10 Zeichen)
                          </label>
                          <textarea
                            value={rollbackReason}
                            onChange={(e) => setRollbackReason(e.target.value)}
                            placeholder="z.B. Falsches Konto ausgewählt, falsche Datei importiert..."
                            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:border-transparent resize-none transition-colors ease-out ${
                              rollbackReason.trim() && !isReasonValid
                                ? 'border-warning focus:ring-warning'
                                : 'border-border focus:ring-error'
                            }`}
                            rows={3}
                          />
                          <div className="flex items-center justify-between mt-1">
                            <p className={`text-xs ${
                              rollbackReason.trim() && !isReasonValid
                                ? 'text-warning'
                                : 'text-muted'
                            }`}>
                              {rollbackReason.trim().length}/10 Zeichen
                            </p>
                            {rollbackReason.trim() && !isReasonValid && (
                              <p className="text-xs text-warning">
                                Bitte geben Sie einen aussagekräftigen Grund an
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={handleRollback}
                            disabled={
                              !isReasonValid || rollbackMutation.isPending
                            }
                            className="px-4 py-2 bg-error text-white rounded-lg hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ease-out font-medium"
                          >
                            {rollbackMutation.isPending
                              ? 'Wird rückgängig gemacht...'
                              : 'Jetzt rückgängig machen'}
                          </button>
                          <button
                            onClick={() => {
                              setShowRollbackConfirm(false);
                              setRollbackReason('');
                            }}
                            disabled={rollbackMutation.isPending}
                            className="px-4 py-2 bg-canvas text-foreground rounded-lg hover:bg-border transition-colors ease-out"
                          >
                            Abbrechen
                          </button>
                        </div>

                        {rollbackMutation.error && (
                          <div className="mt-3 text-sm text-error">
                            Fehler: {String(rollbackMutation.error)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
