
import React, { useState, useEffect, useMemo } from 'react';
import type { AppSettings, Article, Client, Invoice, InvoiceElement, InvoiceItem } from '../types';
import { CanvasElement } from './CanvasElement';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE, A4_WIDTH_PX, A4_HEIGHT_PX } from '../constants';
import { ArrowLeft, Save, Plus, Trash2, Calendar, User, FileText, Calculator, Euro, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { MOCK_SETTINGS } from '../data/mockData';
import { ElementType } from '../types';
import { getPreviewElements } from '../utils/documentPreview';
import { useSettingsQuery } from '../hooks/useSettings';
import { useActiveTemplateQuery } from '../hooks/useTemplates';
import { useClientsQuery } from '../hooks/useClients';
import { useArticlesQuery } from '../hooks/useArticles';
import { useProjectsQuery } from '../hooks/useProjects';
import { formatAddressMultiline } from '../utils/formatters';
import { useUiStore } from '../state/uiStore';
import {
  calculateInvoiceTaxSnapshot,
  INVOICE_TAX_MODE_DEFINITIONS,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';

interface InvoiceDocumentEditorProps {
  invoice: Invoice;
  templateType?: 'invoice' | 'offer';
  mode?: 'create' | 'edit';
  onSave: (invoice: Invoice) => void;
  onCancel: () => void;
}

const formatDate = (dateString: string) => {
  if (!dateString) return '';
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export const InvoiceDocumentEditor: React.FC<InvoiceDocumentEditorProps> = ({
  invoice,
  templateType = 'invoice',
  mode = 'edit',
  onSave,
  onCancel,
}) => {
  const currencyFormatter = useMemo(() => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }), []);
  const formatCurrency = (amount: number) => currencyFormatter.format(amount);
  const [formData, setFormData] = useState<Invoice>(invoice);
  const sidebarCollapsed = useUiStore((s) => s.editorSidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setEditorSidebarCollapsed);
  const { data: clients = [] } = useClientsQuery();
  const { data: articles = [] } = useArticlesQuery();
  const { data: settingsFromDb } = useSettingsQuery();
  const effectiveSettings = settingsFromDb ?? MOCK_SETTINGS;
  const { data: activeTemplate } = useActiveTemplateQuery(templateType);
  const effectiveTemplate: InvoiceElement[] =
    (activeTemplate?.elements as InvoiceElement[] | undefined) ?? (templateType === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE);
  const [selectedClientId, setSelectedClientId] = useState<string>(invoice.clientId ?? '');
  const [isNumberLocked, setIsNumberLocked] = useState<boolean>(mode === 'edit');
  const [articleToAddId, setArticleToAddId] = useState<string>('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const { data: projects = [] } = useProjectsQuery(
    selectedClientId ? { clientId: selectedClientId, includeArchived: false } : undefined,
  );
  const projectTouchedRef = React.useRef(false);

  const previewElements = useMemo(() => {
      return getPreviewElements(formData, effectiveTemplate, effectiveSettings);
  }, [formData, effectiveSettings, effectiveTemplate]);

  const categoryOptions = useMemo(() => {
      const fromSettings = (effectiveSettings.catalog?.categories ?? []).map((c) => c.name).filter(Boolean);
      const fromArticles = articles.map((a) => a.category).filter(Boolean);
      const unique = Array.from(new Set([...fromSettings, ...fromArticles].map((s) => s.trim()).filter(Boolean)));
      unique.sort((a, b) => a.localeCompare(b, 'de-DE'));
      return unique;
  }, [effectiveSettings, articles]);

  const handleItemChange = (index: number, field: keyof InvoiceItem, value: string | number | undefined) => {
      const newItems = [...formData.items];
      const current = newItems[index];
      if (!current) return;
      const next: InvoiceItem = { ...current, [field]: value };
      if (field === 'description') next.articleId = undefined;
      newItems[index] = next;
      
      // Recalculate total
      if (field === 'price' || field === 'quantity') {
          newItems[index].total = newItems[index].price * newItems[index].quantity;
      }

      setFormData({ ...formData, items: newItems });
  };

  const handleAddItem = () => {
      const defaultCategory =
        (effectiveSettings.catalog?.categories?.[0]?.name ?? '').trim() || 'Sonstiges';
      setFormData({
          ...formData,
          items: [
              ...formData.items,
              { description: '', quantity: 1, price: 0, total: 0, category: defaultCategory }
           ]
       });
   };

  const applyClientToDocument = (client: Client) => {
    const addresses = client.addresses ?? [];
    const emails = client.emails ?? [];

    const billingAddress =
      addresses.find((a) => a.isDefaultBilling) ??
      addresses.find((a) => a.kind === 'billing') ??
      addresses[0] ??
      null;

    const shippingAddress =
      addresses.find((a) => a.isDefaultShipping) ??
      addresses.find((a) => a.kind === 'shipping') ??
      billingAddress ??
      null;

    const billingEmail =
      emails.find((e) => e.isDefaultBilling) ?? emails.find((e) => e.isDefaultGeneral) ?? emails[0] ?? null;

    setFormData((prev) => ({
      ...prev,
      clientId: client.id,
      clientNumber: client.customerNumber,
      client: client.company,
      clientEmail: billingEmail?.email ?? client.email ?? prev.clientEmail,
      clientAddress: billingAddress ? formatAddressMultiline(billingAddress as any) : client.address ?? prev.clientAddress,
      billingAddressJson: billingAddress ?? prev.billingAddressJson,
      shippingAddressJson: shippingAddress ?? prev.shippingAddressJson,
    }));
  };

  const handleSelectClient = (clientId: string) => {
    setSelectedClientId(clientId);
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;
    applyClientToDocument(client);
    projectTouchedRef.current = false;
  };

  useEffect(() => {
    if (!selectedClientId) {
      setFormData((prev) => ({ ...prev, projectId: undefined }));
      return;
    }
    if (projects.length === 0) return;
    if (mode !== 'create') return;
    if (projectTouchedRef.current) return;

    setFormData((prev) => {
      if (prev.projectId) return prev;
      const defaultProject = projects.find((p) => p.name === 'Allgemein' && !p.archivedAt) ?? projects[0];
      if (!defaultProject) return prev;
      return { ...prev, projectId: defaultProject.id };
    });
  }, [projects, selectedClientId]);

  const handleAddArticleItem = (article: Article) => {
    setFormData((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          description: article.title,
          articleId: article.id,
          category: article.category,
          taxRate: article.taxRate,
          quantity: 1,
          price: article.price,
          total: article.price,
        },
      ],
    }));
  };

  const handleRemoveItem = (index: number) => {
      setFormData({
          ...formData,
          items: formData.items.filter((_, i) => i !== index)
      });
  };

  const taxSnapshot = useMemo(
    () =>
      calculateInvoiceTaxSnapshot(
        {
          items: formData.items,
          taxMode: formData.taxMode,
          taxMeta: formData.taxMeta,
        },
        effectiveSettings,
      ),
    [formData.items, formData.taxMeta, formData.taxMode, effectiveSettings],
  );
  const totals = {
    net: taxSnapshot.netAmount,
    vat: taxSnapshot.vatAmount,
    gross: taxSnapshot.grossAmount,
  };

  return (
    <div className="flex h-full w-full bg-[#f3f4f6] overflow-hidden">
        {/* Left Sidebar: Form Editor */}
        <div
          className={`flex flex-col bg-white border-r border-gray-200 h-full shadow-xl z-10 transition-all duration-300 ${sidebarCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-[450px]'}`}
        >
            {/* Header */}
            <div className="p-6 border-b border-gray-100 bg-white">
                <button 
                    onClick={onCancel}
                    className="flex items-center gap-2 text-gray-400 hover:text-black transition-colors mb-4 text-xs font-bold uppercase tracking-wider"
                >
                    <ArrowLeft size={14} /> Zurück zur Übersicht
                </button>
                <h2 className="text-xl font-black text-gray-900">
                  {templateType === 'offer' ? 'Angebot' : 'Rechnung'} {mode === 'create' ? 'erstellen' : 'bearbeiten'}
                </h2>
                <p className="text-gray-500 text-sm">{formData.number}</p>
                {saveError ? (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                    {saveError}
                  </div>
                ) : null}
            </div>

            {/* Scrollable Form Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-thin scrollbar-thumb-gray-200">
                
                {/* General Info */}
                <div className="space-y-4 animate-enter" style={{ animationDelay: '0ms' }}>
                    <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900 uppercase tracking-wide">
                        <FileText size={16} className="text-accent fill-black" />
                        Basisdaten
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">
                                {templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'}
                            </label>
                            <div className="relative">
                                <input
                                    type="text"
                                    value={formData.number}
                                    readOnly={isNumberLocked}
                                    onChange={e => setFormData({...formData, number: e.target.value})}
                                    className={`w-full bg-gray-50 border rounded-xl p-2.5 text-sm font-medium outline-none transition-colors ${isNumberLocked ? 'border-gray-200 text-gray-400 cursor-not-allowed pr-10' : 'border-warning focus:ring-2 focus:ring-warning'}`}
                                />
                                {mode === 'edit' && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (isNumberLocked) {
                                                const ok = window.confirm(
                                                    'Achtung: Die manuelle Änderung der Nummer kann die GoBD-konforme Nummerierung gefährden.\n\nNur fortfahren, wenn Sie sicher sind.'
                                                );
                                                if (ok) setIsNumberLocked(false);
                                            } else {
                                                setIsNumberLocked(true);
                                            }
                                        }}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 transition-colors"
                                        title={isNumberLocked ? 'Nummer bearbeiten (GoBD-Warnung)' : 'Nummer sperren'}
                                        aria-label={isNumberLocked ? 'Nummer entsperren' : 'Nummer sperren'}
                                    >
                                        {isNumberLocked ? <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> : <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>}
                                    </button>
                                )}
                            </div>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">Datum</label>
                            <input 
                                type="date" 
                                value={formData.date}
                                onChange={e => setFormData({...formData, date: e.target.value})}
                                className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">Leistungsdatum</label>
                            <input 
                                type="date" 
                                value={formData.servicePeriod || ''}
                                onChange={e => setFormData({...formData, servicePeriod: e.target.value})}
                                className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">Fälligkeit</label>
                            <input 
                                type="date" 
                                value={formData.dueDate}
                                onChange={e => setFormData({...formData, dueDate: e.target.value})}
                                className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                            />
                        </div>
                    </div>
                </div>

                {/* Recipient */}
                <div className="space-y-4 animate-enter" style={{ animationDelay: '100ms' }}>
                    <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900 uppercase tracking-wide">
                        <User size={16} className="text-accent fill-black" />
                        Empfänger
                    </h3>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1">Kunde auswählen</label>
                        <select
                            aria-label="Kunde auswählen"
                            value={selectedClientId}
                            onChange={(e) => handleSelectClient(e.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none mb-3"
                        >
                            <option value="">(Kein Kunde)</option>
                            {clients.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.company}
                                </option>
                            ))}
                        </select>

                        <label className="block text-xs font-bold text-gray-500 mb-1">Projekt</label>
                        <select
                            value={formData.projectId ?? ''}
                            onChange={(e) => {
                              projectTouchedRef.current = true;
                              setFormData({
                                ...formData,
                                projectId: e.target.value ? e.target.value : undefined,
                              });
                            }}
                            disabled={!selectedClientId}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none mb-3 disabled:opacity-60"
                        >
                            <option value="">{selectedClientId ? '(Kein Projekt)' : '(Bitte Kunde auswählen)'}</option>
                            {projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {(p.code ? `${p.code} – ` : '') + p.name}
                                </option>
                            ))}
                        </select>

                        <label className="block text-xs font-bold text-gray-500 mb-1">Firmenname / Kunde</label>
                        <input 
                            type="text" 
                            value={formData.client}
                            onChange={e => setFormData({...formData, client: e.target.value})}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none mb-3"
                        />
                        <label className="block text-xs font-bold text-gray-500 mb-1">E-Mail</label>
                        <input
                            type="email"
                            value={formData.clientEmail}
                            onChange={e => setFormData({...formData, clientEmail: e.target.value})}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none mb-3"
                            placeholder="name@firma.de"
                        />
                        <label className="block text-xs font-bold text-gray-500 mb-1">Adresse (Optional)</label>
                        <textarea 
                            value={formData.clientAddress || ''}
                            onChange={e => setFormData({...formData, clientAddress: e.target.value})}
                            rows={3}
                            placeholder="Straße, PLZ, Stadt..."
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none"
                        />
                        <div className="mt-4 grid grid-cols-1 gap-3">
                          <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">Steuer-Modell</label>
                            <select
                              value={formData.taxMode ?? resolveInvoiceTaxMode(undefined, effectiveSettings)}
                              onChange={(e) =>
                                setFormData((prev) => ({
                                  ...prev,
                                  taxMode: e.target.value as Invoice['taxMode'],
                                }))
                              }
                              className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                            >
                              {INVOICE_TAX_MODE_DEFINITIONS.map((definition) => (
                                <option key={definition.mode} value={definition.mode}>
                                  {definition.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                    </div>
                </div>

                {/* Items */}
                <div className="space-y-4 animate-enter" style={{ animationDelay: '200ms' }}>
                    <div className="flex items-center justify-between">
                        <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900 uppercase tracking-wide">
                            <Calculator size={16} className="text-accent fill-black" />
                            Positionen
                        </h3>
                        <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1">
                                <select
                                    aria-label="Artikel auswählen"
                                    value={articleToAddId}
                                    onChange={(e) => setArticleToAddId(e.target.value)}
                                    className="bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 text-xs font-bold outline-none focus:ring-2 focus:ring-accent"
                                >
                                    <option value="">Artikel wählen...</option>
                                    {articles.map((a) => (
                                        <option key={a.id} value={a.id}>
                                            {a.title}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    disabled={!articleToAddId}
                                    onClick={() => {
                                        const article = articles.find((a) => a.id === articleToAddId);
                                        if (article) {
                                            handleAddArticleItem(article);
                                            setArticleToAddId('');
                                        }
                                    }}
                                    className="text-xs font-bold bg-gray-100 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed text-gray-800 px-2 py-1 rounded-lg transition-colors flex items-center gap-1"
                                    title="Artikel zur Rechnung hinzufügen"
                                >
                                    <Plus size={12} /> Hinzufügen
                                </button>
                            </div>
                            <button 
                                onClick={handleAddItem}
                                className="text-xs font-bold bg-black text-accent px-2 py-1 rounded hover:bg-gray-800 transition-colors flex items-center gap-1"
                            >
                                <Plus size={12} /> Neu
                            </button>
                        </div>
                    </div>
                    
                    <div className="space-y-3">
                        {formData.items.map((item, idx) => (
                            <div key={idx} className="bg-white border border-gray-200 rounded-xl p-3 shadow-sm hover:border-accent transition-colors group animate-enter" style={{ animationDelay: `${200 + idx * 50}ms` }}>
                                <div className="flex gap-2 mb-2">
                                    <input 
                                        type="text"
                                        value={item.description}
                                        onChange={e => handleItemChange(idx, 'description', e.target.value)}
                                        className="flex-1 bg-gray-50 border border-transparent hover:border-gray-200 focus:border-accent rounded-lg px-2 py-1 text-sm font-bold outline-none"
                                        placeholder="Beschreibung"
                                    />
                                    <button 
                                        onClick={() => handleRemoveItem(idx)}
                                        className="text-gray-300 hover:text-red-500 p-1"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                                <div className="grid grid-cols-5 gap-2">
                                    <div>
                                        <label className="text-[10px] text-gray-400 font-medium">USt %</label>
                                        <select
                                            aria-label={`Umsatzsteuer Position ${idx + 1}`}
                                            value={item.taxRate ?? effectiveSettings.legal.defaultVatRate ?? 19}
                                            onChange={(e) => handleItemChange(idx, 'taxRate', Number(e.target.value))}
                                            className="w-full bg-gray-50 rounded-lg px-2 py-1 text-sm outline-none"
                                        >
                                            <option value={19}>19</option><option value={7}>7</option><option value={0}>0</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-gray-400 font-medium">Menge</label>
                                        <input 
                                            type="number"
                                            value={item.quantity}
                                            onChange={e => handleItemChange(idx, 'quantity', Number(e.target.value))}
                                            className="w-full bg-gray-50 rounded-lg px-2 py-1 text-sm outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-gray-400 font-medium">Einzel (€)</label>
                                        <input 
                                            type="number"
                                            value={item.price}
                                            onChange={e => handleItemChange(idx, 'price', Number(e.target.value))}
                                            className="w-full bg-gray-50 rounded-lg px-2 py-1 text-sm outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-gray-400 font-medium">Kategorie</label>
                                        <select
                                            value={item.category ?? ''}
                                            onChange={(e) => handleItemChange(idx, 'category', e.target.value)}
                                            className="w-full bg-gray-50 rounded-lg px-2 py-1 text-sm outline-none"
                                        >
                                            <option value="">(Keine)</option>
                                            {categoryOptions.map((c) => (
                                                <option key={c} value={c}>
                                                    {c}
                                                </option>
                                            ))}
                                            <option value="Sonstiges">Sonstiges</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-gray-400 font-medium">Gesamt</label>
                                        <div className="text-right text-sm font-bold pt-1">
                                            {formatCurrency(item.total)}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Totals Summary in Form */}
                    <div className="bg-gray-50 rounded-xl p-4 space-y-2 border border-gray-100 animate-enter" style={{ animationDelay: '400ms' }}>
                        <div className="flex justify-between text-sm text-gray-500">
                            <span>Netto</span>
                            <span>{formatCurrency(totals.net)}</span>
                        </div>
                        <div className="flex justify-between text-sm text-gray-500">
                            <span>{taxSnapshot.label ?? 'USt'} ({taxSnapshot.vatRateApplied}%)</span>
                            <span>{formatCurrency(totals.vat)}</span>
                        </div>
                        <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-200 pt-2 mt-2">
                            <span>Gesamtbetrag</span>
                            <span>{formatCurrency(totals.gross)}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="p-6 border-t border-gray-200 bg-white animate-enter" style={{ animationDelay: '450ms' }}>
                <button
                    onClick={() => {
                      setSaveError(null);
                      const resolvedTaxMode = resolveInvoiceTaxMode(formData.taxMode, effectiveSettings);
                      const normalized: Invoice = {
                        ...formData,
                        taxMode: resolvedTaxMode,
                        taxSnapshot,
                        amount: taxSnapshot.grossAmount,
                      };
                      onSave(normalized);
                    }}
                    className="w-full bg-accent text-black font-bold py-3 rounded-xl hover:bg-accent-hover transition-all flex items-center justify-center gap-2 shadow-lg shadow-accent/20 active:scale-95"
                >
                    <Save size={18} />
                    Änderungen speichern
                </button>
            </div>
        </div>

        {/* Right Area: Live Preview */}
        <div className="flex-1 bg-[#555] overflow-auto flex justify-center p-8 relative">
            {/* Sidebar toggle */}
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="absolute top-4 left-4 z-10 w-9 h-9 bg-white/15 hover:bg-white/25 rounded-xl flex items-center justify-center text-white/70 hover:text-white transition-all"
              title={sidebarCollapsed ? 'Seitenleiste einblenden' : 'Seitenleiste ausblenden'}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <div className="flex flex-col items-center">
                <div className="mb-4 text-white/50 text-xs font-medium uppercase tracking-wider flex items-center gap-2">
                    Live Vorschau
                </div>
                
                {/* A4 Preview - Read Only */}
                <div
                    className="bg-white shadow-2xl relative transition-transform origin-top"
                    style={{
                        width: `${A4_WIDTH_PX}px`,
                        height: `${A4_HEIGHT_PX}px`,
                        minWidth: `${A4_WIDTH_PX}px`,
                        minHeight: `${A4_HEIGHT_PX}px`,
                        transform: 'scale(0.9)'
                    }}
                >
                    {previewElements.map((el) => (
                        <CanvasElement
                            key={el.id}
                            element={el}
                            elements={previewElements}
                            isSelected={false}
                            scale={1}
                            readOnly={true} // Crucial: disables dragging/editing in preview
                        />
                    ))}
                </div>
            </div>
        </div>
    </div>
  );
};
