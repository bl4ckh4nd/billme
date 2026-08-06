import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InvoiceElement } from '../types';
import { DocumentPages } from '../DocumentPages';
import { A4_HEIGHT_PX, A4_WIDTH_PX } from '../constants';
import { ArrowLeft, Eye, FileText, LockKeyhole, Redo2, Save, Undo2, UnlockKeyhole } from 'lucide-react';
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
  onSelectedClientChange?: (clientId: string) => void;
  onSave: (document: DocumentDraft) => void;
  onCancel: () => void;
}

interface FieldErrors {
  number?: string;
  date?: string;
  client?: string;
  buyerVatId?: string;
  items: Record<number, string>;
}

const inputClass = 'w-full rounded-lg border border-border bg-surface-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/30';
const labelClass = 'mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted';

const clientSearchText = (client: ClientLike) => [
  client.company,
  client.customerNumber,
  client.email,
  client.address,
  ...(client.emails ?? []).flatMap((email) => [email.email]),
  ...(client.addresses ?? []).flatMap((address) => [
    address.company,
    address.contactPerson,
    address.street,
    address.line2,
    address.zip,
    address.city,
    address.country,
  ]),
].filter(Boolean).join(' ');

const normalizeCountry = (country: string | undefined) => {
  const normalized = country?.trim();
  if (!normalized) return '';
  if (/^(DE|Deutschland)$/i.test(normalized)) return 'DE';
  if (/^(AT|Österreich)$/i.test(normalized)) return 'AT';
  if (/^(CH|Schweiz)$/i.test(normalized)) return 'CH';
  return normalized;
};

const formatDocumentAddress = (address: NonNullable<ClientLike['addresses']>[number]) => formatAddressMultiline({
  street: address.street,
  line2: address.line2,
  zip: address.zip,
  city: address.city,
  country: normalizeCountry(address.country),
});

const parseAddressText = (value: string, company: string, previous: unknown): Record<string, string> => {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const base = previous && typeof previous === 'object' ? previous as Record<string, string> : {};
  const nonAddressLines = new Set([company, base.company, base.contactPerson].map((line) => line?.trim()).filter(Boolean));
  const addressLines = lines.filter((line) => !nonAddressLines.has(line));
  const cityIndex = addressLines.findIndex((line) => /\b\d{4,6}\b/.test(line));
  const cityLine = cityIndex >= 0 ? addressLines[cityIndex] : '';
  const cityMatch = cityLine.match(/^(?:([A-Za-z-]{2,5})[ -])?(\d{4,6})\s+(.+)$/);
  const beforeCity = cityIndex >= 0 ? addressLines.slice(0, cityIndex) : addressLines;
  const afterCity = cityIndex >= 0 ? addressLines.slice(cityIndex + 1) : [];
  const country = afterCity[afterCity.length - 1] ?? addressLines.find((line) => /^(DE|AT|CH|Deutschland|Österreich|Schweiz)$/i.test(line));
  const streetLines = beforeCity.filter((line) => line !== country);
  return {
    ...base,
    company: company.trim(),
    street: streetLines[0] ?? '',
    line2: streetLines.slice(1).join(' '),
    zip: cityMatch?.[2] ?? base.zip ?? '',
    city: cityMatch?.[3] ?? (cityIndex >= 0 ? cityLine : base.city ?? ''),
    country: normalizeCountry(country ?? base.country),
  };
};

