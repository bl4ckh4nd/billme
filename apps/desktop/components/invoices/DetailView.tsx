import React from 'react';
import {
  ArrowLeft, Check, Edit3, Download, Mail, CheckCircle, Link, ExternalLink, RefreshCw,
  MoreHorizontal, Share2, Printer, ArrowRight, AlertTriangle, Clock,
} from 'lucide-react';
import { Badge, Button } from '@billme/ui';
import { Invoice, InvoiceTaxSnapshot, InvoiceTaxModeDefinition, InvoiceItem, Payment, AppSettings } from '../../types';
import { getDunningBadge, formatDate } from './helpers';
import { DocumentPreview } from './DocumentPreview';
import { PaymentsSidebarCard } from './PaymentsSidebarCard';

interface DetailViewProps {
  // Core data
  selectedDocument: Invoice;
  documentType: 'invoice' | 'offer';
  settings: AppSettings;
  // Derived values
  selectedDocumentItems: InvoiceItem[];
  selectedDocumentTax: InvoiceTaxSnapshot | null;
  selectedTaxDefinition: InvoiceTaxModeDefinition | null;
  selectedTaxExemptionReason: string | undefined;
  selectedPaymentTermsText: string;
  // Navigation
  onBack: () => void;
  onEditInvoice: (invoice: Invoice, type: 'invoice' | 'offer') => void;
  // Toast
  showShareToast: boolean;
  toastMessage: string;
  pdfLastPath: string | null;
  onOpenPath: (path: string) => void;
  setToastMessage: React.Dispatch<React.SetStateAction<string>>;
  setShowShareToast: React.Dispatch<React.SetStateAction<boolean>>;
  // Toolbar actions
  onEmail: () => void;
  onDownloadPdf: () => void;
  onFinalizeDraftInvoice: () => void;
  onFinalizeDraftOffer: () => void;
  onPublishOffer: () => void;
  onOpenOfferLink: () => void;
  onSyncOfferDecision: () => void;
  onConvertOfferToInvoice: () => void;
  onSharePaymentLink: () => void;
  onPrintPdf: () => void;
  // Dunning
  onCreateReminder: () => void;
  // Payments sidebar
  sumPayments: (doc: Invoice) => number;
  onAddPayment: () => void;
  onEditPayment: (payment: Payment) => void;
  onDeletePayment: (id: string) => void;
  // Modal slots
  emailModal: React.ReactNode;
  paymentModal: React.ReactNode;
  paymentDeleteModal: React.ReactNode;
  convertModal: React.ReactNode;
}

