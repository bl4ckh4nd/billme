

import React, { useState } from 'react';
import {
    Search, Plus, MapPin, Phone, Mail,
    Trash2, Edit3, LayoutGrid, List, Check, ArrowUpRight, X
} from 'lucide-react';
import {
  Avatar, Badge, Button, Card, CardHeader, EMPTY_VALUE, EmptyState, ErrorState, IconButton, Input, ListRow, Metric, Modal, PageHeader,
  SegmentedControl, Select, Sparkline, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, ValidationSummary,
  useActionFeedback,
} from '@billme/ui';
import type { Client, ClientAddress, ClientEmail } from '@billme/desktop-core/types';
import { useClientsQuery, useDeleteClientMutation, useUpsertClientMutation } from '../hooks/useClients';
import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { useCreateIntent } from '../hooks/useCreateIntent';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useCreateDocumentFromClientMutation } from '../hooks/useDocuments';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useUiStore } from '../ui-store';
import { v4 as uuidv4 } from 'uuid';
import { SkeletonLoader } from '../ui/components/SkeletonLoader';

type ClientEditorErrors = Record<string, string>;

const emailFieldKey = (id: string) => `email:${id}`;
const addressFieldKey = (id: string, field: 'street' | 'zip' | 'city' | 'country') => `address:${id}:${field}`;

