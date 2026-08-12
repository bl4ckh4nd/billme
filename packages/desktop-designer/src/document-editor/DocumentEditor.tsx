import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InvoiceElement } from '../types';
import { DocumentCanvasEditor, type DocumentCanvasDocumentFields } from './DocumentCanvasEditor';
import { ArrowLeft, Eye, Redo2, Save, Undo2 } from 'lucide-react';
import { getPreviewElements } from '@billme/desktop-utils/documentPreview';
import { formatAddressMultiline } from '@billme/desktop-utils';
import {
  calculateInvoiceTaxSnapshot,
  getDachVatRates,
  getInvoiceTaxModeDefinition,
  INVOICE_TAX_MODE_DEFINITIONS,
  recommendInvoiceTaxMode,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';
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
  /** Existing template persistence seam for inline authored text. */
  onTemplateElementsChange?: (elements: InvoiceElement[]) => void;
  onValidateVatId?: (args: { countryCode: string; vatNumber: string }) => Promise<{ status: 'valid' | 'invalid' | 'unavailable'; normalizedVatId: string; checkedAt: string }>;
  onSelectedClientChange?: (clientId: string) => void;
  onSave: (document: DocumentDraft) => void;
  onCancel: () => void;
}

interface FieldErrors {
  number?: string;
  date?: string;
  client?: string;
  buyerVatId?: string;
  taxRule?: string;
  items: Record<number, string>;
}

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
  onTemplateElementsChange,
  onValidateVatId,
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
  const [vatValidationPending, setVatValidationPending] = useState(false);
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
  const [editableTemplate, setEditableTemplate] = useState(templateElements as InvoiceElement[]);
  useEffect(() => setEditableTemplate(templateElements as InvoiceElement[]), [templateElements]);
  const effectiveTemplate = editableTemplate;
  const handleTemplateTextChange = useCallback((id: string, content: string) => {
    setEditableTemplate((previous) => {
      const next = previous.map((element) => element.id === id ? { ...element, content } : element);
      onTemplateElementsChange?.(next);
      return next;
    });
  }, [onTemplateElementsChange]);
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
  const resolvedTaxMode = resolveInvoiceTaxMode(formData.taxMode, effectiveSettings);
  const requiresBuyerVatId = getInvoiceTaxModeDefinition(resolvedTaxMode).requiresBuyerVatId;
  const sellerCountryCode = effectiveSettings.legal.countryCode ?? 'DE';
  const buyerCountryCode = normalizeCountry(
    formData.billingAddressJson && typeof formData.billingAddressJson === 'object'
      ? (formData.billingAddressJson as { country?: string }).country
      : undefined,
  );
  const validateBuyerVatId = useCallback(async () => {
    const vatNumber = formData.taxMeta?.buyerVatId?.trim();
    if (!onValidateVatId || !vatNumber || !buyerCountryCode) return;
    setVatValidationPending(true);
    try {
      const result = await onValidateVatId({ countryCode: buyerCountryCode, vatNumber });
      setFormData((previous) => ({
        ...previous,
        taxMeta: {
          ...previous.taxMeta,
          buyerVatId: result.normalizedVatId,
          vatIdValidation: result.status,
          vatIdValidationAt: result.checkedAt,
        },
      }));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setVatValidationPending(false);
    }
  }, [buyerCountryCode, formData.taxMeta?.buyerVatId, onValidateVatId, setFormData]);
  const taxRateOptions = useMemo(
    () => getDachVatRates(sellerCountryCode, effectiveSettings.legal.defaultVatRate),
    [effectiveSettings.legal.defaultVatRate, sellerCountryCode],
  );
  const taxRecommendation = useMemo(
    () => recommendInvoiceTaxMode({
      sellerCountryCode,
      buyerCountryCode,
      buyerType: formData.taxMeta?.buyerType,
      buyerVatId: formData.taxMeta?.buyerVatId,
      sellerVatId: formData.taxMeta?.sellerVatId ?? effectiveSettings.finance.vatId,
      supplyType: 'service',
    }),
    [buyerCountryCode, effectiveSettings.finance.vatId, formData.taxMeta?.buyerType, formData.taxMeta?.buyerVatId, formData.taxMeta?.sellerVatId, sellerCountryCode],
  );

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
      taxMeta: {
        ...previous.taxMeta,
        buyerCountryCode: normalizeCountry(billingAddress?.country),
        buyerType: client.taxProfile?.type ?? previous.taxMeta?.buyerType ?? 'business',
        buyerVatId: client.taxProfile?.vatId ?? previous.taxMeta?.buyerVatId,
        vatIdValidation: client.taxProfile?.vatIdValidation,
        vatIdValidationAt: client.taxProfile?.vatIdValidationAt,
        sellerCountryCode,
        sellerVatId: previous.taxMeta?.sellerVatId ?? effectiveSettings.finance.vatId,
        taxRuleConfirmed: false,
      },
    }));
    setSelectedClientId(client.id);
    onSelectedClientChange?.(client.id);
    projectTouchedRef.current = false;
  }, [effectiveSettings.finance.vatId, onSelectedClientChange, sellerCountryCode, setFormData]);

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
    if (buyerCountryCode && buyerCountryCode !== sellerCountryCode && !formData.taxMeta?.taxRuleConfirmed) {
      errors.taxRule = 'Bitte bestätige das Umsatzsteuer-Modell für diese grenzüberschreitende Rechnung.';
    }
    if (requiresBuyerVatId && formData.taxMeta?.vatIdValidation === 'invalid') {
      errors.buyerVatId = 'Die Käufer-USt-IdNr. wurde als ungültig gemeldet.';
    }
    setFieldErrors(errors);
    return errors;
  }, [buyerCountryCode, effectiveSettings, formData, requiresBuyerVatId, sellerCountryCode]);

  const focusValidationError = useCallback(() => {
    window.requestAnimationFrame(() => {
      const target = editorSurfaceRef.current?.querySelector<HTMLElement>('[data-field-error="true"] input, [data-field-error="true"] textarea, [data-field-error="true"] button, [data-field-error="true"] select');
      target?.focus();
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);

  const handleSave = useCallback(() => {
    const errors = validate();
    if (errors.number || errors.date || errors.client || errors.buyerVatId || errors.taxRule || Object.keys(errors.items).length > 0) {
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

  const title = templateType === 'offer' ? 'Angebot' : 'Rechnung';
  const unlockNumber = useCallback(() => {
    if (isNumberLocked) {
      if (window.confirm('Achtung: Die manuelle Änderung der Nummer kann die GoBD-konforme Nummerierung gefährden.\n\nNur fortfahren, wenn Sie sicher sind.')) setIsNumberLocked(false);
    } else {
      setIsNumberLocked(true);
    }
  }, [isNumberLocked]);
  const selectProject = useCallback((project: ProjectLike) => {
    projectTouchedRef.current = true;
    setFormData((previous) => ({ ...previous, projectId: project.id }));
  }, [setFormData]);
  const documentFields = useMemo<DocumentCanvasDocumentFields>(() => ({
    document: formData,
    templateElements: effectiveTemplate,
    templateType,
    clients,
    projects,
    selectedClientId,
    selectedClientLabel,
    selectedProjectLabel,
    onChange: setFormData,
    onClientNameChange: updateClientName,
    onAddressChange: (value) => setFormData((previous) => ({ ...previous, clientAddress: value, billingAddressJson: parseAddressText(value, previous.client, previous.billingAddressJson) }), { coalesce: true }),
    onSelectClient: applyClientToDocument,
    onSelectProject: selectProject,
    onUnlockNumber: unlockNumber,
    isNumberLocked,
    fieldErrors,
    taxModeOptions: INVOICE_TAX_MODE_DEFINITIONS.map((definition) => ({ value: definition.mode, label: definition.label })),
    taxRateOptions,
    resolvedTaxMode,
    taxRecommendation,
    taxRecommendationLabel: getInvoiceTaxModeDefinition(taxRecommendation.mode).label,
    buyerCountryCode,
    sellerCountryCode,
    requiresBuyerVatId,
    vatValidationPending,
    onValidateBuyerVatId: onValidateVatId ? () => void validateBuyerVatId() : undefined,
    onTemplateTextChange: onTemplateElementsChange ? handleTemplateTextChange : undefined,
    onTemplateElementsChange,
  }), [
    applyClientToDocument,
    buyerCountryCode,
    clients,
    fieldErrors,
    formData,
    effectiveTemplate,
    handleTemplateTextChange,
    isNumberLocked,
    onValidateVatId,
    onTemplateElementsChange,
    projects,
    requiresBuyerVatId,
    resolvedTaxMode,
    selectedClientId,
    selectedClientLabel,
    selectedProjectLabel,
    selectProject,
    sellerCountryCode,
    setFormData,
    taxRecommendation,
    taxRateOptions,
    templateType,
    unlockNumber,
    updateClientName,
    validateBuyerVatId,
    vatValidationPending,
  ]);

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
            <DocumentCanvasEditor elements={previewElements} />
          </div>
        ) : (
          <div ref={editorSurfaceRef} data-document-editor data-testid="document-editor" className="mx-auto w-fit min-w-[min(100%,794px)]">
            <DocumentCanvasEditor
              elements={previewElements}
              items={formData.items}
              articles={articles}
              formatCurrency={formatCurrency}
              taxRateOptions={taxRateOptions}
              documentFields={documentFields}
              onItemsChange={(items, options) => setFormData((previous) => ({ ...previous, items }), options)}
            />
          </div>
        )}
      </main>
    </div>
  );
};