export const DetailView: React.FC<DetailViewProps> = ({
  selectedDocument,
  documentType,
  settings,
  selectedDocumentItems,
  selectedDocumentTax,
  selectedTaxDefinition,
  selectedTaxExemptionReason,
  selectedPaymentTermsText,
  onBack,
  onEditInvoice,
  showShareToast,
  toastMessage,
  pdfLastPath,
  onOpenPath,
  setToastMessage,
  setShowShareToast,
  onEmail,
  onDownloadPdf,
  onFinalizeDraftInvoice,
  onFinalizeDraftOffer,
  onPublishOffer,
  onOpenOfferLink,
  onSyncOfferDecision,
  onConvertOfferToInvoice,
  onSharePaymentLink,
  onPrintPdf,
  onCreateReminder,
  sumPayments,
  onAddPayment,
  onEditPayment,
  onDeletePayment,
  emailModal,
  paymentModal,
  paymentDeleteModal,
  convertModal,
}) => {
  const [isToolbarOverflowOpen, setIsToolbarOverflowOpen] = React.useState(false);
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

  return (
    <div className="bg-surface rounded-xl p-8 min-h-full shadow-sm animate-enter relative">

        {emailModal}
        {paymentModal}
        {paymentDeleteModal}
        {convertModal}

        {/* Toast Notification */}
        {showShareToast && (
            <div className="absolute top-8 right-8 bg-black text-accent px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 z-50 animate-in fade-in slide-in-from-top-2">
                <Check size={16} />
                <span className="text-sm font-bold">{toastMessage}</span>
                {pdfLastPath && toastMessage === 'PDF gespeichert' && (
                  <button
                    onClick={() => onOpenPath(pdfLastPath)}
                    className="ml-2 text-xs font-bold underline underline-offset-2 opacity-80 hover:opacity-100 transition-opacity"
                  >
                    Öffnen
                  </button>
                )}
            </div>
        )}

        {/* Navigation & Title */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6 mb-8 border-b border-border-subtle pb-8">
            <div className="flex items-start gap-4">
                <button
                  onClick={onBack}
                  className="w-10 h-10 rounded-full border border-border flex items-center justify-center hover:bg-foreground hover:text-surface transition-colors ease-out duration-150 shrink-0"
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

            {/* Actions Toolbar — tiered: primary → secondary → overflow */}
            <div className="flex flex-wrap items-center gap-2">
                {/* Convert to Invoice — prominent CTA for accepted offers */}
                {documentType === 'offer' && ['open', 'accepted'].includes(selectedDocument.status ?? '') && (
                  <>
                    <Button
                      onClick={onConvertOfferToInvoice}
                      size="md"
                      title="Angebot in Rechnung umwandeln"
                    >
                      <ArrowRight size={16} />
                      In Rechnung umwandeln
                    </Button>
                    <div className="w-px h-6 bg-border mx-1" />
                  </>
                )}

                {/* PRIMARY: labeled action buttons */}
                <button
                  onClick={() => onEditInvoice(selectedDocument, documentType)}
                  className="h-10 px-4 bg-canvas hover:bg-surface-muted text-foreground rounded-full font-bold text-xs transition-colors ease-out duration-150 flex items-center gap-2"
                >
                  <Edit3 size={14} /> Bearbeiten
                </button>
                <Button onClick={onEmail} size="md">
                  <Mail size={16} /> Senden
                </Button>
                <button
                  onClick={onDownloadPdf}
                  className="h-10 px-4 bg-surface border border-border hover:bg-surface-muted text-foreground rounded-full font-bold text-xs transition-colors ease-out duration-150 flex items-center gap-2"
                  title="PDF herunterladen"
                >
                  <Download size={14} /> PDF
                </button>

                {/* SECONDARY: icon buttons */}
                <div className="w-px h-6 bg-border mx-1" />

                {documentType === 'invoice' && selectedDocument.status === 'draft' && (
                  <button
                    onClick={onFinalizeDraftInvoice}
                    className="h-10 w-10 bg-surface border border-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors ease-out duration-150"
                    title="Als gestellt markieren (Entwurf → Offen)"
                  >
                    <CheckCircle size={18} />
                  </button>
                )}

                {documentType === 'offer' && selectedDocument.status === 'draft' && (
                  <button
                    onClick={onFinalizeDraftOffer}
                    className="h-10 w-10 bg-surface border border-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors ease-out duration-150"
                    title="Als gestellt markieren (Entwurf → Offen)"
                  >
                    <CheckCircle size={18} />
                  </button>
                )}

                {documentType === 'offer' && (
                  <>
                    {!selectedDocument.shareToken ? (
                      <button
                        onClick={onPublishOffer}
                        className="h-10 px-3 bg-foreground text-accent rounded-full font-bold text-xs transition-colors ease-out duration-150 flex items-center gap-1.5 hover:bg-dark-1"
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
                              setToastMessage('Portal-URL fehlt – bitte in Einstellungen → Portal hinterlegen.');
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
                          className="h-10 w-10 bg-surface border border-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors ease-out duration-150"
                          title="Link kopieren"
                        >
                          <Link size={18} />
                        </button>
                        <button
                          onClick={onOpenOfferLink}
                          className="h-10 w-10 bg-surface border border-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors ease-out duration-150"
                          title="Im Browser öffnen"
                        >
                          <ExternalLink size={18} />
                        </button>
                        <button
                          onClick={onSyncOfferDecision}
                          className="h-10 w-10 bg-surface border border-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors ease-out duration-150"
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
                    className="h-10 w-10 bg-surface border border-border hover:bg-surface-muted text-foreground rounded-full flex items-center justify-center transition-colors ease-out duration-150"
                    title="Weitere Aktionen"
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {isToolbarOverflowOpen && (
                    <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-xl shadow-xl p-1.5 z-50 min-w-[180px]">
                      <button
                        onClick={() => {
                          setIsToolbarOverflowOpen(false);
                          onPrintPdf();
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-surface-muted rounded-lg flex items-center gap-2 transition-colors ease-out duration-150"
                      >
                        <Printer size={14} /> Drucken / PDF öffnen
                      </button>
                      <button
                        onClick={() => { setIsToolbarOverflowOpen(false); onSharePaymentLink(); }}
                        className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-surface-muted rounded-lg flex items-center gap-2 transition-colors ease-out duration-150"
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
                 <DocumentPreview
                   selectedDocument={selectedDocument}
                   selectedDocumentItems={selectedDocumentItems}
                   selectedDocumentTax={selectedDocumentTax}
                   selectedPaymentTermsText={selectedPaymentTermsText}
                   documentType={documentType}
                 />
            </div>

            {/* Right Column: Sidebar */}
            <div className="space-y-6">

                {/* Status Card */}
                <div className="bg-surface border border-border-subtle rounded-xl p-6 shadow-sm">
                    <h4 className="font-bold text-sm text-foreground mb-4 flex items-center gap-2">
                        <CheckCircle size={16} className="text-accent fill-black" /> Status
                    </h4>
                    {selectedDocument.status === 'overdue' && (
                        <div className="bg-error-bg rounded-xl p-4 mb-4 border border-error/30">
                            <div className="flex items-start gap-3">
                                <AlertTriangle size={18} className="text-error mt-0.5" />
                                <div>
                                    <p className="text-xs font-bold text-error mb-1">Zahlung überfällig</p>
                                    <button
                                      onClick={onCreateReminder}
                                      className="text-[10px] font-bold bg-surface border border-error/30 text-error px-2 py-1 rounded-sm hover:bg-error-bg transition-colors ease-out duration-150"
                                    >
                                        Mahnung erstellen
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted mb-2">
                         <div className={`w-2 h-2 rounded-full ${selectedDocument.status === 'paid' ? 'bg-success' : 'bg-border'}`}></div>
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
                    <div className="mt-3 border-t border-border-subtle pt-3">
                      <p className="text-[10px] font-bold text-muted uppercase tracking-wider mb-2">Steuerbehandlung</p>
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
                  <PaymentsSidebarCard
                    selectedDocument={selectedDocument}
                    selectedDocumentTax={selectedDocumentTax}
                    sumPayments={sumPayments}
                    onAddPayment={onAddPayment}
                    onEditPayment={onEditPayment}
                    onDeletePayment={onDeletePayment}
                  />
                )}

                {/* Internal Notes */}
                <div className="bg-surface-muted border border-border-subtle rounded-xl p-6">
                    <h4 className="font-bold text-sm text-foreground mb-3 flex items-center gap-2">
                        Interne Notiz
                    </h4>
                    <textarea
                        className="w-full bg-surface border border-border rounded-lg p-3 text-xs text-muted outline-none resize-none focus:ring-2 focus:ring-accent transition-shadow ease-out duration-150"
                        rows={3}
                        placeholder="Notiz zu diesem Vorgang..."
                    />
                </div>

                {/* Timeline */}
                <div className="bg-surface border border-border-subtle rounded-xl p-6 shadow-sm">
                    <h4 className="font-bold text-sm text-foreground mb-4 flex items-center gap-2">
                        <Clock size={16} className="text-muted" /> Verlauf
                    </h4>
                    <div className="space-y-4 relative pl-2 border-l border-border-subtle ml-1">
                        {selectedDocument.history && selectedDocument.history.length > 0 ? selectedDocument.history.map((h, i) => (
                            <div key={i} className="pl-4 relative">
                                <div className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-border border-2 border-surface"></div>
                                <p className="text-[10px] font-bold text-muted uppercase tracking-wide">{formatDate(h.date)}</p>
                                <p className="text-xs font-medium text-foreground">{h.action}</p>
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
};
