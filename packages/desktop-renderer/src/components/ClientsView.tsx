

import React, { useState } from 'react';
import {
    Search, Plus, MapPin, Phone, Mail, FileText,
    MoreHorizontal, Tag, Briefcase, Calendar,
    ArrowRight, ArrowLeft, Trash2, Edit3, X,
    CheckCircle, Clock, AlertCircle, LayoutGrid, List, Check
} from 'lucide-react';
import { Badge, Button, EMPTY_VALUE, EmptyState, ErrorState, ValidationSummary, useActionFeedback } from '@billme/ui';
import type { Client, ClientAddress, ClientEmail } from '@billme/desktop-core/types';
import { useClientsQuery, useDeleteClientMutation, useUpsertClientMutation } from '../hooks/useClients';
import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useCreateDocumentFromClientMutation } from '../hooks/useDocuments';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useUiStore } from '../ui-store';
import { v4 as uuidv4 } from 'uuid';
import { SkeletonLoader } from '@billme/desktop-ui/components/SkeletonLoader';

type ClientEditorErrors = Record<string, string>;

const emailFieldKey = (id: string) => `email:${id}`;
const addressFieldKey = (id: string, field: 'street' | 'zip' | 'city' | 'country') => `address:${id}:${field}`;

const requiredMark = <span aria-hidden="true" className="ml-0.5 text-error-text">*</span>;

const countLabel = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;

