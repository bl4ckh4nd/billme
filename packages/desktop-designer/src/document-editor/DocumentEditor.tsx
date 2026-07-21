
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InvoiceElement } from '../types';
import { ElementRenderer } from '../ElementRenderer';
import { renderTextWithPlaceholders } from '@billme/desktop-utils/placeholders';
import { A4_WIDTH_PX, A4_HEIGHT_PX } from '../constants';
import { ArrowLeft, Save, User, FileText, PanelLeftClose, PanelLeftOpen, Redo2, Undo2 } from 'lucide-react';
import { getPreviewElements } from '@billme/desktop-utils/documentPreview';
import { formatAddressMultiline } from '@billme/desktop-utils';
import {
  calculateInvoiceTaxSnapshot,
  getInvoiceTaxModeDefinition,
  INVOICE_TAX_MODE_DEFINITIONS,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';
import { Combobox, DatePicker } from '@billme/ui';
import { ItemsEditor } from './ItemsEditor';
import { useHistory } from '../hooks/useHistory';
import type { ArticleLike, ClientLike, DocumentDraft, ProjectLike, SettingsLike } from './types';

export interface DocumentEditorProps {
  document: DocumentDraft;
  templateType: 'invoice' | 'offer';
  mode: 'create' | 'edit';
  clients: ClientLike[];
  articles: ArticleLike[];
  projects: ProjectLike[];
  settings: SettingsLike;
  templateElements: unknown[];
  sidebarCollapsed: boolean;
  onSidebarCollapsedChange: (value: boolean) => void;
  onSelectedClientChange?: (clientId: string) => void;
  onSave: (document: DocumentDraft) => void;
  onCancel: () => void;
}

const formatDate = (dateString: string) => {
  if (!dateString) return '';
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

interface FieldErrors {
  number?: string;
  date?: string;
  client?: string;
  buyerVatId?: string;
  items: Record<number, string>;
}

export const DocumentEditor: React.FC<DocumentEditorProps> = ({
  document,
  templateType,
  mode,
  clients,
  articles,
  projects,
  settings: effectiveSettings,
  templateElements,
  sidebarCollapsed,
  onSidebarCollapsedChange,
  onSelectedClientChange,
  onSave,
  onCancel,
}) => {
  const currencyFormatter = useMemo(() => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }), []);
  const formatCurrency = (amount: number) => currencyFormatter.format(amount);
  const initialDocument = useRef(document).current;
  const history = useHistory<DocumentDraft>(document);
  const formData = history.state;
  const setFormData = history.set;
  const dirty = formData !== initialDocument;
  const effectiveTemplate = templateElements as InvoiceElement[];
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
  const [selectedClientId, setSelectedClientId] = useState<string>(document.clientId ?? '');
  const [isNumberLocked, setIsNumberLocked] = useState<boolean>(mode === 'edit');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({ items: {} });
  const projectTouchedRef = React.useRef(false);

  // Auto-fill dueDate when opening in create mode once settings load.
  useEffect(() => {
    if (mode !== 'create' || formData.dueDate) return;
    const today = new Date();
    const days = effectiveSettings.legal?.paymentTermsDays ?? 14;
    const due = new Date(today);
    due.setDate(today.getDate() + (templateType === 'invoice' ? days : 0));
    const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
    setFormData(prev => prev.dueDate ? prev : { ...prev, dueDate: iso });
  }, [effectiveSettings, mode, templateType]);

  const previewElements = useMemo(() => {
      return getPreviewElements(
        { ...formData, taxSnapshot },
        effectiveTemplate as unknown as Parameters<typeof getPreviewElements>[1],
        effectiveSettings,
      ) as unknown as InvoiceElement[];
  }, [formData, effectiveSettings, effectiveTemplate, taxSnapshot]);

  const categoryOptions = useMemo(() => {
      const fromSettings = (effectiveSettings.catalog?.categories ?? []).map((c) => c.name).filter(Boolean);
      const fromArticles = articles.map((a) => a.category).filter(Boolean);
      const unique = Array.from(new Set([...fromSettings, ...fromArticles].map((s) => s.trim()).filter(Boolean)));
      unique.sort((a, b) => a.localeCompare(b, 'de-DE'));
      return unique;
  }, [effectiveSettings, articles]);

  const defaultCategory =
    (effectiveSettings.catalog?.categories?.[0]?.name ?? '').trim() || 'Sonstiges';

  const applyClientToDocument = (client: ClientLike) => {
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
    onSelectedClientChange?.(clientId);
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;
    applyClientToDocument(client);
    projectTouchedRef.current = false;
  };

  useEffect(() => {
    if (!selectedClientId) {
      setFormData((prev) => prev.projectId ? { ...prev, projectId: undefined } : prev);
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

  const totals = {
    net: taxSnapshot.netAmount,
    vat: taxSnapshot.vatAmount,
    gross: taxSnapshot.grossAmount,
  };
  const resolvedTaxMode = resolveInvoiceTaxMode(formData.taxMode, effectiveSettings);
  const requiresBuyerVatId = getInvoiceTaxModeDefinition(resolvedTaxMode).requiresBuyerVatId;
  const selectedClientLabel = clients.find((client) => client.id === selectedClientId)?.company ?? '';
  const selectedProject = projects.find((project) => project.id === formData.projectId);
  const selectedProjectLabel = selectedProject ? `${selectedProject.code ? `${selectedProject.code} – ` : ''}${selectedProject.name}` : '';

  const handleSave = useCallback(() => {
    const resolvedTaxMode = resolveInvoiceTaxMode(formData.taxMode, effectiveSettings);
    const definition = getInvoiceTaxModeDefinition(resolvedTaxMode);
    const errors: FieldErrors = { items: {} };
    if (!formData.number.trim()) errors.number = 'Nummer ist erforderlich.';
    if (!formData.date.trim()) errors.date = 'Datum ist erforderlich.';
    if (!formData.client.trim()) errors.client = 'Kunde ist erforderlich.';
    formData.items.forEach((item, index) => {
      if (!item.description.trim()) errors.items[index] = 'Beschreibung ist erforderlich.';
    });
    if (definition.requiresBuyerVatId && !formData.taxMeta?.buyerVatId?.trim()) {
      errors.buyerVatId = 'USt-IdNr. des Kunden ist erforderlich.';
    }
    const hasErrors = Boolean(errors.number || errors.date || errors.client || errors.buyerVatId || Object.keys(errors.items).length);
    setFieldErrors(errors);
    if (hasErrors) {
      setSaveError('Bitte korrigiere die markierten Pflichtfelder.');
      window.requestAnimationFrame(() => {
        globalThis.document.querySelector<HTMLElement>('[data-field-error="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }

    setSaveError(null);
    onSave({
      ...formData,
      taxMode: resolvedTaxMode,
      taxSnapshot,
      amount: taxSnapshot.grossAmount,
    });
  }, [effectiveSettings, formData, onSave, taxSnapshot]);

  const handleCancel = useCallback(() => {
    if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
    onCancel();
  }, [dirty, onCancel]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        handleSave();
        return;
      }
      const active = globalThis.document.activeElement;
      const editing = active instanceof HTMLElement && (active.matches('input, textarea, select') || active.isContentEditable);
      if (editing) return;
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) history.redo(); else history.undo();
      } else if (key === 'y') {
        event.preventDefault();
        history.redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, history.redo, history.undo]);

  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  return (
    <div className="flex h-full w-full bg-canvas overflow-hidden">
        {/* Left Sidebar: Form Editor */}
        <div
          className={`flex flex-col bg-white border-r border-border h-full shadow-xl z-10 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out ${sidebarCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-[450px]'}`}
        >
            {/* Header */}
            <div className="p-6 border-b border-border-subtle bg-white">
                <button
                    onClick={handleCancel}
                    className="flex items-center gap-2 text-muted hover:text-foreground transition-colors duration-150 ease-out mb-4 text-xs font-bold uppercase tracking-wider"
                >
                    <ArrowLeft size={14} /> Zurück zur Übersicht
                </button>
                <h2 className="text-xl font-black text-foreground">
                  {templateType === 'offer' ? 'Angebot' : 'Rechnung'} {mode === 'create' ? 'erstellen' : 'bearbeiten'}
                </h2>
                <p className="text-muted text-sm">{formData.number}</p>
                {saveError ? (
                  <div className="mt-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
                    {saveError}
                  </div>
                ) : null}
            </div>

            {/* Scrollable Form Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6 scrollbar-thin scrollbar-thumb-border">

                {/* General Info */}
                <div className="space-y-4 animate-enter" style={{ animationDelay: '0ms' }}>
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground uppercase tracking-wide">
                        <FileText size={16} className="text-accent fill-black" />
                        Basisdaten
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div data-field-error={fieldErrors.number ? true : undefined}>
                            <label className="block text-xs font-bold text-muted mb-1">
                                {templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'}
                            </label>
                            <div className="relative">
                                <input
                                    type="text"
                                    value={formData.number}
                                    readOnly={isNumberLocked}
                                    onChange={e => setFormData({...formData, number: e.target.value}, { coalesce: true })}
                                    className={`w-full bg-surface-muted border rounded-lg p-2.5 text-sm font-medium outline-none transition-colors duration-150 ease-out ${fieldErrors.number ? 'border-error focus:ring-2 focus:ring-error' : isNumberLocked ? 'border-border text-muted cursor-not-allowed pr-10' : 'border-warning focus:ring-2 focus:ring-warning'}`}
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
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-colors duration-150 ease-out"
                                        title={isNumberLocked ? 'Nummer bearbeiten (GoBD-Warnung)' : 'Nummer sperren'}
                                        aria-label={isNumberLocked ? 'Nummer entsperren' : 'Nummer sperren'}
                                    >
                                        {isNumberLocked ? <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> : <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>}
                                    </button>
                                )}
                            </div>
                            {fieldErrors.number ? <p className="mt-1 text-xs text-error">{fieldErrors.number}</p> : null}
                        </div>
                        <div data-field-error={fieldErrors.date ? true : undefined}>
                            <label className="block text-xs font-bold text-muted mb-1">Datum</label>
                            <DatePicker
                                value={formData.date}
                                onChange={date => setFormData({...formData, date}, { coalesce: true })}
                                className={`[&>button]:bg-surface-muted [&>button]:border-border [&>button]:rounded-lg [&>button]:text-foreground ${fieldErrors.date ? '[&>button]:border-error [&>button]:focus:ring-error' : ''}`}
                            />
                            {fieldErrors.date ? <p className="mt-1 text-xs text-error">{fieldErrors.date}</p> : null}
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-muted mb-1">Leistungsdatum</label>
                            <DatePicker
                                value={formData.servicePeriod || ''}
                                onChange={servicePeriod => setFormData({...formData, servicePeriod}, { coalesce: true })}
                                placeholder="Optional"
                                className="[&>button]:bg-surface-muted [&>button]:border-border [&>button]:rounded-lg [&>button]:text-foreground"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-muted mb-1">Fälligkeit</label>
                            <DatePicker
                                value={formData.dueDate ?? ''}
                                onChange={dueDate => setFormData({...formData, dueDate}, { coalesce: true })}
                                className="[&>button]:bg-surface-muted [&>button]:border-border [&>button]:rounded-lg [&>button]:text-foreground"
                            />
                        </div>
                    </div>
                </div>

                {/* Recipient */}
                <div className="space-y-4 animate-enter" style={{ animationDelay: '100ms' }}>
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground uppercase tracking-wide">
                        <User size={16} className="text-accent fill-black" />
                        Empfänger
                    </h3>
                    <div>
                        <label className="block text-xs font-bold text-muted mb-1">Kunde auswählen</label>
                        <div className="mb-3">
                          <Combobox
                            items={clients}
                            value={selectedClientLabel}
                            onSelect={(client) => handleSelectClient(client.id)}
                            getLabel={(client) => client.company}
                            getSublabel={(client) => client.customerNumber}
                            getSearchText={(client) => `${client.company} ${client.customerNumber ?? ''}`}
                            placeholder="Kunde suchen..."
                            aria-label="Kunde auswählen"
                            inputClassName="w-full bg-surface-muted border border-border rounded-lg p-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-colors"
                          />
                        </div>

                        <label className="block text-xs font-bold text-muted mb-1">Projekt</label>
                        <div className="mb-3">
                          <Combobox
                            items={projects}
                            value={selectedProjectLabel}
                            disabled={!selectedClientId}
                            onSelect={(project) => {
                              projectTouchedRef.current = true;
                              setFormData((prev) => ({ ...prev, projectId: project.id }));
                            }}
                            getLabel={(project) => `${project.code ? `${project.code} – ` : ''}${project.name}`}
                            getSearchText={(project) => `${project.code ?? ''} ${project.name}`}
                            placeholder={selectedClientId ? 'Projekt suchen...' : 'Bitte Kunde auswählen'}
                            aria-label="Projekt auswählen"
                            inputClassName="w-full bg-surface-muted border border-border rounded-lg p-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-colors"
                          />
                        </div>

                        <div data-field-error={fieldErrors.client ? true : undefined}>
                          <label className="block text-xs font-bold text-muted mb-1">Firmenname / Kunde</label>
                          <input
                              type="text"
                              value={formData.client}
                              onChange={e => setFormData({...formData, client: e.target.value}, { coalesce: true })}
                              className={`w-full bg-surface-muted border rounded-lg p-2.5 text-sm font-medium outline-none focus:ring-2 transition-colors mb-3 ${fieldErrors.client ? 'border-error focus:ring-error' : 'border-border focus:ring-accent'}`}
                          />
                          {fieldErrors.client ? <p className="-mt-2 mb-3 text-xs text-error">{fieldErrors.client}</p> : null}
                        </div>
                        <label className="block text-xs font-bold text-muted mb-1">E-Mail</label>
                        <input
                            type="email"
                            value={formData.clientEmail}
                            onChange={e => setFormData({...formData, clientEmail: e.target.value}, { coalesce: true })}
                            className="w-full bg-surface-muted border border-border rounded-lg p-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-colors mb-3"
                            placeholder="name@firma.de"
                        />
                        <label className="block text-xs font-bold text-muted mb-1">Adresse (Optional)</label>
                        <textarea
                            value={formData.clientAddress || ''}
                            onChange={e => setFormData({...formData, clientAddress: e.target.value}, { coalesce: true })}
                            rows={3}
                            placeholder="Straße, PLZ, Stadt..."
                            className="w-full bg-surface-muted border border-border rounded-lg p-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-colors resize-none"
                        />
                        <div className="mt-4 grid grid-cols-1 gap-3">
                          <div>
                            <label className="block text-xs font-bold text-muted mb-1">Steuer-Modell</label>
                            <select
                              value={formData.taxMode ?? resolveInvoiceTaxMode(undefined, effectiveSettings)}
                              onChange={(e) =>
                                setFormData((prev) => ({
                                  ...prev,
                                  taxMode: e.target.value as DocumentDraft['taxMode'],
                                }))
                              }
                              className="w-full bg-surface-muted border border-border rounded-lg p-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-colors"
                            >
                              {INVOICE_TAX_MODE_DEFINITIONS.map((definition) => (
                                <option key={definition.mode} value={definition.mode}>
                                  {definition.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          {requiresBuyerVatId ? (
                            <div data-field-error={fieldErrors.buyerVatId ? true : undefined}>
                              <label className="block text-xs font-bold text-muted mb-1">USt-IdNr. des Kunden</label>
                              <input
                                type="text"
                                value={formData.taxMeta?.buyerVatId ?? ''}
                                onChange={(event) => setFormData((prev) => ({
                                  ...prev,
                                  taxMeta: { ...prev.taxMeta, buyerVatId: event.target.value },
                                }), { coalesce: true })}
                                className={`w-full bg-surface-muted border rounded-lg p-2.5 text-sm font-medium outline-none focus:ring-2 transition-colors ${fieldErrors.buyerVatId ? 'border-error focus:ring-error' : 'border-border focus:ring-accent'}`}
                              />
                              {fieldErrors.buyerVatId ? <p className="mt-1 text-xs text-error">{fieldErrors.buyerVatId}</p> : null}
                            </div>
                          ) : null}
                        </div>
                    </div>
                </div>

                {/* Items */}
                <div className="space-y-4 animate-enter" style={{ animationDelay: '200ms' }}>
                    <ItemsEditor
                        items={formData.items}
                        articles={articles}
                        categoryOptions={categoryOptions}
                        defaultCategory={defaultCategory}
                        formatCurrency={formatCurrency}
                        itemErrors={fieldErrors.items}
                        onItemsChange={(items, options) => setFormData((prev) => ({ ...prev, items }), options)}
                    />

                    {/* Totals Summary in Form */}
                    <div className="bg-surface-muted rounded-xl p-4 space-y-2 border border-border-subtle animate-enter" style={{ animationDelay: '400ms' }}>
                        <div className="flex justify-between text-sm text-muted">
                            <span>Netto</span>
                            <span className="tabular-nums">{formatCurrency(totals.net)}</span>
                        </div>
                        {(taxSnapshot.vatBreakdown?.length ? taxSnapshot.vatBreakdown : [{
                          rate: taxSnapshot.vatRateApplied,
                          netAmount: taxSnapshot.netAmount,
                          vatAmount: taxSnapshot.vatAmount,
                        }]).map((entry) => (
                          <div key={entry.rate} className="flex justify-between text-sm text-muted">
                            <span>{taxSnapshot.label ?? 'USt'} ({entry.rate}%)</span>
                            <span className="tabular-nums">{formatCurrency(entry.vatAmount)}</span>
                          </div>
                        ))}
                        <div className="flex justify-between text-base font-bold text-foreground border-t border-border pt-2 mt-2">
                            <span>Gesamtbetrag</span>
                            <span className="tabular-nums">{formatCurrency(totals.gross)}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="p-4 border-t border-border bg-white flex items-center gap-2">
                <button
                  type="button"
                  onClick={history.undo}
                  disabled={!history.canUndo}
                  className="w-9 h-9 rounded-lg border border-border bg-surface text-muted hover:text-foreground hover:bg-surface-muted disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                  title="Rückgängig (Strg+Z)"
                >
                  <Undo2 size={15} />
                </button>
                <button
                  type="button"
                  onClick={history.redo}
                  disabled={!history.canRedo}
                  className="w-9 h-9 rounded-lg border border-border bg-surface text-muted hover:text-foreground hover:bg-surface-muted disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                  title="Wiederholen (Strg+Shift+Z)"
                >
                  <Redo2 size={15} />
                </button>
                {dirty ? (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning" />Ungespeichert
                  </span>
                ) : null}
                <button
                    onClick={handleSave}
                    className="flex-1 bg-accent text-accent-foreground font-bold py-3 rounded-xl hover:bg-accent-hover transition-colors flex items-center justify-center gap-2 shadow-lg shadow-accent/20 active:scale-95"
                >
                    <Save size={18} />
                    Speichern
                    <kbd className="hidden xl:inline text-[10px] font-bold opacity-60">Strg+S</kbd>
                </button>
            </div>
        </div>

        {/* Right Area: Live Preview */}
        <div className="flex-1 bg-editor-viewport overflow-auto flex justify-center p-8 relative">
            {/* Sidebar toggle */}
            <button
              onClick={() => onSidebarCollapsedChange(!sidebarCollapsed)}
              className="absolute top-4 left-4 z-10 w-9 h-9 bg-white/15 hover:bg-white/25 rounded-xl flex items-center justify-center text-white/70 hover:text-white transition-[background-color,border-color,color,box-shadow,opacity,transform,width]"
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
                        <ElementRenderer
                            key={el.id}
                            element={el}
                            renderText={renderTextWithPlaceholders}
                            readOnly
                        />
                    ))}
                </div>
            </div>
        </div>
    </div>
  );
};
