import React, { useState, useRef } from 'react';
import {
  Search, Plus, FileText,
  ArrowLeft, Share2, ArrowUpRight,
  AlertTriangle, Mail, Gavel, CheckCircle, X,
  Download, Printer, Send, Paperclip, MoreHorizontal, RefreshCw, Link, ExternalLink, Trash2, LayoutTemplate, Edit3, Euro, ArrowRight
} from 'lucide-react';
import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, EMPTY_VALUE, EmptyState, ErrorState, HatchedProgress, IconButton, Input, Menu, Modal,
  PageHeader, SegmentedControl, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, Timeline, formatEmptyValue, nextSort,
  cn, useActionFeedback, type SortDirection,
} from '@billme/ui';
import type { BadgeStatus } from '@billme/ui';
import {
  getInvoiceDocumentLabel,
  isBillingDocumentKind,
  type Invoice,
  type Offer,
  type InvoiceStatus,
} from '@billme/desktop-core/types';
import { useDeleteInvoiceMutation, useInvoicesQuery, useUpsertInvoiceMutation, useInvoicePaymentMutation } from '../hooks/useInvoices';
import { useDeleteOfferMutation, useOffersQuery, useUpsertOfferMutation } from '../hooks/useOffers';
import { useSettingsQuery } from '../hooks/useSettings';
import { formatDocumentHistoryAction } from '../documentHistory';
import { getRendererRuntime, ipc } from '../runtime-api';
import type { IpcArgs } from '@billme/desktop-contracts/contract';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { localIsoDate } from '@billme/desktop-utils';
import { SkeletonLoader } from '../ui/components/SkeletonLoader';
import { CHAIN_START_LABELS, ChainSourcePicker, type ChainStartAction } from './invoices/ChainSourcePicker';
import {
  calculateDaysOverdue,
  calculateInvoiceTaxSnapshot,
  correctableAmount,
  correctionBlocker,
  isReceivableDocumentKind,
  orderConfirmationBlocker,
  orderSettlement,
  revisionBlocker,
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
    if (!level || level < 1 || level > 3) return null;
    const config = level === 1
      ? { tone: 'warning' as const, label: '1. Mahnung' }
      : level === 2
        ? { tone: 'error' as const, label: '2. Mahnung' }
        : { tone: 'inverse' as const, label: 'Inkasso' };
    return (
      <Badge tone={config.tone} className="whitespace-nowrap">
        <span className="inline-flex items-center gap-1">
          <AlertTriangle size={12} aria-hidden="true" /> {config.label}
        </span>
      </Badge>
    );
};