export const DocumentEditor: React.FC<DocumentEditorProps> = ({
  document,
  templateType,
  mode,
  clients,
  articles,
  projects,
  settings: effectiveSettings,
  templateElements,
  onSelectedClientChange,
  onSave,
  onCancel,
}) => {
  const history = useHistory<DocumentDraft>(document);
  const [baseline, setBaseline] = useState(document);
  const loadedDocumentId = useRef(document.id);
  const [selectedClientId, setSelectedClientId] = useState(document.clientId ?? '');
  const [isNumberLocked, setIsNumberLocked] = useState(mode === 'edit');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({ items: {} });
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const projectTouchedRef = useRef(false);
  const editorSurfaceRef = useRef<HTMLDivElement>(null);

  // A mounted editor can receive a different document from the router/query. Reset
  // only for a new identity; ordinary parent rerenders must preserve local edits.
  useEffect(() => {
    if (loadedDocumentId.current === document.id) return;
    loadedDocumentId.current = document.id;
    history.reset(document);
    setBaseline(document);
    setSelectedClientId(document.clientId ?? '');
    setIsNumberLocked(mode === 'edit');
    setFieldErrors({ items: {} });
    setSaveError(null);
    setView('edit');
    projectTouchedRef.current = false;
  }, [document, history.reset, mode]);

  const formData = history.state;
  const setFormData = history.set;
  const dirty = formData !== baseline;
  const effectiveTemplate = templateElements as InvoiceElement[];
  const taxSnapshot = useMemo(
    () => calculateInvoiceTaxSnapshot({ items: formData.items, taxMode: formData.taxMode, taxMeta: formData.taxMeta }, effectiveSettings),
    [effectiveSettings, formData.items, formData.taxMeta, formData.taxMode],
  );
  const previewElements = useMemo(
    () => getPreviewElements({ ...formData, taxSnapshot }, effectiveTemplate as unknown as Parameters<typeof getPreviewElements>[1], effectiveSettings) as unknown as InvoiceElement[],
    [effectiveSettings, effectiveTemplate, formData, taxSnapshot],
  );
  const currencyFormatter = useMemo(() => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }), []);
  const formatCurrency = (amount: number) => currencyFormatter.format(amount);
  const selectedProjectLabel = useMemo(() => {
    const project = projects.find((candidate) => candidate.id === formData.projectId);
    return project ? `${project.code ? `${project.code} – ` : ''}${project.name}` : '';
  }, [formData.projectId, projects]);
  const selectedClientLabel = clients.find((client) => client.id === selectedClientId)?.company ?? formData.client;
  const categoryOptions = useMemo(() => {
    const fromSettings = (effectiveSettings.catalog?.categories ?? []).map((category) => category.name).filter(Boolean);
    const fromArticles = articles.map((article) => article.category).filter(Boolean);
    return Array.from(new Set([...fromSettings, ...fromArticles].map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'de-DE'));
  }, [articles, effectiveSettings]);
  const defaultCategory = (effectiveSettings.catalog?.categories?.[0]?.name ?? '').trim() || 'Sonstiges';
  const resolvedTaxMode = resolveInvoiceTaxMode(formData.taxMode, effectiveSettings);
  const requiresBuyerVatId = getInvoiceTaxModeDefinition(resolvedTaxMode).requiresBuyerVatId;

  useEffect(() => {
    if (mode !== 'create' || formData.dueDate) return;
    const due = new Date();
    due.setDate(due.getDate() + (templateType === 'invoice' ? effectiveSettings.legal?.paymentTermsDays ?? 14 : 0));
    const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
    setFormData((previous) => previous.dueDate ? previous : { ...previous, dueDate: iso });
  }, [effectiveSettings.legal?.paymentTermsDays, formData.dueDate, mode, setFormData, templateType]);

  const applyClientToDocument = useCallback((client: ClientLike) => {
    const addresses = client.addresses ?? [];
    const emails = client.emails ?? [];
    const billingAddress = addresses.find((address) => address.isDefaultBilling) ?? addresses.find((address) => address.kind === 'billing') ?? addresses[0];
    const shippingAddress = addresses.find((address) => address.isDefaultShipping) ?? addresses.find((address) => address.kind === 'shipping') ?? billingAddress;
    const billingEmail = emails.find((email) => email.isDefaultBilling) ?? emails.find((email) => email.isDefaultGeneral) ?? emails[0];
    setFormData((previous) => ({
      ...previous,
      clientId: client.id,
      clientNumber: client.customerNumber,
      client: client.company,
      clientEmail: billingEmail?.email ?? client.email ?? previous.clientEmail,
      clientAddress: billingAddress ? formatDocumentAddress(billingAddress) : client.address ?? previous.clientAddress,
      billingAddressJson: billingAddress ?? previous.billingAddressJson,
      shippingAddressJson: shippingAddress ?? previous.shippingAddressJson,
    }));
    setSelectedClientId(client.id);
    onSelectedClientChange?.(client.id);
    projectTouchedRef.current = false;
  }, [onSelectedClientChange, setFormData]);

  const updateClientName = useCallback((client: string) => {
    setFormData((previous) => ({
      ...previous,
      client,
      billingAddressJson: previous.clientAddress
        ? parseAddressText(previous.clientAddress, client, previous.billingAddressJson)
        : previous.billingAddressJson,
    }), { coalesce: true });
  }, [setFormData]);

  useEffect(() => {
    if (!selectedClientId || mode !== 'create' || projectTouchedRef.current || projects.length === 0) return;
    setFormData((previous) => {
      if (previous.projectId) return previous;
      const project = projects.find((candidate) => candidate.name === 'Allgemein' && !candidate.archivedAt) ?? projects[0];
      return project ? { ...previous, projectId: project.id } : previous;
    });
  }, [mode, projects, selectedClientId, setFormData]);

  const validate = useCallback(() => {
    const errors: FieldErrors = { items: {} };
    if (!formData.number.trim()) errors.number = 'Nummer ist erforderlich.';
    if (!formData.date.trim()) errors.date = 'Datum ist erforderlich.';
    if (!formData.client.trim()) errors.client = 'Kunde ist erforderlich.';
    formData.items.forEach((item, index) => {
      if (!item.description.trim()) errors.items[index] = 'Beschreibung ist erforderlich.';
    });
    if (getInvoiceTaxModeDefinition(resolveInvoiceTaxMode(formData.taxMode, effectiveSettings)).requiresBuyerVatId && !formData.taxMeta?.buyerVatId?.trim()) {
      errors.buyerVatId = 'USt-IdNr. des Kunden ist erforderlich.';
    }
    setFieldErrors(errors);
    return errors;
  }, [effectiveSettings, formData]);

  const focusValidationError = useCallback(() => {
    window.requestAnimationFrame(() => {
      const target = editorSurfaceRef.current?.querySelector<HTMLElement>('[data-field-error="true"] input, [data-field-error="true"] textarea, [data-field-error="true"] button, [data-field-error="true"] select');
      target?.focus();
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);

  const handleSave = useCallback(() => {
    const errors = validate();
    if (errors.number || errors.date || errors.client || errors.buyerVatId || Object.keys(errors.items).length > 0) {
      setSaveError('Bitte korrigiere die markierten Pflichtfelder.');
      setView('edit');
      focusValidationError();
      return;
    }
    setSaveError(null);
    onSave({ ...formData, taxMode: resolvedTaxMode, taxSnapshot, amount: taxSnapshot.grossAmount });
  }, [focusValidationError, formData, onSave, resolvedTaxMode, taxSnapshot, validate]);

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
      } else if (key === 'z' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        event.shiftKey ? history.redo() : history.undo();
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
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const totals = { net: taxSnapshot.netAmount, vat: taxSnapshot.vatAmount, gross: taxSnapshot.grossAmount };
  const title = templateType === 'offer' ? 'Angebot' : 'Rechnung';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:px-5">
        <button type="button" onClick={handleCancel} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-muted hover:bg-surface-muted hover:text-foreground" aria-label="Zurück">
          <ArrowLeft size={16} /> <span className="hidden sm:inline">Zurück</span>
        </button>
        <div className="min-w-0 flex-1 border-l border-border pl-3">
          <h1 className="truncate text-sm font-bold text-foreground">{title} {mode === 'create' ? 'erstellen' : 'bearbeiten'}</h1>
          <p className="truncate text-xs text-muted">{formData.number || 'Ohne Nummer'}</p>
        </div>
        <button type="button" onClick={history.undo} disabled={!history.canUndo} className="rounded-lg p-2 text-muted hover:bg-surface-muted hover:text-foreground disabled:opacity-40" aria-label="Rückgängig"><Undo2 size={16} /></button>
        <button type="button" onClick={history.redo} disabled={!history.canRedo} className="rounded-lg p-2 text-muted hover:bg-surface-muted hover:text-foreground disabled:opacity-40" aria-label="Wiederholen"><Redo2 size={16} /></button>
        {dirty ? <span className="hidden items-center gap-1 text-xs font-semibold text-warning md:flex"><span className="h-1.5 w-1.5 rounded-full bg-warning" />Ungespeichert</span> : null}
        <div className="flex rounded-lg border border-border bg-surface-muted p-0.5" role="group" aria-label="Dokumentansicht">
          <button type="button" aria-pressed={view === 'edit'} onClick={() => setView('edit')} className={`rounded-md px-2.5 py-1.5 text-xs font-bold ${view === 'edit' ? 'bg-surface text-foreground shadow-sm' : 'text-muted'}`}>Bearbeiten</button>
          <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')} className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-bold ${view === 'preview' ? 'bg-surface text-foreground shadow-sm' : 'text-muted'}`}><Eye size={13} /> Vorschau</button>
        </div>
        <button type="button" onClick={handleSave} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-bold text-accent-foreground hover:bg-accent-hover" aria-label="Speichern"><Save size={15} /> <span className="hidden sm:inline">Speichern</span></button>
      </header>

      {saveError ? <div className="mx-auto mt-3 w-full max-w-[900px] rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm font-medium text-error" role="alert">{saveError}</div> : null}

      <main className="flex-1 overflow-auto bg-editor-viewport p-4 sm:p-8">
        {view === 'preview' ? (
          <div className="mx-auto w-fit min-w-[min(100%,794px)]" data-document-preview data-testid="document-preview">
            <DocumentPages elements={previewElements} pageWidth={A4_WIDTH_PX} pageHeight={A4_HEIGHT_PX} pageClassName="bg-white shadow-2xl" pageGap={24} />
          </div>
        ) : (
          <div ref={editorSurfaceRef} data-document-editor data-testid="document-editor" className="mx-auto min-h-[1123px] w-full max-w-[794px] bg-white px-5 py-6 text-foreground shadow-2xl sm:px-12 sm:py-10">
            <div className="mb-8 flex items-start justify-between gap-6 border-b border-border pb-5">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-muted"><FileText size={17} /><span className="text-xs font-bold uppercase tracking-[0.2em]">{title}</span></div>
                <h2 className="text-2xl font-black text-foreground">{effectiveSettings.company.name}</h2>
                <p className="mt-1 text-sm text-muted">{effectiveSettings.company.street}, {effectiveSettings.company.zip} {effectiveSettings.company.city}</p>
              </div>
              <div className="w-44 shrink-0 space-y-2">
                <div data-field-error={fieldErrors.number ? true : undefined}><label className={labelClass}>{templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'}</label><div className="relative"><input value={formData.number} readOnly={isNumberLocked} onChange={(event) => setFormData((previous) => ({ ...previous, number: event.target.value }), { coalesce: true })} className={`${inputClass} ${isNumberLocked ? 'cursor-not-allowed pr-9 text-muted' : ''}`} aria-label={templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'} />{mode === 'edit' ? <button type="button" onClick={() => { if (isNumberLocked) { if (window.confirm('Achtung: Die manuelle Änderung der Nummer kann die GoBD-konforme Nummerierung gefährden.\n\nNur fortfahren, wenn Sie sicher sind.')) setIsNumberLocked(false); } else setIsNumberLocked(true); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground" aria-label={isNumberLocked ? 'Nummer entsperren' : 'Nummer sperren'} title="Nummer bearbeiten (GoBD-Warnung)">{isNumberLocked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</button> : null}</div>{fieldErrors.number ? <p className="mt-1 text-xs text-error">{fieldErrors.number}</p> : null}</div>
                <div data-field-error={fieldErrors.date ? true : undefined}><label className={labelClass}>Datum</label><DatePicker value={formData.date} onChange={(date) => setFormData((previous) => ({ ...previous, date }), { coalesce: true })} aria-label="Datum" />{fieldErrors.date ? <p className="mt-1 text-xs text-error">{fieldErrors.date}</p> : null}</div>
                <div><label className={labelClass}>{templateType === 'offer' ? 'Gültig bis' : 'Fälligkeit'}</label><DatePicker value={formData.dueDate ?? ''} onChange={(dueDate) => setFormData((previous) => ({ ...previous, dueDate }), { coalesce: true })} placeholder="Optional" aria-label={templateType === 'offer' ? 'Gültig bis' : 'Fälligkeit'} /></div>
              </div>
            </div>

            <section className="mb-8 grid gap-5 border-b border-border pb-6 sm:grid-cols-[1.3fr_1fr]" aria-label="Empfänger">
              <div><label className={labelClass}>Kunde suchen</label><Combobox items={clients} value={selectedClientLabel} onSelect={applyClientToDocument} getLabel={(client) => client.company} getSublabel={(client) => client.customerNumber} getSearchText={clientSearchText} placeholder="Kunde suchen..." aria-label="Kunde auswählen" inputClassName={inputClass} /></div>
              <div><label className={labelClass}>Projekt</label><Combobox items={projects} value={selectedProjectLabel} disabled={!selectedClientId} onSelect={(project) => { projectTouchedRef.current = true; setFormData((previous) => ({ ...previous, projectId: project.id })); }} getLabel={(project) => `${project.code ? `${project.code} – ` : ''}${project.name}`} getSearchText={(project) => `${project.code ?? ''} ${project.name}`} placeholder={selectedClientId ? 'Projekt suchen...' : 'Bitte Kunde auswählen'} aria-label="Projekt auswählen" inputClassName={inputClass} /></div>
              <div data-field-error={fieldErrors.client ? true : undefined}><label className={labelClass}>Empfängername</label><input value={formData.client} onChange={(event) => updateClientName(event.target.value)} className={inputClass} aria-label="Empfängername" />{fieldErrors.client ? <p className="mt-1 text-xs text-error">{fieldErrors.client}</p> : null}</div>
              <div><label className={labelClass}>E-Mail</label><input type="email" value={formData.clientEmail} onChange={(event) => setFormData((previous) => ({ ...previous, clientEmail: event.target.value }), { coalesce: true })} className={inputClass} aria-label="E-Mail" /></div>
              <div className="sm:col-span-2"><label className={labelClass}>Rechnungsadresse</label><textarea rows={3} value={formData.clientAddress ?? ''} onChange={(event) => setFormData((previous) => ({ ...previous, clientAddress: event.target.value, billingAddressJson: parseAddressText(event.target.value, previous.client, previous.billingAddressJson) }), { coalesce: true })} className={`${inputClass} resize-y`} aria-label="Rechnungsadresse" /></div>
            </section>

            <section className="mb-8 grid gap-4 border-b border-border pb-6 sm:grid-cols-2" aria-label="Steuerdaten">
              <div><label className={labelClass}>Steuer-Modell</label><select value={formData.taxMode ?? resolvedTaxMode} onChange={(event) => setFormData((previous) => ({ ...previous, taxMode: event.target.value as DocumentDraft['taxMode'] }))} className={inputClass} aria-label="Steuer-Modell">{INVOICE_TAX_MODE_DEFINITIONS.map((definition) => <option key={definition.mode} value={definition.mode}>{definition.label}</option>)}</select></div>
              {requiresBuyerVatId ? <div data-field-error={fieldErrors.buyerVatId ? true : undefined}><label className={labelClass}>USt-IdNr. des Kunden</label><input value={formData.taxMeta?.buyerVatId ?? ''} onChange={(event) => setFormData((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, buyerVatId: event.target.value } }), { coalesce: true })} className={inputClass} aria-label="USt-IdNr. des Kunden" />{fieldErrors.buyerVatId ? <p className="mt-1 text-xs text-error">{fieldErrors.buyerVatId}</p> : null}</div> : null}
              <div><label className={labelClass}>{templateType === 'offer' ? 'Leistungsdatum / Zeitraum' : 'Leistungsdatum'}</label><DatePicker value={formData.servicePeriod ?? ''} onChange={(servicePeriod) => setFormData((previous) => ({ ...previous, servicePeriod }), { coalesce: true })} placeholder="Optional" aria-label="Leistungsdatum" /></div>
            </section>

            <section aria-label="Positionen" className="mb-8"><ItemsEditor items={formData.items} articles={articles} categoryOptions={categoryOptions} defaultCategory={defaultCategory} formatCurrency={formatCurrency} itemErrors={fieldErrors.items} onItemsChange={(items, options) => setFormData((previous) => ({ ...previous, items }), options)} /></section>
            <section className="ml-auto max-w-xs space-y-2 border-t border-border pt-4" aria-label="Summen"><div className="flex justify-between text-sm text-muted"><span>Netto</span><span className="tabular-nums">{formatCurrency(totals.net)}</span></div>{(taxSnapshot.vatBreakdown?.length ? taxSnapshot.vatBreakdown : [{ rate: taxSnapshot.vatRateApplied, vatAmount: taxSnapshot.vatAmount }]).map((entry) => <div key={entry.rate} className="flex justify-between text-sm text-muted"><span>{taxSnapshot.label ?? 'USt'} ({entry.rate}%)</span><span className="tabular-nums">{formatCurrency(entry.vatAmount)}</span></div>)}<div className="flex justify-between border-t border-border pt-2 text-base font-black"><span>Gesamtbetrag</span><span className="tabular-nums">{formatCurrency(totals.gross)}</span></div></section>
          </div>
        )}
      </main>
    </div>
  );
};
