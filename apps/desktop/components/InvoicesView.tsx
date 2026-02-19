
import React, { useState } from 'react';
import {
  Search, Plus, FileText,
  Clock, ArrowLeft,
  Share2, Check,
  ChevronDown, ArrowUpRight,
  AlertTriangle, Mail, Gavel, CheckCircle, X,
  Download, Printer, Send, Paperclip, MoreHorizontal, Calendar, User, RefreshCw, Link, ExternalLink, Trash2, LayoutTemplate, Edit3, Euro, ArrowRight
} from 'lucide-react';
import { Badge, Button } from '@billme/ui';
import { Invoice, InvoiceStatus, AppSettings } from '../types';
import { MOCK_SETTINGS } from '../data/mockData';
import { useDeleteInvoiceMutation, useInvoicesQuery, useUpsertInvoiceMutation } from '../hooks/useInvoices';
import { useDeleteOfferMutation, useOffersQuery, useUpsertOfferMutation } from '../hooks/useOffers';
import { useSettingsQuery } from '../hooks/useSettings';
import { ipc } from '../ipc/client';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { Spinner } from './Spinner';
import { SkeletonLoader } from './SkeletonLoader';

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
          setToastMessage(`PDF gespeichert: ${res.path}`);
          setTimeout(() => setShowShareToast(false), 3500);
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
      setToastMessage('Portal Base URL fehlt (Settings -> Portal)');
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
    void (async () => {
      try {
        setToastMessage('Rechnung wird erstellt...');
        setShowShareToast(true);
        const newInvoice = await ipc.documents.convertOfferToInvoice({ offerId: selectedDocument.id });
        await queryClient.invalidateQueries({ queryKey: ['invoices'] });
        setToastMessage('Rechnung erfolgreich erstellt!');
        setTimeout(() => {
          setShowShareToast(false);
          // Switch to invoices view and open the new invoice
          switchDocumentType('invoice');
          setTimeout(() => {
            setSelectedId(newInvoice.id);
            setViewMode('detail');
          }, 100);
        }, 1500);
      } catch (e) {
        setToastMessage(`Fehler: ${String(e)}`);
        setTimeout(() => setShowShareToast(false), 5000);
      }
    })();
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
      setEmailData({
          to: selectedDocument.clientEmail,
          subject: `${documentType === 'invoice' ? 'Rechnung' : 'Angebot'} ${selectedDocument.number}`,
          message: `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie ${documentType === 'invoice' ? 'Ihre Rechnung' : 'Ihr Angebot'} ${selectedDocument.number}.\n\nMit freundlichen Grüßen,\nMustermann GmbH`
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


  // --- Dunning Modal ---
  const renderDunningModal = () => {
      if (!isDunningModalOpen) return null;

      return (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
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
                          {isDunningProcessing ? 'Sende...' : `${validSelectedForDunning.length} Mahnungen versenden`}
                      </Button>
                  </div>
              </div>
          </div>
      );
  };

  // --- Email Modal ---
  const renderEmailModal = () => {
    if (!isEmailModalOpen) return null;
    return (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
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
    );
  };

  const renderPaymentModal = () => {
    if (!isPaymentModalOpen) return null;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
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
    );
  };

  const renderPaymentDeleteModal = () => {
    if (!isPaymentDeleteOpen) return null;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
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
    );
  };

  // --- Detail View ---
  if (viewMode === 'detail' && selectedDocument) {
      return (
          <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm animate-enter relative">
              
              {renderEmailModal()}
              {renderPaymentModal()}
              {renderPaymentDeleteModal()}

              {/* Toast Notification */}
              {showShareToast && (
                  <div className="absolute top-8 right-8 bg-black text-accent px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 z-50 animate-in fade-in slide-in-from-top-2">
                      <Check size={16} />
                      <span className="text-sm font-bold">{toastMessage}</span>
                  </div>
              )}

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
                                {documentType === 'offer' && (
                                    <span className="bg-purple-100 text-purple-700 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">Angebot</span>
                                )}
                           </div>
                      </div>
                  </div>

                  {/* Actions Toolbar */}
                  <div className="flex flex-wrap items-center gap-2">
                      {/* Convert to Invoice - Prominent action for accepted offers */}
                      {documentType === 'offer' && selectedDocument.shareDecision === 'accepted' && (
                        <>
                          <Button
                            onClick={handleConvertOfferToInvoice}
                            size="md"
                            title="Angebot in Rechnung umwandeln"
                          >
                            <ArrowRight size={16} />
                            In Rechnung umwandeln
                          </Button>
                          <div className="w-px h-6 bg-gray-200 mx-1"></div>
                        </>
                      )}
                      <button
                        onClick={() => onEditInvoice(selectedDocument, documentType)}
                        className="h-10 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full font-bold text-xs transition-colors flex items-center gap-2"
                      >
                          Bearbeiten
                      </button>
                      {documentType === 'invoice' && selectedDocument.status === 'draft' && (
                        <button
                          onClick={handleFinalizeDraftInvoice}
                          className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                          title="Als gestellt markieren (Entwurf -> Offen)"
                        >
                          <CheckCircle size={18} />
                        </button>
                      )}
                      {documentType === 'offer' && (
                        <>
                          <div className="w-px h-6 bg-gray-200 mx-1"></div>
                          {!selectedDocument.shareToken ? (
                            <button
                              onClick={handlePublishOffer}
                              className="h-10 px-4 bg-black text-accent rounded-full font-bold text-xs transition-colors flex items-center gap-2 hover:bg-gray-800"
                              title="Öffentlichen Link erzeugen"
                            >
                              <Link size={16} /> Veröffentlichen
                            </button>
                          ) : (
                            <>
                              <button
                              onClick={async () => {
                                if (!selectedDocument.shareToken) return;
                                const baseUrl = settings.portal.baseUrl?.trim();
                                if (!baseUrl) {
                                  setToastMessage('Portal Base URL fehlt (Settings → Portal)');
                                  setShowShareToast(true);
                                  setTimeout(() => setShowShareToast(false), 4000);
                                  return;
                                }
                                try {
                                  await navigator.clipboard.writeText(`${baseUrl.replace(/\/+$/, '')}/offers/${selectedDocument.shareToken}`);
                                  setToastMessage('Link kopiert!');
                                } catch (error) {
                                  setToastMessage(`Kopieren fehlgeschlagen: ${String(error)}`);
                                }
                                setShowShareToast(true);
                                setTimeout(() => setShowShareToast(false), 2500);
                              }}
                              className="h-10 px-4 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full font-bold text-xs transition-colors flex items-center gap-2"
                              title="Link kopieren"
                            >
                              <Link size={16} /> Link
                            </button>
                              <button
                              onClick={handleOpenOfferLink}
                              className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                              title="Link im Browser öffnen"
                            >
                              <ExternalLink size={18} />
                            </button>
                            </>
                          )}
                          {selectedDocument.shareToken && (
                            <button
                              onClick={handleSyncOfferDecision}
                              className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                              title="Portal-Status synchronisieren"
                            >
                              <RefreshCw size={18} />
                            </button>
                          )}
                        </>
                      )}
                      <div className="w-px h-6 bg-gray-200 mx-1"></div>
                      <button 
                        onClick={handleDownloadPdf}
                        className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                        title="PDF Herunterladen"
                      >
                          <Download size={18} />
                      </button>
                      <button 
                        className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                        title="Drucken"
                        onClick={() => {
                          if (!selectedDocument) return;
                          void (async () => {
                            try {
                              setToastMessage('PDF wird erstellt...');
                              setShowShareToast(true);
                              const res = await ipc.pdf.export({
                                kind: documentType,
                                id: selectedDocument.id,
                              });
                              await ipc.shell.openPath({ path: res.path });
                              setToastMessage('PDF geöffnet');
                              setTimeout(() => setShowShareToast(false), 2500);
                            } catch (e) {
                              setToastMessage(`PDF Fehler: ${String(e)}`);
                              setTimeout(() => setShowShareToast(false), 5000);
                            }
                          })();
                        }}
                      >
                          <Printer size={18} />
                      </button>
                      <button 
                        onClick={handleSharePaymentLink}
                        className="h-10 w-10 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-full flex items-center justify-center transition-colors"
                        title="Link kopieren"
                      >
                          <Share2 size={18} />
                      </button>
                      <Button
                        onClick={handleOpenEmail}
                        size="md"
                      >
                          <Mail size={16} />
                          Senden
                      </Button>
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
                                       <span className="font-mono">{formatCurrency(selectedDocument.amount / 1.19)}</span>
                                   </div>
                                   <div className="flex justify-between text-sm text-gray-500">
                                       <span>MwSt 19%</span>
                                       <span className="font-mono">{formatCurrency(selectedDocument.amount - (selectedDocument.amount / 1.19))}</span>
                                   </div>
                                   <div className="flex justify-between text-xl font-bold text-gray-900 border-t border-gray-200 pt-3 mt-1">
                                       <span>Gesamt</span>
                                       <span className="font-mono">{formatCurrency(selectedDocument.amount)}</span>
                                   </div>
                               </div>
                          </div>
                       </div>
                  </div>

                  {/* Right Column: Sidebar */}
                  <div className="space-y-6">
                      
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
                               {selectedDocument.status === 'paid' ? 'Bezahlt am 28.10.2023' : 'Noch nicht bezahlt'}
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
                            const remaining = Math.max(0, (Number(selectedDocument.amount) || 0) - paid);
                            const pct =
                              (Number(selectedDocument.amount) || 0) > 0
                                ? Math.min(1, paid / (Number(selectedDocument.amount) || 1))
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
      <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
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
              }}
              disabled={isBulkDeleting || bulkDeleteReason.trim().length === 0}
              className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              <Trash2 size={16} /> Löschen
            </button>
          </div>
        </div>
      </div>
    );
  };

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

  return (
    <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm flex flex-col relative animate-enter">
      {renderDunningModal()}
      {renderEmailModal()}
      {renderPaymentModal()}
      {renderPaymentDeleteModal()}
      {renderBulkDeleteModal()}

      {/* Toast Notification for List View */}
      {showShareToast && viewMode === 'list' && (
          <div className="absolute top-8 right-8 bg-black text-accent px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 z-50 animate-in fade-in slide-in-from-top-2">
              <Check size={16} />
              <span className="text-sm font-bold">{toastMessage}</span>
          </div>
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
                {(['all', 'open', 'paid', 'overdue'] as const).map(s => (
                    <button 
                        key={s}
                        onClick={() => setFilter(s)}
                        className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${filter === s ? 'bg-black text-white shadow-lg' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                    >
                        {s === 'all' ? 'Alle' : s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                ))}
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
                          <p className="text-xs font-bold text-gray-400 truncate">{doc.client}</p>
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
                  <p className="font-medium">Keine {documentType === 'invoice' ? 'Rechnungen' : 'Angebote'} gefunden</p>
              </div>
          )}
      </div>
    </div>
  );
};