interface DocumentsViewProps {
  onOpenTemplates: () => void;
  onOpenRecurring: () => void;
  onEditInvoice: (invoice: Invoice | Offer, type: 'invoice' | 'offer') => void;
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

type KindFilter = 'all' | 'invoice' | 'order_confirmation' | 'delivery_note' | 'settlement' | 'correction';

const KIND_FILTER_LABELS: Record<KindFilter, string> = {
  all: 'Alle Belegarten',
  invoice: 'Rechnungen',
  order_confirmation: 'Auftragsbestätigungen',
  delivery_note: 'Lieferscheine',
  settlement: 'Abschlags-, Teil- und Schlussrechnungen',
  correction: 'Gutschriften und Stornos',
};

const KIND_FILTERS: Record<Exclude<KindFilter, 'all'>, ReadonlyArray<NonNullable<Invoice['documentKind']>>> = {
  invoice: ['invoice'],
  order_confirmation: ['order_confirmation'],
  delivery_note: ['delivery_note'],
  settlement: ['advance_invoice', 'partial_invoice', 'final_invoice'],
  correction: ['credit_note', 'cancellation_invoice'],
};

const isAcceptedOffer = (offer: Offer): boolean => offer.status === 'accepted' || offer.shareDecision === 'accepted';
/** The chain rules read the portal decision from `share`; the renderer keeps it flat. */
const toChainOffer = (offer: Offer) => ({ id: offer.id, amount: offer.amount, status: offer.status, share: { decision: offer.shareDecision ?? undefined } }) as never;

/** Order confirmations, delivery notes and corrections are issued, not open receivables. */
const DocumentStatusBadge: React.FC<{ document: { status: Invoice['status'] | Offer['status']; documentKind?: Invoice['documentKind'] } }> = ({ document }) =>
  document.status === 'open' && !isReceivableDocumentKind(document.documentKind)
    ? <Badge tone="neutral">Ausgestellt</Badge>
    : <Badge status={document.status as BadgeStatus} />;

type AmountChainAction = Extract<ChainAction, 'advance_invoice' | 'partial_invoice' | 'final_invoice' | 'credit_note' | 'cancellation_invoice'>;

const isAmountChainAction = (action: ChainAction): action is AmountChainAction =>
  action === 'advance_invoice' ||
  action === 'partial_invoice' ||
  action === 'final_invoice' ||
  action === 'credit_note' ||
  action === 'cancellation_invoice';

type ChainIssueArgs = IpcArgs<'documents:chainIssue'>;
type WithoutId<T> = T extends { id: string } ? Omit<T, 'id'> : never;
type ChainIssueIntent = WithoutId<ChainIssueArgs>;

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
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Wide screens: a row click selects and shows the summary card beside the list; narrower screens open the detail page.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1440px)').matches === true);
  React.useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1440px)');
    if (!query) return undefined;
    const onChange = () => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
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

  // Payments (Invoice detail)
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [newPaymentId, setNewPaymentId] = useState('');
  const [paymentForm, setPaymentForm] = useState({ date: '', amount: '', method: 'Überweisung' });
  const [paymentReason, setPaymentReason] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isPaymentDeleteOpen, setIsPaymentDeleteOpen] = useState(false);
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
  const [paymentDeleteReason, setPaymentDeleteReason] = useState('');
  const [paymentDeleteError, setPaymentDeleteError] = useState<string | null>(null);

  // Document-chain amount actions use an in-app dialog because Electron has no
  // native prompt support. The number is reserved only after confirmation.
  const [chainAmountDialog, setChainAmountDialog] = useState<{ action: AmountChainAction; source: Invoice | Offer } | null>(null);
  // "Neu" menu: a follow-up document waits here until its source document is picked.
  const [chainStart, setChainStart] = useState<ChainStartAction | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [chainAmountInput, setChainAmountInput] = useState('');
  const [chainAmountError, setChainAmountError] = useState<string | null>(null);
  const [chainIssuePending, setChainIssuePending] = useState(false);
  const pendingChainOperationRef = useRef<{ id: string; intentKey: string } | null>(null);

  // Choose data source based on document type
  const {
    data: invoices = [],
    isLoading: isLoadingInvoices,
    isError: isInvoicesError,
    refetch: refetchInvoices,
  } = useInvoicesQuery();
  const upsertInvoice = useUpsertInvoiceMutation();
  const invoicePayment = useInvoicePaymentMutation();
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

  const selectedInvoice = documentType === 'invoice' ? invoices.find(i => i.id === selectedId) : undefined;
  const selectedOffer = documentType === 'offer' ? offers.find(i => i.id === selectedId) : undefined;
  const selectedDocument = selectedInvoice ?? selectedOffer;
  const offerOrder = selectedOffer
    ? invoices.find((invoice) => invoice.documentKind === 'order_confirmation' && invoice.sourceDocumentId === selectedOffer.id)
    : undefined;
  React.useEffect(() => setNoteDraft(''), [selectedId]);
  const selectedChain = React.useMemo(() => {
    if (!selectedDocument) return [];
    if (documentType === 'offer') {
      const roots = new Set(invoices
        .filter((invoice) => invoice.sourceDocumentId === selectedDocument.id)
        .map((invoice) => invoice.rootDocumentId ?? invoice.id));
      return invoices.filter((invoice) => roots.has(invoice.rootDocumentId ?? invoice.id));
    }
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
    const matchesKind = documentType !== 'invoice' || kindFilter === 'all' || KIND_FILTERS[kindFilter].includes((doc as Invoice).documentKind ?? 'invoice');
    if (!matchesKind) return false;
    const matchesFilter = filter === 'all' || doc.status === filter;
    const matchesSearch = doc.client.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          doc.number.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  type DocumentSortKey = 'number' | 'client' | 'date' | 'dueDate' | 'amount';
  const [sort, setSort] = useState<{ key: DocumentSortKey; direction: SortDirection } | null>(null);
  const sortFor = (key: DocumentSortKey): SortDirection | false => (sort?.key === key ? sort.direction : false);
  const sortedDocuments = sort
    ? [...filteredDocuments].sort((a, b) => {
        const factor = sort.direction === 'asc' ? 1 : -1;
        if (sort.key === 'amount') return (a.amount - b.amount) * factor;
        const left = String(a[sort.key] ?? '');
        const right = String(b[sort.key] ?? '');
        return left.localeCompare(right, 'de', { numeric: true }) * factor;
      })
    : filteredDocuments;
  const allFilteredSelected = filteredDocuments.length > 0 && filteredDocuments.every((doc) => selectedIds.has(doc.id));

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

  const sumPayments = (doc: Pick<Invoice, 'payments'> | undefined) => {
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
        notify('error', `Kopieren fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
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

  const persistChainDocument = (action: ChainAction, amount?: number, source: Invoice | Offer | undefined = selectedDocument) => {
    if (!source || chainIssuePending) return;
    void (async () => {
      try {
        const today = localIsoDate();
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

        let issuePayload: ChainIssueIntent;
        if (action === 'order_confirmation') {
          issuePayload = { operation: action, offerId: source.id, date: today, reason };
        } else if (action === 'delivery_note') {
          issuePayload = { operation: action, orderId: source.id, date: today, reason };
        } else if (action === 'revision') {
          issuePayload = { operation: action, invoiceId: source.id, date: today, reason };
        } else if (action === 'credit_note' || action === 'cancellation_invoice') {
          if (amount === undefined) throw new Error('Ein Korrekturbetrag ist erforderlich.');
          issuePayload = { operation: 'correction', invoiceId: source.id, kind: action, amount, date: today, reason };
        } else {
          if (amount === undefined) throw new Error('Ein Rechnungsbetrag ist erforderlich.');
          issuePayload = { operation: 'settlement_invoice', orderId: source.id, kind: action, amount, date: today, reason };
        }
        // The intent string excludes the operation id, so a retry after a lost
        // response reuses the same id while any changed intent starts anew.
        const intentKey = JSON.stringify(issuePayload);
        const pending = pendingChainOperationRef.current;
        const operationId = pending && pending.intentKey === intentKey ? pending.id : uuidv4();
        pendingChainOperationRef.current = { id: operationId, intentKey };

        setChainIssuePending(true);
        try {
          const issued = await ipc.documents.chainIssue({ id: operationId, ...issuePayload });
          pendingChainOperationRef.current = null;
          queryClient.setQueryData<Invoice[]>(['invoices'], (current = []) => [
            issued,
            ...current.filter((invoice) => invoice.id !== issued.id),
          ]);
          await queryClient.invalidateQueries({ queryKey: ['invoices'] });
          // Every chain document is an invoice-kind document, also when started from the offers list.
          if (documentType !== 'invoice') {
            setDocumentType('invoice');
            setSelectedIds(new Set());
          }
          setSelectedId(issued.id);
          setViewMode('detail');
          notify('success', `${getInvoiceDocumentLabel(issued.documentKind)} ${issued.number} erstellt.`);
        } finally {
          setChainIssuePending(false);
        }
      } catch (error) {
        notify('error', `Dokument konnte nicht erstellt werden: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  };

  const handleCreateChainDocument = (action: ChainAction, source: Invoice | Offer | undefined = selectedDocument) => {
    if (chainIssuePending) return;
    if (!source) return;
    const sourceIsOffer = !('documentKind' in source) || offers.some((offer) => offer.id === source.id);
    if (action === 'order_confirmation' && !sourceIsOffer) return;
    if (action !== 'order_confirmation' && sourceIsOffer) return;
    if (action === 'delivery_note' && source.documentKind !== 'order_confirmation') return;
    if (isAmountChainAction(action)) {
      // Pre-fill what can still be billed or credited, the same arithmetic the server checks.
      const open = action === 'credit_note' || action === 'cancellation_invoice'
        ? correctableAmount(source, invoices)
        : orderSettlement(invoices, source).remaining;
      setChainAmountInput(open.toFixed(2));
      setChainAmountError(null);
      setChainAmountDialog({ action, source });
      return;
    }
    persistChainDocument(action, undefined, source);
  };

  const canSettle = (order: Invoice) => {
    const settlement = orderSettlement(invoices, order);
    return settlement.remaining > 0 && !settlement.finalIssued;
  };

  /** Documents a follow-up from the "Neu" menu may start from. */
  const chainSources = (action: ChainStartAction | null): Array<Invoice | Offer> => {
    const orders = invoices.filter((invoice) => invoice.documentKind === 'order_confirmation' && invoice.status !== 'draft');
    if (action === 'order_confirmation') return offers.filter((offer) => !orderConfirmationBlocker(toChainOffer(offer), invoices));
    if (action === 'delivery_note') return orders;
    if (action === 'advance_invoice' || action === 'partial_invoice' || action === 'final_invoice') return orders.filter((order) => canSettle(order));
    if (action === 'credit_note' || action === 'cancellation_invoice') return invoices.filter((invoice) => !correctionBlocker(invoice, invoices, action));
    return [];
  };

  const cancelChainAmount = () => {
    setChainAmountDialog(null);
    setChainAmountInput('');
    setChainAmountError(null);
  };

  const confirmChainAmount = () => {
    if (chainIssuePending) return;
    if (!chainAmountDialog) return;
    const normalized = chainAmountInput.trim().replace(/\s/g, '').replace(',', '.');
    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount <= 0) {
      setChainAmountError('Bitte einen gültigen Betrag größer als 0 eingeben.');
      return;
    }
    const { action, source } = chainAmountDialog;
    cancelChainAmount();
    persistChainDocument(action, amount, source);
  };

  const switchDocumentType = (type: 'invoice' | 'offer') => {
      setDocumentType(type);
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
              date: localIsoDate(),
              action: `Per E-Mail gesendet an ${emailData.to}`
          };

          if (selectedInvoice) {
            upsertInvoice.mutate({
              invoice: {
                ...selectedInvoice,
                history: [historyEntry, ...(selectedDocument.history ?? [])],
              },
              reason: 'email_sent',
            });
          } else if (selectedOffer) {
            upsertOffer.mutate({
              offer: {
                ...selectedOffer,
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
          date: localIsoDate(),
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
            notify('error', `Finalisieren fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
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
        notify('error', `Mahnlauf fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
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
        { date: localIsoDate(), action: reason },
        ...(selectedDocument.history ?? []),
      ];
      const onSuccess = () => {
        setNoteDraft('');
        notify('success', 'Notiz im Verlauf gespeichert.');
      };
      const onError = (error: unknown) => notify('error', `Notiz konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`);
      if (selectedInvoice) {
        upsertInvoice.mutate({ invoice: { ...selectedInvoice, history }, reason }, { onSuccess, onError });
      } else if (selectedOffer) {
        upsertOffer.mutate({ offer: { ...selectedOffer, history }, reason }, { onSuccess, onError });
      }
  };

  // Customers also accept by phone or mail; record that decision without the portal.
  const handleRecordOfferDecision = (decision: 'accepted' | 'declined') => {
      if (!selectedOffer) return;
      const reason = decision === 'accepted' ? 'Angebot manuell als angenommen markiert' : 'Angebot manuell als abgelehnt markiert';
      upsertOffer.mutate(
        {
          offer: {
            ...selectedOffer,
            shareDecision: decision,
            acceptedAt: decision === 'accepted' ? new Date().toISOString() : selectedOffer.acceptedAt,
          },
          reason,
        },
        {
          onSuccess: () => notify('success', decision === 'accepted' ? 'Angebot als angenommen markiert.' : 'Angebot als abgelehnt markiert.'),
          onError: (error: unknown) => notify('error', `Entscheidung konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`),
        },
      );
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
          date: localIsoDate(),
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
        notify('error', `Mahnung konnte nicht erstellt werden: ${error instanceof Error ? error.message : String(error)}`);
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
        className="flex max-h-[84vh] flex-col overflow-hidden"
      >
          <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
            <div className="min-w-0 flex-1">
              <h3 id="dunning-modal-title" className="text-title text-foreground">Mahnlauf starten</h3>
              <p id="dunning-modal-description" className="text-caption text-muted">{dueDunningCount} von {overdueInvoices.length} überfälligen Rechnungen erreichen eine neue Mahnstufe</p>
            </div>
            <IconButton aria-label="Dialog schließen" tooltip={false} onClick={() => setIsDunningModalOpen(false)}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>

          <div className="flex-1 overflow-y-auto flex flex-col gap-3 px-4.5 pt-1 pb-4">
               {!settings?.automation.dunningEnabled && (
                   <p role="alert" className="rounded-control border border-warning-border bg-warning-bg px-3 py-2.5 text-control text-warning-text">
                       Das Mahnwesen ist ausgeschaltet. Schalte es unter Einstellungen › Mahnwesen ein, dann versendet der Mahnlauf die Mahnungen per E-Mail.
                   </p>
               )}
               {dunningPreview.map(({ inv, level, due }) => (
                   <div key={inv.id} className={`rounded-control border px-3 py-2.5 ${due ? 'border-border-strong bg-surface-muted' : 'border-border bg-surface'}`}>
                       <div className="flex items-center justify-between gap-3">
                           <div className="flex min-w-0 items-center gap-2">
                                <span className="text-control font-semibold tabular-nums">{inv.number}</span>
                                <span className="truncate text-caption text-muted">{inv.client}</span>
                           </div>
                           <span className="text-control font-semibold tabular-nums">{formatCurrency(inv.amount)}</span>
                       </div>
                       <div className="mt-1.5 flex flex-wrap items-center gap-2">
                           <Badge tone="error">Fällig seit {new Date(inv.dueDate).toLocaleDateString('de-DE')}</Badge>
                           {due && level ? (
                             <Badge tone="warning">{level.name}{level.fee > 0 ? ` (+${formatCurrency(level.fee)})` : ''} an {inv.clientEmail || 'keine E-Mail-Adresse'}</Badge>
                           ) : (
                             <span className="text-caption text-muted">{level ? `${level.name} bereits versendet` : 'Noch keine Mahnstufe erreicht'}</span>
                           )}
                       </div>
                   </div>
               ))}
               {overdueInvoices.length === 0 && (
                   <EmptyState
                     title="Keine überfälligen Rechnungen"
                     description="Der Mahnlauf kann nur Rechnungen anmahnen, deren Fälligkeit überschritten ist."
                   />
               )}
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
              <Button variant="secondary" onClick={() => setIsDunningModalOpen(false)}>
                Abbrechen
              </Button>
              <Button
                onClick={() => void handleProcessDunningRun()}
                disabled={dueDunningCount === 0 || !settings?.automation.dunningEnabled || isDunningProcessing}
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
    >
        <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
            <h3 id="email-modal-title" className="flex min-w-0 flex-1 items-center gap-2 text-title text-foreground"><Mail size={16} aria-hidden="true" /> Per E-Mail senden</h3>
            <IconButton aria-label="Dialog schließen" tooltip={false} onClick={() => setIsEmailModalOpen(false)}>
              <X size={16} aria-hidden="true" />
            </IconButton>
        </div>
        <div className="flex flex-col gap-3 px-4.5 pt-1 pb-4">
            <Input
                id="email-recipient"
                label="Empfänger"
                type="email"
                fullWidth
                value={emailData.to}
                onChange={e => setEmailData({...emailData, to: e.target.value})}
            />
            <Input
                id="email-subject"
                label="Betreff"
                type="text"
                fullWidth
                value={emailData.subject}
                onChange={e => setEmailData({...emailData, subject: e.target.value})}
            />
            <Textarea
                id="email-message"
                label="Nachricht"
                rows={6}
                fullWidth
                value={emailData.message}
                onChange={e => setEmailData({...emailData, message: e.target.value})}
            />
            <div className="flex items-center gap-2 rounded-control border border-border bg-surface-muted px-3 py-2.5 text-caption text-muted">
                <Paperclip size={14} aria-hidden="true" />
                <span>Angehängt: {selectedDocument?.number}.pdf</span>
            </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
            <Button variant="secondary" onClick={() => setIsEmailModalOpen(false)}>Abbrechen</Button>
            <Button onClick={handleSendEmail}>
                <Send size={16} aria-hidden="true" /> Senden
            </Button>
        </div>
    </Modal>
  );

  const renderPaymentModal = () => {
    const closePaymentModal = () => {
      if (invoicePayment.isPending) return;
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
      >
          <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
            <div className="min-w-0 flex-1">
              <h3 id="payment-modal-title" className="text-title text-foreground">
                {editingPaymentId ? 'Zahlung bearbeiten' : 'Zahlung erfassen'}
              </h3>
              <p id="payment-modal-description" className="text-caption text-muted">Wird im Audit-Log gespeichert (GoBD).</p>
            </div>
            <IconButton aria-label="Dialog schließen" tooltip={false} onClick={closePaymentModal}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>

          <div className="flex flex-col gap-3 px-4.5 pt-1 pb-4">
            <div className="grid grid-cols-2 gap-3">
              <Input
                id="invoicesview-datum"
                label="Datum"
                type="date"
                fullWidth
                value={paymentForm.date}
                onChange={(e) => setPaymentForm((p) => ({ ...p, date: e.target.value }))}
              />
              <Input
                id="invoicesview-betrag-eur"
                label="Betrag (EUR)"
                inputMode="decimal"
                fullWidth
                value={paymentForm.amount}
                onChange={(e) => setPaymentForm((p) => ({ ...p, amount: e.target.value }))}
                placeholder="z.B. 250,00"
              />
            </div>

            <Select
              id="invoicesview-methode"
              label="Methode"
              fullWidth
              value={paymentForm.method}
              onChange={(e) => setPaymentForm((p) => ({ ...p, method: e.target.value }))}
            >
              <option value="Überweisung">Überweisung</option>
              <option value="PayPal">PayPal</option>
              <option value="Karte">Karte</option>
              <option value="Bar">Bar</option>
              <option value="Sonstiges">Sonstiges</option>
            </Select>

            <Textarea
              id="invoicesview-grund-pflicht"
              label="Grund (Pflicht)"
              fullWidth
              value={paymentReason}
              onChange={(e) => {
                setPaymentReason(e.target.value);
                if (paymentError) setPaymentError(null);
              }}
              rows={3}
              placeholder="z.B. Zahlungseingang Kontoauszug, Teilzahlung, ..."
            />

            {paymentError && <div className="text-caption font-medium text-error-text">{paymentError}</div>}
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
            <Button variant="secondary" disabled={invoicePayment.isPending} onClick={closePaymentModal}>
              Abbrechen
            </Button>
            <Button
              disabled={invoicePayment.isPending}
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
                if (!Number.isFinite(amount) || amount === 0) {
                  setPaymentError('Bitte einen Betrag ungleich null eingeben. Rückzahlungen sind negativ.');
                  return;
                }

                if (editingPaymentId && !(selectedDocument.payments ?? []).some((p) => p.id === editingPaymentId)) {
                  setPaymentError('Zahlung nicht gefunden. Bitte neu öffnen.');
                  return;
                }

                if (invoicePayment.isPending) return;
                invoicePayment.mutate(
                  { operation: 'save', args: { invoiceId: selectedDocument.id, payment: { id: editingPaymentId ?? newPaymentId, date, amount, method: paymentForm.method || 'Überweisung' }, expectedPayment: selectedDocument.payments?.find((payment) => payment.id === editingPaymentId), reason: trimmedReason } },
                  {
                    onError: (error) => setPaymentError(error.message),
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
      >
          <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
            <div className="min-w-0 flex-1">
              <h3 id="chain-amount-title" className="text-title text-foreground">{label} erstellen</h3>
              <p id="chain-amount-description" className="text-caption text-muted">Der Betrag wird als eigener, verknüpfter Beleg gespeichert.</p>
            </div>
            <IconButton aria-label="Dialog schließen" tooltip={false} onClick={cancelChainAmount}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); confirmChainAmount(); }}>
            <div className="flex flex-col gap-3 px-4.5 pt-1 pb-4">
              <Input
                id="chain-amount"
                label="Betrag (EUR)"
                autoFocus
                inputMode="decimal"
                fullWidth
                value={chainAmountInput}
                onChange={(event) => { setChainAmountInput(event.target.value); setChainAmountError(null); }}
                aria-invalid={Boolean(chainAmountError)}
                aria-describedby={chainAmountError ? 'chain-amount-error' : undefined}
              />
              {chainAmountError && <p id="chain-amount-error" role="alert" className="text-caption font-medium text-error-text">{chainAmountError}</p>}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
              <Button variant="secondary" type="button" onClick={cancelChainAmount}>Abbrechen</Button>
              <Button type="submit">{label} erstellen</Button>
            </div>
          </form>
      </Modal>
    );
  };

  const renderPaymentDeleteModal = () => {
    const closePaymentDelete = () => {
      if (invoicePayment.isPending) return;
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
      >
          <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
            <div className="min-w-0 flex-1">
              <h3 id="payment-delete-title" className="text-title text-foreground">Zahlung löschen</h3>
              <p id="payment-delete-description" className="text-caption text-muted">
                Die Zahlung wird entfernt. Bitte Begründung angeben (GoBD).
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 px-4.5 pt-1 pb-4">
            <Textarea
              id="payment-delete-reason"
              label="Grund (Pflicht)"
              fullWidth
              value={paymentDeleteReason}
              onChange={(e) => {
                setPaymentDeleteReason(e.target.value);
                if (paymentDeleteError) setPaymentDeleteError(null);
              }}
              rows={3}
              placeholder="z.B. falsch erfasst, Doppelbuchung, ..."
            />
            {paymentDeleteError && <div className="text-caption font-medium text-error-text">{paymentDeleteError}</div>}
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
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

                if (invoicePayment.isPending) return;
                invoicePayment.mutate(
                  { operation: 'remove', args: { invoiceId: selectedDocument.id, expectedPayment: selectedDocument.payments!.find((payment) => payment.id === deletingPaymentId)!, reason: trimmed } },
                  {
                    onError: (error) => setPaymentDeleteError(error.message),
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
    isSettingsError ? (
      <Card padding="none">
        <ErrorState
          title="Einstellungen konnten nicht geladen werden"
          description="Steuersätze, Mahnstufen und Unternehmensdaten kommen aus den Einstellungen. Ohne sie können Rechnungen nicht korrekt berechnet werden."
          onRetry={() => void refetchSettings()}
        />
      </Card>
    ) : (
      <SkeletonLoader variant="list" count={5} />
    )
  );

  // --- Detail View ---
  // Settings carry the company identity and the tax rules, so the view waits for
  // them instead of falling back to stand-in values. Already loaded settings stay
  // usable even if a later refetch fails.
  if (!settings) {
      return renderSettingsGate();
  }
  if (viewMode === 'detail' && selectedDocument) {
      const paid = sumPayments(selectedDocument);
      const grossAmount = Number(selectedDocumentTax?.grossAmount ?? selectedDocument.amount) || 0;
      const remaining = Math.max(0, grossAmount - paid);
      return (
          <div className="flex min-h-full flex-col">

              {renderEmailModal()}
              {renderPaymentModal()}
              {renderPaymentDeleteModal()}
              {renderChainAmountDialog()}

              <PageHeader
                title={selectedDocument.number}
                description={selectedDocument.client === MISSING_COUNTERPARTY ? undefined : selectedDocument.client}
                back={{ label: 'Zurück zur Liste', onClick: () => setViewMode('list') }}
                actions={
                  <>
                    <Menu
                      aria-label="Weitere Aktionen"
                      align="end"
                      trigger={(props) => (
                        <IconButton {...props} aria-label="Weitere Aktionen">
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </IconButton>
                      )}
                      items={[
                        {
                          id: 'print',
                          label: 'Drucken / PDF öffnen',
                          icon: <Printer size={14} />,
                          onSelect: () => {
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
                          },
                        },
                        ...(documentType === 'invoice'
                          ? [{ id: 'payment-link', label: 'Zahlungslink kopieren', icon: <Share2 size={14} />, onSelect: handleSharePaymentLink }]
                          : []),
                      ]}
                    />
                    <Button variant="secondary" onClick={() => onEditInvoice(selectedDocument, documentType)}>
                      <Edit3 size={16} aria-hidden="true" /> Bearbeiten
                    </Button>
                    <Button variant="secondary" onClick={handleDownloadPdf} title="PDF herunterladen">
                      <Download size={16} aria-hidden="true" /> PDF
                    </Button>
                    <Button onClick={handleOpenEmail}>
                      <Mail size={16} aria-hidden="true" /> Senden
                    </Button>
                  </>
                }
                toolbar={
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <DocumentStatusBadge document={selectedDocument} />
                      {documentType === 'offer' ? (
                        <Badge tone="info">Angebot</Badge>
                      ) : (
                        <Badge tone="neutral">{getInvoiceDocumentLabel(selectedDocument.documentKind)}</Badge>
                      )}
                      {getDunningBadge(selectedDocument.dunningLevel)}
                    </div>

                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {documentType === 'offer' && !selectedDocument.shareDecision && (
                        <>
                          <Button variant="secondary" onClick={() => handleRecordOfferDecision('accepted')} disabled={upsertOffer.isPending} title="Kunde hat das Angebot angenommen (z. B. per Telefon oder E-Mail)">
                            <CheckCircle size={16} aria-hidden="true" /> Angenommen
                          </Button>
                          <Button variant="secondary" onClick={() => handleRecordOfferDecision('declined')} disabled={upsertOffer.isPending} title="Kunde hat das Angebot abgelehnt">
                            Abgelehnt
                          </Button>
                        </>
                      )}

                      {documentType === 'offer' && offerOrder && (
                        <Button
                          variant="secondary"
                          onClick={() => { setDocumentType('invoice'); setSelectedId(offerOrder.id); setViewMode('detail'); }}
                          title="Dieses Angebot wird über die Auftragsbestätigung abgerechnet"
                        >
                          <FileText size={16} aria-hidden="true" />
                          Auftragsbestätigung {offerOrder.number}
                        </Button>
                      )}

                      {documentType === 'offer' && isAcceptedOffer(selectedDocument as Offer) && !offerOrder && (
                        <>
                          {!orderConfirmationBlocker(toChainOffer(selectedDocument as Offer), invoices) && <Button
                            variant="secondary"
                            onClick={() => handleCreateChainDocument('order_confirmation')}
                            disabled={chainIssuePending}
                            title="Auftragsbestätigung aus angenommenem Angebot erstellen"
                          >
                            <FileText size={16} aria-hidden="true" />
                            Auftragsbestätigung
                          </Button>}
                          <Button
                            variant="secondary"
                            onClick={handleConvertOfferToInvoice}
                            title="Angebot in Rechnung umwandeln"
                          >
                            <ArrowRight size={16} aria-hidden="true" />
                            In Rechnung umwandeln
                          </Button>
                        </>
                      )}

                      {documentType === 'invoice' && selectedDocument.documentKind === 'order_confirmation' && (
                        <>
                          <Button variant="secondary" onClick={() => handleCreateChainDocument('delivery_note')} disabled={chainIssuePending} title="Lieferschein aus Auftragsbestätigung erstellen">
                            <FileText size={16} aria-hidden="true" /> Lieferschein
                          </Button>
                          {canSettle(selectedDocument as Invoice) && <>
                          <Button variant="secondary" onClick={() => handleCreateChainDocument('advance_invoice')} disabled={chainIssuePending} title="Abschlagsrechnung erstellen">
                            <Euro size={16} aria-hidden="true" /> Abschlag
                          </Button>
                          <Button variant="secondary" onClick={() => handleCreateChainDocument('partial_invoice')} disabled={chainIssuePending} title="Teilrechnung erstellen">
                            <Euro size={16} aria-hidden="true" /> Teilrechnung
                          </Button>
                          <Button variant="secondary" onClick={() => handleCreateChainDocument('final_invoice')} disabled={chainIssuePending} title="Schlussrechnung erstellen">
                            <CheckCircle size={16} aria-hidden="true" /> Schlussrechnung
                          </Button>
                          </>}
                        </>
                      )}

                      {documentType === 'invoice' && selectedDocument.status !== 'draft' && (
                        <>
                          {!correctionBlocker(selectedDocument as Invoice, invoices, 'credit_note') && <Button variant="secondary" onClick={() => handleCreateChainDocument('credit_note')} disabled={chainIssuePending} title="Gutschrift aus dieser Rechnung erstellen">
                            <ArrowLeft size={16} aria-hidden="true" /> Gutschrift
                          </Button>}
                          {!correctionBlocker(selectedDocument as Invoice, invoices, 'cancellation_invoice') && <Button variant="secondary" onClick={() => handleCreateChainDocument('cancellation_invoice')} disabled={chainIssuePending} title="Stornorechnung aus dieser Rechnung erstellen">
                            <RefreshCw size={16} aria-hidden="true" /> Storno
                          </Button>}
                          {!revisionBlocker(selectedDocument as Invoice, invoices) && <Button variant="secondary" onClick={() => handleCreateChainDocument('revision')} disabled={chainIssuePending} title="Neue Revision aus dieser Rechnung erstellen">
                            <FileText size={16} aria-hidden="true" /> Revision
                          </Button>}
                        </>
                      )}

                      {documentType === 'invoice' && selectedDocument.status === 'draft' && (
                        <IconButton
                          variant="secondary"
                          onClick={handleFinalizeDraftInvoice}
                          tooltip="Als gestellt markieren (Entwurf → Offen)"
                          aria-label="Als gestellt markieren (Entwurf zu Offen)"
                        >
                          <CheckCircle size={16} aria-hidden="true" />
                        </IconButton>
                      )}

                      {documentType === 'offer' && getRendererRuntime().shell !== 'web' && (
                        !selectedDocument.shareToken ? (
                          <Button variant="secondary" onClick={handlePublishOffer} title="Öffentlichen Link erzeugen">
                            <Link size={16} aria-hidden="true" /> Veröffentlichen
                          </Button>
                        ) : (
                          <>
                            <IconButton
                              variant="secondary"
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
                                    notify('error', `Kopieren fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
                                  }
                                }}
                              tooltip="Link kopieren"
                              aria-label="Angebotslink kopieren"
                            >
                              <Link size={16} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                              variant="secondary"
                              onClick={handleOpenOfferLink}
                              tooltip="Im Browser öffnen"
                              aria-label="Angebot im Browser öffnen"
                            >
                              <ExternalLink size={16} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                              variant="secondary"
                              onClick={handleSyncOfferDecision}
                              aria-label="Portal-Status synchronisieren"
                            >
                              <RefreshCw size={16} aria-hidden="true" />
                            </IconButton>
                          </>
                        )
                      )}
                    </div>
                  </>
                }
              />

              <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">

                  {/* Left column: document summary */}
                  <Card padding="none" className="min-w-0">
                      <div className="flex flex-col justify-between gap-4 border-b border-border p-3.5 md:flex-row">
                          <div className="min-w-0">
                              <p className="text-eyebrow uppercase text-muted">Empfänger</p>
                              <p className="mt-1 text-section text-foreground">{selectedDocument.client}</p>
                              <p className="mt-0.5 whitespace-pre-line text-control text-muted">
                                  {selectedDocument.clientAddress || selectedDocument.clientEmail}
                              </p>
                          </div>
                          <div className="flex gap-6">
                              <div>
                                  <p className="text-eyebrow uppercase text-muted">Datum</p>
                                  <p className="mt-1 text-control font-semibold tabular-nums text-foreground">{formatDate(selectedDocument.date)}</p>
                              </div>
                              <div>
                                  <p className="text-eyebrow uppercase text-muted">{documentType === 'offer' ? 'Gültig bis' : 'Fällig'}</p>
                                  <p className={`mt-1 text-control font-semibold tabular-nums ${selectedDocument.status === 'overdue' ? 'text-error-text' : 'text-foreground'}`}>
                                      {formatDate(selectedDocument.dueDate)}
                                  </p>
                              </div>
                          </div>
                      </div>

                      <Table aria-label="Positionen" bare>
                          <TableHeader>
                              <TableRow>
                                  <TableHead>Beschreibung</TableHead>
                                  <TableHead numeric>Menge</TableHead>
                                  <TableHead numeric>Einzel</TableHead>
                                  <TableHead numeric>Gesamt</TableHead>
                              </TableRow>
                          </TableHeader>
                          <TableBody>
                              {selectedDocument.items.map((item, i) => item.kind === 'text' || item.kind === 'group' ? (
                                  <TableRow key={i}>
                                      <TableCell colSpan={4} className="text-muted">{item.description}</TableCell>
                                  </TableRow>
                              ) : (
                                  <TableRow key={i}>
                                      <TableCell className="font-medium">{item.description}</TableCell>
                                      <TableCell numeric muted>{new Intl.NumberFormat('de-DE', { maximumFractionDigits: 4 }).format(item.quantity)}</TableCell>
                                      <TableCell numeric muted>{formatCurrency(item.price)}</TableCell>
                                      <TableCell numeric className="font-medium">{formatCurrency(item.total)}</TableCell>
                                  </TableRow>
                              ))}
                          </TableBody>
                      </Table>

                      <div className="flex flex-col items-start justify-between gap-4 border-t border-border p-3.5 md:flex-row">
                           <div className="min-w-0 flex-1">
                               <p className="text-eyebrow uppercase text-muted">Hinweis</p>
                               <p className="mt-1 max-w-sm text-caption text-muted">
                                   {documentType === 'offer'
                                     ? `Dieses Angebot ist gültig bis ${formatDate(selectedDocument.dueDate)}.`
                                     : `Bitte überweisen Sie den fälligen Betrag bis ${formatDate(selectedDocument.dueDate)} auf das unten angegebene Konto.`}
                               </p>
                           </div>
                           <div className="flex w-full flex-col gap-1.5 md:w-64">
                               <div className="flex justify-between text-control text-muted">
                                   <span>Netto</span>
                                   <span className="tabular-nums">{formatCurrency(selectedDocumentTax?.netAmount ?? 0)}</span>
                               </div>
                               {(selectedDocumentTax?.vatBreakdown?.length
                                 ? selectedDocumentTax.vatBreakdown
                                 : [{ rate: selectedDocumentTax?.vatRateApplied ?? 0, netAmount: selectedDocumentTax?.netAmount ?? 0, vatAmount: selectedDocumentTax?.vatAmount ?? 0 }]
                               ).map((entry) => (
                                 <div key={entry.rate} className="flex justify-between text-control text-muted">
                                   <span>USt {entry.rate}% auf {formatCurrency(entry.netAmount)}</span>
                                   <span className="tabular-nums">{formatCurrency(entry.vatAmount)}</span>
                                 </div>
                               ))}
                               <div className="flex items-baseline justify-between border-t border-border-strong pt-2 text-foreground">
                                   <span className="text-control font-semibold">Gesamt</span>
                                   <span className="text-heading font-bold tabular-nums">{formatCurrency(selectedDocumentTax?.grossAmount ?? selectedDocument.amount)}</span>
                               </div>
                           </div>
                      </div>
                  </Card>

                  {/* Right column */}
                  <div className="flex min-w-0 flex-col gap-3.5">

                      {/* Shared document-chain/revision relationship */}
                      {selectedChain.length > 0 && (
                        <section
                          className="rounded-card border border-border bg-surface"
                          data-testid="document-chain-panel"
                        >
                          <CardHeader
                            className="border-b border-border px-3.5 py-3"
                            title="Dokumentkette"
                            subtitle="Auftrag, Abrechnung und Revisionen"
                            count={`${selectedChain.length} Dokumente`}
                          />
                          <div className="flex flex-col gap-2 p-3.5">
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
                                  onClick={() => {
                                    setDocumentType('invoice');
                                    setSelectedId(document.id);
                                  }}
                                  className={`w-full rounded-control border px-3 py-2 text-left transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                                    isCurrent
                                      ? 'border-border-strong bg-accent-50'
                                      : 'border-border bg-surface hover:bg-surface-muted'
                                  }`}
                                >
                                  <span className="flex items-center justify-between gap-2">
                                    <span className="truncate text-control font-semibold text-foreground">
                                      {getInvoiceDocumentLabel(document.documentKind)} · {document.number}
                                    </span>
                                    <span className="shrink-0 text-micro text-muted">
                                      {relationLabel}
                                    </span>
                                  </span>
                                  <span className="mt-0.5 flex items-center justify-between gap-2 text-caption text-muted tabular-nums">
                                    <span>{formatDate(document.date)}</span>
                                    <span>{formatCurrency(document.amount)}</span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </section>
                      )}

                      <Card padding="none">
                          <CardHeader className="border-b border-border px-3.5 py-3" title="Status" />
                          <div className="flex flex-col gap-3 p-3.5">
                          {selectedDocument.status === 'overdue' && (
                              <div className="flex items-center gap-2.5 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text">
                                  <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
                                  <p className="min-w-0 flex-1 font-medium">Zahlung überfällig</p>
                                  <Button variant="secondary" size="sm" onClick={handleCreateReminder}>
                                      Mahnung erstellen
                                  </Button>
                              </div>
                          )}
                          <div className="flex items-center gap-2">
                               <DocumentStatusBadge document={selectedDocument} />
                               <span className="text-caption text-muted">
                               {selectedDocument.status === 'paid'
                                 ? (() => {
                                     const lastPayment = (selectedDocument.payments ?? [])
                                       .slice()
                                       .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
                                     return lastPayment
                                       ? `Bezahlt am ${formatDate(lastPayment.date)}`
                                       : 'Bezahlt';
                                   })()
                                 : documentType === 'offer'
                                   ? (selectedDocument.shareDecision === 'accepted' ? 'Vom Kunden angenommen' : selectedDocument.shareDecision === 'declined' ? 'Vom Kunden abgelehnt' : 'Noch keine Entscheidung')
                                   : 'Noch nicht bezahlt'}
                               </span>
                          </div>
                          <div className="border-t border-border pt-3">
                            <p className="mb-1.5 text-eyebrow uppercase text-muted">Steuerbehandlung</p>
                            <Badge tone="neutral">{selectedTaxDefinition?.label ?? 'Regelbesteuerung'}</Badge>
                            {selectedTaxExemptionReason && (
                              <p className="mt-2 text-caption text-muted">{selectedTaxExemptionReason}</p>
                            )}
                          </div>
                          </div>
                      </Card>

                      {/* Payments: billing documents only, never an order, delivery note or correction */}
                      {documentType === 'invoice' && isReceivableDocumentKind(selectedDocument.documentKind) && (
                        <Card padding="none">
                          <CardHeader
                            className="border-b border-border px-3.5 py-3"
                            title="Zahlungen"
                            actions={
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={selectedDocument.status === 'draft' || invoicePayment.isPending}
                              onClick={() => {
                                const today = localIsoDate();
                                setEditingPaymentId(null);
                                setNewPaymentId(uuidv4());
                                const openAmount = Math.max(0, (Number(selectedDocumentTax?.grossAmount ?? selectedDocument.amount) || 0) - sumPayments(selectedDocument));
                                setPaymentForm({ date: today, amount: openAmount > 0 ? openAmount.toFixed(2) : '', method: 'Überweisung' });
                                setPaymentReason('Zahlung erfasst');
                                setPaymentError(null);
                                setIsPaymentModalOpen(true);
                              }}
                              >
                                <Plus size={14} aria-hidden="true" /> Zahlung
                              </Button>
                            }
                          />
                          <div className="flex flex-col gap-2 p-3.5">
                            <div className="flex items-center justify-between text-caption text-muted">
                              <span>Bezahlt</span>
                              <span className="tabular-nums font-semibold text-foreground">{formatCurrency(paid)}</span>
                            </div>
                            <HatchedProgress size="sm" label="Bezahlt" value={grossAmount > 0 ? paid / grossAmount : 0} />
                            <div className="flex items-center justify-between text-caption text-muted">
                              <span>Noch offen</span>
                              <span className="tabular-nums font-semibold text-foreground">{formatCurrency(remaining)}</span>
                            </div>

                            {(selectedDocument.payments ?? []).length === 0 ? (
                              <p className="text-caption text-muted">Noch keine Zahlungen erfasst.</p>
                            ) : (
                              <div className="border-t border-border">
                                {(selectedDocument.payments ?? [])
                                  .slice()
                                  .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
                                  .map((p) => (
                                    <div
                                      key={p.id}
                                      className="flex items-center justify-between gap-3 border-b border-dashed border-border py-2.5 last:border-b-0 last:pb-0"
                                    >
                                      <div className="min-w-0">
                                        <p className="text-control font-semibold tabular-nums text-foreground">{formatDate(p.date)}</p>
                                        <p className="text-caption text-muted">{p.method}{p.id.startsWith('transaction-payment:') || p.id.startsWith('tx:') ? ' · Änderungen im Bankabgleich' : ''}</p>
                                      </div>
                                      <div className="flex items-center gap-1">
                                        <div className="mr-1 text-right text-control font-semibold tabular-nums text-foreground">
                                          {formatCurrency(p.amount)}
                                        </div>
                                        <IconButton
                                          size="sm"
                                          aria-label="Zahlung bearbeiten"
                                          disabled={invoicePayment.isPending || p.id.startsWith('transaction-payment:') || p.id.startsWith('tx:')}
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
                                        >
                                          <Edit3 size={14} aria-hidden="true" />
                                        </IconButton>
                                        <IconButton
                                          size="sm"
                                          aria-label="Zahlung löschen"
                                          disabled={invoicePayment.isPending || p.id.startsWith('transaction-payment:') || p.id.startsWith('tx:')}
                                              onClick={() => {
                                                setDeletingPaymentId(p.id);
                                                setPaymentDeleteReason('');
                                                setPaymentDeleteError(null);
                                                setIsPaymentDeleteOpen(true);
                                              }}
                                        >
                                          <Trash2 size={14} aria-hidden="true" />
                                        </IconButton>
                                      </div>
                                    </div>
                                  ))}
                              </div>
                            )}
                          </div>
                        </Card>
                      )}

                      <Card padding="none">
                          <CardHeader className="border-b border-border px-3.5 py-3" title="Interne Notiz" />
                          <div className="flex flex-col gap-2 p-3.5">
                            <Textarea
                                id="document-internal-note"
                                aria-label="Interne Notiz"
                                fullWidth
                                value={noteDraft}
                                onChange={(event) => setNoteDraft(event.target.value)}
                                rows={3}
                                placeholder="Notiz zu diesem Vorgang..."
                            />
                            <div className="flex justify-end">
                              <Button variant="secondary" size="sm" onClick={handleAddNote} disabled={!noteDraft.trim()}>
                                Notiz im Verlauf speichern
                              </Button>
                            </div>
                          </div>
                      </Card>

                      <Card padding="none">
                          <CardHeader className="border-b border-border px-3.5 py-3" title="Verlauf" />
                          <div className="p-3.5">
                              {selectedDocument.history && selectedDocument.history.length > 0 ? (
                                <Timeline
                                  label="Verlauf"
                                  entries={selectedDocument.history.map((h, i) => ({
                                    key: String(i),
                                    title: formatDocumentHistoryAction(h.action),
                                    meta: <span className="tabular-nums">{formatDate(h.date)}</span>,
                                  }))}
                                />
                              ) : (
                                <p className="text-caption text-muted">Entwurf erstellt.</p>
                              )}
                          </div>
                      </Card>
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
      >
          <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
            <div className="min-w-0 flex-1">
              <h3 id="bulk-delete-title" className="text-title text-foreground">Löschen bestätigen</h3>
              <p id="bulk-delete-description" className="text-caption text-muted">{count} Einträge ausgewählt</p>
            </div>
            <IconButton aria-label="Dialog schließen" tooltip={false} onClick={closeBulkDelete}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>

          <div className="flex flex-col gap-3 px-4.5 pt-1 pb-4">
            <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text">
              Diese Aktion kann nicht rückgängig gemacht werden. Es wird ein Audit-Eintrag geschrieben.
            </div>
            <Textarea
              id="bulk-delete-reason"
              label="Grund (Pflicht)"
              fullWidth
              value={bulkDeleteReason}
              onChange={(e) => setBulkDeleteReason(e.target.value)}
              rows={4}
              placeholder="z.B. Duplikat, Testdaten, Kunde hat storniert ..."
            />
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
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
              <Trash2 size={16} aria-hidden="true" /> Löschen
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
  const previewDocument = wide
    ? (sortedDocuments.find((candidate) => candidate.id === previewId) ?? sortedDocuments[0])
    : undefined;

  return (
    <div className="flex min-h-full flex-col">
      {renderDunningModal()}
      {renderEmailModal()}
      {renderPaymentModal()}
      {renderPaymentDeleteModal()}
      {renderBulkDeleteModal()}
      {renderChainAmountDialog()}
      <ChainSourcePicker
        action={chainStart}
        sources={chainSources(chainStart)}
        onClose={() => setChainStart(null)}
        onPick={(source) => {
          const action = chainStart;
          setChainStart(null);
          if (action) handleCreateChainDocument(action, source);
        }}
      />
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

      <PageHeader
        title="Rechnungen & Angebote"
        description={`${filteredDocuments.length} von ${currentData.length} ${documentType === 'invoice' ? 'Belegen' : 'Angeboten'}`}
        actions={
          <>
            {filter === 'overdue' && overdueInvoices.length > 0 && (
              <Button
                variant="secondary"
                onClick={handleStartDunningRun}
                title={`Mahnlauf starten (${overdueInvoices.length} überfällige Rechnungen)`}
                className="text-error-text"
              >
                <Gavel size={16} aria-hidden="true" />
                Mahnlauf ({overdueInvoices.length})
              </Button>
            )}
            <Button variant="secondary" onClick={onOpenTemplates} title="Vorlagen verwalten">
              <LayoutTemplate size={16} aria-hidden="true" />
              Vorlagen
            </Button>
            <Button variant="secondary" onClick={onOpenRecurring} title="Abos / Serien-Dokumente">
              <RefreshCw size={16} aria-hidden="true" />
              Abos
            </Button>
            <Menu
              aria-label="Folgebeleg anlegen"
              align="end"
              trigger={(props) => (
                <Button variant="secondary" {...props} title="Auftragsbestätigung, Lieferschein, Abschlag, Gutschrift oder Storno zu einem bestehenden Beleg">
                  <FileText size={16} aria-hidden="true" />
                  Folgebeleg
                </Button>
              )}
              items={(['order_confirmation', 'delivery_note', 'advance_invoice', 'partial_invoice', 'final_invoice', 'credit_note', 'cancellation_invoice'] as const).map((action) => ({
                id: `new-${action}`,
                label: `${CHAIN_START_LABELS[action]} …`,
                onSelect: () => setChainStart(action),
              }))}
            />
            <Button onClick={() => onCreateInvoice(documentType)}>
              <Plus size={16} aria-hidden="true" />
              {documentType === 'invoice' ? 'Neue Rechnung' : 'Neues Angebot'}
            </Button>
          </>
        }
        toolbar={
          <>
            <SegmentedControl
              aria-label="Dokumentart"
              value={documentType}
              onChange={switchDocumentType}
              options={[{ value: 'invoice', label: 'Rechnungen' }, { value: 'offer', label: 'Angebote' }]}
            />
            {documentType === 'invoice' ? (
              <Select aria-label="Belegart" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as KindFilter)}>
                {(Object.keys(KIND_FILTER_LABELS) as KindFilter[]).map((key) => (
                  <option key={key} value={key}>{KIND_FILTER_LABELS[key]}</option>
                ))}
              </Select>
            ) : null}
            <SegmentedControl
              aria-label="Status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'Alle' },
                { value: 'draft', label: 'Entwurf' },
                { value: 'open', label: 'Offen' },
                { value: 'paid', label: 'Bezahlt' },
                { value: 'overdue', label: 'Überfällig' },
              ]}
            />
            <div className="ml-auto w-full sm:w-64">
              <Input
                type="search"
                placeholder="Nummer oder Kunde suchen"
                aria-label="Rechnungen und Angebote durchsuchen"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                prefix={<Search size={14} aria-hidden="true" />}
                fullWidth
              />
            </div>
          </>
        }
      />

       {isSelecting && (
         <div className="mb-3.5 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3.5 py-2">
           <Badge tone="accent">{selectedIds.size}</Badge>
           <span className="mr-auto text-control font-medium text-foreground">
             {documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} ausgewählt
           </span>
           <Button variant="ghost" size="sm" onClick={toggleSelectAllFiltered} title="Alle in der aktuellen Liste auswählen">
             Alle auswählen
           </Button>
           <Button variant="ghost" size="sm" onClick={clearSelection}>
             Aufheben
           </Button>
           <Button
             variant="secondary"
             size="sm"
             onClick={() => handleBulkExport({ openFolderAfter: false })}
             title="PDFs exportieren (in App-Exports)"
           >
             <Download size={14} aria-hidden="true" /> Export
           </Button>
           <Button
             variant="secondary"
             size="sm"
             onClick={() => handleBulkExport({ openFolderAfter: true })}
             title="PDFs erstellen und Export-Ordner öffnen"
           >
             <Printer size={14} aria-hidden="true" /> Drucken
           </Button>
           <Button
             variant="danger"
             size="sm"
             onClick={() => setIsBulkDeleteOpen(true)}
             title="Ausgewählte Einträge löschen"
           >
             <Trash2 size={14} aria-hidden="true" /> Löschen
           </Button>
         </div>
       )}

       <div className={previewDocument ? 'grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-3.5' : undefined}>
       <div className="min-w-0">
           {isLoading ? (
             <SkeletonLoader variant="list" count={5} />
           ) : isCurrentDataError ? (
             <Card padding="none">
               <ErrorState
                 title={documentType === 'invoice' ? 'Rechnungen konnten nicht geladen werden' : 'Angebote konnten nicht geladen werden'}
                 description="Die Liste ist nicht abrufbar. Eine leere Liste würde hier fälschlich als 'keine Dokumente' gelesen."
                 onRetry={refetchCurrentData}
               />
             </Card>
           ) : sortedDocuments.length > 0 ? (
             <Table aria-label={documentType === 'invoice' ? 'Rechnungen' : 'Angebote'}>
               <TableHeader>
                 <TableRow>
                   <TableHead className="w-10">
                     <Checkbox
                       aria-label="Alle in der Liste auswählen"
                       checked={allFilteredSelected}
                       indeterminate={isSelecting && !allFilteredSelected}
                       onChange={toggleSelectAllFiltered}
                     />
                   </TableHead>
                   <TableHead sort={sortFor('number')} onSort={() => setSort((current) => nextSort(current, 'number'))}>Nummer</TableHead>
                   <TableHead sort={sortFor('client')} onSort={() => setSort((current) => nextSort(current, 'client'))}>Kunde</TableHead>
                   <TableHead className={previewDocument ? 'hidden' : 'hidden lg:table-cell'} sort={sortFor('date')} onSort={() => setSort((current) => nextSort(current, 'date'))}>Datum</TableHead>
                   <TableHead className="hidden lg:table-cell" sort={sortFor('dueDate')} onSort={() => setSort((current) => nextSort(current, 'dueDate'))}>
                     {documentType === 'offer' ? 'Gültig bis' : 'Fällig'}
                   </TableHead>
                   <TableHead numeric sort={sortFor('amount')} onSort={() => setSort((current) => nextSort(current, 'amount'))}>Betrag</TableHead>
                   <TableHead>Status</TableHead>
                   <TableHead className="w-12"><span className="sr-only">Aktionen</span></TableHead>
                 </TableRow>
               </TableHeader>
               <TableBody>
                 {sortedDocuments.map((doc) => {
                   const selected = selectedIds.has(doc.id);
                   return (
                     <TableRow
                       key={doc.id}
                       interactive
                       selected={selected || previewDocument?.id === doc.id}
                       aria-label={`${getInvoiceDocumentLabel(doc.documentKind)} ${doc.number} öffnen`}
                       onClick={() => {
                         if (isSelecting) toggleSelected(doc.id);
                         else if (wide) setPreviewId(doc.id);
                         else handleOpenDetail(doc.id);
                       }}
                       onDoubleClick={() => handleOpenDetail(doc.id)}
                     >
                       <TableCell onClick={(event) => event.stopPropagation()}>
                         <Checkbox
                           aria-label={selected ? `${doc.number}: Auswahl entfernen` : `${doc.number} auswählen`}
                           checked={selected}
                           onChange={() => toggleSelected(doc.id)}
                         />
                       </TableCell>
                       <TableCell className="whitespace-nowrap">
                         <span className="inline-flex items-center gap-2">
                           <span className="font-semibold tabular-nums">{doc.number}</span>
                           <span className={cn('text-caption text-muted', previewDocument && 'hidden')}>
                             {documentType === 'offer' ? 'Angebot' : getInvoiceDocumentLabel(doc.documentKind)}
                           </span>
                           {getDunningBadge(doc.dunningLevel)}
                         </span>
                       </TableCell>
                       <TableCell className="max-w-64 truncate">
                         {doc.client === MISSING_COUNTERPARTY ? EMPTY_VALUE : formatEmptyValue(doc.client)}
                       </TableCell>
                       <TableCell muted className={cn('hidden tabular-nums', !previewDocument && 'lg:table-cell')}>{formatDate(doc.date)}</TableCell>
                       <TableCell className="hidden tabular-nums lg:table-cell">{formatDate(doc.dueDate)}</TableCell>
                       <TableCell numeric>{formatCurrency(doc.amount)}</TableCell>
                       <TableCell><DocumentStatusBadge document={doc} /></TableCell>
                       <TableCell className="py-0 text-right">
                         <IconButton
                           size="sm"
                           className="ui-reveal"
                           tooltip="Bearbeiten"
                           aria-label={`${doc.number} bearbeiten`}
                           onClick={(e) => {
                             e.stopPropagation();
                             onEditInvoice(doc, documentType);
                           }}
                         >
                           <ArrowUpRight size={16} aria-hidden="true" />
                         </IconButton>
                       </TableCell>
                     </TableRow>
                   );
                 })}
               </TableBody>
             </Table>
           ) : (
             <Card padding="none">
              <EmptyState
                title={
                  searchTerm.trim() || filter !== 'all'
                    ? 'Kein Dokument passt zu dieser Auswahl'
                    : `Noch keine ${documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} angelegt`
                }
                description={
                  searchTerm.trim() || filter !== 'all'
                    ? `Suche und Statusfilter schließen alle ${currentData.length} geladenen ${documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} aus.`
                    : `${documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} entstehen hier und laufen anschließend durch die Belegkette. Lege ${documentType === 'invoice' ? 'die erste Rechnung' : 'das erste Angebot'} über die Schaltfläche oben rechts an.`
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
             </Card>
          )}
      </div>
      {previewDocument && (() => {
        const doc = previewDocument;
        const net = doc.taxSnapshot?.netAmount ?? (doc.items ?? []).reduce((sum, item) => sum + (Number(item.total) || 0), 0);
        const gross = doc.taxSnapshot?.grossAmount ?? (Number(doc.amount) || 0);
        const open = Math.max(0, gross - sumPayments(doc));
        return (
          <aside aria-label={`Übersicht ${doc.number}`} className="sticky top-0 min-w-0">
            <Card padding="none">
            <div className="flex items-center gap-3 border-b border-border px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-section tabular-nums text-foreground">{doc.number}</h2>
                <p className="text-caption text-muted">{documentType === 'offer' ? 'Angebot' : getInvoiceDocumentLabel(doc.documentKind)}</p>
              </div>
              <DocumentStatusBadge document={doc} />
            </div>
            <div className="flex flex-col gap-3 p-3.5">
            {/* T-Konto: one figure split into net and gross. */}
            <div className="grid grid-cols-[1fr_1px_1fr]">
              <div className="pr-3.5">
                <div className="text-eyebrow uppercase text-muted">Netto</div>
                <div className="text-label tabular-nums">{formatCurrency(net)}</div>
              </div>
              <div className="bg-border-strong" aria-hidden="true" />
              <div className="pl-3.5 text-right">
                <div className="text-eyebrow uppercase text-muted">Brutto</div>
                <div className="text-heading font-bold tabular-nums">{formatCurrency(gross)}</div>
              </div>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-control">
              <dt className="text-caption text-muted">Kunde</dt><dd className="truncate">{doc.client || '–'}</dd>
              <dt className="text-caption text-muted">Datum</dt><dd className="tabular-nums">{doc.date ? formatDate(doc.date) : '–'}</dd>
              <dt className="text-caption text-muted">{documentType === 'offer' ? 'Gültig bis' : 'Fällig'}</dt><dd className="tabular-nums">{doc.dueDate ? formatDate(doc.dueDate) : '–'}</dd>
              <dt className="text-caption text-muted">Steuer</dt><dd className="truncate">{getInvoiceTaxModeDefinition(resolveInvoiceTaxMode(doc.taxMode, settings)).label}</dd>
              {documentType === 'invoice' && (<><dt className="text-caption text-muted">Offen</dt><dd className="tabular-nums font-semibold">{formatCurrency(open)}</dd></>)}
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => handleOpenDetail(doc.id)}>Öffnen</Button>
              <Button size="sm" variant="secondary" onClick={() => onEditInvoice(doc, documentType)}>Bearbeiten</Button>
            </div>
            {doc.status === 'overdue' && (
              <p className="rounded-control border border-warning-border bg-warning-bg px-3 py-2.5 text-control text-warning-text" role="note">
                Seit {doc.dueDate ? formatDate(doc.dueDate) : 'Fälligkeit'} überfällig. Mahnung, Folgebeleg und Portal-Link stehen in der Detailansicht.
              </p>
            )}
            </div>
            </Card>
          </aside>
        );
      })()}
      </div>
    </div>
  );
};
