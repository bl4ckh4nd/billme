import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { Toast } from './Toast';
import { EurRulesModal } from './EurRulesModal';
import { EurHeader } from './eur/EurHeader';
import { UndoBanner } from './eur/UndoBanner';
import { QueuePanel } from './eur/QueuePanel';
import { ClassificationPanel } from './eur/ClassificationPanel';
import { ReportPanel } from './eur/ReportPanel';
import {
  DEFAULT_YEAR,
  type SourceType,
  type VatMode,
  type QueueStatus,
  type QueueSort,
  type EurItem,
  type UndoChange,
  type EurLineOption,
  triggerCsvDownload,
  itemKey,
} from './eur/types';

export const EurView: React.FC = () => {
  const queryClient = useQueryClient();
  const [taxYear, setTaxYear] = React.useState<number>(DEFAULT_YEAR);
  const [activeSource, setActiveSource] = React.useState<{ sourceType: SourceType; sourceId: string } | null>(null);
  const [selectedLineId, setSelectedLineId] = React.useState<string>('');
  const [vatMode, setVatMode] = React.useState<VatMode>('none');
  const [excluded, setExcluded] = React.useState<boolean>(false);

  const [query, setQuery] = React.useState('');
  const [queueStatus, setQueueStatus] = React.useState<QueueStatus>('unclassified');
  const [flowFilter, setFlowFilter] = React.useState<'all' | 'income' | 'expense'>('all');
  const [queueSort, setQueueSort] = React.useState<QueueSort>('date_desc');
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());
  const [isApplying, setIsApplying] = React.useState(false);
  const [lastUndo, setLastUndo] = React.useState<{ label: string; changes: UndoChange[] } | null>(null);

  const [showRulesModal, setShowRulesModal] = React.useState(false);
  const [showToast, setShowToast] = React.useState(false);
  const [toastMessage, setToastMessage] = React.useState('');
  const [toastType, setToastType] = React.useState<'success' | 'error' | 'warning' | 'info'>('success');

  const showNotification = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    setToastMessage(message);
    setToastType(type);
    setShowToast(true);
  };

  const { data: report, isLoading: reportLoading } = useQuery({
    queryKey: ['eur', 'report', taxYear],
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['eur', 'items', taxYear],
    queryFn: () => ipc.eur.listItems({ taxYear }),
  });

  const upsertClassification = useMutation({
    mutationFn: (payload: {
      sourceType: SourceType;
      sourceId: string;
      taxYear: number;
      eurLineId?: string;
      excluded?: boolean;
      vatMode?: VatMode;
    }) => ipc.eur.upsertClassification(payload),
  });

  const invalidateEur = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['eur', 'items', taxYear] }),
      queryClient.invalidateQueries({ queryKey: ['eur', 'report', taxYear] }),
    ]);
  };

  const exportCsv = async () => {
    const csv = await ipc.eur.exportCsv({ taxYear });
    triggerCsvDownload(csv, `anlage-euer-${taxYear}.csv`);
  };

  const [isPdfExporting, setIsPdfExporting] = React.useState(false);
  const exportPdf = async () => {
    setIsPdfExporting(true);
    try {
      const res = await ipc.eur.exportPdf({ taxYear });
      showNotification(`PDF gespeichert: ${res.path}`, 'success');
    } catch {
      showNotification('PDF-Export fehlgeschlagen', 'error');
    } finally {
      setIsPdfExporting(false);
    }
  };

  const lineOptions = React.useMemo(
    () => (report?.rows ?? []).filter((line) => line.kind === 'income' || line.kind === 'expense') as EurLineOption[],
    [report],
  );

  const activeItem = React.useMemo(
    () => (items as EurItem[]).find((item) => item.sourceType === activeSource?.sourceType && item.sourceId === activeSource?.sourceId),
    [items, activeSource],
  );

  const activeLineOptions = React.useMemo(() => {
    if (!activeItem) return lineOptions;
    return lineOptions.filter((line) => line.kind === activeItem.flowType);
  }, [activeItem, lineOptions]);

  const queueItems = React.useMemo(() => {
    const base = (items as EurItem[]).filter((item) => {
      const statusMatch =
        queueStatus === 'all'
          ? true
          : queueStatus === 'unclassified'
            ? !item.classification?.eurLineId && !item.classification?.excluded
            : queueStatus === 'classified'
              ? Boolean(item.classification?.eurLineId) && !item.classification?.excluded
              : Boolean(item.classification?.excluded);
      const flowMatch = flowFilter === 'all' || item.flowType === flowFilter;
      const needle = query.trim().toLowerCase();
      const searchMatch =
        needle.length === 0 ||
        item.counterparty.toLowerCase().includes(needle) ||
        item.purpose.toLowerCase().includes(needle) ||
        item.date.includes(needle);
      return statusMatch && flowMatch && searchMatch;
    });

    const sorted = [...base];
    sorted.sort((a, b) => {
      if (queueSort === 'date_desc') return b.date.localeCompare(a.date);
      if (queueSort === 'amount_desc') return b.amountGross - a.amountGross;
      return a.counterparty.localeCompare(b.counterparty, 'de');
    });
    return sorted;
  }, [items, queueStatus, flowFilter, query, queueSort]);

  const selectedItems = React.useMemo(
    () => queueItems.filter((item) => selectedKeys.has(itemKey(item))),
    [queueItems, selectedKeys],
  );

  const statusCounts = React.useMemo(() => {
    const all = (items as EurItem[]);
    return {
      all: all.length,
      unclassified: all.filter((item) => !item.classification?.eurLineId && !item.classification?.excluded).length,
      classified: all.filter((item) => item.classification?.eurLineId && !item.classification?.excluded).length,
      excluded: all.filter((item) => item.classification?.excluded).length,
    };
  }, [items]);

  React.useEffect(() => {
    if (!activeItem) return;
    setSelectedLineId(activeItem.classification?.eurLineId ?? activeItem.suggestedLineId ?? '');
    setVatMode(activeItem.classification?.vatMode ?? 'none');
    setExcluded(activeItem.classification?.excluded ?? false);
  }, [activeItem]);

  const applyBulk = async (
    label: string,
    resolver: (item: EurItem) => { eurLineId?: string; excluded?: boolean; vatMode?: VatMode },
  ) => {
    if (selectedItems.length === 0) return;

    const changes: UndoChange[] = selectedItems.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      taxYear,
      prevLineId: item.classification?.eurLineId,
      prevExcluded: item.classification?.excluded ?? false,
      prevVatMode: item.classification?.vatMode ?? 'none',
    }));

    setIsApplying(true);
    try {
      await Promise.all(
        selectedItems.map((item) =>
          upsertClassification.mutateAsync({
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            taxYear,
            ...resolver(item),
          }),
        ),
      );
      setLastUndo({ label, changes });
      setSelectedKeys(new Set());
      await invalidateEur();
      showNotification(`${selectedItems.length} Einträge klassifiziert`, 'success');
    } finally {
      setIsApplying(false);
    }
  };

  const applySingle = async () => {
    if (!activeItem) return;

    const changes: UndoChange[] = [
      {
        sourceType: activeItem.sourceType,
        sourceId: activeItem.sourceId,
        taxYear,
        prevLineId: activeItem.classification?.eurLineId,
        prevExcluded: activeItem.classification?.excluded ?? false,
        prevVatMode: activeItem.classification?.vatMode ?? 'none',
      },
    ];

    setIsApplying(true);
    try {
      await upsertClassification.mutateAsync({
        sourceType: activeItem.sourceType,
        sourceId: activeItem.sourceId,
        taxYear,
        eurLineId: selectedLineId || undefined,
        excluded,
        vatMode,
      });
      setLastUndo({ label: 'Einzelklassifizierung', changes });
      await invalidateEur();
      showNotification('Klassifizierung gespeichert', 'success');
    } finally {
      setIsApplying(false);
    }
  };

  const undoLast = async () => {
    if (!lastUndo) return;
    setIsApplying(true);
    try {
      await Promise.all(
        lastUndo.changes.map((change) =>
          upsertClassification.mutateAsync({
            sourceType: change.sourceType,
            sourceId: change.sourceId,
            taxYear: change.taxYear,
            eurLineId: change.prevLineId,
            excluded: change.prevExcluded,
            vatMode: change.prevVatMode,
          }),
        ),
      );
      await invalidateEur();
      setLastUndo(null);
      showNotification('Letzte Aktion rückgängig gemacht', 'info');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl p-6 min-h-full shadow-sm">
      <EurHeader
        taxYear={taxYear}
        onTaxYearChange={setTaxYear}
        onRulesClick={() => setShowRulesModal(true)}
        onCsvExport={() => void exportCsv()}
        onPdfExport={() => void exportPdf()}
        isPdfExporting={isPdfExporting}
      />

      <UndoBanner
        lastUndo={lastUndo}
        onUndo={() => void undoLast()}
        isApplying={isApplying}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <QueuePanel
          queueItems={queueItems}
          selectedItems={selectedItems}
          statusCounts={statusCounts}
          queueStatus={queueStatus}
          onQueueStatusChange={setQueueStatus}
          query={query}
          onQueryChange={setQuery}
          flowFilter={flowFilter}
          onFlowFilterChange={setFlowFilter}
          queueSort={queueSort}
          onQueueSortChange={setQueueSort}
          selectedKeys={selectedKeys}
          onSelectedKeysChange={setSelectedKeys}
          isApplying={isApplying}
          itemsLoading={itemsLoading}
          activeSource={activeSource}
          onActiveSourceChange={setActiveSource}
          onApplyBulkSuggestion={() =>
            void applyBulk('Bulk: Vorschlag anwenden', (item) => ({
              eurLineId: item.suggestedLineId,
              excluded: false,
              vatMode: item.classification?.vatMode ?? 'none',
            }))
          }
          onApplyBulkExclude={() =>
            void applyBulk('Bulk: Als privat/Transfer markieren', () => ({
              eurLineId: undefined,
              excluded: true,
              vatMode: 'none',
            }))
          }
          onApplyBulkReset={() =>
            void applyBulk('Bulk: Klassifizierung zurücksetzen', () => ({
              eurLineId: undefined,
              excluded: false,
              vatMode: 'none',
            }))
          }
        />

        <ClassificationPanel
          activeItem={activeItem}
          activeLineOptions={activeLineOptions}
          selectedLineId={selectedLineId}
          onSelectedLineIdChange={setSelectedLineId}
          vatMode={vatMode}
          onVatModeChange={setVatMode}
          excluded={excluded}
          onExcludedChange={setExcluded}
          isApplying={isApplying}
          onSave={() => void applySingle()}
          onReset={() => {
            setSelectedLineId('');
            setExcluded(false);
            setVatMode('none');
          }}
        />

        <ReportPanel
          report={report}
          reportLoading={reportLoading}
        />
      </div>

      {showRulesModal && (
        <EurRulesModal
          taxYear={taxYear}
          onClose={() => setShowRulesModal(false)}
          onRulesChanged={() => void invalidateEur()}
        />
      )}

      <Toast
        message={toastMessage}
        type={toastType}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
      />
    </div>
  );
};
