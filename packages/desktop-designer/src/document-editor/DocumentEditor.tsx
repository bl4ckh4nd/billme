import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentFlowEditor, type DocumentFlowDocumentFields } from './DocumentFlowEditor';
import { DocumentFlowPages } from '../flow/DocumentFlowPages';
import { ArrowLeft, Eye, Redo2, Save, Undo2 } from 'lucide-react';
import { buildDocumentViewModel, type DocumentRenderInput } from '@billme/desktop-utils/document';
import type { DocumentTemplateBody, TemplateKind } from '@billme/server-core/domain';
import { formatAddressMultiline } from '@billme/desktop-utils';
import {
  calculateInvoiceTaxSnapshot,
  getDachVatRates,
  getInvoiceTaxExemptionReason,
  getInvoiceTaxModeDefinition,
  INVOICE_TAX_MODE_DEFINITIONS,
  recommendInvoiceTaxMode,
  resolveInvoiceTaxMode,
} from '@billme/server-core/services';
import { Badge, Button, ConfirmDialog, IconButton, Select, ValidationSummary } from '@billme/ui';
import { useHistory } from '../hooks/useHistory';
import type { ArticleLike, ClientLike, DocumentDraft, ProjectLike, SettingsLike } from './types';

export interface DocumentEditorProps {
  document: DocumentDraft;
  templateType: 'invoice' | 'offer';
  mode: 'create' | 'edit';
  accountingEvidenceRequired?: boolean;
  clients: ClientLike[];
  articles: ArticleLike[];
  projects: ProjectLike[];
  settings: SettingsLike;
  /** Template kind the document prints with (a credit note is not an invoice). */
  templateKind: TemplateKind;
  /** Templates of that kind the document can choose instead of the default. */
  templateOptions: Array<{ id: string; name: string }>;
  /** Name of the default template, shown for "Standard". */
  defaultTemplateName: string;
  /** Resolves `layout.templateId` (undefined = default of the kind) to a body. */
  resolveTemplateBody: (templateId?: string) => DocumentTemplateBody;
  onValidateVatId?: (args: { countryCode: string; vatNumber: string }) => Promise<{ status: 'valid' | 'invalid' | 'unavailable'; normalizedVatId: string; checkedAt: string }>;
  onSelectedClientChange?: (clientId: string) => void;
  /** `numberChangeReason` is set when the user unlocked and may have edited the document number. */
  onSave: (document: DocumentDraft, meta?: { numberChangeReason?: string }) => void;
  onCancel: () => void;
}

interface FieldErrors {
  number?: string;
  date?: string;
  client?: string;
  positions?: string;
  buyerVatId?: string;
  taxRule?: string;
  destinationVatRate?: string;
  taxCountry?: string;
  datevEvidenceType?: string;
  datevEvidenceReference?: string;
  datevSachverhaltLl?: string;
  items: Record<number, string>;
}

interface DocumentValidationError {
  id: string;
  message: string;
  opensDetails: boolean;
}

const detailFieldIds = new Set([
  'document-field-tax-rule',
  'document-field-buyer-vat-id',
  'document-field-tax-country',
  'document-field-destination-vat-rate',
  'document-field-datev-evidence-type',
  'document-field-datev-evidence-reference',
  'document-field-datev-sachverhalt-ll',
]);

const getValidationErrors = (errors: FieldErrors): DocumentValidationError[] => {
  const fields: Array<[keyof Omit<FieldErrors, 'items'>, string, string]> = [
    ['number', 'Nummer', 'document-field-number'],
    ['date', 'Datum', 'document-field-date'],
    ['client', 'Kunde', 'document-field-client'],
    ['positions', 'Positionen', 'document-field-positions'],
    ['buyerVatId', 'Käufer-USt-IdNr.', 'document-field-buyer-vat-id'],
    ['taxRule', 'Umsatzsteuer-Modell', 'document-field-tax-rule'],
    ['taxCountry', 'DATEV-Land', 'document-field-tax-country'],
    ['destinationVatRate', 'EU-Steuersatz im Bestimmungsland', 'document-field-destination-vat-rate'],
    ['datevEvidenceType', 'DATEV-Nachweistyp', 'document-field-datev-evidence-type'],
    ['datevEvidenceReference', 'DATEV-Nachweisreferenz', 'document-field-datev-evidence-reference'],
    ['datevSachverhaltLl', 'DATEV-Sachverhalt L+L', 'document-field-datev-sachverhalt-ll'],
  ];
  const result = fields.flatMap(([key, label, id]) => errors[key] ? [{ id, message: `${label}: ${errors[key]}`, opensDetails: detailFieldIds.has(id) }] : []);
  return Object.entries(errors.items)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([index, message]) => ({
      id: `document-item-${index}-description`,
      message: `Position ${Number(index) + 1} Beschreibung: ${message}`,
      opensDetails: false,
    }))
    .reduce((all, item) => [...all, item], result);
};

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