export const ClientsView: React.FC = () => {
    const {
        data: clients = [],
        isLoading: isLoadingClients,
        isError: isClientsError,
        refetch: refetchClients,
    } = useClientsQuery();
    const {
        data: invoices = [],
        isLoading: isLoadingInvoices,
        isError: isInvoicesError,
        refetch: refetchInvoices,
    } = useInvoicesQuery();
    const createFromClient = useCreateDocumentFromClientMutation();
    const upsertClient = useUpsertClientMutation();
    const deleteClient = useDeleteClientMutation();
    const { notify } = useActionFeedback('clients');
    const { pendingIds, requestDelete } = useDeferredDelete({
        scope: 'clients',
        commit: (id) => deleteClient.mutateAsync(id),
        label: (count) => count === 1 ? 'Kunde gelöscht' : `${count} Kunden gelöscht`,
    });
    const navigate = useNavigate();
    const setEditingInvoice = useUiStore((s) => s.setEditingInvoice);
    const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [draft, setDraft] = useState<Client | null>(null);
    const [editorErrors, setEditorErrors] = useState<ClientEditorErrors>({});
    const editorId = React.useId();
    const locationSearch = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;

    const getInputId = (field: string) => `${editorId}-${field.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const getFieldErrorId = (field: string) => `${getInputId(field)}-error`;
    const getValidationTargetId = (field: string) => {
        if (field === 'email' || field === 'emails') {
            return getInputId(emailFieldKey(draft?.emails?.[0]?.id ?? ''));
        }
        if (field === 'addresses') {
            return getInputId(addressFieldKey(draft?.addresses?.[0]?.id ?? '', 'street'));
        }
        return getInputId(field);
    };

    const focusEditorField = (field: string) => {
        const fieldId = field.startsWith(`${editorId}-`) ? field.slice(`${editorId}-`.length) : field;
        let inputId = field.startsWith(`${editorId}-`) ? field : getInputId(field);
        if (fieldId === 'email' || fieldId === 'emails') {
            inputId = getInputId(emailFieldKey(draft?.emails?.[0]?.id ?? ''));
        } else if (fieldId === 'addresses') {
            inputId = getInputId(addressFieldKey(draft?.addresses?.[0]?.id ?? '', 'street'));
        }

        const target = document.getElementById(inputId);
        if (!(target instanceof HTMLElement)) return;
        target.focus();
        target.scrollIntoView?.({ block: 'center' });
    };

    // Several address fields share one rule text; the summary lists each message once.
    const editorValidationIssues = Object.entries(editorErrors)
        .map(([field, message]) => ({ id: getValidationTargetId(field), message }))
        .filter((issue, index, all) => all.findIndex((other) => other.message === issue.message) === index);
    const firstEditorError = editorValidationIssues[0];
    const saveErrorId = `${editorId}-save-error`;

    React.useEffect(() => {
        const firstError = Object.keys(editorErrors)[0];
        if (!firstError || !isEditorOpen) return;
        focusEditorField(firstError);
    }, [editorErrors, isEditorOpen]);

    const visibleClients = clients.filter((client) => !pendingIds.has(client.id));
    const selectedClient = visibleClients.find(c => c.id === selectedClientId);

    const normalizedSearch = searchTerm.trim().toLowerCase();
    const filteredClients = visibleClients.filter((c) => {
        if (!normalizedSearch) return true;
        const searchable = [
            c.company,
            c.contactPerson,
            c.email,
            c.customerNumber,
            c.phone,
            ...(c.emails ?? []).map((email) => email.email),
        ]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase());
        return searchable.some((value) => value.includes(normalizedSearch));
    });

    React.useEffect(() => {
        const deepLinkClientId = typeof locationSearch.id === 'string' ? locationSearch.id : undefined;
        if (!deepLinkClientId) return;
        if (!visibleClients.some((client) => client.id === deepLinkClientId)) return;
        setSelectedClientId(deepLinkClientId);
    }, [locationSearch, visibleClients]);

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
    };

    const openEditor = (client?: Client) => {
        const base: Client =
            client ??
            ({
                id: uuidv4(),
                customerNumber: '',
                company: '',
                contactPerson: '',
                email: '',
                phone: '',
                address: '',
                status: 'active',
                tags: [],
                notes: '',
                projects: [],
                activities: [],
                addresses: [
                    {
                        id: uuidv4(),
                        clientId: 'NEW',
                        label: 'Rechnungsadresse',
                        kind: 'billing',
                        street: '',
                        zip: '',
                        city: '',
                        country: 'DE',
                        isDefaultBilling: true,
                        isDefaultShipping: true,
                    } as ClientAddress,
                ],
                emails: [
                    {
                        id: uuidv4(),
                        clientId: 'NEW',
                        label: 'Buchhaltung',
                        kind: 'billing',
                        email: '',
                        isDefaultBilling: true,
                        isDefaultGeneral: true,
                    } as ClientEmail,
                ],
            } as Client);

        const fixed: Client = {
            ...base,
            addresses: (base.addresses ?? []).map((a) => ({ ...a, clientId: base.id })),
            emails: (base.emails ?? []).map((e) => ({ ...e, clientId: base.id })),
        };

        setEditorErrors({});
        setDraft(fixed);
        setIsEditorOpen(true);
    };

    const closeEditor = () => {
        setIsEditorOpen(false);
        setDraft(null);
        setEditorErrors({});
    };

    const setOnlyOneFlag = <T extends { id: string }>(
        list: T[],
        id: string,
        flag: keyof T,
    ): T[] => {
        return list.map((x) => ({ ...x, [flag]: x.id === id }));
    };

    const emailKindLabel: Record<ClientEmail['kind'], string> = {
        general: 'Allgemein',
        billing: 'Rechnung',
        shipping: 'Lieferung',
        other: 'Sonstiges',
    };

    const addressKindLabel: Record<ClientAddress['kind'], string> = {
        billing: 'Rechnung',
        shipping: 'Lieferung',
        other: 'Sonstiges',
    };

    const defaultBillingEmail = (list: ClientEmail[]) =>
        list.find((e) => e.isDefaultBilling) ?? list.find((e) => e.isDefaultGeneral) ?? list[0] ?? null;
    const defaultGeneralEmail = (list: ClientEmail[]) =>
        list.find((e) => e.isDefaultGeneral) ?? list.find((e) => e.isDefaultBilling) ?? list[0] ?? null;
    const defaultBillingAddress = (list: ClientAddress[]) =>
        list.find((a) => a.isDefaultBilling) ?? list.find((a) => a.kind === 'billing') ?? list[0] ?? null;
    const defaultShippingAddress = (list: ClientAddress[]) =>
        list.find((a) => a.isDefaultShipping) ?? list.find((a) => a.kind === 'shipping') ?? defaultBillingAddress(list) ?? null;

    const saveDraft = async () => {
        if (!draft) return;
        const errors: ClientEditorErrors = {};
        const addError = (field: string, message: string) => {
            if (!errors[field]) errors[field] = message;
        };
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        const company = draft.company.trim();
        if (!company) {
            addError('company', 'Firma ist erforderlich.');
        }

        const legacyEmail = (draft.email ?? '').trim();
        if (legacyEmail && !emailRegex.test(legacyEmail)) {
            addError('email', 'Primäre E-Mail ist ungültig.');
        }

        const normalizedEmails = (draft.emails ?? [])
            .map((email) => ({
                ...email,
                clientId: draft.id,
                label: email.label.trim(),
                email: email.email.trim(),
            }))
            .filter((email) => email.email.length > 0 || email.label.length > 0);

        for (const email of normalizedEmails) {
            if (email.isDefaultBilling && !email.email) {
                addError(emailFieldKey(email.id), 'E-Mail-Adresse ist erforderlich.');
            }
            if (email.email && !emailRegex.test(email.email)) {
                addError(emailFieldKey(email.id), `Ungültige E-Mail-Adresse: ${email.email}`);
            }
        }

        if (normalizedEmails.length > 0 && !normalizedEmails.some((email) => email.isDefaultBilling)) {
            addError('emails', 'Mindestens eine E-Mail muss als Standard Rechnung markiert sein.');
        }

        const normalizedAddresses = (draft.addresses ?? [])
            .map((address) => ({
                ...address,
                clientId: draft.id,
                label: address.label.trim(),
                street: address.street.trim(),
                line2: address.line2?.trim(),
                zip: address.zip.trim(),
                city: address.city.trim(),
                country: address.country.trim(),
            }))
            .filter((address) =>
                address.street.length > 0 ||
                address.zip.length > 0 ||
                address.city.length > 0 ||
                address.label.length > 0,
            );

        const billingAddress = normalizedAddresses.find((address) => address.isDefaultBilling);
        if (normalizedAddresses.length > 0 && !billingAddress) {
            addError('addresses', 'Mindestens eine Adresse muss als Standard Rechnung markiert sein.');
        }
        if (billingAddress) {
            const billingAddressMessage = 'Standard-Rechnungsadresse benötigt Straße, PLZ, Stadt und Land.';
            if (!billingAddress.street) {
                addError(addressFieldKey(billingAddress.id, 'street'), billingAddressMessage);
            }
            if (!billingAddress.zip) {
                addError(addressFieldKey(billingAddress.id, 'zip'), billingAddressMessage);
            }
            if (!billingAddress.city) {
                addError(addressFieldKey(billingAddress.id, 'city'), billingAddressMessage);
            }
            if (!billingAddress.country) {
                addError(addressFieldKey(billingAddress.id, 'country'), billingAddressMessage);
            }
        }

        if (Object.keys(errors).length > 0) {
            setEditorErrors(errors);
            return;
        }
        setEditorErrors({});

        const payload: Client = {
            ...draft,
            company,
            email: legacyEmail,
            contactPerson: draft.contactPerson.trim(),
            phone: draft.phone.trim(),
            address: draft.address.trim(),
            notes: draft.notes ?? '',
            customerNumber: draft.customerNumber?.trim() || undefined,
            addresses: normalizedAddresses,
            emails: normalizedEmails,
            projects: draft.projects ?? [],
            activities: draft.activities ?? [],
        };

        try {
            const saved = await upsertClient.mutateAsync(payload);
            setSelectedClientId(saved.id);
            closeEditor();
        } catch (e) {
            notify('error', `Speichern fehlgeschlagen: ${String(e)}`);
        }
    };

    const DetailView = () => {
        if (!selectedClient) return null;

        const addresses = selectedClient.addresses ?? [];
        const emails = selectedClient.emails ?? [];
        const billingAddress =
            addresses.find(a => a.isDefaultBilling) ??
            addresses.find(a => a.kind === 'billing') ??
            addresses[0] ??
            null;
        const shippingAddress =
            addresses.find(a => a.isDefaultShipping) ??
            addresses.find(a => a.kind === 'shipping') ??
            billingAddress ??
            null;
        const billingEmail =
            emails.find(e => e.isDefaultBilling) ??
            emails.find(e => e.isDefaultGeneral) ??
            emails[0] ??
            null;

        // Values rendered in the "Adressen & E-Mails" card; the counter below reads exactly these lines.
        const addressLines = [
            billingAddress
                ? `${billingAddress.street}${billingAddress.line2 ? `, ${billingAddress.line2}` : ''}, ${billingAddress.zip} ${billingAddress.city}, ${billingAddress.country}`
                : selectedClient.address || '',
            shippingAddress
                ? `${shippingAddress.street}${shippingAddress.line2 ? `, ${shippingAddress.line2}` : ''}, ${shippingAddress.zip} ${shippingAddress.city}, ${shippingAddress.country}`
                : '',
        ];
        const emailLines = [billingEmail?.email || selectedClient.email || ''];

        // Without a separate shipping address the shipping box mirrors the billing one, so count unique lines.
        const addressCount = new Set(addressLines.filter(Boolean)).size;
        const emailCount = new Set(emailLines.filter(Boolean)).size;

        // Calculations
        const clientInvoices = invoices.filter(inv => inv.clientId === selectedClient.id);
        const totalRevenue = clientInvoices.filter(i => i.status === 'paid').reduce((acc, curr) => acc + curr.amount, 0);
        const outstandingAmount = clientInvoices.filter(i => ['open', 'overdue'].includes(i.status)).reduce((acc, curr) => acc + curr.amount, 0);
        const paidCount = clientInvoices.filter(i => i.status === 'paid').length;
        const openCount = clientInvoices.filter(i => ['open', 'overdue'].includes(i.status)).length;

        // Sort invoices by date desc
        const sortedInvoices = [...clientInvoices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return (
            <div className="h-full flex flex-col gap-6 pb-8 overflow-y-auto">
                {/* Navigation & Header Actions */}
                 <div className="flex justify-between items-center">
                    <button onClick={() => setSelectedClientId(null)} className="flex items-center gap-2 text-muted hover:text-foreground font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm">
                        <ArrowLeft size={20} />
                        <span className="text-sm uppercase tracking-wider">Zurück zur Übersicht</span>
                    </button>
                    <div className="flex gap-2">
                        <button
                          onClick={async () => {
                             const res = await createFromClient.mutateAsync({
                               kind: 'invoice',
                               clientId: selectedClient.id,
                             });
                             setEditingInvoice(res, 'invoice', 'create');
                             navigate({ to: '/documents/edit' });
                           }}
                          className="px-3 py-1.5 bg-black text-white rounded-lg text-xs font-bold hover:bg-dark-2 transition-colors flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
                        >
                            <Plus size={14} /> Neue Rechnung
                        </button>
                        <button
                          onClick={async () => {
                             const res = await createFromClient.mutateAsync({
                               kind: 'offer',
                               clientId: selectedClient.id,
                             });
                             setEditingInvoice(res, 'offer', 'create');
                             navigate({ to: '/documents/edit' });
                           }}
                          className="px-4 py-2 bg-white border border-control-border text-black rounded-full text-xs font-bold hover:bg-surface-muted transition-colors flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                            <Plus size={14} /> Neues Angebot
                        </button>
                        <button
                          onClick={() => openEditor(selectedClient)}
                          title="Kunde bearbeiten"
                          aria-label="Kunde bearbeiten"
                          className="w-10 h-10 border border-control-border rounded-full flex items-center justify-center hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                            <Edit3 size={16} />
                        </button>
                        <button
                          onClick={() => {
                            requestDelete([selectedClient.id]);
                            setSelectedClientId(null);
                          }}
                          title="Kunde löschen"
                          aria-label="Kunde löschen"
                          className="w-10 h-10 border border-control-border rounded-full flex items-center justify-center hover:bg-error-bg transition-colors text-error-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                          <Trash2 size={16} />
                        </button>
                    </div>
                </div>

                {/* Top Section: Identity & KPIs */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Identity Card */}
                    <div className="bg-accent rounded-xl p-6 text-black border border-black/10 flex flex-col justify-between min-h-[240px]">
                        <div>
                             <div className="flex items-center gap-4 mb-6">
                                <div className="w-16 h-16 bg-black text-white text-2xl font-bold rounded-2xl flex items-center justify-center">
                                     {selectedClient.company.substring(0, 2).toUpperCase()}
                                 </div>
                                 <div>
                                     <h2 className="text-2xl font-bold leading-tight">{selectedClient.company}</h2>
                                     <p className="font-medium text-black/70">{selectedClient.contactPerson}</p>
                                     {selectedClient.customerNumber && (
                                       <p className="font-mono text-xs text-black/60 mt-1">{selectedClient.customerNumber}</p>
                                     )}
                                 </div>
                             </div>
                             <div className="space-y-2">
                                 <div className="flex items-center gap-2 text-sm font-bold text-black/80">
                                     <Mail size={14} /> {billingEmail?.email || selectedClient.email || EMPTY_VALUE}
                                 </div>
                                 <div className="flex items-center gap-2 text-sm font-bold text-black/80">
                                     <Phone size={14} /> {selectedClient.phone || EMPTY_VALUE}
                                 </div>
                                  <div className="flex items-center gap-2 text-sm font-bold text-black/80">
                                     <MapPin size={14} /> {(billingAddress ? `${billingAddress.street}, ${billingAddress.zip} ${billingAddress.city}` : selectedClient.address) || EMPTY_VALUE}
                                 </div>
                             </div>
                        </div>
                        {selectedClient.tags.length > 0 && (
                            <div className="mt-6 flex flex-wrap gap-2">
                                {selectedClient.tags.map(tag => (
                                    <span key={tag} className="px-3 py-1 bg-white/50 rounded-full text-xs font-bold">{tag}</span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* The question this screen answers is "was schuldet dieser
                        Kunde mir": the outstanding balance is the focal metric,
                        the rest is one compact row. */}
                    <div className="lg:col-span-2 flex flex-col gap-4">
                        {isInvoicesError ? (
                            <ErrorState
                                title="Rechnungsdaten konnten nicht geladen werden"
                                description="Umsatz und offene Forderungen sind ohne die Rechnungen nicht berechenbar, deshalb werden hier keine Zahlen angezeigt."
                                onRetry={() => void refetchInvoices()}
                            />
                        ) : (
                          <>
                            <div className="bg-dark-3 text-white rounded-xl p-6 flex flex-col justify-between">
                                <div>
                                    <p className="text-dark-muted text-xs font-bold uppercase tracking-wider mb-1">Offene Forderungen</p>
                                    <h3 className="text-3xl font-bold tabular-nums">{formatCurrency(outstandingAmount)}</h3>
                                </div>
                                <div className="mt-4 flex items-center gap-2">
                                    {isLoadingInvoices ? (
                                        <span className="bg-white/10 px-2 py-1 rounded-sm text-xs font-bold">Rechnungen werden geladen ...</span>
                                    ) : openCount > 0 ? (
                                        <span className="bg-error-bg text-error-text px-2 py-1 rounded-sm text-xs font-bold flex items-center gap-1 tabular-nums">
                                            <AlertCircle size={12} /> {openCount} offen
                                        </span>
                                    ) : (
                                        <span className="bg-success-bg text-success-text px-2 py-1 rounded-sm text-xs font-bold flex items-center gap-1">
                                            <CheckCircle size={12} /> Alles bezahlt
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div className="rounded-xl bg-surface border border-border px-4 py-3">
                                    <p className="text-xs font-bold text-muted uppercase tracking-wider">Gesamtumsatz (LTV)</p>
                                    <p className="text-lg font-black text-foreground mt-1 tabular-nums">{formatCurrency(totalRevenue)}</p>
                                    <p className="text-xs text-muted tabular-nums">{countLabel(paidCount, 'bezahlte Rechnung', 'bezahlte Rechnungen')}</p>
                                </div>
                                <div className="rounded-xl bg-surface border border-border px-4 py-3">
                                    <p className="text-xs font-bold text-muted uppercase tracking-wider">Aktive Projekte</p>
                                    <p className="text-lg font-black text-foreground mt-1 tabular-nums">{selectedClient.projects.filter(p => p.status === 'active').length}</p>
                                    <p className="text-xs text-muted tabular-nums">Insgesamt {countLabel(selectedClient.projects.length, 'Projekt', 'Projekte')}</p>
                                </div>
                                <div className="rounded-xl bg-surface border border-border px-4 py-3">
                                    <p className="text-xs font-bold text-muted uppercase tracking-wider">Letzte Aktivität</p>
                                    <p className="text-lg font-black text-foreground mt-1 tabular-nums">
                                        {selectedClient.activities[0]
                                            ? new Date(selectedClient.activities[0].date).toLocaleDateString()
                                            : EMPTY_VALUE}
                                    </p>
                                    <p className="text-xs text-muted truncate">
                                        {selectedClient.activities[0]?.content ?? 'Keine Aktivitäten'}
                                    </p>
                                </div>
                            </div>
                          </>
                        )}
                    </div>
                </div>

                {/* Bottom Section: Invoices & History */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Left: Invoice List (2 cols wide) */}
                    <div className="lg:col-span-2 bg-surface rounded-2xl p-6 border border-border min-h-[400px]">
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-xl font-bold flex items-center gap-2">
                                <FileText size={20} /> Rechnungsverlauf
                            </h3>
                        </div>

                        <div className="space-y-2">
                            {isInvoicesError ? (
                                <ErrorState
                                    title="Rechnungsverlauf konnte nicht geladen werden"
                                    description="Die Rechnungen dieses Kunden sind nicht abrufbar."
                                    onRetry={() => void refetchInvoices()}
                                />
                            ) : isLoadingInvoices ? (
                                <SkeletonLoader variant="list" count={3} />
                            ) : sortedInvoices.length > 0 ? sortedInvoices.map((inv) => (
                                <button
                                    key={inv.id}
                                    type="button"
                                    onClick={() => {
                                        navigate({ to: '/documents', search: { kind: 'invoice', id: inv.id } });
                                    }}
                                    className="group w-full text-left flex items-center justify-between p-4 rounded-2xl border border-control-border hover:border-foreground hover:bg-surface-muted transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                    title={`${inv.number} öffnen`}
                                >
                                    <div className="flex items-center gap-4">
                                        <div className="w-10 h-10 rounded-xl border border-border bg-border-subtle text-muted flex items-center justify-center" aria-hidden="true">
                                            {inv.status === 'paid' ? <CheckCircle size={16} /> : <Clock size={16} />}
                                        </div>
                                        <div>
                                            <p className="font-bold text-sm">{inv.number}</p>
                                            <p className="text-xs text-muted tabular-nums">{new Date(inv.date).toLocaleDateString()}</p>
                                        </div>
                                    </div>

                                    <div className="text-right">
                                        <p className="font-bold tabular-nums">{formatCurrency(inv.amount)}</p>
                                        <Badge status={inv.status} />
                                    </div>

                                    <div className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 motion-safe:transition-opacity motion-reduce:transition-none">
                                        <ArrowRight size={16} />
                                    </div>
                                </button>
                            )) : (
                                <EmptyState
                                    title="Noch keine Rechnungen für diesen Kunden"
                                    description='Sobald du eine Rechnung mit diesem Kunden erstellst, erscheint sie hier mit Status und Betrag. Starte sie über "Neue Rechnung" oben rechts.'
                                />
                            )}
                        </div>
                    </div>

                    {/* Right: Notes & Projects (1 col wide) */}
                    <div className="flex flex-col gap-6">
                        {/* Addresses & Emails */}
                        <div className="bg-surface rounded-2xl p-6 border border-border">
                            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                                <MapPin size={18} /> Adressen & E-Mails
                            </h3>
                            <div className="space-y-3">
                                <div className="p-4 bg-surface-muted rounded-2xl border border-border">
                                    <p className="text-xs font-bold text-muted uppercase mb-1">Rechnungsadresse</p>
                                    <p className="text-sm font-medium text-foreground">
                                        {addressLines[0] || EMPTY_VALUE}
                                    </p>
                                </div>
                                <div className="p-4 bg-surface-muted rounded-2xl border border-border">
                                    <p className="text-xs font-bold text-muted uppercase mb-1">Lieferadresse</p>
                                    <p className="text-sm font-medium text-foreground">
                                        {addressLines[1] || EMPTY_VALUE}
                                    </p>
                                </div>
                                 <div className="p-4 bg-surface-muted rounded-2xl border border-border">
                                     <p className="text-xs font-bold text-muted uppercase mb-1">E-Mail (Rechnung)</p>
                                     <p className="text-sm font-medium text-foreground">{emailLines[0] || EMPTY_VALUE}</p>
                                 </div>
                                <div className="text-xs text-muted tabular-nums">
                                    {countLabel(addressCount, 'Adresse', 'Adressen')} • {countLabel(emailCount, 'E-Mail', 'E-Mails')} • Pflege über "Kunde bearbeiten" oben rechts
                                </div>
                            </div>
                        </div>

                        {/* Projects Mini List */}
                        <div className="bg-surface rounded-2xl p-6 border border-border flex-1">
                             <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                                <Briefcase size={18} /> Projekte
                            </h3>
                            <div className="space-y-3">
                                {selectedClient.projects.map(p => (
                                    <button
                                        key={p.id}
                                        onClick={() => navigate({ to: `/projects/${p.id}` })}
                                        className="w-full text-left p-4 bg-surface-muted rounded-2xl border border-control-border hover:bg-border-subtle transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                        title="Projekt öffnen"
                                    >
                                        <div className="flex justify-between items-start mb-2">
                                            <div>
                                              <div className="font-bold text-sm">{p.name}</div>
                                              {p.code && <div className="text-xs text-muted font-mono mt-1">{p.code}</div>}
                                            </div>
                                            {/* The dot never carries the status alone: the label sits next to it. */}
                                            <span className="flex items-center gap-1.5 text-xs font-bold text-muted">
                                                <span
                                                    aria-hidden="true"
                                                    className={`w-2 h-2 rounded-full ${p.status === 'active' ? 'bg-success' : 'bg-muted'}`}
                                                />
                                                {p.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-end">
                                            <span className="text-xs text-muted tabular-nums">Budget: {formatCurrency(p.budget)}</span>
                                        </div>
                                    </button>
                                ))}
                                {selectedClient.projects.length === 0 && (
                                    <EmptyState
                                        className="rounded-2xl bg-surface-muted py-6"
                                        title="Noch keine Projekte"
                                        description="Projekte bündeln die Dokumente dieses Kunden."
                                        action={
                                            <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/projects' })}>
                                                Zu den Projekten
                                            </Button>
                                        }
                                    />
                                )}
                            </div>
                        </div>

                        {/* Notes / Activities */}
                        <div className="bg-surface rounded-2xl p-6 border border-border flex-1">
                            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                                <Tag size={18} /> Notizen
                            </h3>
                             <p className="text-sm text-muted leading-relaxed bg-warning-bg p-4 rounded-xl border border-warning-border">
                                {selectedClient.notes || 'Keine Notizen hinterlegt.'}
                             </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    return (
         <div className="bg-surface rounded-2xl p-6 min-h-full border border-border flex flex-col overflow-hidden">
              {isEditorOpen && draft ? (
                  <div className="flex flex-col flex-1 min-h-0">
                      <div className="flex flex-col flex-1 min-h-0">
                          <div className="p-6 border-b border-border flex items-center justify-between">
                              <h3 className="text-2xl font-bold">
                                  {clients.some((c) => c.id === draft.id) ? 'Kunde bearbeiten' : 'Neuer Kunde'}
                              </h3>
                              <button
                                  onClick={closeEditor}
                                  aria-label="Kundeneditor schließen"
                                  className="w-10 h-10 rounded-full hover:bg-border-subtle flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                              >
                                  <X size={18} />
                              </button>
                          </div>

                         <div className="p-6 space-y-12 flex-1 overflow-y-auto">
                              <ValidationSummary
                                  errors={editorValidationIssues}
                                  onJump={focusEditorField}
                              />
                              <section>
                                  <h4 className="text-lg font-bold mb-6 pb-3 border-b border-border">Stammdaten</h4>
                                 <div className="grid grid-cols-2 gap-4">
                                 <div>
                                     <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-kundennummer">Kundennummer</label>
                                     <input id="clientsview-kundennummer"
                                         value={draft.customerNumber ?? ''}
                                         onChange={(e) => setDraft({ ...draft, customerNumber: e.target.value })}
                                         placeholder="Automatisch bei leerem Feld"
                                         className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                     />
                                 </div>
                                  <div className="col-span-2">
                                      <label htmlFor={getInputId('company')} className="block text-xs font-bold text-muted mb-1">Firma{requiredMark}</label>
                                      <input
                                         id={getInputId('company')}
                                         value={draft.company}
                                         onChange={(e) => setDraft({ ...draft, company: e.target.value })}
                                         required
                                         aria-required="true"
                                         aria-invalid={editorErrors.company ? 'true' : undefined}
                                         aria-describedby={editorErrors.company ? getFieldErrorId('company') : undefined}
                                         className={`w-full bg-surface-muted border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 transition-shadow ${editorErrors.company ? 'border-error focus-visible:outline-error' : 'border-control-border focus-visible:outline-focus-ring'}`}
                                     />
                                     {editorErrors.company && <p id={getFieldErrorId('company')} className="mt-1 text-xs font-medium text-error-text">{editorErrors.company}</p>}
                                 </div>
                                 <div>
                                     <label htmlFor={getInputId('contactPerson')} className="block text-xs font-bold text-muted mb-1">Ansprechpartner</label>
                                     <input
                                         id={getInputId('contactPerson')}
                                         value={draft.contactPerson}
                                         onChange={(e) => setDraft({ ...draft, contactPerson: e.target.value })}
                                         className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                     />
                                 </div>
                                 <div>
                                     <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-telefon">Telefon</label>
                                     <input id="clientsview-telefon"
                                         value={draft.phone}
                                         onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                                         className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                     />
                                 </div>
                                 <div>
                                     <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-status">Status</label>
                                     <select id="clientsview-status"
                                         value={draft.status}
                                         onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
                                         className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                     >
                                         <option value="active">Aktiv</option>
                                         <option value="inactive">Inaktiv</option>
                                     </select>
                                 </div>
                                 <div>
                                     <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-tags-komma">Tags (Komma)</label>
                                     <input id="clientsview-tags-komma"
                                         value={(draft.tags ?? []).join(', ')}
                                         onChange={(e) =>
                                             setDraft({
                                                 ...draft,
                                                 tags: e.target.value
                                                     .split(',')
                                                     .map((t) => t.trim())
                                                     .filter(Boolean),
                                             })
                                         }
                                         className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                     />
                                 </div>
                                 <div className="col-span-2">
                                     <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-notizen">Notizen</label>
                                     <textarea id="clientsview-notizen"
                                         value={draft.notes ?? ''}
                                         onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                                         className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                         rows={3}
                                     />
                                 </div>
                              </div>
                             </section>

                              <section className="space-y-3">
                                  <div>
                                      <h4 className="font-bold text-sm">Steuerprofil</h4>
                                      <p className="text-xs text-muted mt-0.5">
                                          Wird beim Erstellen einer Rechnung als Vorschlag übernommen. Die Rechnung speichert danach ihren eigenen Snapshot.
                                      </p>
                                  </div>
                                  <div className="grid grid-cols-12 gap-4">
                                      <div className="col-span-4">
                                          <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-kundentyp">Kundentyp</label>
                                          <select id="clientsview-kundentyp"
                                              value={draft.taxProfile?.type ?? 'business'}
                                              onChange={(event) => setDraft({ ...draft, taxProfile: { ...draft.taxProfile, type: event.target.value as 'business' | 'consumer' } })}
                                              className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                          >
                                              <option value="business">Unternehmen</option>
                                              <option value="consumer">Privatkunde</option>
                                          </select>
                                      </div>
                                      <div className="col-span-4">
                                          <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-land-iso">Land (ISO)</label>
                                          <input id="clientsview-land-iso"
                                              value={draft.taxProfile?.countryCode ?? ''}
                                              onChange={(event) => setDraft({ ...draft, taxProfile: { ...draft.taxProfile, type: draft.taxProfile?.type ?? 'business', countryCode: event.target.value.toUpperCase() } })}
                                              placeholder="DE"
                                              maxLength={2}
                                              className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                          />
                                      </div>
                                      <div className="col-span-4">
                                          <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-ust-idnr">USt-IdNr.</label>
                                          <input id="clientsview-ust-idnr"
                                              value={draft.taxProfile?.vatId ?? ''}
                                              onChange={(event) => setDraft({ ...draft, taxProfile: { ...draft.taxProfile, type: draft.taxProfile?.type ?? 'business', vatId: event.target.value.toUpperCase(), vatIdValidation: undefined, vatIdValidationAt: undefined } })}
                                              placeholder="DE123456789"
                                              className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                          />
                                          {draft.taxProfile?.vatIdValidation ? <p className="mt-1 text-xs text-muted">Status: {draft.taxProfile.vatIdValidation}</p> : null}
                                      </div>
                                  </div>
                              </section>

                              <section className="space-y-3">
                                  <div className="flex items-center justify-between">
                                      <div>
                                          <h4 className="font-bold text-sm">E-Mails</h4>
                                          <p className="text-xs text-muted mt-0.5">
                                              Kategorie = Zweck. Standard = wird automatisch vorausgewählt.
                                          </p>
                                      </div>
                                      <button
                                          onClick={() =>
                                              setDraft({
                                                  ...draft,
                                                 emails: [
                                                     ...(draft.emails ?? []),
                                                     {
                                                         id: uuidv4(),
                                                         clientId: draft.id,
                                                         label: 'Neu',
                                                         kind: 'general',
                                                         email: '',
                                                     } as ClientEmail,
                                                 ],
                                             })
                                         }
                                         className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-dark-2 transition-colors"
                                     >
                                         + E-Mail
                                      </button>
                                  </div>

                                  {(draft.emails ?? []).map((em, idx) => {
                                      const field = emailFieldKey(em.id);
                                      const errorField = editorErrors[field]
                                          ? field
                                          : idx === 0 && editorErrors.email
                                              ? 'email'
                                              : idx === 0 && editorErrors.emails
                                                  ? 'emails'
                                                  : undefined;
                                      const errorMessage = errorField ? editorErrors[errorField] : undefined;
                                      const hasDefaultBillingEmail = (draft.emails ?? []).some((email) => email.isDefaultBilling);
                                      const isRequiredEmail = Boolean(em.isDefaultBilling) || (!hasDefaultBillingEmail && idx === 0);
                                      return (
                                      <div
                                          key={em.id}
                                          className="p-4 rounded-2xl border border-border bg-surface-muted space-y-3"
                                      >
                                          <div className="grid grid-cols-12 gap-3 items-end">
                                          <div className="col-span-3">
                                              <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-bezeichnung">Bezeichnung</label>
                                              <input id="clientsview-bezeichnung"
                                                  value={em.label}
                                                 onChange={(e) => {
                                                     const next = [...(draft.emails ?? [])];
                                                     next[idx] = { ...em, label: e.target.value };
                                                     setDraft({ ...draft, emails: next });
                                                 }}
                                                  className="w-full bg-surface border border-control-border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                              />
                                          </div>
                                          <div className="col-span-2">
                                              <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-kategorie">Kategorie</label>
                                              <select id="clientsview-kategorie"
                                                  value={em.kind}
                                                  onChange={(e) => {
                                                      const next = [...(draft.emails ?? [])];
                                                      next[idx] = { ...em, kind: e.target.value as any };
                                                      setDraft({ ...draft, emails: next });
                                                  }}
                                                  className="w-full bg-surface border border-control-border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                              >
                                                  <option value="general">{emailKindLabel.general}</option>
                                                  <option value="billing">{emailKindLabel.billing}</option>
                                                  <option value="shipping">{emailKindLabel.shipping}</option>
                                                  <option value="other">{emailKindLabel.other}</option>
                                              </select>
                                          </div>
                                          <div className="col-span-5">
                                              <label htmlFor={getInputId(field)} className="block text-xs font-bold text-muted mb-1">E-Mail-Adresse{isRequiredEmail && requiredMark}</label>
                                              <input
                                                  id={getInputId(field)}
                                                  value={em.email}
                                                  required={isRequiredEmail}
                                                  aria-required={isRequiredEmail ? 'true' : undefined}
                                                  aria-invalid={errorMessage ? 'true' : undefined}
                                                  aria-describedby={errorMessage ? getFieldErrorId(field) : undefined}
                                                  onChange={(e) => {
                                                      const next = [...(draft.emails ?? [])];
                                                     next[idx] = { ...em, email: e.target.value };
                                                     setDraft({ ...draft, emails: next });
                                                 }}
                                                  className={`w-full bg-surface border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 transition-shadow ${errorMessage ? 'border-error focus-visible:outline-error' : 'border-control-border focus-visible:outline-focus-ring'}`}
                                              />
                                              {errorMessage && <p id={getFieldErrorId(field)} className="mt-1 text-xs font-medium text-error-text">{errorMessage}</p>}
                                          </div>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <div className="flex items-center gap-2">
                                                  <span className="text-xs font-bold text-muted uppercase tracking-wider">Standard</span>
                                                  <button
                                                      onClick={() => {
                                                          const next = setOnlyOneFlag((draft.emails ?? []) as any, em.id, 'isDefaultBilling') as ClientEmail[];
                                                          setDraft({ ...draft, emails: next });
                                                      }}
                                                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                                                          em.isDefaultBilling ? 'bg-black text-white border-black' : 'bg-white text-foreground border-control-border hover:bg-surface-muted'
                                                      }`}
                                                  >
                                                      {em.isDefaultBilling && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                                                      Rechnung
                                                  </button>
                                                  <button
                                                      onClick={() => {
                                                          const next = setOnlyOneFlag((draft.emails ?? []) as any, em.id, 'isDefaultGeneral') as ClientEmail[];
                                                          setDraft({ ...draft, emails: next });
                                                      }}
                                                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                                                          em.isDefaultGeneral ? 'bg-black text-white border-black' : 'bg-white text-foreground border-control-border hover:bg-surface-muted'
                                                      }`}
                                                  >
                                                      {em.isDefaultGeneral && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                                                      Allgemein
                                                  </button>
                                              </div>
                                              <button
                                                  onClick={() => {
                                                      const next = (draft.emails ?? []).filter((e) => e.id !== em.id);
                                                      setDraft({ ...draft, emails: next });
                                                  }}
                                                  className="px-3 py-1.5 rounded-lg border border-error text-error-text hover:bg-error-bg text-xs font-bold flex items-center gap-1.5 transition-colors"
                                              >
                                                  <Trash2 size={14} />
                                                  Entfernen
                                              </button>
                                          </div>
                                      </div>
                                      );
                                  })}
                              </section>

                              <section className="space-y-3">
                                  <div className="flex items-center justify-between">
                                      <div>
                                          <h4 className="font-bold text-sm">Adressen</h4>
                                          <p className="text-xs text-muted mt-0.5">
                                              Kategorie = Zweck. Standard = wird automatisch übernommen.
                                          </p>
                                      </div>
                                      <button
                                          onClick={() =>
                                              setDraft({
                                                  ...draft,
                                                 addresses: [
                                                     ...(draft.addresses ?? []),
                                                     {
                                                         id: uuidv4(),
                                                         clientId: draft.id,
                                                         label: 'Neu',
                                                         kind: 'other',
                                                         street: '',
                                                         zip: '',
                                                         city: '',
                                                         country: 'DE',
                                                     } as ClientAddress,
                                                 ],
                                             })
                                         }
                                         className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-dark-2 transition-colors"
                                     >
                                         + Adresse
                                      </button>
                                  </div>

                                  {(draft.addresses ?? []).map((ad, idx) => {
                                      const addressRequired = Boolean(ad.isDefaultBilling);
                                      const fieldError = (field: 'street' | 'zip' | 'city' | 'country') => {
                                          const key = addressFieldKey(ad.id, field);
                                          if (editorErrors[key]) return { key, message: editorErrors[key] };
                                          if (idx === 0 && field === 'street' && editorErrors.addresses) {
                                              return { key: 'addresses', message: editorErrors.addresses };
                                          }
                                          return undefined;
                                      };
                                      const streetError = fieldError('street');
                                      const zipError = fieldError('zip');
                                      const cityError = fieldError('city');
                                      const countryError = fieldError('country');
                                      return (
                                      <div key={ad.id} className="p-4 bg-surface-muted rounded-2xl border border-border space-y-3">
                                          <div className="grid grid-cols-12 gap-3">
                                              <div className="col-span-4">
                                                  <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-bezeichnung-2">Bezeichnung</label>
                                                  <input id="clientsview-bezeichnung-2"
                                                     value={ad.label}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, label: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-control-border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                                 />
                                              </div>
                                              <div className="col-span-3">
                                                  <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-kategorie-2">Kategorie</label>
                                                  <select id="clientsview-kategorie-2"
                                                      value={ad.kind}
                                                      onChange={(e) => {
                                                          const next = [...(draft.addresses ?? [])];
                                                          next[idx] = { ...ad, kind: e.target.value as any };
                                                          setDraft({ ...draft, addresses: next });
                                                      }}
                                                      className="w-full bg-surface border border-control-border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                                  >
                                                      <option value="billing">{addressKindLabel.billing}</option>
                                                      <option value="shipping">{addressKindLabel.shipping}</option>
                                                      <option value="other">{addressKindLabel.other}</option>
                                                  </select>
                                              </div>
                                              <div className="col-span-5 flex items-end justify-end gap-2">
                                                  <button
                                                      onClick={() => {
                                                          const next = setOnlyOneFlag((draft.addresses ?? []) as any, ad.id, 'isDefaultBilling') as ClientAddress[];
                                                          setDraft({ ...draft, addresses: next });
                                                      }}
                                                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                                                          ad.isDefaultBilling ? 'bg-black text-white border-black' : 'bg-white text-foreground border-control-border hover:bg-surface-muted'
                                                      }`}
                                                  >
                                                      {ad.isDefaultBilling && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                                                      Standard Rechnung
                                                  </button>
                                                  <button
                                                      onClick={() => {
                                                          const next = setOnlyOneFlag((draft.addresses ?? []) as any, ad.id, 'isDefaultShipping') as ClientAddress[];
                                                          setDraft({ ...draft, addresses: next });
                                                      }}
                                                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                                                          ad.isDefaultShipping ? 'bg-black text-white border-black' : 'bg-white text-foreground border-control-border hover:bg-surface-muted'
                                                      }`}
                                                  >
                                                      {ad.isDefaultShipping && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                                                      Standard Lieferung
                                                  </button>
                                              </div>
                                          </div>

                                         <div className="grid grid-cols-12 gap-3">
                                             <div className="col-span-6">
                                                 <label htmlFor={getInputId(addressFieldKey(ad.id, 'street'))} className="block text-xs font-bold text-muted mb-1">Straße{addressRequired && requiredMark}</label>
                                                 <input
                                                     id={getInputId(addressFieldKey(ad.id, 'street'))}
                                                     value={ad.street}
                                                     required={addressRequired}
                                                     aria-required={addressRequired ? 'true' : undefined}
                                                     aria-invalid={streetError ? 'true' : undefined}
                                                     aria-describedby={streetError ? getFieldErrorId(streetError.key) : undefined}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, street: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className={`w-full bg-surface border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 transition-shadow ${streetError ? 'border-error focus-visible:outline-error' : 'border-control-border focus-visible:outline-focus-ring'}`}
                                                 />
                                                 {streetError && <p id={getFieldErrorId(streetError.key)} className="mt-1 text-xs font-medium text-error-text">{streetError.message}</p>}
                                             </div>
                                             <div className="col-span-6">
                                                 <label className="block text-xs font-bold text-muted mb-1" htmlFor="clientsview-zusatz">Zusatz</label>
                                                 <input id="clientsview-zusatz"
                                                     value={ad.line2 ?? ''}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, line2: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-control-border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                                                 />
                                             </div>
                                             <div className="col-span-3">
                                                 <label htmlFor={getInputId(addressFieldKey(ad.id, 'zip'))} className="block text-xs font-bold text-muted mb-1">PLZ{addressRequired && requiredMark}</label>
                                                 <input
                                                     id={getInputId(addressFieldKey(ad.id, 'zip'))}
                                                     value={ad.zip}
                                                     required={addressRequired}
                                                     aria-required={addressRequired ? 'true' : undefined}
                                                     aria-invalid={zipError ? 'true' : undefined}
                                                     aria-describedby={zipError ? getFieldErrorId(zipError.key) : undefined}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, zip: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className={`w-full bg-surface border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 transition-shadow ${zipError ? 'border-error focus-visible:outline-error' : 'border-control-border focus-visible:outline-focus-ring'}`}
                                                 />
                                                 {zipError && <p id={getFieldErrorId(zipError.key)} className="mt-1 text-xs font-medium text-error-text">{zipError.message}</p>}
                                             </div>
                                             <div className="col-span-5">
                                                 <label htmlFor={getInputId(addressFieldKey(ad.id, 'city'))} className="block text-xs font-bold text-muted mb-1">Stadt{addressRequired && requiredMark}</label>
                                                 <input
                                                     id={getInputId(addressFieldKey(ad.id, 'city'))}
                                                     value={ad.city}
                                                     required={addressRequired}
                                                     aria-required={addressRequired ? 'true' : undefined}
                                                     aria-invalid={cityError ? 'true' : undefined}
                                                     aria-describedby={cityError ? getFieldErrorId(cityError.key) : undefined}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, city: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className={`w-full bg-surface border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 transition-shadow ${cityError ? 'border-error focus-visible:outline-error' : 'border-control-border focus-visible:outline-focus-ring'}`}
                                                 />
                                                 {cityError && <p id={getFieldErrorId(cityError.key)} className="mt-1 text-xs font-medium text-error-text">{cityError.message}</p>}
                                             </div>
                                             <div className="col-span-4">
                                                 <label htmlFor={getInputId(addressFieldKey(ad.id, 'country'))} className="block text-xs font-bold text-muted mb-1">Land{addressRequired && requiredMark}</label>
                                                 <input
                                                     id={getInputId(addressFieldKey(ad.id, 'country'))}
                                                     value={ad.country}
                                                     required={addressRequired}
                                                     aria-required={addressRequired ? 'true' : undefined}
                                                     aria-invalid={countryError ? 'true' : undefined}
                                                     aria-describedby={countryError ? getFieldErrorId(countryError.key) : undefined}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, country: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className={`w-full bg-surface border rounded-xl p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 transition-shadow ${countryError ? 'border-error focus-visible:outline-error' : 'border-control-border focus-visible:outline-focus-ring'}`}
                                                 />
                                                 {countryError && <p id={getFieldErrorId(countryError.key)} className="mt-1 text-xs font-medium text-error-text">{countryError.message}</p>}
                                             </div>
                                         </div>

                                         <div className="flex justify-end">
                                             <button
                                                 onClick={() => {
                                                     const next = (draft.addresses ?? []).filter((a) => a.id !== ad.id);
                                                     setDraft({ ...draft, addresses: next });
                                                 }}
                                                 className="px-3 py-1.5 rounded-lg border border-error text-error-text hover:bg-error-bg text-xs font-bold flex items-center gap-1.5 transition-colors"
                                             >
                                                 <Trash2 size={14} />
                                                 Entfernen
                                             </button>
                                         </div>
                                      </div>
                                      );
                                  })}
                              </section>
                          </div>

                          <div className="p-6 border-t border-border bg-surface-muted rounded-b-2xl">
                              {firstEditorError && (
                                  <p id={saveErrorId} className="mb-3 text-right text-xs font-medium text-error-text">
                                      {firstEditorError.message}
                                  </p>
                              )}
                              <div className="flex justify-end gap-3">
                              <button
                                  onClick={closeEditor}
                                  className="px-4 py-2 bg-surface border border-control-border text-black rounded-full text-xs font-bold hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                              >
                                  Abbrechen
                              </button>
                              <button
                                  onClick={() => void saveDraft()}
                                  aria-describedby={firstEditorError ? saveErrorId : undefined}
                                  className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-dark-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
                              >
                                  Speichern
                              </button>
                              </div>
                          </div>
                      </div>
                  </div>
              ) : (
                  <>
             {selectedClientId ? (
                 <DetailView />
             ) : (
             <>
             <div className="flex items-center justify-between mb-8">
                 <h1 className="text-3xl font-black text-foreground">Kunden</h1>
                 <div className="flex gap-3">
                    <div className="relative">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" size={18} />
                        <input
                            type="text"
                            aria-label="Kunden durchsuchen"
                            placeholder="Suchen..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-12 pr-6 py-3 bg-surface-muted border-none rounded-full text-sm font-bold w-64 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow"
                        />
                   </div>

                   <div className="bg-surface-muted p-1 rounded-full flex items-center">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${viewMode === 'grid' ? 'bg-white shadow text-black' : 'text-muted hover:text-foreground'}`}
                            title="Rasteransicht"
                        >
                            <LayoutGrid size={18} />
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${viewMode === 'list' ? 'bg-white shadow text-black' : 'text-muted hover:text-foreground'}`}
                            title="Listenansicht"
                        >
                            <List size={18} />
                        </button>
                   </div>

                   <button
                     onClick={() => openEditor()}
                     aria-label="Neuer Kunde"
                     className="w-12 h-12 bg-black text-white rounded-full flex items-center justify-center motion-safe:transition-transform motion-safe:active:scale-95 motion-reduce:transition-none shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
                   >
                     <Plus size={24} />
                   </button>
                </div>
             </div>

             {viewMode === 'grid' ? (
                 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 overflow-y-auto pb-4">
                     {isLoadingClients ? (
                       <SkeletonLoader variant="card" count={6} />
                     ) : isClientsError ? (
                       <div className="col-span-full">
                         <ErrorState
                           title="Kunden konnten nicht geladen werden"
                           description="Die Kundenliste ist nicht abrufbar. Es werden bewusst keine Ersatzdaten angezeigt."
                           onRetry={() => void refetchClients()}
                         />
                       </div>
                     ) : filteredClients.length === 0 ? (
                       <EmptyState
                         className="col-span-full"
                         title={searchTerm.trim() ? 'Kein Kunde passt zu dieser Suche' : 'Noch keine Kunden angelegt'}
                         description={
                           searchTerm.trim()
                             ? `Die Suche "${searchTerm.trim()}" schließt alle ${visibleClients.length} vorhandenen Kunden aus.`
                             : 'Kunden sind die Empfänger deiner Rechnungen und Angebote. Lege den ersten Kunden über das + oben rechts an, um Dokumente zu erstellen.'
                         }
                         action={
                           searchTerm.trim() ? (
                             <Button variant="secondary" size="sm" onClick={() => setSearchTerm('')}>
                               Suche zurücksetzen
                             </Button>
                           ) : undefined
                         }
                       />
                     ) : filteredClients.map((client) => (
                         <button
                            key={client.id}
                            type="button"
                            onClick={() => setSelectedClientId(client.id)}
                            className="group border border-border text-left bg-surface-muted rounded-xl p-6 hover:border-foreground cursor-pointer relative overflow-hidden min-h-[220px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                         >
                             <div className="flex justify-between items-start mb-8">
                                 <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-xl font-bold shadow-sm">
                                     {client.company.substring(0,2).toUpperCase()}
                                 </div>
                                 <div className="w-8 h-8 rounded-full border border-control-border flex items-center justify-center group-hover:bg-black group-hover:text-white transition-colors">
                                     <ArrowRight size={14} className="-rotate-45" />
                                 </div>
                             </div>

                             <div>
                                 <h3 className="text-xl font-bold mb-1 leading-tight line-clamp-1">{client.company}</h3>
                                 <p className="text-sm font-medium text-black/60 mb-6">{client.contactPerson || EMPTY_VALUE}</p>

                                 <div className="flex gap-2">
                                     <span className="px-3 py-1 bg-white/50 rounded-full text-xs font-bold tabular-nums">
                                         {countLabel(client.projects.length, 'Projekt', 'Projekte')}
                                     </span>
                                     <span className={`px-3 py-1 rounded-full text-xs font-bold border ${client.status === 'active' ? 'bg-success-bg text-success-text border-success-text' : 'bg-surface text-muted border-border'}`}>
                                         {client.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                                     </span>
                                 </div>
                             </div>
                         </button>
                     ))}
                 </div>
             ) : (
                 <div className="flex-1 overflow-y-auto pb-4 space-y-2">
                     <div className="grid grid-cols-12 gap-4 px-4 py-2 text-xs font-bold text-muted uppercase tracking-wider sticky top-0 bg-white z-10">
                        <div className="col-span-4">Firma / Kontakt</div>
                        <div className="col-span-3">Kontaktinfo</div>
                        <div className="col-span-2">Status</div>
                        <div className="col-span-2">Projekte</div>
                        <div className="col-span-1"></div>
                     </div>

                     {isLoadingClients ? (
                       <SkeletonLoader variant="list" count={5} />
                     ) : isClientsError ? (
                       <ErrorState
                         title="Kunden konnten nicht geladen werden"
                         description="Die Kundenliste ist nicht abrufbar. Es werden bewusst keine Ersatzdaten angezeigt."
                         onRetry={() => void refetchClients()}
                       />
                     ) : filteredClients.length === 0 ? (
                       <EmptyState
                         title={searchTerm.trim() ? 'Kein Kunde passt zu dieser Suche' : 'Noch keine Kunden angelegt'}
                         description={
                           searchTerm.trim()
                             ? `Die Suche "${searchTerm.trim()}" schließt alle ${visibleClients.length} vorhandenen Kunden aus.`
                             : 'Kunden sind die Empfänger deiner Rechnungen und Angebote. Lege den ersten Kunden über das + oben rechts an, um Dokumente zu erstellen.'
                         }
                         action={
                           searchTerm.trim() ? (
                             <Button variant="secondary" size="sm" onClick={() => setSearchTerm('')}>
                               Suche zurücksetzen
                             </Button>
                           ) : undefined
                         }
                       />
                     ) : filteredClients.map((client) => (
                         <button
                            key={client.id}
                            type="button"
                            onClick={() => setSelectedClientId(client.id)}
                            className="group w-full text-left bg-surface-muted rounded-2xl p-4 border border-border hover:border-control-border hover:bg-surface transition-colors grid grid-cols-12 gap-4 items-center cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                         >
                            <div className="col-span-4 flex items-center gap-4">
                                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-sm font-bold shadow-sm text-black shrink-0">
                                     {client.company.substring(0,2).toUpperCase()}
                                 </div>
                                 <div className="min-w-0">
                                     <h3 className="font-bold text-sm text-foreground truncate">{client.company}</h3>
                                     <p className="text-xs text-muted truncate">{client.contactPerson || EMPTY_VALUE}</p>
                                 </div>
                            </div>
                            <div className="col-span-3 space-y-1">
                                <div className="flex items-center gap-2 text-xs text-muted truncate">
                                    <Mail size={12} className="shrink-0"/>
                                    <span className="truncate">{client.email || EMPTY_VALUE}</span>
                                </div>
                                 <div className="flex items-center gap-2 text-xs text-muted truncate">
                                    <Phone size={12} className="shrink-0"/>
                                    <span className="truncate">{client.phone || EMPTY_VALUE}</span>
                                </div>
                            </div>
                            <div className="col-span-2">
                                <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${client.status === 'active' ? 'bg-success-bg text-success-text border-success-text' : 'bg-surface text-muted border-border'}`}>
                                    {client.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                                </span>
                            </div>
                            <div className="col-span-2">
                                <span className="text-xs font-medium bg-white px-2 py-1 rounded-sm border border-border tabular-nums">
                                    {countLabel(client.projects.length, 'Projekt', 'Projekte')}
                                </span>
                            </div>
                            <div className="col-span-1 flex justify-end opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 motion-safe:transition-opacity motion-reduce:transition-none">
                                <ArrowRight size={16} className="text-muted" />
                            </div>
                         </button>
                     ))}
                 </div>
              )}
             </>
             )}
                  </>
              )}
        </div>
    );
};
