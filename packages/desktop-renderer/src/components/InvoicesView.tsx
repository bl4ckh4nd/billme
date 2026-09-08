import React, { useState } from 'react';
import {
  Search, Plus, FileText,
  Clock, ArrowLeft,
  Share2, Check,
  ChevronDown, ArrowUpRight,
  AlertTriangle, Mail, Gavel, CheckCircle, X,
  Download, Printer, Send, Paperclip, MoreHorizontal, Calendar, User, RefreshCw, Link, ExternalLink, Trash2, LayoutTemplate, Edit3, Euro, ArrowRight
} from 'lucide-react';
import { Badge, Button, ConfirmDialog, Portal, useActionFeedback } from '@billme/ui';
import {
  getInvoiceDocumentLabel,
  isBillingDocumentKind,
  type Invoice,
  type InvoiceStatus,
  type AppSettings,
} from '@billme/desktop-core/types';
import { MOCK_SETTINGS } from '@billme/desktop-services/mockData';
import { useDeleteInvoiceMutation, useInvoicesQuery, useUpsertInvoiceMutation } from '../hooks/useInvoices';
import { useDeleteOfferMutation, useOffersQuery, useUpsertOfferMutation } from '../hooks/useOffers';
import { useSettingsQuery } from '../hooks/useSettings';
import { ipc } from '../runtime-api';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import { SkeletonLoader } from '@billme/desktop-ui/components/SkeletonLoader';
import {
  calculateInvoiceTaxSnapshot,
  getInvoiceTaxExemptionReason,
  getInvoiceTaxModeDefinition,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';

// Mock data for Offers to demonstrate the switch
const MOCK_OFFERS: Invoice[] = [];

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

const formatDate = (dateString: string) => {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const getDunningBadge = (level: number | undefined) => {
    if (!level || level === 0) return null;
    let label = '';
    let colorClass = '';
    switch(level) {
        case 1:
            label = '1. Mahnung';
            colorClass = 'bg-warning-bg text-warning border-warning-border';
            break;
        case 2:
            label = '2. Mahnung';
            colorClass = 'bg-error-bg text-error border-error-border';
            break;
        case 3:
            label = 'Inkasso';
            colorClass = 'bg-dark-base text-white border-dark-base';
            break;
        default:
            return null;
    }
    return <span className={`px-2 py-1 rounded text-[10px] font-bold border ${colorClass} uppercase tracking-wide flex items-center gap-1 whitespace-nowrap`}>
        <AlertTriangle size={10} /> {label}
    </span>;
};

interface DocumentsViewProps {
  onOpenTemplates: () => void;
  onOpenRecurring: () => void;
  onEditInvoice: (invoice: Invoice, type: 'invoice' | 'offer') => void;
  onCreateInvoice: (type: 'invoice' | 'offer') => void;
  initialDocumentType?: 'invoice' | 'offer';
  initialSelectedId?: string;
  initialStatus?: InvoiceStatus;
}

type ChainAction =
  | 'order_confirmation'
  | 'delivery_note'
  | 'advance_invoice'
  | 'partial_invoice'
  | 'final_invoice'
  | 'credit_note'
  | 'cancellation_invoice'
  | 'revision';

type AmountChainAction = Extract<ChainAction, 'advance_invoice' | 'partial_invoice' | 'final_invoice' | 'credit_note' | 'cancellation_invoice'>;

const isAmountChainAction = (action: ChainAction): action is AmountChainAction =>
  action === 'advance_invoice' ||
  action === 'partial_invoice' ||
  action === 'final_invoice' ||
  action === 'credit_note' ||
  action === 'cancellation_invoice';

export const DocumentsView: React.FC<DocumentsViewProps> = ({
  onOpenTemplates,
  onOpenRecurring,
  onEditInvoice,
  onCreateInvoice,
  initialDocumentType,
  initialSelectedId,
  initialStatus,
}) => {
  const queryClient = useQueryClient();
  const [documentType, setDocumentType] = useState<'invoice' | 'offer'>('invoice');
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Dunning State
  const [isDunningModalOpen, setIsDunningModalOpen] = useState(false);
  const [selectedForDunning, setSelectedForDunning] = useState<string[]>([]);
  const [isDunningProcessing, setIsDunningProcessing] = useState(false);
  const [reminderConfirmation, setReminderConfirmation] = useState<{
    invoiceId: string;
    invoiceNumber: string;
    levelName: string;
    fee: number;
  } | null>(null);
  const [isCreatingReminder, setIsCreatingReminder] = useState(false);

  // Email State
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
  const [emailData, setEmailData] = useState({ to: '', subject: '', message: '' });

  // Multi-select (List View)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [bulkDeleteReason, setBulkDeleteReason] = useState('');
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Detail toolbar overflow menu
  const [isToolbarOverflowOpen, setIsToolbarOverflowOpen] = useState(false);
  const toolbarOverflowRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!isToolbarOverflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (toolbarOverflowRef.current && !toolbarOverflowRef.current.contains(e.target as Node)) {
        setIsToolbarOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isToolbarOverflowOpen]);

  // Payments (Invoice detail)
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [paymentForm, setPaymentForm] = useState({ date: '', amount: '', method: 'Überweisung' });
  const [paymentReason, setPaymentReason] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isPaymentDeleteOpen, setIsPaymentDeleteOpen] = useState(false);
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
  const [paymentDeleteReason, setPaymentDeleteReason] = useState('');
  const [paymentDeleteError, setPaymentDeleteError] = useState<string | null>(null);

  // Document-chain amount actions use an in-app dialog because Electron has no
  // native prompt support. The number is reserved only after confirmation.
  const [chainAmountDialog, setChainAmountDialog] = useState<{ action: AmountChainAction } | null>(null);
  const [chainAmountInput, setChainAmountInput] = useState('');
  const [chainAmountError, setChainAmountError] = useState<string | null>(null);

  // Choose data source based on document type
  // In a real app, this would come from a context or prop
  const { data: invoices = [], isLoading: isLoadingInvoices } = useInvoicesQuery();
  const upsertInvoice = useUpsertInvoiceMutation();
  const deleteInvoice = useDeleteInvoiceMutation();
  const { data: offers = MOCK_OFFERS, isLoading: isLoadingOffers } = useOffersQuery();
  const upsertOffer = useUpsertOfferMutation();
  const deleteOffer = useDeleteOfferMutation();
  const { data: settingsFromDb } = useSettingsQuery();
  const { notify } = useActionFeedback('documents');
  const settings = settingsFromDb ?? MOCK_SETTINGS;
  const currentData = documentType === 'invoice' ? invoices : offers;
  const isLoading = documentType === 'invoice' ? isLoadingInvoices : isLoadingOffers;

  const selectedDocument = currentData.find(i => i.id === selectedId);
  const selectedChain = React.useMemo(() => {
    if (documentType !== 'invoice' || !selectedDocument) return [];
    const rootId = selectedDocument.rootDocumentId ?? selectedDocument.id;
    return invoices
      .filter((invoice) => (invoice.rootDocumentId ?? invoice.id) === rootId)
      .sort((left, right) => {
        if (left.id === selectedDocument.id) return -1;
        if (right.id === selectedDocument.id) return 1;
        return `${left.date}-${left.number}`.localeCompare(`${right.date}-${right.number}`);
      });
  }, [documentType, invoices, selectedDocument]);
  const selectedDocumentTax =
    selectedDocument
      ? (selectedDocument.taxSnapshot ??
        calculateInvoiceTaxSnapshot(
          {
            items: selectedDocument.items ?? [],
            taxMode: resolveInvoiceTaxMode(selectedDocument.taxMode, settings),
            taxMeta: selectedDocument.taxMeta,
          },
          settings,
        ))
      : null;
  const selectedTaxDefinition = selectedDocument
    ? getInvoiceTaxModeDefinition(resolveInvoiceTaxMode(selectedDocument.taxMode, settings))
    : null;
  const selectedTaxExemptionReason = selectedDocument
    ? getInvoiceTaxExemptionReason(resolveInvoiceTaxMode(selectedDocument.taxMode, settings), selectedDocument.taxMeta)
    : undefined;

  React.useEffect(() => {
    setFilter(initialStatus ?? 'all');
    setDocumentType(initialDocumentType ?? 'invoice');
    if (!initialSelectedId) return;
    setSelectedId(initialSelectedId);
    setViewMode('detail');
  }, [initialDocumentType, initialSelectedId, initialStatus]);

  const filteredDocuments = currentData.filter(doc => {
    const matchesFilter = filter === 'all' || doc.status === filter;
    const matchesSearch = doc.client.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          doc.number.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const overdueInvoices = invoices.filter(i => i.status === 'overdue');
  const overdueInvoiceIds = new Set(overdueInvoices.map((i) => i.id));
  const validSelectedForDunning = selectedForDunning.filter((id) => overdueInvoiceIds.has(id));

  React.useEffect(() => {
    if (!isDunningModalOpen) return;
    const reconciled = selectedForDunning.filter((id) => overdueInvoiceIds.has(id));
    if (reconciled.length !== selectedForDunning.length) {
      setSelectedForDunning(reconciled);
    }
  }, [isDunningModalOpen, selectedForDunning, overdueInvoices]);

  const sumPayments = (doc: Invoice | undefined) => {
    if (!doc) return 0;
    return (doc.payments ?? []).reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
  };

  const handleOpenDetail = (id: string) => {
    setSelectedId(id);
    setViewMode('detail');
  };

  const isSelecting = selectedIds.size > 0;

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const allIds = filteredDocuments.map((d) => d.id);
      const allSelected = allIds.length > 0 && allIds.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(allIds);
    });
  };

  const handleSharePaymentLink = () => {
    if (!selectedDocument?.number) {
      notify('error', 'Kein Dokument für Zahllink ausgewählt.');
      return;
    }

    const paymentBaseUrl = settings.portal.baseUrl?.trim() || 'https://pay.billme.de';
    const url = `${paymentBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(selectedDocument.number)}`;
    void (async () => {
      try {
        await navigator.clipboard.writeText(url);
        notify('success', 'Zahllink kopiert!');
      } catch (error) {
        notify('error', `Kopieren fehlgeschlagen: ${String(error)}`);
      }
    })();
  };

  const handleDownloadPdf = () => {
      if (!selectedDocument) return;
      void (async () => {
        try {
          notify('progress', 'PDF wird erstellt...');
          const res = await ipc.pdf.export({ kind: documentType, id: selectedDocument.id });
          notify('success', 'PDF gespeichert', {
            action: { label: 'Öffnen', onClick: () => void ipc.shell.openPath({ path: res.path }) },
          });
        } catch (e) {
          notify('error', `PDF Fehler: ${String(e)}`);
        }
      })();
  };

  const handlePublishOffer = () => {
    if (!selectedDocument) return;
    void (async () => {
      try {
        notify('progress', 'Angebot wird veröffentlicht...');
        const res = await ipc.portal.publishOffer({ offerId: selectedDocument.id });
        await navigator.clipboard.writeText(res.publicUrl);
        notify('success', 'Link kopiert!');
        await queryClient.invalidateQueries({ queryKey: ['offers'] });
      } catch (e) {
        notify('error', `Portalfehler: ${String(e)}`);
      }
    })();
  };

  const getOfferPublicUrl = (): string | null => {
    if (!selectedDocument?.shareToken) return null;
    const baseUrl = settings.portal.baseUrl?.trim();
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/+$/, '')}/offers/${selectedDocument.shareToken}`;
  };

  const handleOpenOfferLink = () => {
    const url = getOfferPublicUrl();
    if (!url) {
      notify('error', 'Portal-URL fehlt. Hinterlege sie in Einstellungen unter Portal.');
      return;
    }
    void (async () => {
      try {
        await ipc.shell.openExternal({ url });
      } catch (e) {
        notify('error', `Link konnte nicht geöffnet werden: ${String(e)}`);
      }
    })();
  };

  const handleSyncOfferDecision = () => {
    if (!selectedDocument) return;
    void (async () => {
      try {
        notify('progress', 'Portalstatus wird synchronisiert ...');
        const res = await ipc.portal.syncOfferStatus({ offerId: selectedDocument.id });
        await queryClient.invalidateQueries({ queryKey: ['offers'] });
        notify('success', res.updated ? 'Status aktualisiert' : 'Keine Änderung');
      } catch (e) {
        notify('error', `Synchronisierung fehlgeschlagen: ${String(e)}`);
      }
    })();
  };

  const handleConvertOfferToInvoice = () => {
    if (!selectedDocument || documentType !== 'offer') return;
    void (async () => {
      try {
        notify('progress', 'Rechnung wird erstellt...');
        const newInvoice = await ipc.documents.convertOfferToInvoice({ offerId: selectedDocument.id });
        await queryClient.invalidateQueries({ queryKey: ['invoices'] });
        notify('success', 'Rechnung erfolgreich erstellt!');
        setTimeout(() => {
          // Switch to invoices view and open the new invoice
          switchDocumentType('invoice');
          setTimeout(() => {
            setSelectedId(newInvoice.id);
            setViewMode('detail');
          }, 100);
        }, 1500);
      } catch (e) {
        notify('error', `Fehler: ${String(e)}`);
      }
    })();
  };

  const persistChainDocument = (action: ChainAction, amount?: number) => {
    if (!selectedDocument) return;
    void (async () => {
      let reservationId: string | undefined;
      try {
        const today = new Date().toISOString().split('T')[0] ?? '';
        const reasonByAction: Record<ChainAction, string> = {
          order_confirmation: 'Auftragsbestätigung aus angenommenem Angebot erstellt',
          delivery_note: 'Lieferschein aus Auftragsbestätigung erstellt',
          advance_invoice: 'Abschlagsrechnung erstellt',
          partial_invoice: 'Teilrechnung erstellt',
          final_invoice: 'Schlussrechnung erstellt',
          credit_note: 'Gutschrift erstellt',
          cancellation_invoice: 'Stornorechnung erstellt',
          revision: 'Revisionsdokument erstellt',
        };
        const reason = reasonByAction[action];
        const reservation = await ipc.numbers.reserve({ kind: 'invoice' });
        const reservedId = reservation.reservationId;
        reservationId = reservedId;
        const base = { id: uuidv4(), number: reservation.number, date: today, reason };
        let created: Invoice;

        if (action === 'order_confirmation') {
          created = await ipc.documents.chainCreate({ operation: action, ...base, offerId: selectedDocument.id });
        } else if (action === 'delivery_note') {
          created = await ipc.documents.chainCreate({ operation: action, ...base, orderId: selectedDocument.id });
        } else if (action === 'revision') {
          created = await ipc.documents.chainCreate({ operation: action, ...base, invoiceId: selectedDocument.id });
        } else if (action === 'credit_note' || action === 'cancellation_invoice') {
          if (amount === undefined) throw new Error('Ein Korrekturbetrag ist erforderlich.');
          created = await ipc.documents.chainCreate({ operation: 'correction', ...base, invoiceId: selectedDocument.id, kind: action, amount });
        } else {
          if (amount === undefined) throw new Error('Ein Rechnungsbetrag ist erforderlich.');
          created = await ipc.documents.chainCreate({ operation: 'settlement_invoice', ...base, orderId: selectedDocument.id, kind: action, amount });
        }

        await ipc.numbers.finalize({ reservationId: reservedId, documentId: created.id });
        reservationId = undefined;
        const finalized = await ipc.invoices.upsert({
          invoice: { ...created, status: 'open' },
          reason: `${reason} (finalisiert)`,
        });
        queryClient.setQueryData<Invoice[]>(['invoices'], (current = []) => [
          finalized,
          ...current.filter((invoice) => invoice.id !== finalized.id),
        ]);
        await queryClient.invalidateQueries({ queryKey: ['invoices'] });
        if (action === 'order_confirmation') {
          setDocumentType('invoice');
          setIsTypeDropdownOpen(false);
          setSelectedIds(new Set());
        }
        setSelectedId(finalized.id);
        setViewMode('detail');
        notify('success', `${getInvoiceDocumentLabel(finalized.documentKind)} ${finalized.number} erstellt.`);
      } catch (error) {
        if (reservationId) await ipc.numbers.release({ reservationId }).catch(() => undefined);
        notify('error', `Dokument konnte nicht erstellt werden: ${String(error)}`);
      }
    })();
  };

  const handleCreateChainDocument = (action: ChainAction) => {
    if (!selectedDocument) return;
    if (action === 'order_confirmation' && documentType !== 'offer') return;
    if (action !== 'order_confirmation' && documentType !== 'invoice') return;
    if (action === 'delivery_note' && selectedDocument.documentKind !== 'order_confirmation') return;
    if (isAmountChainAction(action)) {
      setChainAmountInput(selectedDocument.amount.toFixed(2));
      setChainAmountError(null);
      setChainAmountDialog({ action });
      return;
    }
    persistChainDocument(action);
  };

  const cancelChainAmount = () => {
    setChainAmountDialog(null);
    setChainAmountInput('');
    setChainAmountError(null);
  };

  const confirmChainAmount = () => {
    if (!chainAmountDialog) return;
    const normalized = chainAmountInput.trim().replace(/\s/g, '').replace(',', '.');
    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount <= 0) {
      setChainAmountError('Bitte einen gültigen Betrag größer als 0 eingeben.');
      return;
    }
    const { action } = chainAmountDialog;
    cancelChainAmount();
    persistChainDocument(action, amount);
  };

  const switchDocumentType = (type: 'invoice' | 'offer') => {
      setDocumentType(type);
      setIsTypeDropdownOpen(false);
      setSelectedId(null);
      setViewMode('list');
      clearSelection();
  };

  // --- Email Logic ---
  const handleOpenEmail = () => {
      if(!selectedDocument) return;
      const companyName = settings.company?.name?.trim() || 'Ihr Unternehmen';
      const contactPerson = settings.company?.owner?.trim();
      const signature = contactPerson ? `${contactPerson}\n${companyName}` : companyName;
      setEmailData({
          to: selectedDocument.clientEmail,
          subject: `${documentType === 'invoice' ? 'Rechnung' : 'Angebot'} ${selectedDocument.number}`,
          message: `Guten Tag,\n\nanbei erhalten Sie ${documentType === 'invoice' ? 'Ihre Rechnung' : 'Ihr Angebot'} ${selectedDocument.number}.\n\nMit freundlichen Grüßen,\n${signature}`
      });
      setIsEmailModalOpen(true);
  };

  const handleSendEmail = () => {
      if(!selectedDocument) return;
      void (async () => {
        try {
          setIsEmailModalOpen(false);
          notify('progress', 'E-Mail wird gesendet...');

          const result = await ipc.email.send({
            documentType,
            documentId: selectedDocument.id,
            recipientEmail: emailData.to,
            recipientName: selectedDocument.client,
            subject: emailData.subject,
            bodyText: emailData.message,
          });

          if (!result.success) {
            notify('error', `Fehler: ${result.error}`);
            return;
          }

          // Update document history
          const historyEntry = {
              date: new Date().toISOString().split('T')[0],
              action: `Per E-Mail gesendet an ${emailData.to}`
          };

          if (documentType === 'invoice') {
            upsertInvoice.mutate({
              invoice: {
                ...selectedDocument,
                history: [historyEntry, ...(selectedDocument.history ?? [])],
              },
              reason: 'email_sent',
            });
          } else {
            upsertOffer.mutate({
              offer: {
                ...selectedDocument,
                history: [historyEntry, ...(selectedDocument.history ?? [])],
              },
              reason: 'email_sent',
            });
          }

          notify('success', 'E-Mail wurde versendet.');
        } catch (e) {
          notify('error', `Fehler: ${String(e)}`);
        }
      })();
  };

  const handleFinalizeDraftInvoice = () => {
      if (!selectedDocument || documentType !== 'invoice' || selectedDocument.status !== 'draft') return;

      const historyEntry = {
          date: new Date().toISOString().split('T')[0] ?? '',
          action: 'Rechnung gestellt (Status: Offen)',
      };

      upsertInvoice.mutate(
        {
          invoice: {
            ...selectedDocument,
            status: 'open',
            history: [historyEntry, ...(selectedDocument.history ?? [])],
          },
          reason: 'invoice_finalize',
        },
        {
          onSuccess: () => {
            notify('success', 'Rechnung als gestellt markiert');
          },
          onError: (error) => {
            notify('error', `Finalisieren fehlgeschlagen: ${String(error)}`);
          },
        },
      );
  };


  // --- Dunning Logic ---
  const handleStartDunningRun = () => {
      setSelectedForDunning(overdueInvoices.map(i => i.id));
      setIsDunningModalOpen(true);
  };

  const handleProcessDunningRun = async () => {
      if (isDunningProcessing) return;
      setIsDunningProcessing(true);
      const selectedIds = [...selectedForDunning];
      const selectedSet = new Set(selectedIds);
      const currentOverdueById = new Map(overdueInvoices.map((i) => [i.id, i]));

      let processed = 0;
      let failed = 0;
      let skipped = 0;
      let firstError = '';

      for (const invoiceId of selectedIds) {
          const inv = currentOverdueById.get(invoiceId);
          if (!inv || !selectedSet.has(invoiceId)) {
            skipped++;
            continue;
          }

          const currentLevel = inv.dunningLevel || 0;
          const nextLevel = Math.min(currentLevel + 1, 3);
          const levelConfig = settings.dunning.levels.find((l) => l.id === nextLevel);

          const historyEntry = {
              date: new Date().toISOString().split('T')[0] ?? '',
              action: `Mahnlauf: ${levelConfig?.name || 'Mahnung'} versendet`,
          };

          try {
            await upsertInvoice.mutateAsync({
              invoice: {
                ...inv,
                dunningLevel: nextLevel,
                history: [...(inv.history ?? []), historyEntry],
              },
              reason: 'dunning_run',
            });
            processed++;
          } catch (error) {
            failed++;
            if (!firstError) firstError = String(error);
          }
      }

      setIsDunningProcessing(false);
      setIsDunningModalOpen(false);
      setSelectedForDunning([]);
      const summary = [
        `${processed} verarbeitet`,
        `${skipped} übersprungen`,
        `${failed} fehlgeschlagen`,
      ].join(' • ');
      notify(firstError ? 'error' : 'success', firstError ? `${summary}\nErster Fehler: ${firstError}` : summary);
  };

  const handleCreateReminder = () => {
      if (!selectedDocument || documentType !== 'invoice') return;
      const currentLevel = selectedDocument.dunningLevel || 0;
      const nextLevel = Math.min(currentLevel + 1, 3);
      const levelConfig = settings.dunning.levels.find(l => l.id === nextLevel);
      setReminderConfirmation({
        invoiceId: selectedDocument.id,
        invoiceNumber: selectedDocument.number,
        levelName: levelConfig?.name ?? 'Mahnung',
        fee: levelConfig?.fee ?? 0,
      });
  };

  const handleConfirmReminder = async () => {
      if (!reminderConfirmation || isCreatingReminder) return;
      const invoice = invoices.find((item) => item.id === reminderConfirmation.invoiceId);
      if (!invoice) {
        setReminderConfirmation(null);
        notify('error', 'Die Rechnung für die Mahnung wurde nicht gefunden.');
        return;
      }

      setIsCreatingReminder(true);
      const nextLevel = Math.min((invoice.dunningLevel || 0) + 1, 3);
      const historyEntry = {
          date: new Date().toISOString().split('T')[0] ?? '',
          action: `${reminderConfirmation.levelName} erstellt (+${formatCurrency(reminderConfirmation.fee)})`,
      };
      try {
        await upsertInvoice.mutateAsync({
          invoice: {
            ...invoice,
            dunningLevel: nextLevel,
            history: [...(invoice.history ?? []), historyEntry],
          },
          reason: 'dunning_create',
        });
        setReminderConfirmation(null);
        notify('success', `${reminderConfirmation.levelName} für ${invoice.number} erstellt.`);
      } catch (error) {
        notify('error', `Mahnung konnte nicht erstellt werden: ${String(error)}`);
      } finally {
        setIsCreatingReminder(false);
      }
  };


  // --- Dunning Modal ---
  const renderDunningModal = () => {
      if (!isDunningModalOpen) return null;

      return (
          <Portal>
      <div className="fixed inset-0 bg-dark-base/20 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
              <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-scale-in">
                  <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                      <div>
                        <h3 className="text-xl font-black">Mahnlauf starten</h3>
                        <p className="text-sm text-gray-500">{validSelectedForDunning.length} Rechnungen ausgewählt</p>
                      </div>
                      <button onClick={() => setIsDunningModalOpen(false)} className="p-2 hover:bg-gray-200 rounded-full transition-colors"><X size={20}/></button>
                  </div>

                  <div className="p-6 overflow-y-auto flex-1 space-y-3">
                       {overdueInvoices.map(inv => {
                           const currentLevel = inv.dunningLevel || 0;
                           const nextLevel = Math.min(currentLevel + 1, 3);
                           const levelConfig = settings.dunning.levels.find(l => l.id === nextLevel);
                           const isSelected = selectedForDunning.includes(inv.id);

                           return (
                               <div key={inv.id} className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${isSelected ? 'border-black bg-gray-50' : 'border-gray-100 bg-white hover:border-gray-300'}`}
                                    onClick={() => {
                                        if (isSelected) setSelectedForDunning((prev) => prev.filter((id) => id !== inv.id));
                                        else setSelectedForDunning((prev) => [...prev, inv.id]);
                                    }}
                               >
                                   <div className="flex justify-between items-center mb-2">
                                       <div className="flex items-center gap-3">
                                            <div className={`w-5 h-5 rounded border flex items-center justify-center ${isSelected ? 'bg-black border-black text-white' : 'border-gray-300'}`}>
                                                {isSelected && <Check size={12} />}
                                            </div>
                                            <span className="font-bold">{inv.number}</span>
                                            <span className="text-sm text-gray-500">{inv.client}</span>
                                       </div>
                                       <span className="font-mono font-bold">{formatCurrency(inv.amount)}</span>
                                   </div>
                                   <div className="pl-8 flex items-center gap-2 text-xs">
                                       <span className="bg-error-bg text-error px-2 py-1 rounded font-bold">Überfällig seit {new Date(inv.dueDate).toLocaleDateString()}</span>
                                       <span className="text-gray-400">➔</span>
                                       <span className="bg-black text-accent px-2 py-1 rounded font-bold">Wird: {levelConfig?.name} (+{formatCurrency(levelConfig?.fee || 0)})</span>
                                   </div>
                               </div>
                           );
                       })}
                       {overdueInvoices.length === 0 && (
                           <p className="text-center text-gray-500 py-8">Keine überfälligen Rechnungen gefunden.</p>
                       )}
                  </div>

                  <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-end gap-3">
                      <button
                        onClick={() => {
                          setIsDunningModalOpen(false);
                          setSelectedForDunning(validSelectedForDunning);
                        }}
                        className="px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-200 transition-colors"
                      >
                        Abbrechen
                      </button>
                      <Button
                        onClick={() => void handleProcessDunningRun()}
                        disabled={validSelectedForDunning.length === 0 || isDunningProcessing}
                        size="md"
                      >
                          {isDunningProcessing ? 'Wird gesendet ...' : `${validSelectedForDunning.length} Mahnungen versenden`}
                      </Button>
                  </div>
              </div>
          </div>
          </Portal>
      );
  };

  // --- Email Modal ---
  const renderEmailModal = () => {
    if (!isEmailModalOpen) return null;
    return (
        <Portal>
        <div className="fixed inset-0 bg-dark-base/20 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
             <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl flex flex-col animate-scale-in">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50 rounded-t-3xl">
                    <h3 className="text-lg font-black flex items-center gap-2"><Mail size={18}/> Per E-Mail senden</h3>
                    <button onClick={() => setIsEmailModalOpen(false)} className="p-2 hover:bg-gray-200 rounded-full"><X size={18}/></button>
                </div>
                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1">Empfänger</label>
                        <input
                            type="email"
                            value={emailData.to}
                            onChange={e => setEmailData({...emailData, to: e.target.value})}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1">Betreff</label>
                        <input
                            type="text"
                            value={emailData.subject}
                            onChange={e => setEmailData({...emailData, subject: e.target.value})}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1">Nachricht</label>
                        <textarea
                            rows={6}
                            value={emailData.message}
                            onChange={e => setEmailData({...emailData, message: e.target.value})}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none resize-none"
                        />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500 bg-gray-50 p-3 rounded-lg border border-gray-100">
                        <Paperclip size={14} />
                        <span>Angehängt: {selectedDocument?.number}.pdf</span>
                    </div>
                </div>
                <div className="p-6 border-t border-gray-100 bg-gray-50 rounded-b-3xl flex justify-end gap-3">
                    <button onClick={() => setIsEmailModalOpen(false)} className="px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-200 transition-colors">Abbrechen</button>
                    <Button onClick={handleSendEmail} size="md">
                        <Send size={16} /> Senden
                    </Button>
                </div>
             </div>
        </div>
        </Portal>
    );
  };

  const renderPaymentModal = () => {
    if (!isPaymentModalOpen) return null;

    return (
      <Portal>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-dark-base/20 backdrop-blur-sm p-4">
        <div className="w-full max-w-lg rounded-3xl bg-white shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
            <div>
              <h3 className="text-lg font-black text-gray-900">
                {editingPaymentId ? 'Zahlung bearbeiten' : 'Zahlung erfassen'}
              </h3>
              <p className="text-sm text-gray-500 mt-1">Wird im Audit-Log gespeichert (GoBD).</p>
            </div>
            <button
              onClick={() => {
                setIsPaymentModalOpen(false);
                setEditingPaymentId(null);
                setPaymentError(null);
              }}
              className="w-10 h-10 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center"
              title="Schließen"
            >
              <X size={18} />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Datum</label>
                <input
                  type="date"
                  value={paymentForm.date}
                  onChange={(e) => setPaymentForm((p) => ({ ...p, date: e.target.value }))}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Betrag (EUR)</label>
                <input
                  inputMode="decimal"
                  value={paymentForm.amount}
                  onChange={(e) => setPaymentForm((p) => ({ ...p, amount: e.target.value }))}
                  placeholder="z.B. 250,00"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">Methode</label>
              <select
                value={paymentForm.method}
                onChange={(e) => setPaymentForm((p) => ({ ...p, method: e.target.value }))}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
              >
                <option value="Überweisung">Überweisung</option>
                <option value="PayPal">PayPal</option>
                <option value="Karte">Karte</option>
                <option value="Bar">Bar</option>
                <option value="Sonstiges">Sonstiges</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">Grund (Pflicht)</label>
              <textarea
                value={paymentReason}
                onChange={(e) => {
                  setPaymentReason(e.target.value);
                  if (paymentError) setPaymentError(null);
                }}
                rows={3}
                placeholder="z.B. Zahlungseingang Kontoauszug, Teilzahlung, ..."
                className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none"
              />
            </div>

            {paymentError && <div className="text-sm font-bold text-error">{paymentError}</div>}
          </div>

          <div className="px-6 py-5 border-t border-gray-100 flex items-center justify-end gap-3">
            <button
              onClick={() => {
                setIsPaymentModalOpen(false);
                setEditingPaymentId(null);
                setPaymentError(null);
              }}
              className="px-5 py-2.5 rounded-xl font-bold bg-gray-100 text-gray-900 hover:bg-gray-200 transition-colors"
            >
              Abbrechen
            </button>
            <button
              onClick={() => {
                if (!selectedDocument || documentType !== 'invoice') return;

                const trimmedReason = paymentReason.trim();
                if (!trimmedReason) {
                  setPaymentError('Grund ist Pflicht.');
                  return;
                }

                const date = paymentForm.date;
                if (!date) {
                  setPaymentError('Datum ist Pflicht.');
                  return;
                }

                const normalized = paymentForm.amount.replace(/\s/g, '').replace(',', '.');
                const amount = Number(normalized);
                if (!Number.isFinite(amount) || amount <= 0) {
                  setPaymentError('Bitte einen gültigen Betrag > 0 eingeben.');
                  return;
                }

                if (editingPaymentId && !(selectedDocument.payments ?? []).some((p) => p.id === editingPaymentId)) {
                  setPaymentError('Zahlung nicht gefunden. Bitte neu öffnen.');
                  return;
                }

                const next: Invoice = {
                  ...selectedDocument,
                  payments: editingPaymentId
                    ? (selectedDocument.payments ?? []).map((p) =>
                        p.id === editingPaymentId
                          ? { ...p, date, amount, method: paymentForm.method || 'Überweisung' }
                          : p,
                      )
                    : [
                        ...(selectedDocument.payments ?? []),
                        { id: uuidv4(), date, amount, method: paymentForm.method || 'Überweisung' },
                      ],
                };

                upsertInvoice.mutate(
                  { invoice: next, reason: trimmedReason },
                  {
                    onSuccess: () => {
                      setIsPaymentModalOpen(false);
                      setEditingPaymentId(null);
                      setPaymentError(null);
                      setPaymentReason('');
                      setPaymentForm({ date: '', amount: '', method: 'Überweisung' });
                    },
                  },
                );
              }}
              className="px-5 py-2.5 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
            >
              Speichern
            </button>
          </div>
        </div>
      </div>
      </Portal>
    );
  };

  const renderChainAmountDialog = () => {
    if (!chainAmountDialog) return null;
    const label = getInvoiceDocumentLabel(chainAmountDialog.action);
    return (
      <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-base/20 p-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="chain-amount-title"
          className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-6 py-5">
            <div>
              <h3 id="chain-amount-title" className="text-lg font-black text-gray-900">{label} erstellen</h3>
              <p className="mt-1 text-sm text-gray-500">Der Betrag wird als eigener, verknüpfter Beleg gespeichert.</p>
            </div>
            <button type="button" onClick={cancelChainAmount} className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200" aria-label="Dialog schließen">
              <X size={18} />
            </button>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); confirmChainAmount(); }}>
            <div className="space-y-2 p-6">
              <label htmlFor="chain-amount" className="block text-xs font-bold text-gray-500">Betrag (EUR)</label>
              <input
                id="chain-amount"
                autoFocus
                inputMode="decimal"
                value={chainAmountInput}
                onChange={(event) => { setChainAmountInput(event.target.value); setChainAmountError(null); }}
                aria-invalid={Boolean(chainAmountError)}
                aria-describedby={chainAmountError ? 'chain-amount-error' : undefined}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm outline-none focus:ring-2 focus:ring-accent"
              />
              {chainAmountError && <p id="chain-amount-error" role="alert" className="text-sm font-medium text-error">{chainAmountError}</p>}
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-100 bg-gray-50 p-6">
              <button type="button" onClick={cancelChainAmount} className="rounded-xl px-6 py-3 font-bold text-gray-500 hover:bg-gray-200">Abbrechen</button>
              <Button type="submit" size="md">{label} erstellen</Button>
            </div>
          </form>
        </div>
      </div>
      </Portal>
    );
  };

  const renderPaymentDeleteModal = () => {
    if (!isPaymentDeleteOpen) return null;

    return (
      <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-base/20 p-4 backdrop-blur-sm">
        <div className="w-full max-w-lg rounded-3xl bg-white shadow-xl p-6">
          <h3 className="text-lg font-black text-gray-900 mb-1">Zahlung löschen</h3>
          <p className="text-sm text-gray-500 mb-4">
            Die Zahlung wird entfernt. Bitte Begründung angeben (GoBD).
          </p>

          <label className="text-xs font-bold text-gray-700">Grund (Pflicht)</label>
          <textarea
            value={paymentDeleteReason}
            onChange={(e) => {
              setPaymentDeleteReason(e.target.value);
              if (paymentDeleteError) setPaymentDeleteError(null);
            }}
            rows={3}
            className="mt-2 w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-black"
            placeholder="z.B. falsch erfasst, Doppelbuchung, ..."
          />
          {paymentDeleteError && <div className="mt-2 text-sm font-bold text-error">{paymentDeleteError}</div>}

          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              className="px-5 py-2.5 rounded-xl font-bold bg-gray-100 text-gray-900 hover:bg-gray-200 transition-colors"
              onClick={() => {
                setIsPaymentDeleteOpen(false);
                setDeletingPaymentId(null);
                setPaymentDeleteReason('');
                setPaymentDeleteError(null);
              }}
            >
              Abbrechen
            </button>
            <button
              className="px-5 py-2.5 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
              onClick={() => {
                if (!selectedDocument || documentType !== 'invoice') return;
                if (!deletingPaymentId) return;

                const trimmed = paymentDeleteReason.trim();
                if (!trimmed) {
                  setPaymentDeleteError('Grund ist Pflicht.');
                  return;
                }

                const exists = (selectedDocument.payments ?? []).some((p) => p.id === deletingPaymentId);
                if (!exists) {
                  setPaymentDeleteError('Zahlung nicht gefunden. Bitte neu öffnen.');
                  return;
                }

                const next: Invoice = {
                  ...selectedDocument,
                  payments: (selectedDocument.payments ?? []).filter((p) => p.id !== deletingPaymentId),
                };

                upsertInvoice.mutate(
                  { invoice: next, reason: trimmed },
                  {
                    onSuccess: () => {
                      setIsPaymentDeleteOpen(false);
                      setDeletingPaymentId(null);
                      setPaymentDeleteReason('');
                      setPaymentDeleteError(null);
                    },
                  },
                );
              }}
            >
              Löschen
            </button>
          </div>
        </div>
      </div>
      </Portal>
    );
  };

  // --- Detail View ---
  if (viewMode === 'detail' && selectedDocument) {
      return (
          <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm animate-enter relative">

              {renderEmailModal()}
              {renderPaymentModal()}
              {renderPaymentDeleteModal()}
              {renderChainAmountDialog()}

              {/* Navigation & Title */}
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6 mb-8 border-b border-gray-100 pb-8">
                  <div className="flex items-start gap-4">
                      <button
                        onClick={() => setViewMode('list')}
                        className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-black hover:text-white transition-colors shrink-0"
                      >
                          <ArrowLeft size={18} />
                      </button>
                      <div>
                           <div className="flex items-center gap-3 mb-1">
                                <h1 className="text-3xl font-bold">
                                    {selectedDocument.number}
                                </h1>
                                {getDunningBadge(selectedDocument.dunningLevel)}
                           </div>
                           <div className="flex items-center gap-3">
                                <Badge status={selectedDocument.status} />
                                {documentType === 'offer' ? (
                                    <span className="bg-purple-100 text-purple-700 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">Angebot</span>
                                ) : (
                                    <span className="bg-gray-100 text-gray-700 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">
                                      {getInvoiceDocumentLabel(selectedDocument.documentKind)}
                                    </span>
                                )}
                           </div>
                      </div>
                  </div>

                  {/* Actions Toolbar — tiered: primary → secondary → overflow */}
                  <div className="flex flex-wrap items-center gap-2">
                      {/* Convert to Invoice — prominent CTA for accepted offers */}
                      {documentType === 'offer' && selectedDocument.shareDecision === 'accepted' && (
                        <>
                          <Button
                            onClick={() => handleCreateChainDocument('order_confirmation')}
                            size="md"
                            title="Auftragsbestätigung aus angenommenem Angebot erstellen"
                          >
                            <FileText size={16} />
                            Auftragsbestätigung
                          </Button>
                          <Button
                            onClick={handleConvertOfferToInvoice}
                            size="md"
                            title="Angebot in Rechnung umwandeln"
                          >
                            <ArrowRight size={16} />
                            In Rechnung umwandeln
                          </Button>
                          <div className="w-px h-6 bg-gray-200 mx-1" />
                        </>
                      )}

                      {documentType === 'invoice' && selectedDocument.documentKind === 'order_confirmation' && (
                        <>
                          <Button onClick={() => handleCreateChainDocument('delivery_note')} size="md" title="Lieferschein aus Auftragsbestätigung erstellen">
                            <FileText size={16} /> Lieferschein
                          </Button>
                          <Button onClick={() => handleCreateChainDocument('advance_invoice')} size="md" title="Abschlagsrechnung erstellen">
                            <Euro size={16} /> Abschlag
                          </Button>
                          <Button onClick={() => handleCreateChainDocument('partial_invoice')} size="md" title="Teilrechnung erstellen">
                            <Euro size={16} /> Teilrechnung
                          </Button>
                          <Button onClick={() => handleCreateChainDocument('final_invoice')} size="md" title="Schlussrechnung erstellen">
                            <CheckCircle size={16} /> Schlussrechnung
                          </Button>
                          <div className="w-px h-6 bg-gray-200 mx-1" />
                        </>
                      )}

                      {documentType === 'invoice' && isBillingDocumentKind(selectedDocument.documentKind) && selectedDocument.status !== 'draft' && (
                        <>
                          <Button onClick={() => handleCreateChainDocument('credit_note')} size="md" title="Gutschrift aus dieser Rechnung erstellen">
                            <ArrowLeft size={16} /> Gutschrift
                          </Button>
                          <Button onClick={() => handleCreateChainDocument('cancellation_invoice')} size="md" title="Stornorechnung aus dieser Rechnung erstellen">
                            <RefreshCw size={16} /> Storno
                          </Button>
                          <Button onClick={() => handleCreateChainDocument('revision')} size="md" title="Neue Revision aus dieser Rechnung erstellen">
                            <FileText size={16} /> Revision
                          </Button>
                          <div className="w-px h-6 bg-gray-200 mx-1" />
                        </>
                      )}

                      {/* PRIMARY: labeled action buttons */}
                      <button
                        onClick={() => onEditInvoice(selectedDocument, documentType)}
                        className="h-10 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full font-bold text-xs transition-colors flex items-center gap-2"
                      >
                        <Edit3 size={14} /> Bearbeiten
                      </button>
                      <Button onClick={handleOpenEmail} size="md">
                        <Mail size={16} /> Senden
                      </Button>
                      <button
                        onClick={handleDownloadPdf}
                        className="h-10 px-4 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full font-bold text-xs transition-colors flex items-center gap-2"
                        title="PDF herunterladen"
                      >
                        <Download size={14} /> PDF
                      </button>

                      {/* SECONDARY: icon buttons */}
                      <div className="w-px h-6 bg-gray-200 mx-1" />

                      {documentType === 'invoice' && selectedDocument.status === 'draft' && (
                        <button
                          onClick={handleFinalizeDraftInvoice}
                          className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                          title="Als gestellt markieren (Entwurf → Offen)"
                        >
                          <CheckCircle size={18} />
                        </button>
                      )}

                      {documentType === 'offer' && (
                        <>
                          {!selectedDocument.shareToken ? (
                            <button
                              onClick={handlePublishOffer}
                              className="h-10 px-3 bg-black text-accent rounded-full font-bold text-xs transition-colors flex items-center gap-1.5 hover:bg-gray-800"
                              title="Öffentlichen Link erzeugen"
                            >
                              <Link size={14} /> Veröffentlichen
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={async () => {
                                  if (!selectedDocument.shareToken) return;
                                  const baseUrl = settings.portal.baseUrl?.trim();
                                  if (!baseUrl) {
                                    notify('error', 'Portal-URL fehlt. Hinterlege sie in Einstellungen unter Portal.');
                                    return;
                                  }
                                  try {
                                    await navigator.clipboard.writeText(`${baseUrl.replace(/\/+$/, '')}/offers/${selectedDocument.shareToken}`);
                                    notify('success', 'Link kopiert!');
                                  } catch (error) {
                                    notify('error', `Kopieren fehlgeschlagen: ${String(error)}`);
                                  }
                                }}
                                className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                                title="Link kopieren"
                              >
                                <Link size={18} />
                              </button>
                              <button
                                onClick={handleOpenOfferLink}
                                className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                                title="Im Browser öffnen"
                              >
                                <ExternalLink size={18} />
                              </button>
                              <button
                                onClick={handleSyncOfferDecision}
                                className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                                title="Portal-Status synchronisieren"
                              >
                                <RefreshCw size={18} />
                              </button>
                            </>
                          )}
                        </>
                      )}

                      {/* OVERFLOW: rarely-used actions */}
                      <div ref={toolbarOverflowRef} className="relative">
                        <button
                          onClick={() => setIsToolbarOverflowOpen((v) => !v)}
                          className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                          title="Weitere Aktionen"
                        >
                          <MoreHorizontal size={18} />
                        </button>
                        {isToolbarOverflowOpen && (
                          <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-2xl shadow-xl p-1.5 z-50 min-w-[180px]">
                            <button
                              onClick={() => {
                                setIsToolbarOverflowOpen(false);
                                if (!selectedDocument) return;
                                void (async () => {
                                  try {
                                    notify('progress', 'PDF wird erstellt...');
                                    const res = await ipc.pdf.export({ kind: documentType, id: selectedDocument.id });
                                    await ipc.shell.openPath({ path: res.path });
                                    notify('success', 'PDF geöffnet');
                                  } catch (e) {
                                    notify('error', `PDF Fehler: ${String(e)}`);
                                  }
                                })();
                              }}
                              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-2 transition-colors"
                            >
                              <Printer size={14} /> Drucken / PDF öffnen
                            </button>
                            <button
                              onClick={() => { setIsToolbarOverflowOpen(false); handleSharePaymentLink(); }}
                              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-2 transition-colors"
                            >
                              <Share2 size={14} /> Zahlungslink kopieren
                            </button>
                          </div>
                        )}
                      </div>
                  </div>
              </div>

              {/* Main Content Layout */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">

                  {/* Left Column: Document Preview */}
                  <div className="xl:col-span-2 space-y-6">
                       <div className="bg-gray-50 rounded-[2rem] p-8 border border-gray-100 relative overflow-hidden">
                          {/* Visual Paper Edge Effect top */}
                          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-b from-gray-200/50 to-transparent opacity-50"></div>

                          {/* Meta Header */}
                          <div className="flex flex-col md:flex-row justify-between gap-8 mb-10 pb-8 border-b border-gray-200 border-dashed">
                              <div>
                                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                                      <User size={12}/> Empfänger
                                  </p>
                                  <p className="font-bold text-gray-900 text-lg">{selectedDocument.client}</p>
                                  <p className="text-sm text-gray-500 whitespace-pre-line leading-relaxed mt-1">
                                      {selectedDocument.clientAddress || selectedDocument.clientEmail}
                                  </p>
                              </div>
                              <div className="flex gap-8">
                                  <div>
                                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                                          <Calendar size={12}/> Datum
                                      </p>
                                      <p className="font-mono font-bold text-gray-900">{formatDate(selectedDocument.date)}</p>
                                  </div>
                                  <div>
                                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                                          <Clock size={12}/> {documentType === 'offer' ? 'Gültig bis' : 'Fällig'}
                                      </p>
                                      <p className={`font-mono font-bold ${selectedDocument.status === 'overdue' ? 'text-error' : 'text-gray-900'}`}>
                                          {formatDate(selectedDocument.dueDate)}
                                      </p>
                                  </div>
                              </div>
                          </div>

                          {/* Items Table */}
                          <div className="mb-8">
                              <table className="w-full">
                                  <thead>
                                      <tr className="text-[10px] font-bold text-gray-400 uppercase tracking-wider text-left border-b border-gray-200">
                                          <th className="pb-3 pl-2">Beschreibung</th>
                                          <th className="pb-3 text-right">Menge</th>
                                          <th className="pb-3 text-right">Einzel</th>
                                          <th className="pb-3 text-right pr-2">Gesamt</th>
                                      </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-200/50">
                                      {selectedDocument.items.map((item, i) => (
                                          <tr key={i} className="group hover:bg-white/50 transition-colors">
                                              <td className="py-4 pl-2 font-bold text-gray-900">{item.description}</td>
                                              <td className="py-4 text-right text-gray-500 font-mono text-sm">{item.quantity}</td>
                                              <td className="py-4 text-right text-gray-500 font-mono text-sm">{formatCurrency(item.price)}</td>
                                              <td className="py-4 text-right font-bold text-gray-900 font-mono pr-2">{formatCurrency(item.total)}</td>
                                          </tr>
                                      ))}
                                  </tbody>
                              </table>
                          </div>

                          {/* Totals & Notes */}
                          <div className="flex flex-col md:flex-row justify-between items-start gap-8 border-t border-gray-200 border-dashed pt-8">
                               <div className="flex-1">
                                   <p className="text-xs font-bold text-gray-900 mb-2">Hinweis</p>
                                   <p className="text-xs text-gray-500 leading-relaxed max-w-sm">
                                       Vielen Dank für Ihren Auftrag. Bitte überweisen Sie den fälligen Betrag innerhalb von 14 Tagen auf das unten angegebene Konto.
                                   </p>
                               </div>
                               <div className="w-full md:w-64 space-y-2">
                                   <div className="flex justify-between text-sm text-gray-500">
                                       <span>Netto</span>
                                       <span className="font-mono">{formatCurrency(selectedDocumentTax?.netAmount ?? 0)}</span>
                                   </div>
                                   <div className="flex justify-between text-sm text-gray-500">
                                       <span>USt {(selectedDocumentTax?.vatRateApplied ?? 0)}%</span>
                                       <span className="font-mono">{formatCurrency(selectedDocumentTax?.vatAmount ?? 0)}</span>
                                   </div>
                                   <div className="flex justify-between text-xl font-bold text-gray-900 border-t border-gray-200 pt-3 mt-1">
                                       <span>Gesamt</span>
                                       <span className="font-mono">{formatCurrency(selectedDocumentTax?.grossAmount ?? selectedDocument.amount)}</span>
                                   </div>
                               </div>
                          </div>
                       </div>
                  </div>

                  {/* Right Column: Sidebar */}
                  <div className="space-y-6">

                      {/* Shared document-chain/revision relationship */}
                      {selectedChain.length > 0 && (
                        <div
                          className="bg-gray-50 border border-gray-200 rounded-3xl p-6 shadow-sm"
                          data-testid="document-chain-panel"
                        >
                          <div className="flex items-start justify-between gap-3 mb-4">
                            <div>
                              <h4 className="font-bold text-sm text-gray-900 flex items-center gap-2">
                                <Link size={16} className="text-gray-400" /> Dokumentkette
                              </h4>
                              <p className="text-xs text-gray-500 mt-1">Auftrag, Abrechnung und Revisionen</p>
                            </div>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                              {selectedChain.length} Dokumente
                            </span>
                          </div>
                          <div className="space-y-2">
                            {selectedChain.map((document) => {
                              const isCurrent = document.id === selectedDocument.id;
                              const relationLabel = isCurrent
                                ? 'Aktuell'
                                : document.revisionOfId
                                  ? `Revision ${document.revisionNumber ?? ''}`.trim()
                                  : document.sourceDocumentId
                                    ? 'Aus Vorgänger'
                                    : 'Wurzel';
                              return (
                                <button
                                  key={document.id}
                                  type="button"
                                  data-testid={`document-chain-item-${document.id}`}
                                  onClick={() => setSelectedId(document.id)}
                                  className={`w-full text-left rounded-2xl border px-3 py-2.5 transition-colors ${
                                    isCurrent
                                      ? 'border-black bg-white shadow-sm'
                                      : 'border-gray-200 bg-white/60 hover:bg-white hover:border-gray-300'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-bold text-gray-900 truncate">
                                      {getInvoiceDocumentLabel(document.documentKind)} · {document.number}
                                    </span>
                                    <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400 shrink-0">
                                      {relationLabel}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2 mt-1 text-[10px] text-gray-500">
                                    <span>{formatDate(document.date)}</span>
                                    <span>{formatCurrency(document.amount)}</span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Status Card */}
                      <div className="bg-white border border-gray-100 rounded-3xl p-6 shadow-sm">
                          <h4 className="font-bold text-sm text-gray-900 mb-4 flex items-center gap-2">
                              <CheckCircle size={16} className="text-accent fill-black" /> Status
                          </h4>
                          {selectedDocument.status === 'overdue' && (
                              <div className="bg-error-bg rounded-xl p-4 mb-4 border border-error/30">
                                  <div className="flex items-start gap-3">
                                      <AlertTriangle size={18} className="text-error mt-0.5" />
                                      <div>
                                          <p className="text-xs font-bold text-error mb-1">Zahlung überfällig</p>
                                          <button
                                            onClick={handleCreateReminder}
                                            className="text-[10px] font-bold bg-white border border-error/30 text-error px-2 py-1 rounded hover:bg-error-bg transition-colors"
                                          >
                                              Mahnung erstellen
                                          </button>
                                      </div>
                                  </div>
                              </div>
                          )}
                          <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                               <div className={`w-2 h-2 rounded-full ${selectedDocument.status === 'paid' ? 'bg-success' : 'bg-gray-300'}`}></div>
                               {selectedDocument.status === 'paid'
                                 ? (() => {
                                     const lastPayment = (selectedDocument.payments ?? [])
                                       .slice()
                                       .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
                                     return lastPayment
                                       ? `Bezahlt am ${formatDate(lastPayment.date)}`
                                       : 'Bezahlt';
                                   })()
                                 : 'Noch nicht bezahlt'}
                          </div>
                          <div className="mt-3 border-t border-gray-100 pt-3">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Steuerbehandlung</p>
                            <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-xs font-bold text-gray-700">
                              <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                              {selectedTaxDefinition?.label ?? 'Regelbesteuerung'}
                            </div>
                            {selectedTaxExemptionReason && (
                              <p className="mt-2 text-xs text-gray-500 leading-relaxed">{selectedTaxExemptionReason}</p>
                            )}
                          </div>
                      </div>

                      {/* Payments (Invoices only) */}
                      {documentType === 'invoice' && (
                        <div className="bg-white border border-gray-100 rounded-3xl p-6 shadow-sm">
                          <div className="flex items-center justify-between mb-4">
                            <h4 className="font-bold text-sm text-gray-900 flex items-center gap-2">
                              <Euro size={16} className="text-gray-400" /> Zahlungen
                            </h4>
                            <button
                              onClick={() => {
                                const today = new Date().toISOString().split('T')[0] ?? '';
                                setEditingPaymentId(null);
                                setPaymentForm({ date: today, amount: '', method: 'Überweisung' });
                                setPaymentReason('Zahlung erfasst');
                                setPaymentError(null);
                                setIsPaymentModalOpen(true);
                              }}
                              className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-900 font-bold text-sm inline-flex items-center gap-2"
                            >
                              <Plus size={16} /> Zahlung
                            </button>
                          </div>

                          {(() => {
                            const paid = sumPayments(selectedDocument);
                            const grossAmount = Number(selectedDocumentTax?.grossAmount ?? selectedDocument.amount) || 0;
                            const remaining = Math.max(0, grossAmount - paid);
                            const pct =
                              grossAmount > 0
                                ? Math.min(1, paid / grossAmount)
                                : 0;

                            return (
                              <>
                                <div className="mb-4">
                                  <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                                    <span>Bezahlt</span>
                                    <span className="font-mono font-bold text-gray-900">{formatCurrency(paid)}</span>
                                  </div>
                                  <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                                    <div
                                      className="h-full bg-black"
                                      style={{ width: `${Math.round(pct * 100)}%` }}
                                    />
                                  </div>
                                  <div className="flex items-center justify-between text-xs text-gray-500 mt-2">
                                    <span>Noch offen</span>
                                    <span className="font-mono font-bold text-gray-900">{formatCurrency(remaining)}</span>
                                  </div>
                                </div>

                                {(selectedDocument.payments ?? []).length === 0 ? (
                                  <p className="text-xs text-gray-400">Noch keine Zahlungen erfasst.</p>
                                ) : (
                                  <div className="space-y-2">
                                    {(selectedDocument.payments ?? [])
                                      .slice()
                                      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
                                      .map((p) => (
                                        <div
                                          key={p.id}
                                          className="flex items-center justify-between p-3 bg-gray-50 rounded-2xl border border-gray-100"
                                        >
                                          <div>
                                            <p className="text-xs font-bold text-gray-900">{formatDate(p.date)}</p>
                                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wide">
                                              {p.method}
                                            </p>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <div className="font-mono font-bold text-gray-900 min-w-[120px] text-right">
                                              {formatCurrency(p.amount)}
                                            </div>
                                            <button
                                              onClick={() => {
                                                setEditingPaymentId(p.id);
                                                setPaymentForm({
                                                  date: p.date ?? '',
                                                  amount: String(p.amount ?? ''),
                                                  method: p.method ?? 'Überweisung',
                                                });
                                                setPaymentReason('');
                                                setPaymentError(null);
                                                setIsPaymentModalOpen(true);
                                              }}
                                              className="w-9 h-9 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 flex items-center justify-center"
                                              title="Bearbeiten"
                                            >
                                              <Edit3 size={16} className="text-gray-700" />
                                            </button>
                                            <button
                                              onClick={() => {
                                                setDeletingPaymentId(p.id);
                                                setPaymentDeleteReason('');
                                                setPaymentDeleteError(null);
                                                setIsPaymentDeleteOpen(true);
                                              }}
                                              className="w-9 h-9 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 flex items-center justify-center"
                                              title="Löschen"
                                            >
                                              <Trash2 size={16} className="text-gray-700" />
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}

                      {/* Internal Notes */}
                      <div className="bg-yellow-50/50 border border-yellow-100 rounded-3xl p-6">
                          <h4 className="font-bold text-sm text-gray-900 mb-3 flex items-center gap-2">
                              Interne Notiz
                          </h4>
                          <textarea
                              className="w-full bg-white border border-yellow-200 rounded-xl p-3 text-xs text-gray-600 outline-none resize-none focus:ring-2 focus:ring-yellow-300 transition-shadow"
                              rows={3}
                              placeholder="Notiz zu diesem Vorgang..."
                          />
                      </div>

                      {/* Timeline */}
                      <div className="bg-white border border-gray-100 rounded-3xl p-6 shadow-sm">
                          <h4 className="font-bold text-sm text-gray-900 mb-4 flex items-center gap-2">
                              <Clock size={16} className="text-gray-400" /> Verlauf
                          </h4>
                          <div className="space-y-4 relative pl-2 border-l border-gray-100 ml-1">
                              {selectedDocument.history && selectedDocument.history.length > 0 ? selectedDocument.history.map((h, i) => (
                                  <div key={i} className="pl-4 relative">
                                      <div className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-gray-300 border-2 border-white"></div>
                                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">{formatDate(h.date)}</p>
                                      <p className="text-xs font-medium text-gray-700">{h.action}</p>
                                  </div>
                              )) : (
                                <p className="text-xs text-gray-400 pl-4">Entwurf erstellt.</p>
                              )}
                          </div>
                      </div>
                  </div>

              </div>
          </div>
      );
  }

  // --- List View ---
  const renderBulkDeleteModal = () => {
    if (!isBulkDeleteOpen) return null;

    const count = selectedIds.size;

    return (
      <Portal>
      <div className="fixed inset-0 bg-dark-base/20 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div className="bg-white rounded-3xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col animate-scale-in">
          <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
            <div>
              <h3 className="text-lg font-black">Löschen bestätigen</h3>
              <p className="text-sm text-gray-500">{count} Einträge ausgewählt</p>
            </div>
            <button
              onClick={() => {
                setIsBulkDeleteOpen(false);
                setBulkDeleteReason('');
              }}
              className="p-2 hover:bg-gray-200 rounded-full transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <div className="bg-error-bg border border-error/30 rounded-2xl p-4 text-sm text-error">
              Diese Aktion kann nicht rückgängig gemacht werden. Es wird ein Audit-Eintrag geschrieben.
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">Grund (Pflicht)</label>
              <textarea
                value={bulkDeleteReason}
                onChange={(e) => setBulkDeleteReason(e.target.value)}
                rows={4}
                placeholder="z.B. Duplikat, Testdaten, Kunde hat storniert ..."
                className="w-full bg-gray-50 border border-gray-200 rounded-2xl p-4 text-sm outline-none focus:ring-2 focus:ring-accent resize-none"
              />
            </div>
          </div>

          <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-end gap-3">
            <button
              onClick={() => {
                setIsBulkDeleteOpen(false);
                setBulkDeleteReason('');
              }}
              className="px-4 py-2 bg-white border border-gray-200 text-black rounded-full text-xs font-bold hover:bg-gray-50 transition-colors"
              disabled={isBulkDeleting}
            >
              Abbrechen
            </button>
            <button
              onClick={() => {
                void (async () => {
                  const reason = bulkDeleteReason.trim();
                  if (!reason) return;

                  setIsBulkDeleting(true);
                  try {
                    const ids = Array.from(selectedIds);
                    notify('progress', `Lösche ${ids.length} Einträge...`);

                    for (const id of ids) {
                      if (documentType === 'invoice') await deleteInvoice.mutateAsync({ id, reason });
                      else await deleteOffer.mutateAsync({ id, reason });
                    }

                    clearSelection();
                    setIsBulkDeleteOpen(false);
                    setBulkDeleteReason('');

                    notify('success', `${ids.length} Einträge gelöscht`);
                  } catch (e) {
                    notify('error', `Löschen fehlgeschlagen: ${String(e)}`);
                  } finally {
                    setIsBulkDeleting(false);
                  }
                })();
              }}
              disabled={isBulkDeleting || bulkDeleteReason.trim().length === 0}
              className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              <Trash2 size={16} /> Löschen
            </button>
          </div>
        </div>
      </div>
      </Portal>
    );
  };

  const handleBulkExport = (opts: { openFolderAfter?: boolean }) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    void (async () => {
      try {
        notify('progress', `PDFs werden erstellt (0/${ids.length})...`);

        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          await ipc.pdf.export({ kind: documentType, id });
          notify('progress', `PDFs werden erstellt (${i + 1}/${ids.length})...`);
        }

        notify('success', `PDFs erstellt: ${ids.length}`);
        if (opts.openFolderAfter) {
          await ipc.shell.openExportsDir();
        }
      } catch (e) {
        notify('error', `PDF Fehler: ${String(e)}`);
      }
    })();
  };

  return (
    <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm flex flex-col relative animate-enter">
      {renderDunningModal()}
      {renderEmailModal()}
      {renderPaymentModal()}
      {renderPaymentDeleteModal()}
      {renderBulkDeleteModal()}
      {renderChainAmountDialog()}
      {reminderConfirmation && (
        <ConfirmDialog
          open
          title="Mahnung erstellen"
          description={`${reminderConfirmation.levelName} erstellen für ${reminderConfirmation.invoiceNumber}? Gebühr: ${formatCurrency(reminderConfirmation.fee)}`}
          confirmLabel="Erstellen"
          onConfirm={() => void handleConfirmReminder()}
          onCancel={() => setReminderConfirmation(null)}
          busy={isCreatingReminder}
        />
      )}

       <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
           {/* Document Type Dropdown */}
           <div className="relative">
                <button
                    onClick={() => setIsTypeDropdownOpen(!isTypeDropdownOpen)}
                    className="flex items-center gap-2 text-3xl font-bold text-gray-900 hover:opacity-70 transition-opacity"
                >
                    {documentType === 'invoice' ? 'Rechnungen' : 'Angebote'}
                    <ChevronDown size={28} className={`transition-transform duration-300 ${isTypeDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {isTypeDropdownOpen && (
                    <div className="absolute top-full left-0 mt-2 w-56 bg-white rounded-2xl shadow-xl border border-gray-100 p-2 z-50 animate-in fade-in zoom-in-95 duration-200">
                        <button
                            onClick={() => switchDocumentType('invoice')}
                            className={`w-full text-left px-4 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-between ${documentType === 'invoice' ? 'bg-black text-white' : 'hover:bg-gray-50 text-gray-700'}`}
                        >
                            Rechnungen
                            {documentType === 'invoice' && <Check size={16} />}
                        </button>
                        <button
                            onClick={() => switchDocumentType('offer')}
                            className={`w-full text-left px-4 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-between ${documentType === 'offer' ? 'bg-black text-white' : 'hover:bg-gray-50 text-gray-700'}`}
                        >
                            Angebote
                            {documentType === 'offer' && <Check size={16} />}
                        </button>
                    </div>
                )}
           </div>

           <div className="flex gap-2">
                {(['all', 'open', 'paid', 'overdue'] as const).map(s => {
                    const labels: Record<string, string> = { all: 'Alle', open: 'Offen', paid: 'Bezahlt', overdue: 'Überfällig' };
                    return (
                        <button
                            key={s}
                            onClick={() => setFilter(s)}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${filter === s ? 'bg-black text-white shadow-lg' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                        >
                            {labels[s]}
                        </button>
                    );
                })}
           </div>
        </div>

        {/* Action Header Area */}
        <div className="flex gap-3 items-center">
           {filter === 'overdue' && overdueInvoices.length > 0 && (
               <button
                  onClick={handleStartDunningRun}
                  className="bg-error-bg text-error border border-error/30 px-4 py-3 rounded-full font-bold text-sm hover:bg-error-bg/80 transition-colors flex items-center gap-2 mr-2 animate-in slide-in-from-right-4"
               >
                   <Gavel size={16} />
                   Mahnlauf starten ({overdueInvoices.length})
               </button>
           )}

           <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input
                    type="text"
                    placeholder="Suchen..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-12 pr-6 py-3 bg-gray-50 border-none rounded-full text-sm font-bold outline-none w-64 focus:ring-2 focus:ring-accent transition-all"
                />
           </div>

           <button
             onClick={onOpenTemplates}
             className="px-4 py-3 rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition-colors font-bold text-sm flex items-center gap-2"
             title="Vorlagen verwalten"
           >
             <LayoutTemplate size={18} />
             Vorlagen
           </button>

           <button
             onClick={onOpenRecurring}
             className="px-4 py-3 rounded-full bg-gray-100 text-gray-800 hover:bg-gray-200 transition-colors font-bold text-sm flex items-center gap-2"
             title="Abos / Serien-Dokumente"
           >
             <RefreshCw size={18} />
             Abos
           </button>
           <button
             onClick={() => onCreateInvoice(documentType)}
             className="w-12 h-12 bg-accent text-accent-foreground rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all shadow-lg hover:bg-accent-hover"
             title={documentType === 'invoice' ? "Neue Rechnung" : "Neues Angebot"}
           >
             <Plus size={24} />
           </button>
         </div>
       </div>

       {isSelecting && (
         <div className="mb-5 bg-black text-white rounded-3xl px-5 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 shadow-xl">
           <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center font-bold text-xs">
               {selectedIds.size}
             </div>
             <div className="font-bold">
               Auswahl aktiv
               <span className="ml-2 text-xs font-bold text-white/60">
                 ({documentType === 'invoice' ? 'Rechnungen' : 'Angebote'})
               </span>
             </div>
           </div>
           <div className="flex flex-wrap items-center gap-2">
             <button
               onClick={toggleSelectAllFiltered}
               className="h-10 px-4 bg-white/10 hover:bg-white/15 border border-white/15 rounded-full text-xs font-bold transition-colors"
               title="Alle in der aktuellen Liste auswählen"
             >
               Alle auswählen
             </button>
             <button
               onClick={clearSelection}
               className="h-10 px-4 bg-white/10 hover:bg-white/15 border border-white/15 rounded-full text-xs font-bold transition-colors"
             >
               Aufheben
             </button>
             <div className="w-px h-6 bg-white/15 mx-1"></div>
             <button
               onClick={() => handleBulkExport({ openFolderAfter: false })}
               className="h-10 px-4 bg-white rounded-full text-xs font-bold text-black hover:bg-gray-100 transition-colors flex items-center gap-2"
               title="PDFs exportieren (in App-Exports)"
             >
               <Download size={16} /> Export
             </button>
             <Button
               onClick={() => handleBulkExport({ openFolderAfter: true })}
               size="sm"
               title="PDFs erstellen und Export-Ordner öffnen"
             >
               <Printer size={16} /> Drucken
             </Button>
             <button
               onClick={() => setIsBulkDeleteOpen(true)}
               className="h-10 px-4 bg-error text-white rounded-full text-xs font-bold hover:bg-error/90 transition-colors flex items-center gap-2"
               title="Ausgewählte Einträge löschen"
             >
               <Trash2 size={16} /> Löschen
             </button>
           </div>
         </div>
       )}

       <div className="space-y-3 flex-1 overflow-y-auto pt-2 px-1 -mx-1">
           {isLoading ? (
             <SkeletonLoader variant="list" count={5} />
           ) : filteredDocuments.length > 0 ? filteredDocuments.map((doc, idx) => (
               <div
                 key={doc.id}
                 onClick={() => {
                   if (isSelecting) toggleSelected(doc.id);
                   else handleOpenDetail(doc.id);
                 }}
                 className={`group flex items-center gap-4 p-4 rounded-3xl border hover:shadow-xl hover:-translate-y-1 transition-all cursor-pointer relative animate-enter ${
                   selectedIds.has(doc.id)
                     ? 'border-black bg-gray-50'
                     : 'border-gray-100 hover:border-black bg-white'
                 }`}
                 style={{ animationDelay: `${idx * 50}ms` }}
               >
                   <button
                     onClick={(e) => {
                       e.stopPropagation();
                       toggleSelected(doc.id);
                     }}
                     className="shrink-0"
                     title={selectedIds.has(doc.id) ? 'Auswahl entfernen' : 'Auswählen'}
                   >
                     <div
                       className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                         selectedIds.has(doc.id)
                           ? 'bg-black border-black text-accent'
                           : 'border-gray-300 bg-white group-hover:border-black/40'
                       }`}
                     >
                       {selectedIds.has(doc.id) && <Check size={12} />}
                     </div>
                   </button>
                   {/* Flex Column 1: Info (Flex 1 to take remaining space) */}
                   <div className="flex-1 flex items-center gap-4 min-w-0">
                       <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-gray-400 group-hover:text-accent group-hover:bg-black transition-colors shrink-0 ${documentType === 'offer' ? 'bg-purple-50 text-purple-400' : 'bg-gray-50'}`}>
                           <FileText size={20} />
                      </div>
                      <div className="min-w-0">
                          <p className="font-bold text-lg text-gray-900 flex items-center gap-2 flex-wrap">
                              <span className="truncate">{doc.number}</span>
                              {getDunningBadge(doc.dunningLevel)}
                          </p>
                          <p className="text-xs font-bold text-gray-400 truncate">
                            {documentType === 'offer' ? 'Angebot' : getInvoiceDocumentLabel(doc.documentKind)} · {doc.client}
                          </p>
                      </div>
                  </div>

                  {/* Flex Column 2: Date (Fixed Width) */}
                  <div className="hidden md:block w-32 text-right shrink-0">
                      <p className="text-xs font-bold text-gray-400 uppercase">Datum</p>
                      <p className="text-sm font-bold">{formatDate(doc.date)}</p>
                  </div>

                  {/* Flex Column 3: Due Date (Fixed Width) */}
                  <div className="hidden md:block w-32 text-right shrink-0">
                      <p className="text-xs font-bold text-gray-400 uppercase">{documentType === 'offer' ? 'Gültig bis' : 'Fällig'}</p>
                      <p className={`text-sm font-bold ${doc.status === 'overdue' ? 'text-error' : ''}`}>{formatDate(doc.dueDate)}</p>
                  </div>

                  {/* Flex Column 4: Amount (Fixed Width) */}
                  <div className="w-32 text-right shrink-0">
                      <p className="text-lg font-mono font-bold truncate">{formatCurrency(doc.amount)}</p>
                  </div>

                  {/* Flex Column 5: Status (Fixed Width) */}
                  <div className="w-28 flex justify-end shrink-0">
                      <Badge status={doc.status} />
                  </div>

                  {/* Flex Column 6: Arrow (Fixed Width) */}
                  <div className="w-10 flex justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-2 hover:bg-gray-100 rounded-full" onClick={(e) => {
                        e.stopPropagation();
                        onEditInvoice(doc, documentType);
                      }}>
                          <ArrowUpRight size={18} />
                      </button>
                  </div>
              </div>
          )) : (
              <div className="flex flex-col items-center justify-center h-64 text-gray-400">
                  <FileText size={48} className="mb-4 opacity-20" />
                  <p className="font-bold text-gray-500">
                    {searchTerm || filter !== 'all'
                      ? `Keine Treffer für die aktuelle Suche oder Filterung`
                      : `Noch keine ${documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} vorhanden`}
                  </p>
                  {!searchTerm && filter === 'all' && (
                    <p className="text-sm mt-1">Klicke auf das + oben rechts, um {documentType === 'invoice' ? 'eine Rechnung' : 'ein Angebot'} zu erstellen.</p>
                  )}
              </div>
          )}
      </div>
    </div>
  );
};