const kpiTile = 'rounded-tile border border-border bg-surface px-4 py-3.5';

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
    const { pendingIds, leavingIds, requestDelete } = useDeferredDelete({
        scope: 'clients',
        commit: (id) => deleteClient.mutateAsync(id),
        label: (count) => count === 1 ? 'Kunde gelöscht' : `${count} Kunden gelöscht`,
    });
    const navigate = useNavigate();
    const setEditingInvoice = useUiStore((s) => s.setEditingInvoice);
    const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [draft, setDraft] = useState<Client | null>(null);
    const [editorErrors, setEditorErrors] = useState<ClientEditorErrors>({});
    const editorId = React.useId();
    const locationSearch = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;

    const getInputId = (field: string) => `${editorId}-${field.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
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

    const visibleClients = clients.filter((client) => !pendingIds.has(client.id) || leavingIds.has(client.id));
    // Linked from the command palette (?create=client).
    useCreateIntent('/clients', ['client'] as const, () => openEditor());
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

    const openBalanceByClient = new Map<string, number>();
    for (const inv of invoices) {
        if (!inv.clientId || !['open', 'overdue'].includes(inv.status)) continue;
        openBalanceByClient.set(inv.clientId, (openBalanceByClient.get(inv.clientId) ?? 0) + inv.amount);
    }

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

        // Paid revenue per month over the last year, oldest first, for the trend beside the total.
        const now = new Date();
        const paidTrend = Array.from({ length: 12 }, (_, index) => {
            const month = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
            return clientInvoices
                .filter((inv) => inv.status === 'paid')
                .filter((inv) => {
                    const d = new Date(inv.date);
                    return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth();
                })
                .reduce((sum, inv) => sum + inv.amount, 0);
        });

        // Sort invoices by date desc
        const sortedInvoices = [...clientInvoices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return (
            <>
                <PageHeader
                    className="mb-0"
                    title={selectedClient.company}
                    description={[selectedClient.contactPerson, selectedClient.customerNumber].filter(Boolean).join(' · ') || undefined}
                    back={{ label: 'Zurück zur Kundenübersicht', onClick: () => setSelectedClientId(null) }}
                    actions={
                        <>
                            <IconButton aria-label="Kunde bearbeiten" onClick={() => openEditor(selectedClient)}>
                                <Edit3 size={16} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                                aria-label="Kunde löschen"
                                onClick={() => {
                                    requestDelete([selectedClient.id]);
                                    setSelectedClientId(null);
                                }}
                            >
                                <Trash2 size={16} aria-hidden="true" />
                            </IconButton>
                            <Button
                                variant="secondary"
                                onClick={async () => {
                                    const res = await createFromClient.mutateAsync({ kind: 'offer', clientId: selectedClient.id });
                                    setEditingInvoice(res, 'offer', 'create');
                                    navigate({ to: '/documents/edit' });
                                }}
                            >
                                <Plus size={16} aria-hidden="true" /> Neues Angebot
                            </Button>
                            <Button
                                onClick={async () => {
                                    const res = await createFromClient.mutateAsync({ kind: 'invoice', clientId: selectedClient.id });
                                    setEditingInvoice(res, 'invoice', 'create');
                                    navigate({ to: '/documents/edit' });
                                }}
                            >
                                <Plus size={16} aria-hidden="true" /> Neue Rechnung
                            </Button>
                        </>
                    }
                />

                {/* The question this screen answers is "was schuldet dieser
                    Kunde mir": the outstanding balance leads the row. */}
                {isInvoicesError ? (
                    <ErrorState
                        title="Rechnungsdaten konnten nicht geladen werden"
                        description="Umsatz und offene Forderungen sind ohne die Rechnungen nicht berechenbar, deshalb werden hier keine Zahlen angezeigt."
                        onRetry={() => void refetchInvoices()}
                    />
                ) : (
                    <section aria-label="Kennzahlen" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className={kpiTile}>
                            <Metric
                                marker="tick"
                                tone={isLoadingInvoices ? 'neutral' : openCount > 0 ? 'error' : 'success'}
                                label="Offene Forderungen"
                                value={formatCurrency(outstandingAmount)}
                                hint={isLoadingInvoices ? 'Rechnungen werden geladen …' : openCount > 0 ? `${openCount} offen` : 'Alles bezahlt'}
                            />
                        </div>
                        <div className={kpiTile}>
                            <Metric
                                marker="tick"
                                label="Gesamtumsatz"
                                value={formatCurrency(totalRevenue)}
                                sparkline={paidTrend.some((value) => value > 0)
                                    ? <Sparkline values={paidTrend} aria-label="Bezahlter Umsatz der letzten 12 Monate" />
                                    : undefined}
                                hint={countLabel(paidCount, 'bezahlte Rechnung', 'bezahlte Rechnungen')}
                            />
                        </div>
                        <div className={kpiTile}>
                            <Metric
                                marker="tick"
                                label="Aktive Projekte"
                                value={selectedClient.projects.filter((p) => p.status === 'active').length}
                                hint={`Insgesamt ${countLabel(selectedClient.projects.length, 'Projekt', 'Projekte')}`}
                            />
                        </div>
                        <div className={kpiTile}>
                            <Metric
                                marker="tick"
                                label="Letzte Aktivität"
                                value={selectedClient.activities[0]
                                    ? new Date(selectedClient.activities[0].date).toLocaleDateString('de-DE')
                                    : EMPTY_VALUE}
                                hint={<span className="block truncate">{selectedClient.activities[0]?.content ?? 'Keine Aktivitäten'}</span>}
                            />
                        </div>
                    </section>
                )}

                <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-3">
                    <section aria-labelledby="client-invoices-heading" className="lg:col-span-2">
                        <Card padding="none" className="overflow-hidden">
                            <CardHeader className="border-b border-border px-3.5 py-3" title={<span id="client-invoices-heading">Rechnungsverlauf</span>} />
                            {isInvoicesError ? (
                                <div className="p-3.5">
                                    <ErrorState
                                        title="Rechnungsverlauf konnte nicht geladen werden"
                                        description="Die Rechnungen dieses Kunden sind nicht abrufbar."
                                        onRetry={() => void refetchInvoices()}
                                    />
                                </div>
                            ) : isLoadingInvoices ? (
                                <div className="p-3.5">
                                    <SkeletonLoader variant="list" count={3} />
                                </div>
                            ) : sortedInvoices.length > 0 ? (
                                <Table aria-label="Rechnungsverlauf" bare>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Nummer</TableHead>
                                            <TableHead>Datum</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead numeric>Betrag</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {sortedInvoices.map((inv) => (
                                            <TableRow
                                                key={inv.id}
                                                interactive
                                                aria-label={`${inv.number} öffnen`}
                                                onClick={() => navigate({ to: '/documents', search: { kind: 'invoice', id: inv.id } })}
                                            >
                                                <TableCell className="font-medium">{inv.number}</TableCell>
                                                <TableCell muted className="tabular-nums">{new Date(inv.date).toLocaleDateString('de-DE')}</TableCell>
                                                <TableCell><Badge status={inv.status} /></TableCell>
                                                <TableCell numeric className="font-medium">{formatCurrency(inv.amount)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            ) : (
                                <EmptyState
                                    title="Noch keine Rechnungen für diesen Kunden"
                                    description='Sobald du eine Rechnung mit diesem Kunden erstellst, erscheint sie hier mit Status und Betrag. Starte sie über "Neue Rechnung" oben rechts.'
                                />
                            )}
                        </Card>
                    </section>

                    <div className="flex flex-col gap-3">
                        <section aria-labelledby="client-contact-heading">
                            <Card padding="none">
                                <CardHeader className="border-b border-border px-3.5 py-3" title={<span id="client-contact-heading">Kontakt</span>} />
                                <div className="flex flex-col gap-3 p-3.5">
                                    <dl className="space-y-2 text-control">
                                        <div className="flex items-center gap-2 text-foreground">
                                            <dt><Mail size={14} className="text-muted" aria-label="E-Mail" /></dt>
                                            <dd className="min-w-0 truncate">{billingEmail?.email || selectedClient.email || EMPTY_VALUE}</dd>
                                        </div>
                                        <div className="flex items-center gap-2 text-foreground">
                                            <dt><Phone size={14} className="text-muted" aria-label="Telefon" /></dt>
                                            <dd className="tabular-nums">{selectedClient.phone || EMPTY_VALUE}</dd>
                                        </div>
                                        <div className="flex items-center gap-2 text-foreground">
                                            <dt><MapPin size={14} className="text-muted" aria-label="Adresse" /></dt>
                                            <dd className="min-w-0">{(billingAddress ? `${billingAddress.street}, ${billingAddress.zip} ${billingAddress.city}` : selectedClient.address) || EMPTY_VALUE}</dd>
                                        </div>
                                    </dl>
                                    {selectedClient.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5">
                                            {selectedClient.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}
                                        </div>
                                    )}
                                </div>
                            </Card>
                        </section>

                        <section aria-labelledby="client-addresses-heading">
                            <Card padding="none">
                                <CardHeader className="border-b border-border px-3.5 py-3" title={<span id="client-addresses-heading">Adressen & E-Mails</span>} />
                                <div className="p-3.5">
                                    <dl className="space-y-3 text-control">
                                        <div>
                                            <dt className="text-caption text-muted">Rechnungsadresse</dt>
                                            <dd className="mt-0.5 text-foreground">{addressLines[0] || EMPTY_VALUE}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-caption text-muted">Lieferadresse</dt>
                                            <dd className="mt-0.5 text-foreground">{addressLines[1] || EMPTY_VALUE}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-caption text-muted">E-Mail (Rechnung)</dt>
                                            <dd className="mt-0.5 text-foreground">{emailLines[0] || EMPTY_VALUE}</dd>
                                        </div>
                                    </dl>
                                    <p className="mt-3 border-t border-border pt-3 text-caption text-muted tabular-nums">
                                        {countLabel(addressCount, 'Adresse', 'Adressen')} · {countLabel(emailCount, 'E-Mail', 'E-Mails')} · Pflege über „Kunde bearbeiten“
                                    </p>
                                </div>
                            </Card>
                        </section>

                        <section aria-labelledby="client-projects-heading">
                            <Card padding="none">
                                <CardHeader className="border-b border-border px-3.5 py-3" title={<span id="client-projects-heading">Projekte</span>} />
                                {selectedClient.projects.length > 0 ? (
                                    <ul className="px-3.5">
                                        {selectedClient.projects.map((p) => (
                                            <li key={p.id} className="border-b border-dashed border-border last:border-b-0">
                                                <ListRow
                                                    title={p.name}
                                                    subtitle={<span className="tabular-nums">Budget {formatCurrency(p.budget)}</span>}
                                                    value={<Badge tone={p.status === 'active' ? 'success' : 'neutral'}>{p.status === 'active' ? 'Aktiv' : 'Inaktiv'}</Badge>}
                                                    onClick={() => navigate({ to: `/projects/${p.id}` })}
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <EmptyState
                                        title="Noch keine Projekte"
                                        description="Projekte bündeln die Dokumente dieses Kunden."
                                        action={
                                            <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/projects' })}>
                                                Zu den Projekten
                                            </Button>
                                        }
                                    />
                                )}
                            </Card>
                        </section>

                        <section aria-labelledby="client-notes-heading">
                            <Card padding="none">
                                <CardHeader className="border-b border-border px-3.5 py-3" title={<span id="client-notes-heading">Notizen</span>} />
                                <p className={`whitespace-pre-line p-3.5 text-control ${selectedClient.notes ? 'text-foreground' : 'text-muted'}`}>
                                    {selectedClient.notes || 'Keine Notizen hinterlegt.'}
                                </p>
                            </Card>
                        </section>
                    </div>
                </div>
            </>
        );
    };

    const renderEditor = (draft: Client) => (
        <Modal open onClose={closeEditor} titleId={`${editorId}-title`} dismissOnBackdrop={false} className="max-w-4xl">
            <div className="flex items-start gap-3 px-4.5 pb-2.5 pt-4">
                <h2 id={`${editorId}-title`} className="min-w-0 flex-1 text-title text-foreground">
                    {clients.some((c) => c.id === draft.id) ? 'Kunde bearbeiten' : 'Neuer Kunde'}
                </h2>
                <IconButton size="sm" aria-label="Kundeneditor schließen" onClick={closeEditor}>
                    <X size={16} aria-hidden="true" />
                </IconButton>
            </div>
            <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-4.5 pb-4 pt-1">
            <ValidationSummary
                errors={editorValidationIssues}
                onJump={focusEditorField}
            />
            {firstEditorError && (
                <p id={saveErrorId} className="sr-only">
                    {firstEditorError.message}
                </p>
            )}

            <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
                <div className="flex flex-col gap-3">
                    <Card padding="none">
                        <CardHeader className="border-b border-border px-3.5 py-3" title="Stammdaten" />
                        <div className="grid grid-cols-2 gap-3 p-3.5">
                            <Input
                                id="clientsview-kundennummer"
                                label="Kundennummer"
                                value={draft.customerNumber ?? ''}
                                onChange={(e) => setDraft({ ...draft, customerNumber: e.target.value })}
                                placeholder="Automatisch bei leerem Feld"
                                className="font-mono"
                                fullWidth
                            />
                            <div className="col-span-2">
                                <Input
                                    id={getInputId('company')}
                                    label="Firma"
                                    value={draft.company}
                                    onChange={(e) => setDraft({ ...draft, company: e.target.value })}
                                    required
                                    error={editorErrors.company}
                                    fullWidth
                                />
                            </div>
                            <Input
                                id={getInputId('contactPerson')}
                                label="Ansprechpartner"
                                value={draft.contactPerson}
                                onChange={(e) => setDraft({ ...draft, contactPerson: e.target.value })}
                                fullWidth
                            />
                            <Input
                                id="clientsview-telefon"
                                label="Telefon"
                                value={draft.phone}
                                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                                fullWidth
                            />
                            <Select
                                id="clientsview-status"
                                label="Status"
                                value={draft.status}
                                onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
                                fullWidth
                            >
                                <option value="active">Aktiv</option>
                                <option value="inactive">Inaktiv</option>
                            </Select>
                            <Input
                                id="clientsview-tags-komma"
                                label="Tags (Komma)"
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
                                fullWidth
                            />
                            <div className="col-span-2">
                                <Textarea
                                    id="clientsview-notizen"
                                    label="Notizen"
                                    value={draft.notes ?? ''}
                                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                                    rows={3}
                                    fullWidth
                                />
                            </div>
                        </div>
                    </Card>

                    <Card padding="none">
                        <CardHeader
                            className="border-b border-border px-3.5 py-3"
                            title="Steuerprofil"
                            subtitle="Wird beim Erstellen einer Rechnung als Vorschlag übernommen. Die Rechnung speichert danach ihren eigenen Snapshot."
                        />
                        <div className="grid grid-cols-3 gap-3 p-3.5">
                            <Select
                                id="clientsview-kundentyp"
                                label="Kundentyp"
                                value={draft.taxProfile?.type ?? 'business'}
                                onChange={(event) => setDraft({ ...draft, taxProfile: { ...draft.taxProfile, type: event.target.value as 'business' | 'consumer' } })}
                                fullWidth
                            >
                                <option value="business">Unternehmen</option>
                                <option value="consumer">Privatkunde</option>
                            </Select>
                            <Input
                                id="clientsview-land-iso"
                                label="Land (ISO)"
                                value={draft.taxProfile?.countryCode ?? ''}
                                onChange={(event) => setDraft({ ...draft, taxProfile: { ...draft.taxProfile, type: draft.taxProfile?.type ?? 'business', countryCode: event.target.value.toUpperCase() } })}
                                placeholder="DE"
                                maxLength={2}
                                className="uppercase"
                                fullWidth
                            />
                            <Input
                                id="clientsview-ust-idnr"
                                label="USt-IdNr."
                                value={draft.taxProfile?.vatId ?? ''}
                                onChange={(event) => setDraft({ ...draft, taxProfile: { ...draft.taxProfile, type: draft.taxProfile?.type ?? 'business', vatId: event.target.value.toUpperCase(), vatIdValidation: undefined, vatIdValidationAt: undefined } })}
                                placeholder="DE123456789"
                                className="font-mono"
                                hint={draft.taxProfile?.vatIdValidation ? `Status: ${draft.taxProfile.vatIdValidation}` : undefined}
                                fullWidth
                            />
                        </div>
                    </Card>
                </div>

                <div className="flex flex-col gap-3">
                    <Card padding="none">
                        <CardHeader
                            className="px-3.5 py-3"
                            title="E-Mails"
                            subtitle="Kategorie = Zweck. Standard = wird automatisch vorausgewählt."
                            actions={
                                <Button
                                    variant="secondary"
                                    size="sm"
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
                                >
                                    + E-Mail
                                </Button>
                            }
                        />

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
                                <div key={em.id} className="flex flex-col gap-3 border-t border-border p-3.5">
                                    <div className="grid grid-cols-2 gap-3">
                                        <Input
                                            label="Bezeichnung"
                                            value={em.label}
                                            onChange={(e) => {
                                                const next = [...(draft.emails ?? [])];
                                                next[idx] = { ...em, label: e.target.value };
                                                setDraft({ ...draft, emails: next });
                                            }}
                                            fullWidth
                                        />
                                        <Select
                                            label="Kategorie"
                                            value={em.kind}
                                            onChange={(e) => {
                                                const next = [...(draft.emails ?? [])];
                                                next[idx] = { ...em, kind: e.target.value as any };
                                                setDraft({ ...draft, emails: next });
                                            }}
                                            fullWidth
                                        >
                                            <option value="general">{emailKindLabel.general}</option>
                                            <option value="billing">{emailKindLabel.billing}</option>
                                            <option value="shipping">{emailKindLabel.shipping}</option>
                                            <option value="other">{emailKindLabel.other}</option>
                                        </Select>
                                        <div className="col-span-2">
                                            <Input
                                                id={getInputId(field)}
                                                label="E-Mail-Adresse"
                                                value={em.email}
                                                required={isRequiredEmail}
                                                error={errorMessage}
                                                onChange={(e) => {
                                                    const next = [...(draft.emails ?? [])];
                                                    next[idx] = { ...em, email: e.target.value };
                                                    setDraft({ ...draft, emails: next });
                                                }}
                                                fullWidth
                                            />
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-eyebrow uppercase text-muted">Standard</span>
                                            <Button
                                                size="sm"
                                                variant={em.isDefaultBilling ? 'dark' : 'secondary'}
                                                aria-pressed={Boolean(em.isDefaultBilling)}
                                                onClick={() => {
                                                    const next = setOnlyOneFlag((draft.emails ?? []) as any, em.id, 'isDefaultBilling') as ClientEmail[];
                                                    setDraft({ ...draft, emails: next });
                                                }}
                                            >
                                                {em.isDefaultBilling && <Check size={14} aria-hidden="true" />}
                                                Rechnung
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant={em.isDefaultGeneral ? 'dark' : 'secondary'}
                                                aria-pressed={Boolean(em.isDefaultGeneral)}
                                                onClick={() => {
                                                    const next = setOnlyOneFlag((draft.emails ?? []) as any, em.id, 'isDefaultGeneral') as ClientEmail[];
                                                    setDraft({ ...draft, emails: next });
                                                }}
                                            >
                                                {em.isDefaultGeneral && <Check size={14} aria-hidden="true" />}
                                                Allgemein
                                            </Button>
                                        </div>
                                        <Button
                                            size="sm"
                                            variant="danger"
                                            onClick={() => {
                                                const next = (draft.emails ?? []).filter((e) => e.id !== em.id);
                                                setDraft({ ...draft, emails: next });
                                            }}
                                        >
                                            <Trash2 size={14} aria-hidden="true" />
                                            Entfernen
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </Card>

                    <Card padding="none">
                        <CardHeader
                            className="px-3.5 py-3"
                            title="Adressen"
                            subtitle="Kategorie = Zweck. Standard = wird automatisch übernommen."
                            actions={
                                <Button
                                    variant="secondary"
                                    size="sm"
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
                                >
                                    + Adresse
                                </Button>
                            }
                        />

                        {(draft.addresses ?? []).map((ad, idx) => {
                            const addressRequired = Boolean(ad.isDefaultBilling);
                            const fieldError = (field: 'street' | 'zip' | 'city' | 'country') => {
                                const key = addressFieldKey(ad.id, field);
                                if (editorErrors[key]) return editorErrors[key];
                                if (idx === 0 && field === 'street' && editorErrors.addresses) return editorErrors.addresses;
                                return undefined;
                            };
                            const updateAddress = (patch: Partial<ClientAddress>) => {
                                const next = [...(draft.addresses ?? [])];
                                next[idx] = { ...ad, ...patch };
                                setDraft({ ...draft, addresses: next });
                            };
                            return (
                                <div key={ad.id} className="flex flex-col gap-3 border-t border-border p-3.5">
                                    <div className="grid grid-cols-12 gap-3">
                                        <div className="col-span-6">
                                            <Input
                                                label="Bezeichnung"
                                                value={ad.label}
                                                onChange={(e) => updateAddress({ label: e.target.value })}
                                                fullWidth
                                            />
                                        </div>
                                        <div className="col-span-6">
                                            <Select
                                                label="Kategorie"
                                                value={ad.kind}
                                                onChange={(e) => updateAddress({ kind: e.target.value as any })}
                                                fullWidth
                                            >
                                                <option value="billing">{addressKindLabel.billing}</option>
                                                <option value="shipping">{addressKindLabel.shipping}</option>
                                                <option value="other">{addressKindLabel.other}</option>
                                            </Select>
                                        </div>
                                        <div className="col-span-6">
                                            <Input
                                                id={getInputId(addressFieldKey(ad.id, 'street'))}
                                                label="Straße"
                                                value={ad.street}
                                                required={addressRequired}
                                                error={fieldError('street')}
                                                onChange={(e) => updateAddress({ street: e.target.value })}
                                                fullWidth
                                            />
                                        </div>
                                        <div className="col-span-6">
                                            <Input
                                                label="Zusatz"
                                                value={ad.line2 ?? ''}
                                                onChange={(e) => updateAddress({ line2: e.target.value })}
                                                fullWidth
                                            />
                                        </div>
                                        <div className="col-span-3">
                                            <Input
                                                id={getInputId(addressFieldKey(ad.id, 'zip'))}
                                                label="PLZ"
                                                value={ad.zip}
                                                required={addressRequired}
                                                error={fieldError('zip')}
                                                onChange={(e) => updateAddress({ zip: e.target.value })}
                                                fullWidth
                                            />
                                        </div>
                                        <div className="col-span-5">
                                            <Input
                                                id={getInputId(addressFieldKey(ad.id, 'city'))}
                                                label="Stadt"
                                                value={ad.city}
                                                required={addressRequired}
                                                error={fieldError('city')}
                                                onChange={(e) => updateAddress({ city: e.target.value })}
                                                fullWidth
                                            />
                                        </div>
                                        <div className="col-span-4">
                                            <Input
                                                id={getInputId(addressFieldKey(ad.id, 'country'))}
                                                label="Land"
                                                value={ad.country}
                                                required={addressRequired}
                                                error={fieldError('country')}
                                                onChange={(e) => updateAddress({ country: e.target.value })}
                                                fullWidth
                                            />
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Button
                                                size="sm"
                                                variant={ad.isDefaultBilling ? 'dark' : 'secondary'}
                                                aria-pressed={Boolean(ad.isDefaultBilling)}
                                                onClick={() => {
                                                    const next = setOnlyOneFlag((draft.addresses ?? []) as any, ad.id, 'isDefaultBilling') as ClientAddress[];
                                                    setDraft({ ...draft, addresses: next });
                                                }}
                                            >
                                                {ad.isDefaultBilling && <Check size={14} aria-hidden="true" />}
                                                Standard Rechnung
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant={ad.isDefaultShipping ? 'dark' : 'secondary'}
                                                aria-pressed={Boolean(ad.isDefaultShipping)}
                                                onClick={() => {
                                                    const next = setOnlyOneFlag((draft.addresses ?? []) as any, ad.id, 'isDefaultShipping') as ClientAddress[];
                                                    setDraft({ ...draft, addresses: next });
                                                }}
                                            >
                                                {ad.isDefaultShipping && <Check size={14} aria-hidden="true" />}
                                                Standard Lieferung
                                            </Button>
                                        </div>
                                        <Button
                                            size="sm"
                                            variant="danger"
                                            onClick={() => {
                                                const next = (draft.addresses ?? []).filter((a) => a.id !== ad.id);
                                                setDraft({ ...draft, addresses: next });
                                            }}
                                        >
                                            <Trash2 size={14} aria-hidden="true" />
                                            Entfernen
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </Card>
                </div>
            </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
                <Button variant="secondary" onClick={closeEditor}>
                    Abbrechen
                </Button>
                <Button onClick={() => void saveDraft()} aria-describedby={firstEditorError ? saveErrorId : undefined}>
                    Speichern
                </Button>
            </div>
        </Modal>
    );

    const emptyClients = (
        <Card padding="none">
            <EmptyState
                title={searchTerm.trim() ? 'Kein Kunde passt zu dieser Suche' : 'Noch keine Kunden angelegt'}
                description={
                    searchTerm.trim()
                        ? `Die Suche "${searchTerm.trim()}" schließt alle ${visibleClients.length} vorhandenen Kunden aus.`
                        : 'Kunden sind die Empfänger deiner Rechnungen und Angebote. Lege den ersten Kunden über „Neuer Kunde“ oben rechts an, um Dokumente zu erstellen.'
                }
                action={
                    searchTerm.trim() ? (
                        <Button variant="secondary" size="sm" onClick={() => setSearchTerm('')}>
                            Suche zurücksetzen
                        </Button>
                    ) : undefined
                }
            />
        </Card>
    );

    return (
        <div className="flex flex-col gap-3">
            {isEditorOpen && draft && renderEditor(draft)}
            {selectedClientId ? (
                <DetailView />
            ) : (
                <>
                    <PageHeader
                        className="mb-0"
                        title="Kunden"
                        description={isLoadingClients || isClientsError ? undefined : countLabel(visibleClients.length, 'Stammdatensatz', 'Stammdatensätze')}
                        actions={
                            <Button onClick={() => openEditor()}>
                                <Plus size={16} aria-hidden="true" /> Neuer Kunde
                            </Button>
                        }
                        toolbar={
                            <>
                                <div className="w-full sm:w-64">
                                    <Input
                                        type="search"
                                        aria-label="Kunden durchsuchen"
                                        placeholder="Kunden suchen"
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        prefix={<Search size={14} aria-hidden="true" />}
                                        fullWidth
                                    />
                                </div>
                                <SegmentedControl
                                    className="ml-auto"
                                    aria-label="Ansicht"
                                    value={viewMode}
                                    onChange={setViewMode}
                                    options={[
                                        { value: 'list', label: <List size={16} aria-hidden="true" />, ariaLabel: 'Listenansicht' },
                                        { value: 'grid', label: <LayoutGrid size={16} aria-hidden="true" />, ariaLabel: 'Rasteransicht' },
                                    ]}
                                />
                            </>
                        }
                    />

                    {isLoadingClients ? (
                        <SkeletonLoader variant={viewMode === 'grid' ? 'card' : 'table'} count={viewMode === 'grid' ? 6 : 5} />
                    ) : isClientsError ? (
                        <ErrorState
                            title="Kunden konnten nicht geladen werden"
                            description="Die Kundenliste ist nicht abrufbar. Es werden bewusst keine Ersatzdaten angezeigt."
                            onRetry={() => void refetchClients()}
                        />
                    ) : filteredClients.length === 0 ? emptyClients : viewMode === 'grid' ? (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {filteredClients.map((client) => (
                                <button
                                    key={client.id}
                                    data-leaving={leavingIds.has(client.id) || undefined}
                                    type="button"
                                    onClick={() => setSelectedClientId(client.id)}
                                    className="group flex flex-col rounded-card border border-border bg-surface p-3.5 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <Avatar name={client.company} size="lg" />
                                        <ArrowUpRight size={16} aria-hidden="true" className="ui-reveal text-muted" />
                                    </div>

                                    <h3 className="mt-3 text-section line-clamp-1">{client.company}</h3>
                                    <p className="text-control text-muted line-clamp-1">{client.contactPerson || EMPTY_VALUE}</p>

                                    <div className="mt-3 flex items-center gap-2">
                                        <Badge tone={client.status === 'active' ? 'success' : 'neutral'}>
                                            {client.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                                        </Badge>
                                        <span className="text-caption text-muted tabular-nums">
                                            {countLabel(client.projects.length, 'Projekt', 'Projekte')}
                                        </span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <Table aria-label="Kunden">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Ort</TableHead>
                                    <TableHead className="hidden lg:table-cell">E-Mail</TableHead>
                                    <TableHead className="hidden md:table-cell">USt-IdNr.</TableHead>
                                    <TableHead numeric>Offener Saldo</TableHead>
                                    <TableHead>Steuer</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredClients.map((client) => {
                                    const billing = defaultBillingAddress(client.addresses ?? []);
                                    const place = billing ? [billing.zip, billing.city].filter(Boolean).join(' ') : '';
                                    const country = (client.taxProfile?.countryCode || billing?.country || '').trim().toUpperCase();
                                    const openBalance = openBalanceByClient.get(client.id) ?? 0;
                                    return (
                                        <TableRow key={client.id} data-leaving={leavingIds.has(client.id) || undefined} interactive aria-label={`${client.company} öffnen`} onClick={() => setSelectedClientId(client.id)}>
                                            <TableCell>
                                                <span className="flex items-center gap-2">
                                                    <span className="truncate font-medium">{client.company}</span>
                                                    {client.status !== 'active' && <Badge tone="neutral">Inaktiv</Badge>}
                                                </span>
                                            </TableCell>
                                            <TableCell className="max-w-56 truncate">{place || client.address || EMPTY_VALUE}</TableCell>
                                            <TableCell muted className="hidden max-w-56 truncate lg:table-cell">{client.email || EMPTY_VALUE}</TableCell>
                                            <TableCell className="hidden tabular-nums md:table-cell">
                                                {client.taxProfile?.vatId || <span className="text-caption text-muted">nicht hinterlegt</span>}
                                            </TableCell>
                                            <TableCell numeric>
                                                {isLoadingInvoices || isInvoicesError
                                                    ? EMPTY_VALUE
                                                    : openBalance > 0
                                                        ? formatCurrency(openBalance)
                                                        : <span className="text-caption text-muted">ausgeglichen</span>}
                                            </TableCell>
                                            <TableCell>
                                                {country.length === 2
                                                    ? <Badge tone={country === 'DE' ? 'neutral' : 'info'}>{country === 'DE' ? 'Inland' : country}</Badge>
                                                    : EMPTY_VALUE}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    )}
                </>
            )}
        </div>
    );
};
