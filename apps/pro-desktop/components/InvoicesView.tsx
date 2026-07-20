
import React, { useState } from 'react';
import {
  Search, Plus, FileText,
  Check,
  ChevronDown,
  Gavel,
  RefreshCw, LayoutTemplate,
} from 'lucide-react';
import { Invoice, InvoiceStatus, Payment } from '../types';
import { MOCK_SETTINGS } from '../data/mockData';
import { useDeleteInvoiceMutation, useInvoicesQuery, useUpsertInvoiceMutation } from '../hooks/useInvoices';
import { useDeleteOfferMutation, useOffersQuery, useUpsertOfferMutation } from '../hooks/useOffers';
import { useSettingsQuery } from '../hooks/useSettings';
import { ipc } from '../ipc/client';
import { useQueryClient } from '@tanstack/react-query';
import { SkeletonLoader } from './SkeletonLoader';
import { getDefaultPaymentTermsText } from '../utils/placeholders';
import { ConvertOfferModal } from './ConvertOfferModal';

import {
  formatCurrency,
  formatDate,
  round2,
  getDisplayLineTotal,
} from './invoices/helpers';
import { DunningModal } from './invoices/DunningModal';
import { EmailModal } from './invoices/EmailModal';
import { PaymentModal } from './invoices/PaymentModal';
import { PaymentDeleteModal } from './invoices/PaymentDeleteModal';
import { BulkDeleteModal } from './invoices/BulkDeleteModal';
import { DocumentListItem } from './invoices/DocumentListItem';
import { SelectionBar } from './invoices/SelectionBar';
import { DetailView } from './invoices/DetailView';

// Mock data for Offers to demonstrate the switch
const MOCK_OFFERS: Invoice[] = [];

interface DocumentsViewProps {
  onOpenTemplates: () => void;
  onOpenRecurring: () => void;
  onEditInvoice: (invoice: Invoice, type: 'invoice' | 'offer') => void;
  onCreateInvoice: (type: 'invoice' | 'offer') => void;
  initialDocumentType?: 'invoice' | 'offer';
  initialSelectedId?: string;
}