// ponytail: two aria-pressed buttons instead of SegmentedControl; tests and E2E address them by role button, switch once they target radios.
const viewButtonClass = (selected: boolean) => `inline-flex h-6.5 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-caption focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring ${selected ? 'bg-surface font-semibold text-foreground shadow-thumb' : 'font-medium text-muted hover:text-foreground'}`;

export const DocumentEditor: React.FC<DocumentEditorProps> = ({
  document,
  templateType,
  mode,
  accountingEvidenceRequired = true,
  clients,
  articles,
  projects,
  settings: effectiveSettings,
  templateKind,
  templateOptions,
  defaultTemplateName,
  resolveTemplateBody,
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
  // GoBD: unlocking the number needs a stated reason; it goes into the save's audit entry.
  const [unlockReason, setUnlockReason] = useState('');
  const [numberChangeReason, setNumberChangeReason] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [vatValidationPending, setVatValidationPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({ items: {} });
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [taxDetailsOpen, setTaxDetailsOpen] = useState(false);
  const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);
  const [showUnlockConfirmation, setShowUnlockConfirmation] = useState(false);
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
    setTaxDetailsOpen(false);
    projectTouchedRef.current = false;
  }, [document, history.reset, mode]);

  const formData = history.state;
  const setFormData = history.set;
  const dirty = formData !== baseline;
  const selectedTemplateId = formData.layout?.templateId;
  // A template deleted since the document chose it falls back to the default.
  const knownTemplateId = templateOptions.some((option) => option.id === selectedTemplateId) ? selectedTemplateId : undefined;
  const templateBody = useMemo(() => resolveTemplateBody(knownTemplateId), [knownTemplateId, resolveTemplateBody]);
  const taxSnapshot = useMemo(
    () => calculateInvoiceTaxSnapshot({ items: formData.items, taxMode: formData.taxMode, taxMeta: formData.taxMeta }, effectiveSettings),
    [effectiveSettings, formData.items, formData.taxMeta, formData.taxMode],
  );
  const viewModel = useMemo(
    () => buildDocumentViewModel({
      kind: templateKind,
      template: templateBody,
      document: { ...formData, taxSnapshot } as unknown as DocumentRenderInput['document'],
      settings: effectiveSettings as unknown as DocumentRenderInput['settings'],
      texts: formData.layout?.texts,
    }),
    [effectiveSettings, formData, taxSnapshot, templateBody, templateKind],
  );
  const currencyFormatter = useMemo(() => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }), []);
  const formatCurrency = (amount: number) => currencyFormatter.format(amount);
  const selectedProjectLabel = useMemo(() => {
    const project = projects.find((candidate) => candidate.id === formData.projectId);
    return project ? `${project.code ? `${project.code} – ` : ''}${project.name}` : '';
  }, [formData.projectId, projects]);
  const selectedClientLabel = clients.find((client) => client.id === selectedClientId)?.company ?? formData.client;
  const resolvedTaxMode = resolveInvoiceTaxMode(formData.taxMode, effectiveSettings);
  const datevTaxMeta = formData.taxMeta as (typeof formData.taxMeta & { destinationVatRate?: number; datevEvidenceType?: string; datevEvidenceReference?: string; datevSachverhaltLl?: string }) | undefined;
  // Keep these flags aligned with the canonical DATEV tax-case definitions
  // used by the posting seam.  UI mode names are the renderer contract, while
  // the backend resolves them to the corresponding tax-case key.
  const requiresTaxCountry = ['intra_eu_supply_6a', 'intra_eu_service_reverse_charge', 'export_third_country', 'non_taxable_outside_scope'].includes(resolvedTaxMode);
  const requiresDestinationRate = ['intra_eu_supply_6a', 'intra_eu_service_reverse_charge'].includes(resolvedTaxMode);
  const requiresDatevEvidence = accountingEvidenceRequired && ['small_business_19_ustg', 'reverse_charge_13b', 'intra_eu_supply_6a', 'intra_eu_service_reverse_charge', 'export_third_country', 'vat_exempt_4_ustg', 'non_taxable_outside_scope'].includes(resolvedTaxMode);
  const requiresDatevSachverhaltLl = accountingEvidenceRequired && ['reverse_charge_13b', 'intra_eu_service_reverse_charge', 'non_taxable_outside_scope'].includes(resolvedTaxMode);
  const requiresBuyerVatId = getInvoiceTaxModeDefinition(resolvedTaxMode).requiresBuyerVatId;
  const sellerCountryCode = effectiveSettings.legal.countryCode ?? 'DE';
  const buyerCountryCode = normalizeCountry(
    formData.taxMeta?.buyerCountryCode ?? (formData.billingAddressJson && typeof formData.billingAddressJson === 'object'
      ? (formData.billingAddressJson as { country?: string }).country
      : undefined),
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
    // ponytail: offers default to 30 days validity; replace with a settings field once one exists.
    due.setDate(due.getDate() + (templateType === 'invoice' ? effectiveSettings.legal?.paymentTermsDays ?? 14 : 30));
    const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
    if (formData === baseline) {
      // A default is not a user edit: keep an untouched draft pristine for the discard prompt.
      const next = { ...formData, dueDate: iso };
      history.reset(next);
      setBaseline(next);
      return;
    }
    setFormData((previous) => previous.dueDate ? previous : { ...previous, dueDate: iso });
  }, [baseline, effectiveSettings.legal?.paymentTermsDays, formData, history.reset, mode, setFormData, templateType]);

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
        buyerCountryCode: normalizeCountry(billingAddress?.country) || undefined,
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

  const startManualRecipient = useCallback(() => {
    setFormData((previous) => {
      const next = { ...previous };
      delete next.clientId;
      delete next.clientNumber;
      delete next.projectId;
      delete next.billingAddressJson;
      delete next.shippingAddressJson;
      next.client = '';
      next.clientEmail = '';
      next.clientAddress = '';
      if (next.taxMeta) {
        const taxMeta = { ...next.taxMeta };
        delete taxMeta.buyerCountryCode;
        delete taxMeta.buyerType;
        delete taxMeta.buyerVatId;
        delete taxMeta.vatIdValidation;
        delete taxMeta.vatIdValidationAt;
        taxMeta.taxRuleConfirmed = false;
        next.taxMeta = taxMeta;
      }
      return next;
    });
    setSelectedClientId('');
    onSelectedClientChange?.('');
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
    if (formData.items.length === 0) errors.positions = 'Mindestens eine Position ist erforderlich.';
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
    if (requiresTaxCountry && !/^[A-Z]{2}$/.test(datevTaxMeta?.buyerCountryCode ?? buyerCountryCode)) {
      errors.taxCountry = 'Ländercode des Leistungs-/Bestimmungslandes ist erforderlich.';
    }
    if (requiresDestinationRate && (!Number.isFinite(datevTaxMeta?.destinationVatRate) || Number(datevTaxMeta?.destinationVatRate) < 0 || Number(datevTaxMeta?.destinationVatRate) >= 100)) {
      errors.destinationVatRate = 'EU-Steuersatz im Bestimmungsland ist erforderlich.';
    }
    if (requiresDatevEvidence && !datevTaxMeta?.datevEvidenceType?.trim()) errors.datevEvidenceType = 'Nachweistyp ist erforderlich.';
    if (requiresDatevEvidence && !datevTaxMeta?.datevEvidenceReference?.trim()) errors.datevEvidenceReference = 'Nachweisreferenz ist erforderlich.';
    if (requiresDatevSachverhaltLl && !/^[1-9]\d{0,2}$/.test(datevTaxMeta?.datevSachverhaltLl ?? '')) errors.datevSachverhaltLl = 'DATEV-Sachverhalt L+L ist erforderlich.';
    setFieldErrors(errors);
    setTaxDetailsOpen(getValidationErrors(errors).some((error) => error.opensDetails));
    return errors;
  }, [buyerCountryCode, datevTaxMeta, effectiveSettings, formData, requiresBuyerVatId, requiresDatevEvidence, requiresDatevSachverhaltLl, requiresDestinationRate, requiresTaxCountry, sellerCountryCode]);

  const focusValidationField = useCallback((fieldId: string) => {
    if (detailFieldIds.has(fieldId)) setTaxDetailsOpen(true);
    window.requestAnimationFrame(() => {
      const block = globalThis.document.getElementById(fieldId);
      const target = block?.querySelector<HTMLElement>('input, textarea, button, select, [role="combobox"]') ?? block;
      target?.focus();
      if (typeof block?.scrollIntoView === 'function') block.scrollIntoView({ block: 'center' });
    });
  }, []);

  const focusValidationError = useCallback((errors: FieldErrors) => {
    const firstError = getValidationErrors(errors)[0];
    if (firstError) focusValidationField(firstError.id);
  }, [focusValidationField]);

  const handleSave = useCallback(() => {
    const errors = validate();
    if (getValidationErrors(errors).length > 0) {
      setSaveError('Bitte korrigiere die markierten Pflichtfelder.');
      setView('edit');
      focusValidationError(errors);
      return;
    }
    setSaveError(null);
    onSave({ ...formData, taxMode: resolvedTaxMode, taxSnapshot, amount: taxSnapshot.grossAmount }, numberChangeReason ? { numberChangeReason } : undefined);
  }, [focusValidationError, formData, numberChangeReason, onSave, resolvedTaxMode, taxSnapshot, validate]);

  const handleCancel = useCallback(() => {
    if (dirty) {
      setShowDiscardConfirmation(true);
      return;
    }
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
      setShowUnlockConfirmation(true);
    } else {
      setIsNumberLocked(true);
    }
  }, [isNumberLocked]);
  const selectProject = useCallback((project: ProjectLike) => {
    projectTouchedRef.current = true;
    setFormData((previous) => ({ ...previous, projectId: project.id }));
  }, [setFormData]);
  const validationErrors = useMemo(() => getValidationErrors(fieldErrors), [fieldErrors]);
  const detailValidationOpen = validationErrors.some((error) => error.opensDetails);
  const documentFields = useMemo<DocumentFlowDocumentFields>(() => ({
    document: formData,
    templateTexts: { intro: templateBody.texts.intro, closing: templateBody.texts.closing },
    templateType,
    clients,
    projects,
    selectedClientId,
    selectedClientLabel,
    selectedProjectLabel,
    onChange: setFormData,
    onClientNameChange: updateClientName,
    onAddressChange: (value) => setFormData((previous) => ({ ...previous, clientAddress: value, billingAddressJson: parseAddressText(value, previous.client, previous.billingAddressJson) }), { coalesce: true }),
    onStartManualRecipient: startManualRecipient,
    onSelectClient: applyClientToDocument,
    onSelectProject: selectProject,
    onUnlockNumber: unlockNumber,
    isNumberLocked,
    fieldErrors,
    taxDetailsOpen: taxDetailsOpen || detailValidationOpen,
    onTaxDetailsOpenChange: setTaxDetailsOpen,
    taxModeOptions: INVOICE_TAX_MODE_DEFINITIONS.map((definition) => ({ value: definition.mode, label: definition.label })),
    taxRateOptions,
    resolvedTaxMode,
    taxLegalText: getInvoiceTaxExemptionReason(resolvedTaxMode, formData.taxMeta),
    taxRecommendation,
    taxRecommendationLabel: getInvoiceTaxModeDefinition(taxRecommendation.mode).label,
    buyerCountryCode,
    sellerCountryCode,
    requiresBuyerVatId,
    requiresTaxCountry,
    requiresDestinationVatRate: requiresDestinationRate,
    requiresDatevEvidence,
    requiresDatevSachverhaltLl,
    vatValidationPending,
    onValidateBuyerVatId: onValidateVatId ? () => void validateBuyerVatId() : undefined,
  }), [
    applyClientToDocument,
    buyerCountryCode,
    clients,
    detailValidationOpen,
    fieldErrors,
    formData,
    templateBody,
    isNumberLocked,
    onValidateVatId,
    projects,
    requiresBuyerVatId,
    requiresDatevEvidence,
    requiresDatevSachverhaltLl,
    requiresDestinationRate,
    requiresTaxCountry,
    resolvedTaxMode,
    selectedClientId,
    selectedClientLabel,
    selectedProjectLabel,
    selectProject,
    sellerCountryCode,
    startManualRecipient,
    setFormData,
    taxDetailsOpen,
    taxRecommendation,
    taxRateOptions,
    templateType,
    unlockNumber,
    updateClientName,
    validateBuyerVatId,
    vatValidationPending,
  ]);
  const firstValidationError = validationErrors[0]?.message;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-2.5 sm:px-5">
        <Button variant="ghost" size="sm" onClick={handleCancel} aria-label="Zurück">
          <ArrowLeft size={14} aria-hidden="true" />
          <span className="hidden sm:inline">Zurück</span>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title text-foreground">{title} {mode === 'create' ? 'erstellen' : 'bearbeiten'}</h1>
          <p className="truncate text-caption text-muted">{formData.number || 'Ohne Nummer'}</p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton onClick={history.undo} disabled={!history.canUndo} aria-label="Rückgängig"><Undo2 size={16} aria-hidden="true" /></IconButton>
          <IconButton onClick={history.redo} disabled={!history.canRedo} aria-label="Wiederholen"><Redo2 size={16} aria-hidden="true" /></IconButton>
        </div>
        <div className="hidden items-center gap-2 lg:flex">
          <label htmlFor="document-template" className="text-caption font-medium text-foreground-secondary">Vorlage</label>
          <Select
            id="document-template"
            aria-label="Vorlage"
            value={knownTemplateId ?? ''}
            onChange={(event) => setFormData((previous) => ({
              ...previous,
              layout: { ...previous.layout, templateId: event.target.value || undefined },
            }))}
            className="max-w-48"
          >
            <option value="">Standard ({defaultTemplateName})</option>
            {templateOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </Select>
        </div>
        {dirty ? <Badge tone="warning" className="hidden md:inline-flex"><span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />Ungespeichert</Badge> : null}
        <div className="flex gap-0.5 rounded-control border border-border bg-surface-sunken p-0.5" role="group" aria-label="Dokumentansicht">
          <button type="button" aria-pressed={view === 'edit'} onClick={() => setView('edit')} className={viewButtonClass(view === 'edit')}>Bearbeiten</button>
          <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')} className={viewButtonClass(view === 'preview')}><Eye size={14} aria-hidden="true" /> Vorschau</button>
        </div>
        {firstValidationError ? <span id="document-save-validation-error" className="max-w-56 text-right text-caption text-error-text" role="status" aria-live="assertive">{firstValidationError}</span> : null}
        <Button onClick={handleSave} aria-label="Speichern" aria-describedby={firstValidationError ? 'document-save-validation-error' : undefined}>
          <Save size={16} aria-hidden="true" />
          <span className="hidden sm:inline">Speichern</span>
        </Button>
      </header>

      {saveError && validationErrors.length === 0 ? <div className="mx-auto mt-3 w-full max-w-[900px] rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">{saveError}</div> : null}
      {validationErrors.length > 0 ? <div className="mx-auto mt-3 w-full max-w-[900px]"><ValidationSummary title="Bitte korrigiere die markierten Pflichtfelder." errors={validationErrors.map(({ id, message }) => ({ id, message }))} onJump={focusValidationField} /></div> : null}

      <main className={`flex-1 overflow-auto bg-surface-inverse-raised p-5 ${saveError || validationErrors.length > 0 ? 'mt-3' : ''}`}>
        {view === 'preview' ? (
          <div className="mx-auto w-fit" data-document-preview data-testid="document-preview">
            <DocumentFlowPages model={viewModel} pageClassName="bf-page-preview" />
          </div>
        ) : (
          <div ref={editorSurfaceRef} data-document-editor data-testid="document-editor" className="mx-auto w-fit">
            <DocumentFlowEditor
              model={viewModel}
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

      <ConfirmDialog
        open={showDiscardConfirmation}
        title="Ungespeicherte Änderungen verwerfen?"
        description="Deine bisher eingetragenen Änderungen gehen verloren."
        confirmLabel="Änderungen verwerfen"
        cancelLabel="Weiter bearbeiten"
        destructive
        onConfirm={() => {
          setShowDiscardConfirmation(false);
          onCancel();
        }}
        onCancel={() => setShowDiscardConfirmation(false)}
      />
      <ConfirmDialog
        open={showUnlockConfirmation}
        title="Nummer entsperren?"
        description="Achtung: Die manuelle Änderung der Nummer kann die GoBD-konforme Nummerierung gefährden. Der Grund wird mit der Änderung im Audit-Log gespeichert."
        confirmLabel="Nummer entsperren"
        cancelLabel="Abbrechen"
        destructive
        reason={{
          label: 'Grund (Pflicht)',
          placeholder: 'Warum wird die Nummer geändert?',
          required: true,
          value: unlockReason,
          onChange: setUnlockReason,
        }}
        onConfirm={() => {
          setShowUnlockConfirmation(false);
          setIsNumberLocked(false);
          setNumberChangeReason(unlockReason.trim());
          setUnlockReason('');
        }}
        onCancel={() => {
          setShowUnlockConfirmation(false);
          setUnlockReason('');
        }}
      />
    </div>
  );
};
