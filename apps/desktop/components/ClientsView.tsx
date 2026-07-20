

import React, { useState } from 'react';
import {
    Search, Plus, LayoutGrid, List, Users,
} from 'lucide-react';
import type { Client, ClientAddress, ClientEmail } from '../types';
import { useClientsQuery, useDeleteClientMutation, useUpsertClientMutation } from '../hooks/useClients';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useCreateDocumentFromClientMutation } from '../hooks/useDocuments';
import { useNavigate } from '@tanstack/react-router';
import { useUiStore } from '../state/uiStore';
import { v4 as uuidv4 } from 'uuid';
import { SkeletonLoader } from './SkeletonLoader';
import { ipc } from '../ipc/client';
import { ClientCard } from './clients/ClientCard';
import { ClientListRow } from './clients/ClientListRow';
import { ClientDetailPanel } from './clients/ClientDetailPanel';
import { ClientEditorModal } from './clients/ClientEditorModal';

export const ClientsView: React.FC = () => {
    const { data: clients = [], isLoading } = useClientsQuery();
    const { data: invoices = [] } = useInvoicesQuery();
    const createFromClient = useCreateDocumentFromClientMutation();
    const upsertClient = useUpsertClientMutation();
    const deleteClient = useDeleteClientMutation();
    const navigate = useNavigate();
    const setEditingInvoice = useUiStore((s) => s.setEditingInvoice);
    const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [draft, setDraft] = useState<Client | null>(null);
    const [editorErrors, setEditorErrors] = useState<string[]>([]);
    const [customerReservationId, setCustomerReservationId] = useState<string | null>(null);
    const locationSearch = window.location.search;

    const selectedClient = clients.find(c => c.id === selectedClientId);

    const normalizedSearch = searchTerm.trim().toLowerCase();
    const filteredClients = clients.filter((c) => {
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
        const params = new URLSearchParams(locationSearch);
        const deepLinkClientId = params.get('id');
        if (!deepLinkClientId) return;
        if (!clients.some((client) => client.id === deepLinkClientId)) return;
        setSelectedClientId(deepLinkClientId);
    }, [locationSearch, clients]);

    const openEditor = async (client?: Client) => {
        let reservedNumber = '';
        let reservationId: string | null = null;

        if (!client) {
            try {
                const reservation = await ipc.numbers.reserve({ kind: 'customer' });
                reservedNumber = reservation.number;
                reservationId = reservation.reservationId;
            } catch {
                // Non-fatal: user can still type the number manually.
            }
        }

        const base: Client =
            client ??
            ({
                id: uuidv4(),
                customerNumber: reservedNumber,
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

        setCustomerReservationId(reservationId);
        setEditorErrors([]);
        setDraft(fixed);
        setIsEditorOpen(true);
    };

    const closeEditor = () => {
        if (customerReservationId) {
            ipc.numbers.release({ reservationId: customerReservationId }).catch(() => {});
            setCustomerReservationId(null);
        }
        setIsEditorOpen(false);
        setDraft(null);
        setEditorErrors([]);
    };

    const saveDraft = async () => {
        if (!draft) return;
        const errors: string[] = [];
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        const company = draft.company.trim();
        if (!company) {
            errors.push('Firma ist erforderlich.');
        }

        const legacyEmail = (draft.email ?? '').trim();
        if (legacyEmail && !emailRegex.test(legacyEmail)) {
            errors.push('Primäre E-Mail ist ungültig.');
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
            if (email.email && !emailRegex.test(email.email)) {
                errors.push(`Ungültige E-Mail-Adresse: ${email.email}`);
            }
        }

        if (normalizedEmails.length > 0 && !normalizedEmails.some((email) => email.isDefaultBilling)) {
            errors.push('Mindestens eine E-Mail muss als Standard Rechnung markiert sein.');
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
                country: address.country.trim() || 'DE',
            }))
            .filter((address) =>
                address.street.length > 0 ||
                address.zip.length > 0 ||
                address.city.length > 0 ||
                address.label.length > 0,
            );

        const billingAddress = normalizedAddresses.find((address) => address.isDefaultBilling);
        if (normalizedAddresses.length > 0 && !billingAddress) {
            errors.push('Mindestens eine Adresse muss als Standard Rechnung markiert sein.');
        }
        if (billingAddress) {
            if (!billingAddress.street || !billingAddress.zip || !billingAddress.city || !billingAddress.country) {
                errors.push('Standard-Rechnungsadresse benötigt Straße, PLZ, Stadt und Land.');
            }
        }

        if (errors.length > 0) {
            setEditorErrors(errors);
            return;
        }
        setEditorErrors([]);

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
            setCustomerReservationId(null);
            setSelectedClientId(saved.id);
            closeEditor();
        } catch (e) {
            alert(`Speichern fehlgeschlagen: ${String(e)}`);
        }
    };

    return (
        <div className="bg-surface rounded-2xl p-6 min-h-full border border-border flex flex-col animate-enter overflow-hidden">
            {isEditorOpen && draft ? (
                <div className="flex flex-col flex-1 min-h-0">
                    <ClientEditorModal
                        draft={draft}
                        onDraftChange={(updated) => setDraft(updated)}
                        editorErrors={editorErrors}
                        isExistingClient={clients.some((c) => c.id === draft.id)}
                        onClose={closeEditor}
                        onSave={saveDraft}
                    />
                </div>
            ) : (
                <>
                    {selectedClientId ? (
                        selectedClient ? (
                            <ClientDetailPanel
                                selectedClient={selectedClient}
                                invoices={invoices}
                                onBack={() => setSelectedClientId(null)}
                                onEdit={() => void openEditor(selectedClient)}
                                onDelete={async () => {
                                    await deleteClient.mutateAsync(selectedClient.id);
                                    setSelectedClientId(null);
                                }}
                                onCreateInvoice={async () => {
                                    const res = await createFromClient.mutateAsync({
                                        kind: 'invoice',
                                        clientId: selectedClient.id,
                                    });
                                    setEditingInvoice(res, 'invoice', 'create');
                                    navigate({ to: '/documents/edit' });
                                }}
                                onCreateOffer={async () => {
                                    const res = await createFromClient.mutateAsync({
                                        kind: 'offer',
                                        clientId: selectedClient.id,
                                    });
                                    setEditingInvoice(res, 'offer', 'create');
                                    navigate({ to: '/documents/edit' });
                                }}
                            />
                        ) : null
                    ) : (
                        <>
                            <div className="flex items-center justify-between mb-8">
                                <h1 className="text-3xl font-black text-foreground">Kunden</h1>
                                <div className="flex gap-3">
                                    <div className="relative">
                                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" size={18} />
                                        <input
                                            type="text"
                                            placeholder="Suchen..."
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                            className="pl-12 pr-6 py-3 bg-surface-muted border-none rounded-full text-sm font-bold outline-none w-64 focus:ring-2 focus:ring-accent transition-shadow"
                                        />
                                    </div>

                                    <div className="bg-canvas p-1 rounded-full flex items-center">
                                        <button
                                            onClick={() => setViewMode('grid')}
                                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out duration-150 ${viewMode === 'grid' ? 'bg-surface shadow text-foreground' : 'text-muted hover:text-foreground'}`}
                                            title="Rasteransicht"
                                        >
                                            <LayoutGrid size={18} />
                                        </button>
                                        <button
                                            onClick={() => setViewMode('list')}
                                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out duration-150 ${viewMode === 'list' ? 'bg-surface shadow text-foreground' : 'text-muted hover:text-foreground'}`}
                                            title="Listenansicht"
                                        >
                                            <List size={18} />
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => void openEditor()}
                                        className="w-12 h-12 bg-black text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-lg"
                                    >
                                        <Plus size={24} />
                                    </button>
                                </div>
                            </div>

                            {viewMode === 'grid' ? (
                                <>
                                    {!isLoading && clients.length === 0 && (
                                        <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
                                            <Users size={48} className="text-muted mb-4 opacity-40" />
                                            <h3 className="text-xl font-bold text-foreground mb-2">Noch keine Kunden</h3>
                                            <p className="text-muted text-sm mb-6">Fügen Sie Ihren ersten Kunden hinzu, um loszulegen.</p>
                                            <button
                                                onClick={() => void openEditor()}
                                                className="flex items-center gap-2 px-5 py-2.5 bg-accent text-accent-foreground rounded-xl font-bold text-sm hover:bg-accent-hover transition-colors ease-out duration-150"
                                            >
                                                <Plus size={16} /> Ersten Kunden anlegen
                                            </button>
                                        </div>
                                    )}
                                    {!isLoading && clients.length > 0 && filteredClients.length === 0 && (
                                        <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
                                            <Search size={48} className="text-muted mb-4 opacity-40" />
                                            <h3 className="text-xl font-bold text-foreground mb-2">Keine Treffer</h3>
                                            <p className="text-muted text-sm mb-4">Keine Kunden für „{searchTerm}" gefunden.</p>
                                            <button
                                                onClick={() => setSearchTerm('')}
                                                className="text-sm font-bold text-muted underline hover:text-foreground transition-colors ease-out duration-150"
                                            >
                                                Suche zurücksetzen
                                            </button>
                                        </div>
                                    )}
                                    {(isLoading || filteredClients.length > 0) && (
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 overflow-y-auto pb-4">
                                            {isLoading ? (
                                                <SkeletonLoader variant="card" count={6} />
                                            ) : filteredClients.map((client, idx) => (
                                                <ClientCard
                                                    key={client.id}
                                                    client={client}
                                                    idx={idx}
                                                    onClick={() => setSelectedClientId(client.id)}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="flex-1 overflow-y-auto pb-4 space-y-2">
                                    <div className="grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-bold text-muted uppercase tracking-wider sticky top-0 bg-surface z-10">
                                        <div className="col-span-4">Firma / Kontakt</div>
                                        <div className="col-span-3">Kontaktinfo</div>
                                        <div className="col-span-2">Status</div>
                                        <div className="col-span-2">Projekte</div>
                                        <div className="col-span-1"></div>
                                    </div>

                                    {isLoading ? (
                                        <SkeletonLoader variant="list" count={5} />
                                    ) : clients.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-24 text-center">
                                            <Users size={48} className="text-muted mb-4 opacity-40" />
                                            <h3 className="text-xl font-bold text-foreground mb-2">Noch keine Kunden</h3>
                                            <p className="text-muted text-sm mb-6">Fügen Sie Ihren ersten Kunden hinzu, um loszulegen.</p>
                                            <button
                                                onClick={() => void openEditor()}
                                                className="flex items-center gap-2 px-5 py-2.5 bg-accent text-accent-foreground rounded-xl font-bold text-sm hover:bg-accent-hover transition-colors ease-out duration-150"
                                            >
                                                <Plus size={16} /> Ersten Kunden anlegen
                                            </button>
                                        </div>
                                    ) : filteredClients.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-24 text-center">
                                            <Search size={48} className="text-muted mb-4 opacity-40" />
                                            <h3 className="text-xl font-bold text-foreground mb-2">Keine Treffer</h3>
                                            <p className="text-muted text-sm mb-4">Keine Kunden für „{searchTerm}" gefunden.</p>
                                            <button
                                                onClick={() => setSearchTerm('')}
                                                className="text-sm font-bold text-muted underline hover:text-foreground transition-colors ease-out duration-150"
                                            >
                                                Suche zurücksetzen
                                            </button>
                                        </div>
                                    ) : filteredClients.map((client, idx) => (
                                        <ClientListRow
                                            key={client.id}
                                            client={client}
                                            idx={idx}
                                            onClick={() => setSelectedClientId(client.id)}
                                        />
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