export const DocumentsView: React.FC<DocumentsViewProps> = ({
  onOpenTemplates,
  onOpenRecurring,
  onEditInvoice,
  onCreateInvoice,
  initialDocumentType,
  initialSelectedId,
}) => {
  const queryClient = useQueryClient();
  const [documentType, setDocumentType] = useState<'invoice' | 'offer'>('invoice');
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showShareToast, setShowShareToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  // Dunning State
  const [isDunningModalOpen, setIsDunningModalOpen] = useState(false);
  const [selectedForDunning, setSelectedForDunning] = useState<string[]>([]);
  const [isDunningProcessing, setIsDunningProcessing] = useState(false);

  // Email State
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
  const [emailData, setEmailData] = useState({ to: '', subject: '', message: '' });

  // Multi-select (List View)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [bulkDeleteReason, setBulkDeleteReason] = useState('');
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // PDF path for "Öffnen" button in toast
  const [pdfLastPath, setPdfLastPath] = useState<string | null>(null);

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

  const [showConvertModal, setShowConvertModal] = useState(false);

  // Choose data source based on document type
  // In a real app, this would come from a context or prop
  const { data: invoices = [], isLoading: isLoadingInvoices } = useInvoicesQuery();
  const upsertInvoice = useUpsertInvoiceMutation();
  const deleteInvoice = useDeleteInvoiceMutation();
  const { data: offers = MOCK_OFFERS, isLoading: isLoadingOffers } = useOffersQuery();
  const upsertOffer = useUpsertOfferMutation();
  const deleteOffer = useDeleteOfferMutation();
  const { data: settingsFromDb } = useSettingsQuery();
  const settings = settingsFromDb ?? MOCK_SETTINGS;
  const currentData = documentType === 'invoice' ? invoices : offers;
  const isLoading = documentType === 'invoice' ? isLoadingInvoices : isLoadingOffers;

  const selectedDocument = currentData.find(i => i.id === selectedId);
  const selectedDocumentItems = selectedDocument
    ? selectedDocument.items.map((item) => ({
        ...item,
        total: getDisplayLineTotal(item),
      }))
    : [];
  const selectedDocumentNet = selectedDocumentItems.reduce((sum, item) => sum + item.total, 0);
  const selectedDocumentVatRate = settings.legal.smallBusinessRule ? 0 : Number(settings.legal.defaultVatRate || 0);
  const selectedDocumentVat = round2(selectedDocumentNet * (selectedDocumentVatRate / 100));
  const selectedDocumentGross = round2(selectedDocumentNet + selectedDocumentVat);
  const selectedPaymentTermsText = getDefaultPaymentTermsText(selectedDocument?.dueDate);

  React.useEffect(() => {
    if (!initialSelectedId) return;
    setDocumentType(initialDocumentType ?? 'invoice');
    setSelectedId(initialSelectedId);
    setViewMode('detail');
  }, [initialDocumentType, initialSelectedId]);

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
      setToastMessage('Kein Dokument für Zahllink ausgewählt.');
      setShowShareToast(true);
      setTimeout(() => setShowShareToast(false), 3000);
      return;
    }

    const paymentBaseUrl = settings.portal.baseUrl?.trim() || 'https://pay.billme.de';
    const url = `${paymentBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(selectedDocument.number)}`;
    void (async () => {
      try {
        await navigator.clipboard.writeText(url);
        setToastMessage('Zahllink kopiert!');
      } catch (error) {
        setToastMessage(`Kopieren fehlgeschlagen: ${String(error)}`);
      }
      setShowShareToast(true);
      setTimeout(() => setShowShareToast(false), 3500);
    })();
  };

  const handleDownloadPdf = () => {
      if (!selectedDocument) return;
      void (async () => {
        try {
          setToastMessage('PDF wird erstellt...');
          setShowShareToast(true);
          const res = await ipc.pdf.export({ kind: documentType, id: selectedDocument.id });
          setToastMessage(`PDF gespeichert`);
          setPdfLastPath(res.path);
          setTimeout(() => setShowShareToast(false), 5000);
        } catch (e) {
          setToastMessage(`PDF Fehler: ${String(e)}`);
          setTimeout(() => setShowShareToast(false), 5000);
        }
      })();
  };

  const handlePublishOffer = () => {
    if (!selectedDocument) return;
    void (async () => {
      try {
        setToastMessage('Angebot wird veröffentlicht...');
        setShowShareToast(true);
        const res = await ipc.portal.publishOffer({ offerId: selectedDocument.id });
        await navigator.clipboard.writeText(res.publicUrl);
        setToastMessage('Link kopiert!');
        await queryClient.invalidateQueries({ queryKey: ['offers'] });
        setTimeout(() => setShowShareToast(false), 3000);
      } catch (e) {
        setToastMessage(`Portal Fehler: ${String(e)}`);
        setTimeout(() => setShowShareToast(false), 5000);
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
      setToastMessage('Portal-URL fehlt – bitte in Einstellungen → Portal hinterlegen.');
      setShowShareToast(true);
      setTimeout(() => setShowShareToast(false), 4000);
      return;
    }
    void (async () => {
      try {
        await ipc.shell.openExternal({ url });
      } catch (e) {
        setToastMessage(`Link Fehler: ${String(e)}`);
        setShowShareToast(true);
        setTimeout(() => setShowShareToast(false), 5000);
      }
    })();
  };

  const handleSyncOfferDecision = () => {
    if (!selectedDocument) return;
    void (async () => {
      try {
        setToastMessage('Portal Status wird synchronisiert...');
        setShowShareToast(true);
        const res = await ipc.portal.syncOfferStatus({ offerId: selectedDocument.id });
        await queryClient.invalidateQueries({ queryKey: ['offers'] });
        setToastMessage(res.updated ? 'Status aktualisiert' : 'Keine Änderung');
        setTimeout(() => setShowShareToast(false), 2500);
      } catch (e) {
        setToastMessage(`Sync Fehler: ${String(e)}`);
        setTimeout(() => setShowShareToast(false), 5000);
      }
    })();
  };

  const handleConvertOfferToInvoice = () => {
    if (!selectedDocument || documentType !== 'offer') return;
    setShowConvertModal(true);
  };

  const handleOfferConverted = (newInvoiceId: string) => {
    setShowConvertModal(false);
    switchDocumentType('invoice');
    setTimeout(() => {
      setSelectedId(newInvoiceId);
      setViewMode('detail');
    }, 50);
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
          message: `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie ${documentType === 'invoice' ? 'Ihre Rechnung' : 'Ihr Angebot'} ${selectedDocument.number}.\n\nMit freundlichen Grüßen,\n${signature}`
      });
      setIsEmailModalOpen(true);
  };

  const handleSendEmail = () => {
      if(!selectedDocument) return;
      void (async () => {
        try {
          setIsEmailModalOpen(false);
          setToastMessage('E-Mail wird gesendet...');
          setShowShareToast(true);

          const result = await ipc.email.send({
            documentType,
            documentId: selectedDocument.id,
            recipientEmail: emailData.to,
            recipientName: selectedDocument.client,
            subject: emailData.subject,
            bodyText: emailData.message,
          });

          if (!result.success) {
            setToastMessage(`Fehler: ${result.error}`);
            setTimeout(() => setShowShareToast(false), 5000);
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

          setToastMessage('E-Mail erfolgreich versendet!');
          setTimeout(() => setShowShareToast(false), 3000);
        } catch (e) {
          setToastMessage(`Fehler: ${String(e)}`);
          setTimeout(() => setShowShareToast(false), 5000);
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
            setToastMessage('Rechnung als gestellt markiert');
            setShowShareToast(true);
            setTimeout(() => setShowShareToast(false), 3000);
          },
          onError: (error) => {
            setToastMessage(`Finalisieren fehlgeschlagen: ${String(error)}`);
            setShowShareToast(true);
            setTimeout(() => setShowShareToast(false), 5000);
          },
        },
      );
  };

  const handleFinalizeDraftOffer = () => {
    if (!selectedDocument || documentType !== 'offer' || selectedDocument.status !== 'draft') return;

    const historyEntry = {
      date: new Date().toISOString().split('T')[0] ?? '',
      action: 'Angebot gestellt (Status: Offen)',
    };

    upsertOffer.mutate(
      {
        offer: {
          ...selectedDocument,
          status: 'open',
          history: [historyEntry, ...(selectedDocument.history ?? [])],
        },
        reason: 'offer_finalize',
      },
      {
        onSuccess: () => {
          setToastMessage('Angebot als gestellt markiert');
          setShowShareToast(true);
          setTimeout(() => setShowShareToast(false), 3000);
        },
        onError: (error) => {
          setToastMessage(`Finalisieren fehlgeschlagen: ${String(error)}`);
          setShowShareToast(true);
          setTimeout(() => setShowShareToast(false), 5000);
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
      alert(firstError ? `${summary}\nErster Fehler: ${firstError}` : summary);
  };

  const handleCreateReminder = () => {
      if (!selectedDocument) return;
      const currentLevel = selectedDocument.dunningLevel || 0;
      const nextLevel = Math.min(currentLevel + 1, 3);
      const levelConfig = settings.dunning.levels.find(l => l.id === nextLevel);

      if (confirm(`${levelConfig?.name} erstellen für ${selectedDocument.number}?\nGebühr: ${formatCurrency(levelConfig?.fee || 0)}`)) {
          if (documentType === 'invoice') {
              const historyEntry = {
                  date: new Date().toISOString().split('T')[0],
                  action: `${levelConfig?.name} erstellt (+${formatCurrency(levelConfig?.fee || 0)})`
              };
              upsertInvoice.mutate({
                invoice: {
                  ...selectedDocument,
                  dunningLevel: nextLevel,
                  history: [...(selectedDocument.history ?? []), historyEntry],
                },
                reason: 'dunning_create',
              });
          }
      }
  };

  // --- Payment handlers ---
  const handleAddPayment = () => {
    const today = new Date().toISOString().split('T')[0] ?? '';
    setEditingPaymentId(null);
    setPaymentForm({ date: today, amount: '', method: 'Überweisung' });
    setPaymentReason('Zahlung erfasst');
    setPaymentError(null);
    setIsPaymentModalOpen(true);
  };

  const handleEditPayment = (p: Payment) => {
    setEditingPaymentId(p.id);
    setPaymentForm({
      date: p.date ?? '',
      amount: String(p.amount ?? ''),
      method: p.method ?? 'Überweisung',
    });
    setPaymentReason('');
    setPaymentError(null);
    setIsPaymentModalOpen(true);
  };

  const handleSavePayment = (updatedInvoice: Invoice, reason: string) => {
    upsertInvoice.mutate(
      { invoice: updatedInvoice, reason },
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
  };

  const handleDeletePayment = (id: string) => {
    setDeletingPaymentId(id);
    setPaymentDeleteReason('');
    setPaymentDeleteError(null);
    setIsPaymentDeleteOpen(true);
  };

  const handleConfirmDeletePayment = (updatedInvoice: Invoice, reason: string) => {
    upsertInvoice.mutate(
      { invoice: updatedInvoice, reason },
      {
        onSuccess: () => {
          setIsPaymentDeleteOpen(false);
          setDeletingPaymentId(null);
          setPaymentDeleteReason('');
          setPaymentDeleteError(null);
        },
      },
    );
  };

  // --- Print PDF handler ---
  const handlePrintPdf = () => {
    if (!selectedDocument) return;
    void (async () => {
      try {
        setToastMessage('PDF wird erstellt...');
        setShowShareToast(true);
        const res = await ipc.pdf.export({ kind: documentType, id: selectedDocument.id });
        await ipc.shell.openPath({ path: res.path });
        setToastMessage('PDF geöffnet');
        setTimeout(() => setShowShareToast(false), 2500);
      } catch (e) {
        setToastMessage(`PDF Fehler: ${String(e)}`);
        setTimeout(() => setShowShareToast(false), 5000);
      }
    })();
  };

  // --- Bulk export handler ---
  const handleBulkExport = (opts: { openFolderAfter?: boolean }) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    void (async () => {
      try {
        setToastMessage(`PDFs werden erstellt (0/${ids.length})...`);
        setShowShareToast(true);

        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          await ipc.pdf.export({ kind: documentType, id });
          setToastMessage(`PDFs werden erstellt (${i + 1}/${ids.length})...`);
        }

        setToastMessage(`PDFs erstellt: ${ids.length}`);
        if (opts.openFolderAfter) {
          await ipc.shell.openExportsDir();
        }
        setTimeout(() => setShowShareToast(false), 3000);
      } catch (e) {
        setToastMessage(`PDF Fehler: ${String(e)}`);
        setTimeout(() => setShowShareToast(false), 5000);
      }
    })();
  };

  // --- Bulk delete handler ---
  const handleBulkDeleteConfirm = () => {
    void (async () => {
      const reason = bulkDeleteReason.trim();
      if (!reason) return;

      setIsBulkDeleting(true);
      try {
        const ids = Array.from(selectedIds);
        setToastMessage(`Lösche ${ids.length} Einträge...`);
        setShowShareToast(true);

        for (const id of ids) {
          if (documentType === 'invoice') await deleteInvoice.mutateAsync({ id, reason });
          else await deleteOffer.mutateAsync({ id, reason });
        }

        clearSelection();
        setIsBulkDeleteOpen(false);
        setBulkDeleteReason('');

        setToastMessage(`${ids.length} Einträge gelöscht`);
        setTimeout(() => setShowShareToast(false), 3000);
      } catch (e) {
        setToastMessage(`Löschen fehlgeschlagen: ${String(e)}`);
        setTimeout(() => setShowShareToast(false), 5000);
      } finally {
        setIsBulkDeleting(false);
      }
    })();
  };

  // --- Detail View ---
  if (viewMode === 'detail' && selectedDocument) {
    return (
      <DetailView
        selectedDocument={selectedDocument}
        documentType={documentType}
        settings={settings}
        selectedDocumentItems={selectedDocumentItems}
        selectedDocumentNet={selectedDocumentNet}
        selectedDocumentVatRate={selectedDocumentVatRate}
        selectedDocumentVat={selectedDocumentVat}
        selectedDocumentGross={selectedDocumentGross}
        selectedPaymentTermsText={selectedPaymentTermsText}
        showShareToast={showShareToast}
        toastMessage={toastMessage}
        pdfLastPath={pdfLastPath}
        onOpenPdfPath={() => { if (pdfLastPath) void ipc.shell.openPath({ path: pdfLastPath }); }}
        setToastMessage={setToastMessage}
        setShowShareToast={setShowShareToast}
        onBack={() => setViewMode('list')}
        onEditInvoice={onEditInvoice}
        onEmail={handleOpenEmail}
        onDownloadPdf={handleDownloadPdf}
        onFinalizeDraftInvoice={handleFinalizeDraftInvoice}
        onFinalizeDraftOffer={handleFinalizeDraftOffer}
        onConvertOfferToInvoice={handleConvertOfferToInvoice}
        onPublishOffer={handlePublishOffer}
        onOpenOfferLink={handleOpenOfferLink}
        onSyncOfferDecision={handleSyncOfferDecision}
        onPrintPdf={handlePrintPdf}
        onSharePaymentLink={handleSharePaymentLink}
        sumPayments={sumPayments}
        onCreateReminder={handleCreateReminder}
        onAddPayment={handleAddPayment}
        onEditPayment={handleEditPayment}
        onDeletePayment={handleDeletePayment}
        emailModal={
          <EmailModal
            isOpen={isEmailModalOpen}
            onClose={() => setIsEmailModalOpen(false)}
            emailData={emailData}
            setEmailData={setEmailData}
            selectedDocument={selectedDocument}
            onSend={handleSendEmail}
          />
        }
        paymentModal={
          <PaymentModal
            isOpen={isPaymentModalOpen}
            onClose={() => setIsPaymentModalOpen(false)}
            editingPaymentId={editingPaymentId}
            setEditingPaymentId={setEditingPaymentId}
            paymentForm={paymentForm}
            setPaymentForm={setPaymentForm}
            paymentReason={paymentReason}
            setPaymentReason={setPaymentReason}
            paymentError={paymentError}
            setPaymentError={setPaymentError}
            selectedDocument={selectedDocument}
            onSave={handleSavePayment}
          />
        }
        paymentDeleteModal={
          <PaymentDeleteModal
            isOpen={isPaymentDeleteOpen}
            onClose={() => setIsPaymentDeleteOpen(false)}
            selectedDocument={selectedDocument}
            deletingPaymentId={deletingPaymentId}
            paymentDeleteReason={paymentDeleteReason}
            setPaymentDeleteReason={setPaymentDeleteReason}
            paymentDeleteError={paymentDeleteError}
            setPaymentDeleteError={setPaymentDeleteError}
            onDelete={handleConfirmDeletePayment}
          />
        }
        convertModal={
          showConvertModal && documentType === 'offer' ? (
            <ConvertOfferModal
              offer={selectedDocument}
              settings={settings}
              ipc={ipc}
              queryClient={queryClient}
              onClose={() => setShowConvertModal(false)}
              onConverted={handleOfferConverted}
            />
          ) : null
        }
      />
    );
  }

  // --- List View ---
  return (
    <div className="bg-surface rounded-xl p-8 min-h-full shadow-sm flex flex-col relative animate-enter">
      <DunningModal
        isOpen={isDunningModalOpen}
        onClose={() => setIsDunningModalOpen(false)}
        overdueInvoices={overdueInvoices}
        settings={settings}
        selectedForDunning={selectedForDunning}
        setSelectedForDunning={setSelectedForDunning}
        validSelectedForDunning={validSelectedForDunning}
        isDunningProcessing={isDunningProcessing}
        onProcess={() => void handleProcessDunningRun()}
      />
      <EmailModal
        isOpen={isEmailModalOpen}
        onClose={() => setIsEmailModalOpen(false)}
        emailData={emailData}
        setEmailData={setEmailData}
        selectedDocument={selectedDocument!}
        onSend={handleSendEmail}
      />
      <PaymentModal
        isOpen={isPaymentModalOpen}
        onClose={() => setIsPaymentModalOpen(false)}
        editingPaymentId={editingPaymentId}
        setEditingPaymentId={setEditingPaymentId}
        paymentForm={paymentForm}
        setPaymentForm={setPaymentForm}
        paymentReason={paymentReason}
        setPaymentReason={setPaymentReason}
        paymentError={paymentError}
        setPaymentError={setPaymentError}
        selectedDocument={selectedDocument!}
        onSave={handleSavePayment}
      />
      <PaymentDeleteModal
        isOpen={isPaymentDeleteOpen}
        onClose={() => setIsPaymentDeleteOpen(false)}
        selectedDocument={selectedDocument!}
        deletingPaymentId={deletingPaymentId}
        paymentDeleteReason={paymentDeleteReason}
        setPaymentDeleteReason={setPaymentDeleteReason}
        paymentDeleteError={paymentDeleteError}
        setPaymentDeleteError={setPaymentDeleteError}
        onDelete={handleConfirmDeletePayment}
      />
      <BulkDeleteModal
        isOpen={isBulkDeleteOpen}
        onClose={() => setIsBulkDeleteOpen(false)}
        count={selectedIds.size}
        bulkDeleteReason={bulkDeleteReason}
        setBulkDeleteReason={setBulkDeleteReason}
        isBulkDeleting={isBulkDeleting}
        onConfirm={handleBulkDeleteConfirm}
      />
      {showConvertModal && selectedDocument && documentType === 'offer' && (
        <ConvertOfferModal
          offer={selectedDocument}
          settings={settings}
          ipc={ipc}
          queryClient={queryClient}
          onClose={() => setShowConvertModal(false)}
          onConverted={handleOfferConverted}
        />
      )}

      {/* Toast Notification for List View */}
      {showShareToast && viewMode === 'list' && (
          <div className="absolute top-8 right-8 bg-foreground text-accent px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 z-50 animate-in fade-in slide-in-from-top-2">
              <Check size={16} />
              <span className="text-sm font-bold">{toastMessage}</span>
              {pdfLastPath && toastMessage === 'PDF gespeichert' && (
                <button
                  onClick={() => void ipc.shell.openPath({ path: pdfLastPath })}
                  className="ml-2 text-xs font-bold underline underline-offset-2 opacity-80 hover:opacity-100 transition-opacity ease-out duration-150"
                >
                  Öffnen
                </button>
              )}
          </div>
      )}

       <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
           {/* Document Type Dropdown */}
           <div className="relative">
                <button
                    onClick={() => setIsTypeDropdownOpen(!isTypeDropdownOpen)}
                    className="flex items-center gap-2 text-3xl font-bold text-foreground hover:opacity-70 transition-opacity ease-out duration-150"
                >
                    {documentType === 'invoice' ? 'Rechnungen' : 'Angebote'}
                    <ChevronDown size={28} className={`transition-transform duration-300 ${isTypeDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {isTypeDropdownOpen && (
                    <div className="absolute top-full left-0 mt-2 w-56 bg-surface rounded-xl shadow-xl border border-border-subtle p-2 z-50 animate-in fade-in zoom-in-95 duration-200">
                        <button
                            onClick={() => switchDocumentType('invoice')}
                            className={`w-full text-left px-4 py-3 rounded-lg font-bold text-sm transition-colors ease-out duration-150 flex items-center justify-between ${documentType === 'invoice' ? 'bg-foreground text-white' : 'hover:bg-surface-muted text-foreground'}`}
                        >
                            Rechnungen
                            {documentType === 'invoice' && <Check size={16} />}
                        </button>
                        <button
                            onClick={() => switchDocumentType('offer')}
                            className={`w-full text-left px-4 py-3 rounded-lg font-bold text-sm transition-colors ease-out duration-150 flex items-center justify-between ${documentType === 'offer' ? 'bg-foreground text-white' : 'hover:bg-surface-muted text-foreground'}`}
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
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ease-out duration-150 ${filter === s ? 'bg-foreground text-white shadow-lg' : 'bg-canvas text-muted hover:bg-surface-muted'}`}
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
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" size={18} />
                <input
                    type="text"
                    placeholder="Suchen..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-12 pr-6 py-3 bg-surface-muted border-none rounded-full text-sm font-bold outline-none w-64 focus:ring-2 focus:ring-accent transition-[background-color,border-color,color,box-shadow,transform,opacity] ease-out duration-150"
                />
           </div>

           <button
             onClick={onOpenTemplates}
             className="px-4 py-3 rounded-full bg-canvas text-foreground hover:bg-surface-muted transition-colors ease-out duration-150 font-bold text-sm flex items-center gap-2"
             title="Vorlagen verwalten"
           >
             <LayoutTemplate size={18} />
             Vorlagen
           </button>

           <button
             onClick={onOpenRecurring}
             className="px-4 py-3 rounded-full bg-canvas text-foreground hover:bg-surface-muted transition-colors ease-out duration-150 font-bold text-sm flex items-center gap-2"
             title="Abos / Serien-Dokumente"
           >
             <RefreshCw size={18} />
             Abos
           </button>
           <button
             onClick={() => onCreateInvoice(documentType)}
             className="w-12 h-12 bg-accent text-accent-foreground rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-[background-color,border-color,color,box-shadow,transform,opacity] shadow-lg hover:bg-accent-hover"
             title={documentType === 'invoice' ? "Neue Rechnung" : "Neues Angebot"}
           >
             <Plus size={24} />
           </button>
         </div>
       </div>

       {isSelecting && (
         <SelectionBar
           selectedIds={selectedIds}
           documentType={documentType}
           onToggleSelectAll={toggleSelectAllFiltered}
           onClearSelection={clearSelection}
           onBulkExport={handleBulkExport}
           onBulkDelete={() => setIsBulkDeleteOpen(true)}
         />
       )}

       <div className="space-y-3 flex-1 overflow-y-auto pt-2 px-1 -mx-1">
           {isLoading ? (
             <SkeletonLoader variant="list" count={5} />
           ) : filteredDocuments.length > 0 ? filteredDocuments.map((doc, idx) => (
               <DocumentListItem
                 key={doc.id}
                 doc={doc}
                 documentType={documentType}
                 isSelected={selectedIds.has(doc.id)}
                 isSelecting={isSelecting}
                 onToggleSelect={() => toggleSelected(doc.id)}
                 onOpenDetail={() => handleOpenDetail(doc.id)}
                 onEditInvoice={onEditInvoice}
                 animationDelay={idx * 50}
               />
           )) : searchTerm || filter !== 'all' ? (
               /* NO-RESULTS state */
               <div className="flex flex-col items-center justify-center h-64 text-muted">
                   <FileText size={48} className="mb-4 opacity-20" />
                   <p className="font-bold text-foreground mb-1">Keine Treffer</p>
                   <p className="text-sm text-muted mb-4">Kein Dokument entspricht der aktuellen Suche oder Filterung.</p>
                   <button
                     onClick={() => { setSearchTerm(''); setFilter('all'); }}
                     className="px-4 py-2 rounded-full bg-canvas text-foreground hover:bg-surface-muted transition-colors ease-out duration-150 font-bold text-xs"
                   >
                     Filter zurücksetzen
                   </button>
               </div>
           ) : (
               /* EMPTY state */
               <div className="flex flex-col items-center justify-center h-64 text-muted">
                   <FileText size={48} className="mb-4 opacity-20" />
                   <p className="font-bold text-foreground mb-1">
                     {documentType === 'invoice' ? 'Noch keine Rechnungen' : 'Noch keine Angebote'}
                   </p>
                   <p className="text-sm text-muted mb-4">
                     {documentType === 'invoice'
                       ? 'Erstelle deine erste Rechnung und behalte den Überblick über deine Einnahmen.'
                       : 'Erstelle dein erstes Angebot und sende es direkt an deine Kunden.'}
                   </p>
                   <button
                     onClick={() => onCreateInvoice(documentType)}
                     className="px-5 py-2.5 rounded-full bg-foreground text-white hover:bg-dark-1 transition-colors ease-out duration-150 font-bold text-sm"
                   >
                     {documentType === 'invoice' ? '+ Erste Rechnung erstellen' : '+ Erstes Angebot erstellen'}
                   </button>
               </div>
           )}
       </div>
    </div>
  );
};
