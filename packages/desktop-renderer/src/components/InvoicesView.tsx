import React, { useState } from 'react';
import {
  Search, Plus, FileText,
  Clock, ArrowLeft,
  Share2, Check,
  ChevronDown, ArrowUpRight,
  AlertTriangle, Mail, Gavel, CheckCircle, X,
  Download, Printer, Send, Paperclip, MoreHorizontal, Calendar, User, RefreshCw, Link, ExternalLink, Trash2, LayoutTemplate, Edit3, Euro, ArrowRight
} from 'lucide-react';
import { Badge, Button, ConfirmDialog, EMPTY_VALUE, EmptyState, ErrorState, Modal, formatEmptyValue, useActionFeedback } from '@billme/ui';
import {
  getInvoiceDocumentLabel,
  isBillingDocumentKind,
  type Invoice,
  type InvoiceStatus,
} from '@billme/desktop-core/types';
import { useDeleteInvoiceMutation, useInvoicesQuery, useUpsertInvoiceMutation } from '../hooks/useInvoices';
import { useDeleteOfferMutation, useOffersQuery, useUpsertOfferMutation } from '../hooks/useOffers';
import { useSettingsQuery } from '../hooks/useSettings';
import { formatDocumentHistoryAction } from '../documentHistory';
import { getRendererRuntime, ipc } from '../runtime-api';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { SkeletonLoader } from '@billme/desktop-ui/components/SkeletonLoader';
import {
  calculateDaysOverdue,
  calculateInvoiceTaxSnapshot,
  determineDunningLevel,
  getInvoiceTaxExemptionReason,
  getInvoiceTaxModeDefinition,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';

const NOTE_PREFIX = 'Notiz: ';

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

const formatDate = (dateString: string) => {
  if (!dateString) return EMPTY_VALUE;
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

// Documents without a linked client carry the literal "Unbekannt"; treat it as no value.
const MISSING_COUNTERPARTY = 'Unbekannt';

const getDunningBadge = (level: number | undefined) => {
    if (!level || level === 0) return null;
    let label = '';
    let colorClass = '';
    switch(level) {
        case 1:
            label = '1. Mahnung';
            colorClass = 'bg-warning-bg text-warning-text border-warning-border';
            break;
        case 2:
            label = '2. Mahnung';
            colorClass = 'bg-error-bg text-error-text border-error-border';
            break;
        case 3:
            label = 'Inkasso';
            colorClass = 'bg-dark-base text-background border-dark-base';
            break;
        default:
            return null;
    }
    return <span className={`px-2 py-1 rounded-sm text-xs font-bold border ${colorClass} uppercase tracking-wide flex items-center gap-1 whitespace-nowrap`}>
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
  const [isDunningProcessing, setIsDunningProcessing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
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
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsToolbarOverflowOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [isToolbarOverflowOpen]);

  const typeDropdownRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!isTypeDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (typeDropdownRef.current && !typeDropdownRef.current.contains(e.target as Node)) {
        setIsTypeDropdownOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsTypeDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [isTypeDropdownOpen]);

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
  const {
    data: invoices = [],
    isLoading: isLoadingInvoices,
    isError: isInvoicesError,
    refetch: refetchInvoices,
  } = useInvoicesQuery();
  const upsertInvoice = useUpsertInvoiceMutation();
  const deleteInvoice = useDeleteInvoiceMutation();
  const {
    data: offers = [],
    isLoading: isLoadingOffers,
    isError: isOffersError,
    refetch: refetchOffers,
  } = useOffersQuery();
  const upsertOffer = useUpsertOfferMutation();
  const deleteOffer = useDeleteOfferMutation();
  const {
    data: settings,
    isError: isSettingsError,
    refetch: refetchSettings,
  } = useSettingsQuery();
  const { notify } = useActionFeedback('documents');
  const currentData = documentType === 'invoice' ? invoices : offers;
  const isLoading = documentType === 'invoice' ? isLoadingInvoices : isLoadingOffers;
  const isCurrentDataError = documentType === 'invoice' ? isInvoicesError : isOffersError;
  const refetchCurrentData = () => {
    if (documentType === 'invoice') void refetchInvoices();
    else void refetchOffers();
  };

  // Company identity, dunning levels and the portal base URL all come from the
  // user's settings. Until they are loaded nothing is rendered from a stand-in.
  const dunningSettings = settings?.dunning;
  const portalSettings = settings?.portal;

  const selectedDocument = currentData.find(i => i.id === selectedId);
  React.useEffect(() => setNoteDraft(''), [selectedId]);
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
    selectedDocument && settings
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
  const selectedTaxDefinition = selectedDocument && settings
    ? getInvoiceTaxModeDefinition(resolveInvoiceTaxMode(selectedDocument.taxMode, settings))
    : null;
  const selectedTaxExemptionReason = selectedDocument && settings
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
  // Mirrors the level choice of the shared dunning engine, which sends the run.
  // Runs only once the user's dunning levels are loaded, never on defaults.
  const dunningLevels = dunningSettings?.levels ?? [];
  const dunningPreview = dunningLevels.length > 0
    ? overdueInvoices.map((inv) => {
        const level = determineDunningLevel(calculateDaysOverdue(inv.dueDate), dunningLevels);
        return { inv, level, due: Boolean(level) && (inv.dunningLevel ?? 0) < (level?.id ?? 0) };
      })
    : [];
  const dueDunningCount = dunningPreview.filter((entry) => entry.due).length;

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

    const paymentBaseUrl = portalSettings?.baseUrl?.trim();
    if (!paymentBaseUrl) {
      notify('error', 'Portal-URL fehlt. Hinterlege sie in Einstellungen unter Portal.');
      return;
    }
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
    const baseUrl = portalSettings?.baseUrl?.trim();
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
      const companyName = settings?.company?.name?.trim() || 'Ihr Unternehmen';
      const contactPerson = settings?.company?.owner?.trim();
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
      setIsDunningModalOpen(true);
  };

  const handleProcessDunningRun = async () => {
      if (isDunningProcessing) return;
      setIsDunningProcessing(true);
      try {
        const response = await ipc.dunning.manualRun();
        await queryClient.invalidateQueries({ queryKey: ['invoices'] });
        if (!response.success || !response.result) {
          notify('error', `Mahnlauf fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
          return;
        }
        const { emailsSent, feesApplied, errors } = response.result;
        setIsDunningModalOpen(false);
        const summary = `${emailsSent} ${emailsSent === 1 ? 'Mahnung' : 'Mahnungen'} per E-Mail versendet`
          + (feesApplied > 0 ? ` · ${formatCurrency(feesApplied)} Mahngebühren` : '');
        notify(
          errors.length > 0 ? 'error' : 'success',
          errors.length > 0
            ? `${summary} · ${errors.length} fehlgeschlagen (${errors[0]?.invoiceNumber}: ${errors[0]?.error})`
            : summary,
        );
      } catch (error) {
        notify('error', `Mahnlauf fehlgeschlagen: ${String(error)}`);
      } finally {
        setIsDunningProcessing(false);
      }
  };

  const handleAddNote = () => {
      const text = noteDraft.trim();
      if (!selectedDocument || !text) return;
      // Server-backed runtimes rebuild the timeline from the audit log
      // ("action (reason)"), so the note travels as the audit reason. The local
      // history entry keeps runtimes that store history as-is in step.
      const reason = `${NOTE_PREFIX}${text}`;
      const history = [
        { date: new Date().toISOString().split('T')[0] ?? '', action: reason },
        ...(selectedDocument.history ?? []),
      ];
      const onSuccess = () => {
        setNoteDraft('');
        notify('success', 'Notiz im Verlauf gespeichert.');
      };
      const onError = (error: unknown) => notify('error', `Notiz konnte nicht gespeichert werden: ${String(error)}`);
      if (documentType === 'invoice') {
        upsertInvoice.mutate({ invoice: { ...selectedDocument, history }, reason }, { onSuccess, onError });
      } else {
        upsertOffer.mutate({ offer: { ...selectedDocument, history }, reason }, { onSuccess, onError });
      }
  };

  const handleCreateReminder = () => {
      if (!selectedDocument || documentType !== 'invoice') return;
      const currentLevel = selectedDocument.dunningLevel || 0;
      const nextLevel = Math.min(currentLevel + 1, 3);
      const levelConfig = dunningLevels.find(l => l.id === nextLevel);
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
  const renderDunningModal = () => (
      <Modal
        open={isDunningModalOpen}
        onClose={() => setIsDunningModalOpen(false)}
        titleId="dunning-modal-title"
        descriptionId="dunning-modal-description"
        ariaBusy={isDunningProcessing}
        className="max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
          <div className="p-6 border-b border-border flex justify-between items-center bg-surface-muted">
              <div>
                <h3 id="dunning-modal-title" className="text-xl font-black">Mahnlauf starten</h3>
                <p id="dunning-modal-description" className="text-sm text-muted tabular-nums">{dueDunningCount} von {overdueInvoices.length} überfälligen Rechnungen erreichen eine neue Mahnstufe</p>
              </div>
              <button
                type="button"
                onClick={() => setIsDunningModalOpen(false)}
                aria-label="Dialog schließen"
                className="p-2 hover:bg-border-subtle rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <X size={20}/>
              </button>
          </div>

          <div className="p-6 overflow-y-auto flex-1 space-y-3">
               {!settings?.automation.dunningEnabled && (
                   <p role="alert" className="p-4 rounded-xl bg-warning-bg text-warning-text text-sm">
                       Das Mahnwesen ist ausgeschaltet. Schalte es unter Einstellungen › Mahnwesen ein, dann versendet der Mahnlauf die Mahnungen per E-Mail.
                   </p>
               )}
               {dunningPreview.map(({ inv, level, due }) => (
                   <div key={inv.id} className={`p-4 rounded-xl border-2 ${due ? 'border-foreground bg-surface-muted' : 'border-border bg-white'}`}>
                       <div className="flex justify-between items-center mb-2">
                           <div className="flex items-center gap-3">
                                <span className="font-bold">{inv.number}</span>
                                <span className="text-sm text-muted">{inv.client}</span>
                           </div>
                           <span className="font-bold tabular-nums">{formatCurrency(inv.amount)}</span>
                       </div>
                       <div className="flex flex-wrap items-center gap-2 text-xs">
                           <span className="bg-error-bg text-error-text px-2 py-1 rounded-sm font-bold tabular-nums">Fällig seit {new Date(inv.dueDate).toLocaleDateString('de-DE')}</span>
                           {due && level ? (
                             <span className="bg-dark-base text-background px-2 py-1 rounded-sm font-bold">{level.name}{level.fee > 0 ? ` (+${formatCurrency(level.fee)})` : ''} an {inv.clientEmail || 'keine E-Mail-Adresse'}</span>
                           ) : (
                             <span className="text-muted">{level ? `${level.name} bereits versendet` : 'Noch keine Mahnstufe erreicht'}</span>
                           )}
                       </div>
                   </div>
               ))}
               {overdueInvoices.length === 0 && (
                   <EmptyState
                     className="rounded-xl bg-surface-muted border-0"
                     title="Keine überfälligen Rechnungen"
                     description="Der Mahnlauf kann nur Rechnungen anmahnen, deren Fälligkeit überschritten ist."
                   />
               )}
          </div>

          <div className="p-6 border-t border-border bg-surface-muted flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setIsDunningModalOpen(false)}>
                Abbrechen
              </Button>
              <Button
                onClick={() => void handleProcessDunningRun()}
                disabled={dueDunningCount === 0 || !settings?.automation.dunningEnabled || isDunningProcessing}
                size="md"
              >
                  {isDunningProcessing ? 'Wird gesendet ...' : `${dueDunningCount} ${dueDunningCount === 1 ? 'Mahnung' : 'Mahnungen'} per E-Mail senden`}
              </Button>
          </div>
      </Modal>
  );

  // --- Email Modal ---
  const renderEmailModal = () => (
    <Modal
      open={isEmailModalOpen}
      onClose={() => setIsEmailModalOpen(false)}
      titleId="email-modal-title"
      className="max-w-lg overflow-hidden flex flex-col"
    >
        <div className="p-6 border-b border-border flex justify-between items-center bg-surface-muted">
            <h3 id="email-modal-title" className="text-lg font-black flex items-center gap-2"><Mail size={18}/> Per E-Mail senden</h3>
            <button
              type="button"
              onClick={() => setIsEmailModalOpen(false)}
              aria-label="Dialog schließen"
              className="p-2 hover:bg-border-subtle rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <X size={18}/>
            </button>
        </div>
        <div className="p-6 space-y-4">
            <div>
                <label htmlFor="email-recipient" className="block text-xs font-bold text-muted mb-1">Empfänger</label>
                <input
                    id="email-recipient"
                    type="email"
                    value={emailData.to}
                    onChange={e => setEmailData({...emailData, to: e.target.value})}
                    className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
            </div>
            <div>
                <label htmlFor="email-subject" className="block text-xs font-bold text-muted mb-1">Betreff</label>
                <input
                    id="email-subject"
                    type="text"
                    value={emailData.subject}
                    onChange={e => setEmailData({...emailData, subject: e.target.value})}
                    className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
            </div>
            <div>
                <label htmlFor="email-message" className="block text-xs font-bold text-muted mb-1">Nachricht</label>
                <textarea
                    id="email-message"
                    rows={6}
                    value={emailData.message}
                    onChange={e => setEmailData({...emailData, message: e.target.value})}
                    className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
                />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted bg-surface-muted p-3 rounded-lg border border-border">
                <Paperclip size={14} />
                <span>Angehängt: {selectedDocument?.number}.pdf</span>
            </div>
        </div>
        <div className="p-6 border-t border-border bg-surface-muted flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setIsEmailModalOpen(false)}>Abbrechen</Button>
            <Button onClick={handleSendEmail} size="md">
                <Send size={16} /> Senden
            </Button>
        </div>
    </Modal>
  );

  const renderPaymentModal = () => {
    const closePaymentModal = () => {
      setIsPaymentModalOpen(false);
      setEditingPaymentId(null);
      setPaymentError(null);
    };

    return (
      <Modal
        open={isPaymentModalOpen}
        onClose={closePaymentModal}
        titleId="payment-modal-title"
        descriptionId="payment-modal-description"
        className="max-w-lg overflow-hidden"
      >
          <div className="flex items-center justify-between px-6 py-5 border-b border-border">
            <div>
              <h3 id="payment-modal-title" className="text-lg font-black text-foreground">
                {editingPaymentId ? 'Zahlung bearbeiten' : 'Zahlung erfassen'}
              </h3>
              <p id="payment-modal-description" className="text-sm text-muted mt-1">Wird im Audit-Log gespeichert (GoBD).</p>
            </div>
            <button
              type="button"
              onClick={closePaymentModal}
              className="w-10 h-10 rounded-full bg-surface-muted hover:bg-border-subtle flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              aria-label="Dialog schließen"
            >
              <X size={18} />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="invoicesview-datum">Datum</label>
                <input id="invoicesview-datum"
                  type="date"
                  value={paymentForm.date}
                  onChange={(e) => setPaymentForm((p) => ({ ...p, date: e.target.value }))}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="invoicesview-betrag-eur">Betrag (EUR)</label>
                <input id="invoicesview-betrag-eur"
                  inputMode="decimal"
                  value={paymentForm.amount}
                  onChange={(e) => setPaymentForm((p) => ({ ...p, amount: e.target.value }))}
                  placeholder="z.B. 250,00"
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-muted mb-1" htmlFor="invoicesview-methode">Methode</label>
              <select id="invoicesview-methode"
                value={paymentForm.method}
                onChange={(e) => setPaymentForm((p) => ({ ...p, method: e.target.value }))}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <option value="Überweisung">Überweisung</option>
                <option value="PayPal">PayPal</option>
                <option value="Karte">Karte</option>
                <option value="Bar">Bar</option>
                <option value="Sonstiges">Sonstiges</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-muted mb-1" htmlFor="invoicesview-grund-pflicht">Grund (Pflicht)</label>
              <textarea id="invoicesview-grund-pflicht"
                value={paymentReason}
                onChange={(e) => {
                  setPaymentReason(e.target.value);
                  if (paymentError) setPaymentError(null);
                }}
                rows={3}
                placeholder="z.B. Zahlungseingang Kontoauszug, Teilzahlung, ..."
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
              />
            </div>

            {paymentError && <div className="text-sm font-bold text-error-text">{paymentError}</div>}
          </div>

          <div className="px-6 py-5 border-t border-border flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={closePaymentModal}>
              Abbrechen
            </Button>
            <Button
              variant="dark"
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
            >
              Speichern
            </Button>
          </div>
      </Modal>
    );
  };

  const renderChainAmountDialog = () => {
    const label = chainAmountDialog ? getInvoiceDocumentLabel(chainAmountDialog.action) : '';
    return (
      <Modal
        open={Boolean(chainAmountDialog)}
        onClose={cancelChainAmount}
        titleId="chain-amount-title"
        descriptionId="chain-amount-description"
        className="max-w-md overflow-hidden"
      >
          <div className="flex items-center justify-between border-b border-border px-6 py-5">
            <div>
              <h3 id="chain-amount-title" className="text-lg font-black text-foreground">{label} erstellen</h3>
              <p id="chain-amount-description" className="mt-1 text-sm text-muted">Der Betrag wird als eigener, verknüpfter Beleg gespeichert.</p>
            </div>
            <button type="button" onClick={cancelChainAmount} className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted hover:bg-border-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" aria-label="Dialog schließen">
              <X size={18} />
            </button>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); confirmChainAmount(); }}>
            <div className="space-y-2 p-6">
              <label htmlFor="chain-amount" className="block text-xs font-bold text-muted">Betrag (EUR)</label>
              <input
                id="chain-amount"
                autoFocus
                inputMode="decimal"
                value={chainAmountInput}
                onChange={(event) => { setChainAmountInput(event.target.value); setChainAmountError(null); }}
                aria-invalid={Boolean(chainAmountError)}
                aria-describedby={chainAmountError ? 'chain-amount-error' : undefined}
                className="w-full rounded-xl border border-control-border bg-surface-muted p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              />
              {chainAmountError && <p id="chain-amount-error" role="alert" className="text-sm font-medium text-error-text">{chainAmountError}</p>}
            </div>
            <div className="flex justify-end gap-3 border-t border-border bg-surface-muted p-6">
              <Button variant="secondary" type="button" onClick={cancelChainAmount}>Abbrechen</Button>
              <Button type="submit" size="md">{label} erstellen</Button>
            </div>
          </form>
      </Modal>
    );
  };

  const renderPaymentDeleteModal = () => {
    const closePaymentDelete = () => {
      setIsPaymentDeleteOpen(false);
      setDeletingPaymentId(null);
      setPaymentDeleteReason('');
      setPaymentDeleteError(null);
    };

    return (
      <Modal
        open={isPaymentDeleteOpen}
        onClose={closePaymentDelete}
        titleId="payment-delete-title"
        descriptionId="payment-delete-description"
        className="max-w-lg p-6"
      >
          <h3 id="payment-delete-title" className="text-lg font-black text-foreground mb-1">Zahlung löschen</h3>
          <p id="payment-delete-description" className="text-sm text-muted mb-4">
            Die Zahlung wird entfernt. Bitte Begründung angeben (GoBD).
          </p>

          <label htmlFor="payment-delete-reason" className="text-xs font-bold text-muted">Grund (Pflicht)</label>
          <textarea
            id="payment-delete-reason"
            value={paymentDeleteReason}
            onChange={(e) => {
              setPaymentDeleteReason(e.target.value);
              if (paymentDeleteError) setPaymentDeleteError(null);
            }}
            rows={3}
            className="mt-2 w-full rounded-2xl border border-control-border bg-surface-muted px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            placeholder="z.B. falsch erfasst, Doppelbuchung, ..."
          />
          {paymentDeleteError && <div className="mt-2 text-sm font-bold text-error-text">{paymentDeleteError}</div>}

          <div className="mt-6 flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={closePaymentDelete}>
              Abbrechen
            </Button>
            <Button
              variant="danger"
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
            </Button>
          </div>
      </Modal>
    );
  };

  const renderSettingsGate = () => (
    <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm flex flex-col">
      {isSettingsError ? (
        <ErrorState
          title="Einstellungen konnten nicht geladen werden"
          description="Steuersätze, Mahnstufen und Unternehmensdaten kommen aus den Einstellungen. Ohne sie können Rechnungen nicht korrekt berechnet werden."
          onRetry={() => void refetchSettings()}
        />
      ) : (
        <SkeletonLoader variant="list" count={5} />
      )}
    </div>
  );

  // --- Detail View ---
  // Settings carry the company identity and the tax rules, so the view waits for
  // them instead of falling back to stand-in values. Already loaded settings stay
  // usable even if a later refetch fails.
  if (!settings) {
      return renderSettingsGate();
  }

  if (viewMode === 'detail' && selectedDocument) {
      return (
          <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm relative">

              {renderEmailModal()}
              {renderPaymentModal()}
              {renderPaymentDeleteModal()}
              {renderChainAmountDialog()}

              {/* Navigation & Title */}
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6 mb-8 border-b border-border pb-8">
                  <div className="flex items-start gap-4">
                      <button
                        onClick={() => setViewMode('list')}
                        aria-label="Zurück zur Liste"
                        className="w-10 h-10 rounded-full border border-control-border flex items-center justify-center hover:bg-black hover:text-white transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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
                                    <span className="bg-info-bg text-info-text px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider">Angebot</span>
                                ) : (
                                    <span className="bg-surface-muted text-foreground px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider">
                                      {getInvoiceDocumentLabel(selectedDocument.documentKind)}
                                    </span>
                                )}
                           </div>
                      </div>
                  </div>

                  {/* Actions toolbar, tiered: primary, secondary, overflow */}
                  <div className="flex flex-wrap items-center gap-2">
                      {/* Convert to invoice: the prominent CTA for accepted offers */}
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
                          <div className="w-px h-6 bg-border-subtle mx-1" />
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
                          <div className="w-px h-6 bg-border-subtle mx-1" />
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
                          <div className="w-px h-6 bg-border-subtle mx-1" />
                        </>
                      )}

                      {/* PRIMARY: labeled action buttons */}
                      <button
                        onClick={() => onEditInvoice(selectedDocument, documentType)}
                        className="h-10 px-4 bg-surface-muted border border-control-border hover:bg-border-subtle text-foreground rounded-full font-bold text-xs transition-colors flex items-center gap-2"
                      >
                        <Edit3 size={14} /> Bearbeiten
                      </button>
                      <Button onClick={handleOpenEmail} size="md">
                        <Mail size={16} /> Senden
                      </Button>
                      <button
                        onClick={handleDownloadPdf}
                        className="h-10 px-4 bg-white border border-control-border hover:bg-surface-muted text-foreground rounded-full font-bold text-xs transition-colors flex items-center gap-2"
                        title="PDF herunterladen"
                      >
                        <Download size={14} /> PDF
                      </button>

                      {/* SECONDARY: icon buttons */}
                      <div className="w-px h-6 bg-border-subtle mx-1" />

                      {documentType === 'invoice' && selectedDocument.status === 'draft' && (
                        <button
                          onClick={handleFinalizeDraftInvoice}
                          className="h-10 w-10 bg-white border border-control-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                          title="Als gestellt markieren (Entwurf → Offen)"
                          aria-label="Als gestellt markieren (Entwurf zu Offen)"
                        >
                          <CheckCircle size={18} />
                        </button>
                      )}

                      {documentType === 'offer' && getRendererRuntime().shell !== 'web' && (
                        <>
                          {!selectedDocument.shareToken ? (
                            <button
                              onClick={handlePublishOffer}
                              className="h-10 px-3 bg-black text-white rounded-full font-bold text-xs transition-colors flex items-center gap-1.5 hover:bg-dark-2"
                              title="Öffentlichen Link erzeugen"
                            >
                              <Link size={14} /> Veröffentlichen
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={async () => {
                                  if (!selectedDocument.shareToken) return;
                                  const baseUrl = portalSettings?.baseUrl?.trim();
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
                                className="h-10 w-10 bg-white border border-control-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                title="Link kopieren"
                                aria-label="Angebotslink kopieren"
                              >
                                <Link size={18} />
                              </button>
                              <button
                                onClick={handleOpenOfferLink}
                                className="h-10 w-10 bg-white border border-control-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                title="Im Browser öffnen"
                                aria-label="Angebot im Browser öffnen"
                              >
                                <ExternalLink size={18} />
                              </button>
                              <button
                                onClick={handleSyncOfferDecision}
                                className="h-10 w-10 bg-white border border-control-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                title="Portal-Status synchronisieren"
                                aria-label="Portal-Status synchronisieren"
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
                          aria-expanded={isToolbarOverflowOpen}
                          className="h-10 w-10 bg-white border border-control-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                          title="Weitere Aktionen"
                          aria-label="Weitere Aktionen"
                        >
                          <MoreHorizontal size={18} />
                        </button>
                        {isToolbarOverflowOpen && (
                          <div className="absolute right-0 top-full mt-1 bg-white rounded-2xl shadow-xl p-1.5 z-[var(--z-dropdown)] min-w-[180px]">
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
                              className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-surface-muted rounded-xl flex items-center gap-2 transition-colors"
                            >
                              <Printer size={14} /> Drucken / PDF öffnen
                            </button>
                            <button
                              onClick={() => { setIsToolbarOverflowOpen(false); handleSharePaymentLink(); }}
                              className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-surface-muted rounded-xl flex items-center gap-2 transition-colors"
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
                       <div className="bg-surface-muted rounded-xl p-8 border border-border">

                          {/* Meta Header */}
                          <div className="flex flex-col md:flex-row justify-between gap-8 mb-10 pb-8 border-b border-border border-dashed">
                              <div>
                                  <p className="text-xs font-bold text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                                      <User size={12}/> Empfänger
                                  </p>
                                  <p className="font-bold text-foreground text-lg">{selectedDocument.client}</p>
                                  <p className="text-sm text-muted whitespace-pre-line leading-relaxed mt-1">
                                      {selectedDocument.clientAddress || selectedDocument.clientEmail}
                                  </p>
                              </div>
                              <div className="flex gap-8">
                                  <div>
                                      <p className="text-xs font-bold text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                                          <Calendar size={12}/> Datum
                                      </p>
                                      <p className="tabular-nums font-bold text-foreground">{formatDate(selectedDocument.date)}</p>
                                  </div>
                                  <div>
                                      <p className="text-xs font-bold text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                                          <Clock size={12}/> {documentType === 'offer' ? 'Gültig bis' : 'Fällig'}
                                      </p>
                                      <p className={`tabular-nums font-bold ${selectedDocument.status === 'overdue' ? 'text-error-text' : 'text-foreground'}`}>
                                          {formatDate(selectedDocument.dueDate)}
                                      </p>
                                  </div>
                              </div>
                          </div>

                          {/* Items Table */}
                          <div className="mb-8">
                              <table className="w-full">
                                  <thead>
                                      <tr className="text-xs font-bold text-muted uppercase tracking-wider text-left border-b border-border">
                                          <th className="pb-3 pl-2">Beschreibung</th>
                                          <th className="pb-3 text-right">Menge</th>
                                          <th className="pb-3 text-right">Einzel</th>
                                          <th className="pb-3 text-right pr-2">Gesamt</th>
                                      </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border-subtle">
                                      {selectedDocument.items.map((item, i) => (
                                          <tr key={i} className="group hover:bg-white/50 transition-colors">
                                              <td className="py-4 pl-2 font-bold text-foreground">{item.description}</td>
                                              <td className="py-4 text-right text-muted tabular-nums text-sm">{item.quantity}</td>
                                              <td className="py-4 text-right text-muted tabular-nums text-sm">{formatCurrency(item.price)}</td>
                                              <td className="py-4 text-right font-bold text-foreground tabular-nums pr-2">{formatCurrency(item.total)}</td>
                                          </tr>
                                      ))}
                                  </tbody>
                              </table>
                          </div>

                          {/* Totals & Notes */}
                          <div className="flex flex-col md:flex-row justify-between items-start gap-8 border-t border-border border-dashed pt-8">
                               <div className="flex-1">
                                   <p className="text-xs font-bold text-foreground mb-2">Hinweis</p>
                                   <p className="text-xs text-muted leading-relaxed max-w-sm">
                                       Vielen Dank für Ihren Auftrag. Bitte überweisen Sie den fälligen Betrag innerhalb von 14 Tagen auf das unten angegebene Konto.
                                   </p>
                               </div>
                               <div className="w-full md:w-64 space-y-2">
                                   <div className="flex justify-between text-sm text-muted">
                                       <span>Netto</span>
                                       <span className="tabular-nums">{formatCurrency(selectedDocumentTax?.netAmount ?? 0)}</span>
                                   </div>
                                   <div className="flex justify-between text-sm text-muted">
                                       <span>USt {(selectedDocumentTax?.vatRateApplied ?? 0)}%</span>
                                       <span className="tabular-nums">{formatCurrency(selectedDocumentTax?.vatAmount ?? 0)}</span>
                                   </div>
                                   <div className="flex justify-between text-xl font-bold text-foreground border-t border-border pt-3 mt-1">
                                       <span>Gesamt</span>
                                       <span className="tabular-nums">{formatCurrency(selectedDocumentTax?.grossAmount ?? selectedDocument.amount)}</span>
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
                          className="bg-surface-muted border border-border rounded-3xl p-6"
                          data-testid="document-chain-panel"
                        >
                          <div className="flex items-start justify-between gap-3 mb-4">
                            <div>
                              <h4 className="font-bold text-sm text-foreground flex items-center gap-2">
                                <Link size={16} className="text-muted" /> Dokumentkette
                              </h4>
                              <p className="text-xs text-muted mt-1">Auftrag, Abrechnung und Revisionen</p>
                            </div>
                            <span className="text-xs font-bold uppercase tracking-wider text-muted">
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
                                      ? 'border-foreground bg-white'
                                      : 'border-control-border bg-white/60 hover:bg-white hover:border-control-border'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-bold text-foreground truncate">
                                      {getInvoiceDocumentLabel(document.documentKind)} · {document.number}
                                    </span>
                                    <span className="text-xs font-bold uppercase tracking-wide text-muted shrink-0">
                                      {relationLabel}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2 mt-1 text-xs text-muted">
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
                      <div className="bg-white border border-border rounded-3xl p-6">
                          <h4 className="font-bold text-sm text-foreground mb-4 flex items-center gap-2">
                              <CheckCircle size={16} className="text-foreground" /> Status
                          </h4>
                          {selectedDocument.status === 'overdue' && (
                              <div className="bg-error-bg rounded-xl p-4 mb-4 border border-error-border">
                                  <div className="flex items-start gap-3">
                                      <AlertTriangle size={18} className="text-error-text mt-0.5" />
                                      <div>
                                          <p className="text-xs font-bold text-error-text mb-1">Zahlung überfällig</p>
                                          <button
                                            onClick={handleCreateReminder}
                                            className="text-xs font-bold bg-white border border-error-border text-error-text px-2 py-1 rounded-sm hover:bg-error-bg transition-colors"
                                          >
                                              Mahnung erstellen
                                          </button>
                                      </div>
                                  </div>
                              </div>
                          )}
                          <div className="mb-2 flex items-center gap-2">
                               <Badge status={selectedDocument.status} />
                               <span className="text-xs text-muted">
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
                               </span>
                          </div>
                          <div className="mt-3 border-t border-border pt-3">
                            <p className="text-xs font-bold text-muted uppercase tracking-wider mb-2">Steuerbehandlung</p>
                            <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border bg-surface-muted text-xs font-bold text-foreground">
                              <span className="w-1.5 h-1.5 rounded-full bg-muted" />
                              {selectedTaxDefinition?.label ?? 'Regelbesteuerung'}
                            </div>
                            {selectedTaxExemptionReason && (
                              <p className="mt-2 text-xs text-muted leading-relaxed">{selectedTaxExemptionReason}</p>
                            )}
                          </div>
                      </div>

                      {/* Payments (Invoices only) */}
                      {documentType === 'invoice' && (
                        <div className="bg-white border border-border rounded-3xl p-6">
                          <div className="flex items-center justify-between mb-4">
                            <h4 className="font-bold text-sm text-foreground flex items-center gap-2">
                              <Euro size={16} className="text-muted" /> Zahlungen
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
                              className="px-3 py-2 rounded-xl bg-surface-muted border border-control-border hover:bg-border-subtle text-foreground font-bold text-sm inline-flex items-center gap-2"
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
                                  <div className="flex items-center justify-between text-xs text-muted mb-2">
                                    <span>Bezahlt</span>
                                    <span className="tabular-nums font-bold text-foreground">{formatCurrency(paid)}</span>
                                  </div>
                                  <div className="w-full h-2 rounded-full bg-surface-muted border border-control-border overflow-hidden">
                                    <div
                                      className="h-full bg-black"
                                      style={{ width: `${Math.round(pct * 100)}%` }}
                                    />
                                  </div>
                                  <div className="flex items-center justify-between text-xs text-muted mt-2">
                                    <span>Noch offen</span>
                                    <span className="tabular-nums font-bold text-foreground">{formatCurrency(remaining)}</span>
                                  </div>
                                </div>

                                {(selectedDocument.payments ?? []).length === 0 ? (
                                  <p className="text-xs text-muted">Noch keine Zahlungen erfasst.</p>
                                ) : (
                                  <div className="space-y-2">
                                    {(selectedDocument.payments ?? [])
                                      .slice()
                                      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
                                      .map((p) => (
                                        <div
                                          key={p.id}
                                          className="flex items-center justify-between p-3 bg-surface-muted rounded-2xl border border-border"
                                        >
                                          <div>
                                            <p className="text-xs font-bold text-foreground">{formatDate(p.date)}</p>
                                            <p className="text-xs text-muted font-bold uppercase tracking-wide">
                                              {p.method}
                                            </p>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <div className="tabular-nums font-bold text-foreground min-w-[120px] text-right">
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
                                              className="w-9 h-9 rounded-xl bg-white border border-control-border hover:bg-surface-muted flex items-center justify-center"
                                              title="Bearbeiten"
                                            >
                                              <Edit3 size={16} className="text-foreground" />
                                            </button>
                                            <button
                                              onClick={() => {
                                                setDeletingPaymentId(p.id);
                                                setPaymentDeleteReason('');
                                                setPaymentDeleteError(null);
                                                setIsPaymentDeleteOpen(true);
                                              }}
                                              className="w-9 h-9 rounded-xl bg-white border border-control-border hover:bg-surface-muted flex items-center justify-center"
                                              title="Löschen"
                                            >
                                              <Trash2 size={16} className="text-foreground" />
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
                      <div className="bg-warning-bg border border-warning-border rounded-3xl p-6">
                          <h4 className="font-bold text-sm text-foreground mb-3 flex items-center gap-2">
                              Interne Notiz
                          </h4>
                          <textarea
                              id="document-internal-note"
                              aria-label="Interne Notiz"
                              value={noteDraft}
                              onChange={(event) => setNoteDraft(event.target.value)}
 className="w-full bg-white border border-warning-border rounded-xl p-3 text-xs text-muted resize-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                              rows={3}
                              placeholder="Notiz zu diesem Vorgang..."
                          />
                          <div className="mt-2 flex justify-end">
                            <Button size="sm" onClick={handleAddNote} disabled={!noteDraft.trim()}>
                              Notiz im Verlauf speichern
                            </Button>
                          </div>
                      </div>

                      {/* Timeline */}
                      <div className="bg-white border border-border rounded-3xl p-6">
                          <h4 className="font-bold text-sm text-foreground mb-4 flex items-center gap-2">
                              <Clock size={16} className="text-muted" /> Verlauf
                          </h4>
                          <div className="space-y-4 relative pl-2 border-l border-border ml-1">
                              {selectedDocument.history && selectedDocument.history.length > 0 ? selectedDocument.history.map((h, i) => (
                                  <div key={i} className="pl-4 relative">
                                      <div className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-border border-2 border-white"></div>
                                      <p className="text-xs font-bold text-muted uppercase tracking-wide">{formatDate(h.date)}</p>
                                      <p className="text-xs font-medium text-foreground">{formatDocumentHistoryAction(h.action)}</p>
                                  </div>
                              )) : (
                                <p className="text-xs text-muted pl-4">Entwurf erstellt.</p>
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
    const count = selectedIds.size;
    const closeBulkDelete = () => {
      setIsBulkDeleteOpen(false);
      setBulkDeleteReason('');
    };

    return (
      <Modal
        open={isBulkDeleteOpen}
        onClose={closeBulkDelete}
        titleId="bulk-delete-title"
        descriptionId="bulk-delete-description"
        ariaBusy={isBulkDeleting}
        className="max-w-xl overflow-hidden flex flex-col"
      >
          <div className="p-6 border-b border-border flex justify-between items-center bg-surface-muted">
            <div>
              <h3 id="bulk-delete-title" className="text-lg font-black">Löschen bestätigen</h3>
              <p id="bulk-delete-description" className="text-sm text-muted tabular-nums">{count} Einträge ausgewählt</p>
            </div>
            <button
              type="button"
              onClick={closeBulkDelete}
              aria-label="Dialog schließen"
              className="p-2 hover:bg-border-subtle rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <X size={20} />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <div className="bg-error-bg border border-error-border rounded-2xl p-4 text-sm text-error-text">
              Diese Aktion kann nicht rückgängig gemacht werden. Es wird ein Audit-Eintrag geschrieben.
            </div>
            <div>
              <label htmlFor="bulk-delete-reason" className="block text-xs font-bold text-muted mb-1">Grund (Pflicht)</label>
              <textarea
                id="bulk-delete-reason"
                value={bulkDeleteReason}
                onChange={(e) => setBulkDeleteReason(e.target.value)}
                rows={4}
                placeholder="z.B. Duplikat, Testdaten, Kunde hat storniert ..."
                className="w-full bg-surface-muted border border-control-border rounded-2xl p-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
              />
            </div>
          </div>

          <div className="p-6 border-t border-border bg-surface-muted flex justify-end gap-3">
            <Button variant="secondary" onClick={closeBulkDelete} disabled={isBulkDeleting}>
              Abbrechen
            </Button>
            <Button
              variant="danger"
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
            >
              <Trash2 size={16} /> Löschen
            </Button>
          </div>
      </Modal>
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
    <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm flex flex-col relative">
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

       <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <div className="flex flex-wrap items-center gap-4">
           {/* Document Type Dropdown */}
           <div ref={typeDropdownRef} className="relative">
                <button
                    type="button"
                    onClick={() => setIsTypeDropdownOpen(!isTypeDropdownOpen)}
                    aria-expanded={isTypeDropdownOpen}
                    aria-haspopup="menu"
                    className="flex items-center gap-2 text-3xl font-bold text-foreground hover:text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
                >
                    {documentType === 'invoice' ? 'Rechnungen' : 'Angebote'}
                    <ChevronDown size={28} className={`motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none ${isTypeDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {isTypeDropdownOpen && (
                    <div className="ui-enter-popover absolute top-full left-0 mt-2 w-56 bg-white rounded-2xl shadow-xl p-2 z-[var(--z-dropdown)]">
                        <button
                            onClick={() => switchDocumentType('invoice')}
                            className={`w-full text-left px-4 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-between ${documentType === 'invoice' ? 'bg-black text-white' : 'hover:bg-surface-muted text-foreground'}`}
                        >
                            Rechnungen
                            {documentType === 'invoice' && <Check size={16} />}
                        </button>
                        <button
                            onClick={() => switchDocumentType('offer')}
                            className={`w-full text-left px-4 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-between ${documentType === 'offer' ? 'bg-black text-white' : 'hover:bg-surface-muted text-foreground'}`}
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
                            aria-pressed={filter === s}
                            className={`ui-press px-4 py-1.5 rounded-full text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${filter === s ? 'bg-black text-white' : 'bg-surface-muted text-muted hover:bg-border-subtle'}`}
                        >
                            {labels[s]}
                        </button>
                    );
                })}
           </div>
        </div>

        {/* Action Header Area. Wraps below the toolbar copy on narrow windows,
            and the search field takes the full row there so nothing is clipped. */}
        <div className="flex flex-wrap items-center justify-end gap-3">
           {filter === 'overdue' && overdueInvoices.length > 0 && (
               <button
                  onClick={handleStartDunningRun}
                  title={`Mahnlauf starten (${overdueInvoices.length} überfällige Rechnungen)`}
                  className="h-12 w-40 shrink-0 justify-center bg-error-bg text-error-text border border-error-border px-3 rounded-full font-bold text-sm hover:bg-error-bg transition-colors flex items-center gap-2 tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
               >
                   <Gavel size={16} />
                   Mahnlauf ({overdueInvoices.length})
               </button>
           )}

           <div className="relative w-full sm:w-auto">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" size={18} />
                <input
                    type="text"
                    placeholder="Suchen..."
                    aria-label="Rechnungen und Angebote durchsuchen"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-12 pr-6 py-3 bg-surface-muted border border-control-border rounded-full text-sm font-bold w-full sm:w-64 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
           </div>

           <button
             onClick={onOpenTemplates}
             className="px-4 py-3 rounded-full bg-surface-muted border border-control-border text-foreground hover:bg-border-subtle transition-colors font-bold text-sm flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
             title="Vorlagen verwalten"
           >
             <LayoutTemplate size={18} />
             Vorlagen
           </button>

           <button
             onClick={onOpenRecurring}
             className="px-4 py-3 rounded-full bg-surface-muted border border-control-border text-foreground hover:bg-border-subtle transition-colors font-bold text-sm flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
             title="Abos / Serien-Dokumente"
           >
             <RefreshCw size={18} />
             Abos
           </button>
           <button
             onClick={() => onCreateInvoice(documentType)}
             className="w-12 h-12 bg-accent text-accent-foreground rounded-full flex items-center justify-center motion-safe:transition-transform motion-safe:active:scale-95 motion-reduce:transition-none shadow-sm hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
             title={documentType === 'invoice' ? "Neue Rechnung" : "Neues Angebot"}
             aria-label={documentType === 'invoice' ? "Neue Rechnung" : "Neues Angebot"}
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
               className="h-10 px-4 bg-white rounded-full text-xs font-bold text-black hover:bg-border-subtle transition-colors flex items-center gap-2"
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
           ) : isCurrentDataError ? (
             <ErrorState
               title={documentType === 'invoice' ? 'Rechnungen konnten nicht geladen werden' : 'Angebote konnten nicht geladen werden'}
               description="Die Liste ist nicht abrufbar. Eine leere Liste würde hier fälschlich als 'keine Dokumente' gelesen."
               onRetry={refetchCurrentData}
             />
           ) : filteredDocuments.length > 0 ? filteredDocuments.map((doc) => (
               <div
                 key={doc.id}
                 role="button"
                 tabIndex={0}
                 aria-label={`${getInvoiceDocumentLabel(doc.documentKind)} ${doc.number} öffnen`}
                 onClick={() => {
                   if (isSelecting) toggleSelected(doc.id);
                   else handleOpenDetail(doc.id);
                 }}
                 onKeyDown={(event) => {
                   if (event.target !== event.currentTarget) return;
                   if (event.key !== 'Enter' && event.key !== ' ') return;
                   event.preventDefault();
                   if (isSelecting) toggleSelected(doc.id);
                   else handleOpenDetail(doc.id);
                 }}
                 className={`group flex flex-wrap items-center gap-4 p-4 rounded-xl border transition-colors cursor-pointer relative focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                   selectedIds.has(doc.id)
                     ? 'border-foreground bg-surface-muted'
                     : 'border-border-subtle hover:border-control-border bg-white'
                 }`}
               >
                   <button
                     onClick={(e) => {
                       e.stopPropagation();
                       toggleSelected(doc.id);
                     }}
                     className="shrink-0 -m-0.5 p-0.5"
                     aria-label={selectedIds.has(doc.id) ? `${doc.number}: Auswahl entfernen` : `${doc.number} auswählen`}
                     aria-pressed={selectedIds.has(doc.id)}
                   >
                     <div
                       className={`w-5 h-5 rounded-sm border flex items-center justify-center transition-colors ${
                         selectedIds.has(doc.id)
                           ? 'bg-black border-black text-white'
                           : 'border-control-border bg-white group-hover:border-foreground/40'
                       }`}
                     >
                       {selectedIds.has(doc.id) && <Check size={12} />}
                     </div>
                   </button>
                   {/* Flex Column 1: Info (Flex 1 to take remaining space) */}
                   <div className="flex-1 flex items-center gap-4 min-w-0">
                       <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-muted group-hover:bg-surface-muted transition-colors shrink-0 ${documentType === 'offer' ? 'bg-info-bg text-info-text' : 'bg-surface-muted'}`}>
                           <FileText size={20} />
                      </div>
                      <div className="min-w-0">
                          <p className="font-bold text-lg text-foreground flex items-center gap-2 flex-wrap">
                              <span className="truncate">{doc.number}</span>
                              {getDunningBadge(doc.dunningLevel)}
                          </p>
                          <p className="text-xs font-bold text-muted truncate">
                            {documentType === 'offer' ? 'Angebot' : getInvoiceDocumentLabel(doc.documentKind)} · {doc.client === MISSING_COUNTERPARTY ? EMPTY_VALUE : formatEmptyValue(doc.client)}
                          </p>
                      </div>
                  </div>

                  {/* Metadata group: its own right-aligned line below md, inline from md. */}
                  <div className="flex w-full items-center justify-end gap-4 md:w-auto">

                  {/* Flex Column 2: Date (Fixed Width). Shown from lg: below that the
                      row keeps number, amount and status and drops the date pair. */}
                  <div className="hidden lg:block w-32 text-right shrink-0">
                      <p className="text-xs font-bold text-muted uppercase">Datum</p>
                      <p className="text-sm font-bold tabular-nums">{formatDate(doc.date)}</p>
                  </div>

                  {/* Flex Column 3: Due Date (Fixed Width) */}
                  <div className="hidden lg:block w-32 text-right shrink-0">
                      <p className="text-xs font-bold text-muted uppercase">{documentType === 'offer' ? 'Gültig bis' : 'Fällig'}</p>
                      <p className={`text-sm font-bold tabular-nums ${doc.status === 'overdue' ? 'text-error-text' : ''}`}>{formatDate(doc.dueDate)}</p>
                  </div>

                  {/* Flex Column 4: Amount (Fixed Width) */}
                  <div className="w-24 lg:w-32 text-right shrink-0">
                      <p className="text-lg tabular-nums font-bold truncate">{formatCurrency(doc.amount)}</p>
                  </div>

                  {/* Flex Column 5: Status (Fixed Width) */}
                  <div className="w-24 lg:w-28 flex justify-end shrink-0">
                      <Badge status={doc.status} />
                  </div>

                  {/* Flex Column 6: Arrow (Fixed Width) */}
                  <div className="w-10 flex justify-center shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 motion-safe:transition-opacity motion-reduce:transition-none">
                      <button
                        className="p-2 hover:bg-border-subtle rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        title="Bearbeiten"
                        aria-label={`${doc.number} bearbeiten`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditInvoice(doc, documentType);
                        }}
                      >
                          <ArrowUpRight size={18} />
                      </button>
                  </div>
                  </div>
              </div>
          )) : (
              <EmptyState
                title={
                  searchTerm.trim() || filter !== 'all'
                    ? 'Kein Dokument passt zu dieser Auswahl'
                    : `Noch keine ${documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} angelegt`
                }
                description={
                  searchTerm.trim() || filter !== 'all'
                    ? `Suche und Statusfilter schließen alle ${currentData.length} geladenen ${documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} aus.`
                    : `${documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} entstehen hier und laufen anschließend durch die Belegkette. Lege ${documentType === 'invoice' ? 'die erste Rechnung' : 'das erste Angebot'} über das + oben rechts an.`
                }
                action={
                  searchTerm.trim() || filter !== 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchTerm('');
                        setFilter('all');
                      }}
                    >
                      Filter zurücksetzen
                    </Button>
                  ) : undefined
                }
              />
          )}
      </div>
    </div>
  );
};
