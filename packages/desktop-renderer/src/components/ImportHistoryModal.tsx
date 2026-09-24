import { useId, useState } from 'react';
import { X, AlertTriangle, Calendar, CheckCircle2, XCircle, Undo2, Link2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../runtime-api';
import { formatCurrency } from '@billme/desktop-utils/formatters';
import {
  ConfirmDialog, EmptyState, ErrorState, Modal, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import { Spinner } from '@billme/desktop-ui/components/Spinner';

interface ImportHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountId?: string;
}

const queryErrorDetail = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Unbekannter Fehler beim Laden.';

export const ImportHistoryModal = ({ isOpen, onClose, accountId }: ImportHistoryModalProps) => {
  const queryClient = useQueryClient();
  const titleId = useId();
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

  // ponytail: ConfirmDialog enforces a non-empty reason; keep the existing 10-character guard at the mutation seam.
  const handleRollback = () => {
    if (!selectedBatchId || !rollbackReason.trim() || rollbackReason.trim().length < 10) return;
    rollbackMutation.mutate({ batchId: selectedBatchId, reason: rollbackReason });
  };

  const isReasonValid = rollbackReason.trim().length >= 10;

  if (!isOpen) return null;

  const batches = batchesQuery.data ?? [];
  const details = detailsQuery.data;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      titleId={titleId}
      className="flex h-[85vh] max-w-4xl flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-6">
        <div>
          <h2 id={titleId} className="text-xl font-semibold text-foreground">Import-Historie</h2>
          <p className="mt-1 text-sm text-muted">
            Übersicht aller CSV-Importe mit Rollback-Möglichkeit
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Import-Historie schließen"
          className="rounded-lg p-2 text-muted transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Batch List */}
        <div className="w-1/3 space-y-2 overflow-y-auto border-r border-border p-4">
          {batchesQuery.isError && (
            <ErrorState
              title="Importe konnten nicht geladen werden"
              description={queryErrorDetail(batchesQuery.error)}
              onRetry={() => void batchesQuery.refetch()}
            />
          )}

          {batchesQuery.isLoading && (
            <div className="flex flex-col items-center gap-3 py-8 text-muted">
              <Spinner size="sm" />
              <span className="text-sm">Lade Import-Historie …</span>
            </div>
          )}

          {!batchesQuery.isLoading && !batchesQuery.isError && batches.length === 0 && (
            <EmptyState
              title="Keine Importe vorhanden"
              description="Sobald du eine CSV-Datei importierst, erscheint der Vorgang hier mit allen importierten Transaktionen."
              className="border-0 bg-transparent px-2"
            />
          )}

          {!batchesQuery.isError && batches.map((batch) => (
            <button
              key={batch.id}
              type="button"
              onClick={() => setSelectedBatchId(batch.id)}
              aria-pressed={selectedBatchId === batch.id}
              className={`w-full rounded-lg border-2 p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                selectedBatchId === batch.id
                  ? 'border-foreground bg-surface-muted'
                  : 'border-border hover:border-control-border'
              }`}
            >
              <div className="mb-2 flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{batch.fileName}</p>
                  <p className="mt-1 flex items-center text-xs tabular-nums text-muted">
                    <Calendar size={12} className="mr-1" aria-hidden="true" />
                    {new Date(batch.createdAt).toLocaleString('de-DE')}
                  </p>
                </div>
                {batch.rolledBackAt && (
                  <span className="ml-2 whitespace-nowrap rounded-full border border-error-border bg-error-bg px-2 py-1 text-xs text-error-text">
                    Rückgängig
                  </span>
                )}
              </div>

              <div className="mt-2 flex items-center gap-3 text-xs">
                <span className="flex items-center tabular-nums text-success-text">
                  <CheckCircle2 size={12} className="mr-1" aria-hidden="true" />
                  {batch.importedCount} importiert
                </span>
                {batch.skippedCount > 0 && (
                  <span className="flex items-center tabular-nums text-muted">
                    <XCircle size={12} className="mr-1" aria-hidden="true" />
                    {batch.skippedCount} übersprungen
                  </span>
                )}
              </div>

              <div className="mt-2 text-xs text-muted">
                Profil: <span className="font-medium text-foreground">{batch.profile}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Right: Batch Details */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selectedBatchId && (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                title="Kein Import ausgewählt"
                description="Wähle links einen Vorgang aus, um Details und Rollback-Optionen zu sehen."
                className="border-0 bg-transparent"
              />
            </div>
          )}

          {selectedBatchId && detailsQuery.isLoading && (
            <div className="flex flex-col items-center gap-3 py-8 text-muted">
              <Spinner size="sm" />
              <span className="text-sm">Lade Details …</span>
            </div>
          )}

          {selectedBatchId && detailsQuery.isError && (
            <ErrorState
              title="Import-Details konnten nicht geladen werden"
              description={queryErrorDetail(detailsQuery.error)}
              onRetry={() => void detailsQuery.refetch()}
            />
          )}

          {details && (
            <div className="space-y-6">
              {/* Batch Info */}
              <div className="rounded-lg border border-border bg-surface-muted p-4">
                <h3 className="mb-3 font-semibold text-foreground">Import-Details</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-muted">Dateiname</p>
                    <p className="font-medium text-foreground">{details.batch.fileName}</p>
                  </div>
                  <div>
                    <p className="text-muted">Profil</p>
                    <p className="font-medium text-foreground">{details.batch.profile}</p>
                  </div>
                  <div>
                    <p className="text-muted">Importiert am</p>
                    <p className="font-medium tabular-nums text-foreground">
                      {new Date(details.batch.createdAt).toLocaleString('de-DE')}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted">Status</p>
                    {details.batch.rolledBackAt ? (
                      <p className="font-medium text-error-text">Rückgängig gemacht</p>
                    ) : (
                      <p className="font-medium text-success-text">Aktiv</p>
                    )}
                  </div>
                </div>

                {details.batch.rolledBackAt && (
                  <div className="mt-3 border-t border-border-subtle pt-3">
                    <p className="text-sm text-muted">Grund für Rollback</p>
                    <p className="text-sm font-medium text-foreground">{details.batch.rollbackReason}</p>
                    <p className="mt-1 text-xs tabular-nums text-muted">
                      Rückgängig gemacht am:{' '}
                      {new Date(details.batch.rolledBackAt).toLocaleString('de-DE')}
                    </p>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-4 border-t border-border-subtle pt-3 text-sm">
                  <span className="flex items-center tabular-nums text-success-text">
                    <CheckCircle2 size={14} className="mr-1" aria-hidden="true" />
                    {details.batch.importedCount} importiert
                  </span>
                  {details.batch.skippedCount > 0 && (
                    <span className="flex items-center tabular-nums text-muted">
                      <XCircle size={14} className="mr-1" aria-hidden="true" />
                      {details.batch.skippedCount} übersprungen
                    </span>
                  )}
                  {details.linkedInvoiceCount > 0 && (
                    <span className="flex items-center tabular-nums text-info-text">
                      <Link2 size={14} className="mr-1" aria-hidden="true" />
                      {details.linkedInvoiceCount} mit Rechnungen verknüpft
                    </span>
                  )}
                </div>
              </div>

              {/* Transaction Preview */}
              <div>
                <h3 className="mb-3 font-semibold text-foreground">
                  Transaktionen (Vorschau)
                </h3>
                {details.transactions.length === 0 ? (
                  <div className="rounded-card border border-border py-4 text-center text-sm text-muted">
                    Keine Transaktionen in diesem Import
                  </div>
                ) : (
                  <Table
                    aria-label="Transaktionen dieses Imports"
                    density="compact"
                    bare
                    containerClassName="max-h-64 rounded-card border border-border"
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead>Datum</TableHead>
                        <TableHead>Gegenseite</TableHead>
                        <TableHead>Verwendungszweck</TableHead>
                        <TableHead numeric>Betrag</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {details.transactions.map((tx) => (
                        <TableRow key={tx.id}>
                          <TableCell muted className="tabular-nums">
                            {new Date(tx.date).toLocaleDateString('de-DE')}
                          </TableCell>
                          <TableCell className="font-medium">{tx.counterparty}</TableCell>
                          <TableCell muted className="max-w-xs truncate">{tx.purpose}</TableCell>
                          <TableCell
                            numeric
                            className={`font-medium ${tx.type === 'income' ? 'text-success-text' : 'text-error-text'}`}
                          >
                            {tx.type === 'income' ? '+' : '-'}
                            {formatCurrency(Math.abs(tx.amount))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <p className="mt-2 text-xs text-muted">
                  Zeigt maximal 50 Transaktionen
                </p>
              </div>

              {/* Rollback Section */}
              {!details.batch.rolledBackAt && (
                <div className="border-t border-border pt-6">
                  {!details.canRollback && (
                    <div className="rounded-lg border border-warning-border bg-warning-bg p-4">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={20} className="mt-0.5 text-warning-text" aria-hidden="true" />
                        <div className="flex-1">
                          <p className="font-medium text-warning-text">
                            Rollback nicht möglich
                          </p>
                          <p className="mt-1 text-sm text-warning-text">
                            {details.linkedInvoiceCount} Transaktion(en) sind bereits mit
                            Rechnungen verknüpft. Bitte löse zuerst die Verknüpfungen.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {details.canRollback && !showRollbackConfirm && (
                    <button
                      type="button"
                      onClick={() => setShowRollbackConfirm(true)}
                      className="flex items-center gap-2 rounded-lg border border-error-border bg-error-bg px-4 py-2 font-medium text-error-text transition-colors hover:bg-error-bg/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <Undo2 size={16} aria-hidden="true" />
                      Import rückgängig machen
                    </button>
                  )}

                  {details.canRollback && showRollbackConfirm && (
                    <ConfirmDialog
                      open
                      title="Import wirklich rückgängig machen?"
                      description={(
                        <>
                          <p>Dies ist eine unwiderrufliche Aktion. Bitte prüfe die Auswirkungen.</p>
                          {rollbackMutation.error ? <p className="mt-2 text-error-text">Fehler: {String(rollbackMutation.error)}</p> : null}
                        </>
                      )}
                      confirmLabel="Jetzt rückgängig machen"
                      cancelLabel="Abbrechen"
                      destructive
                      busy={rollbackMutation.isPending}
                      reason={{
                        label: 'Grund für Rollback (mindestens 10 Zeichen)',
                        placeholder: 'z. B. Falsches Konto ausgewählt, falsche Datei importiert …',
                        required: true,
                        value: rollbackReason,
                        onChange: setRollbackReason,
                      }}
                      details={(
                        <div className="space-y-2" aria-label="Auswirkungen">
                          <p className="text-sm font-semibold text-foreground">Auswirkungen:</p>
                          <div className="flex items-center gap-2 text-sm">
                            <XCircle size={14} className="text-error-text" aria-hidden="true" />
                            <span>
                              <strong className="tabular-nums">{details.batch.importedCount}</strong> Transaktionen werden gelöscht
                            </span>
                          </div>
                          {details.linkedInvoiceCount > 0 && (
                            <div className="flex items-center gap-2 text-sm">
                              <CheckCircle2 size={14} className="text-success-text" aria-hidden="true" />
                              <span>
                                <strong className="tabular-nums">{details.linkedInvoiceCount}</strong> verknüpfte Transaktion(en) bleiben geschützt
                              </span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-sm">
                            <AlertTriangle size={14} className="text-warning-text" aria-hidden="true" />
                            <span>Dieser Import wird als rückgängig gemacht markiert</span>
                          </div>
                          <p className={`text-xs tabular-nums ${rollbackReason.trim() && !isReasonValid ? 'text-warning-text' : 'text-muted'}`}>
                            {rollbackReason.trim().length}/10 Zeichen
                          </p>
                          {rollbackReason.trim() && !isReasonValid ? <p className="text-xs text-warning-text">Bitte gib einen aussagekräftigen Grund an.</p> : null}
                        </div>
                      )}
                      onConfirm={handleRollback}
                      onCancel={() => {
                        if (rollbackMutation.isPending) return;
                        setShowRollbackConfirm(false);
                        setRollbackReason('');
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
