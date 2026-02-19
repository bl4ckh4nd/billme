

import React, { useState } from 'react';
import {
    Search, Plus, MapPin, Phone, Mail, FileText,
    MoreHorizontal, Tag, Briefcase, Calendar,
    ArrowRight, ArrowLeft, Trash2, Edit3, X,
    CheckCircle, Clock, AlertCircle, LayoutGrid, List, Check
} from 'lucide-react';
import { Button } from '@billme/ui';
import type { Client, ClientAddress, ClientEmail } from '../types';
import { useClientsQuery, useDeleteClientMutation, useUpsertClientMutation } from '../hooks/useClients';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useCreateDocumentFromClientMutation } from '../hooks/useDocuments';
import { useNavigate } from '@tanstack/react-router';
import { useUiStore } from '../state/uiStore';
import { v4 as uuidv4 } from 'uuid';
import { Spinner } from './Spinner';
import { SkeletonLoader } from './SkeletonLoader';

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

        setEditorErrors([]);
        setDraft(fixed);
        setIsEditorOpen(true);
    };

    const closeEditor = () => {
        setIsEditorOpen(false);
        setDraft(null);
        setEditorErrors([]);
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
            setSelectedClientId(saved.id);
            closeEditor();
        } catch (e) {
            alert(`Speichern fehlgeschlagen: ${String(e)}`);
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

        // Calculations
        const clientInvoices = invoices.filter(inv => inv.clientId === selectedClient.id);
        const totalRevenue = clientInvoices.filter(i => i.status === 'paid').reduce((acc, curr) => acc + curr.amount, 0);
        const outstandingAmount = clientInvoices.filter(i => ['open', 'overdue'].includes(i.status)).reduce((acc, curr) => acc + curr.amount, 0);
        const paidCount = clientInvoices.filter(i => i.status === 'paid').length;
        const openCount = clientInvoices.filter(i => ['open', 'overdue'].includes(i.status)).length;
        
        // Sort invoices by date desc
        const sortedInvoices = [...clientInvoices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        return (
            <div className="h-full flex flex-col gap-6 animate-enter pb-8 overflow-y-auto">
                {/* Navigation & Header Actions */}
                 <div className="flex justify-between items-center">
                    <button onClick={() => setSelectedClientId(null)} className="flex items-center gap-2 text-gray-500 hover:text-black font-bold transition-colors">
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
                          className="px-3 py-1.5 bg-black text-white rounded-lg text-xs font-bold hover:bg-gray-800 transition-colors flex items-center gap-2"
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
                          className="px-4 py-2 bg-white border border-gray-200 text-black rounded-full text-xs font-bold hover:bg-gray-50 transition-colors flex items-center gap-2"
                        >
                            <Plus size={14} /> Neues Angebot
                        </button>
                        <button
                          onClick={() => openEditor(selectedClient)}
                          className="w-10 h-10 border border-gray-200 rounded-full flex items-center justify-center hover:bg-gray-50 transition-colors"
                        >
                            <Edit3 size={16} />
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm('Kunde wirklich löschen?')) return;
                            try {
                              await deleteClient.mutateAsync(selectedClient.id);
                              setSelectedClientId(null);
                            } catch (error) {
                              alert(`Kunde konnte nicht gelöscht werden: ${String(error)}`);
                            }
                          }}
                          className="w-10 h-10 border border-gray-200 rounded-full flex items-center justify-center hover:bg-error-bg transition-colors text-error"
                        >
                          <Trash2 size={16} />
                        </button>
                    </div>
                </div>

                {/* Top Section: Identity & KPIs */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Identity Card */}
                    <div className="bg-accent rounded-[2rem] p-6 text-black relative overflow-hidden border border-black/10 flex flex-col justify-between min-h-[240px] animate-scale-in">
                        <div>
                             <div className="flex items-center gap-4 mb-6">
                                <div className="w-16 h-16 bg-black text-white text-2xl font-bold rounded-2xl flex items-center justify-center shadow-lg">
                                     {selectedClient.company.substring(0, 2).toUpperCase()}
                                 </div>
                                 <div>
                                     <h2 className="text-2xl font-bold leading-tight">{selectedClient.company}</h2>
                                     <p className="font-medium opacity-70">{selectedClient.contactPerson}</p>
                                     {selectedClient.customerNumber && (
                                       <p className="font-mono text-xs opacity-60 mt-1">{selectedClient.customerNumber}</p>
                                     )}
                                 </div>
                             </div>
                             <div className="space-y-2">
                                 <div className="flex items-center gap-2 text-sm font-bold opacity-80">
                                     <Mail size={14} /> {billingEmail?.email || selectedClient.email}
                                 </div>
                                 <div className="flex items-center gap-2 text-sm font-bold opacity-80">
                                     <Phone size={14} /> {selectedClient.phone}
                                 </div>
                                  <div className="flex items-center gap-2 text-sm font-bold opacity-80">
                                     <MapPin size={14} /> {(billingAddress ? `${billingAddress.street}, ${billingAddress.zip} ${billingAddress.city}` : selectedClient.address)}
                                 </div>
                             </div>
                        </div>
                        <div className="mt-6 flex gap-2">
                            {selectedClient.tags.map(tag => (
                                <span key={tag} className="px-3 py-1 bg-white/40 backdrop-blur-md rounded-full text-xs font-bold">{tag}</span>
                            ))}
                        </div>
                    </div>

                    {/* KPI Cards */}
                    <div className="lg:col-span-2 grid grid-cols-2 gap-4">
                        {/* Revenue KPI */}
                        <div className="bg-[#1c1c1c] text-white rounded-[2rem] p-6 flex flex-col justify-between relative overflow-hidden group animate-scale-in delay-75">
                            <div className="relative z-10">
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">Gesamtumsatz (LTV)</p>
                                <h3 className="text-3xl font-mono font-bold text-accent">{formatCurrency(totalRevenue)}</h3>
                            </div>
                            <div className="relative z-10 mt-4 flex items-center gap-2">
                                <span className="bg-white/10 px-2 py-1 rounded text-[10px] font-bold">{paidCount} bezahlte Rechnungen</span>
                            </div>
                            <div className="absolute top-0 right-0 w-32 h-32 bg-accent rounded-full blur-[60px] opacity-10 group-hover:opacity-20 transition-opacity"></div>
                        </div>

                        {/* Outstanding KPI */}
                        <div className="bg-surface border border-border rounded-[2rem] p-6 flex flex-col justify-between relative overflow-hidden animate-scale-in delay-100">
                             <div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">Offene Forderungen</p>
                                <h3 className={`text-3xl font-mono font-bold ${outstandingAmount > 0 ? 'text-error' : 'text-gray-900'}`}>{formatCurrency(outstandingAmount)}</h3>
                            </div>
                            <div className="mt-4 flex items-center gap-2">
                                {openCount > 0 ? (
                                    <span className="bg-error-bg text-error px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1">
                                        <AlertCircle size={10} /> {openCount} offen
                                    </span>
                                ) : (
                                    <span className="bg-success-bg text-success px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1">
                                        <CheckCircle size={10} /> Alles bezahlt
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Projects KPI */}
                        <div className="bg-surface border border-border rounded-[2rem] p-6 flex flex-col justify-between animate-scale-in delay-150">
                            <div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">Aktive Projekte</p>
                                <h3 className="text-3xl font-mono font-bold">{selectedClient.projects.filter(p => p.status === 'active').length}</h3>
                            </div>
                            <div className="mt-4">
                                <p className="text-xs text-gray-500 font-medium">Insgesamt {selectedClient.projects.length} Projekte</p>
                            </div>
                        </div>

                         {/* Last Activity KPI */}
                         <div className="bg-surface-muted border border-border rounded-[2rem] p-6 flex flex-col justify-between animate-scale-in delay-200">
                            <div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">Letzte Aktivität</p>
                                <h3 className="text-xl font-bold truncate">
                                    {selectedClient.activities[0] 
                                        ? new Date(selectedClient.activities[0].date).toLocaleDateString() 
                                        : '-'}
                                </h3>
                            </div>
                            <div className="mt-4">
                                <p className="text-xs text-gray-500 font-medium truncate">
                                    {selectedClient.activities[0]?.content || 'Keine Aktivitäten'}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Bottom Section: Invoices & History */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Left: Invoice List (2 cols wide) */}
                    <div className="lg:col-span-2 bg-surface rounded-[2.5rem] p-6 border border-border min-h-[400px] animate-enter delay-200">
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-xl font-bold flex items-center gap-2">
                                <FileText size={20} /> Rechnungsverlauf
                            </h3>
                        </div>

                        <div className="space-y-2">
                            {sortedInvoices.length > 0 ? sortedInvoices.map((inv, idx) => (
                                <button
                                    key={inv.id}
                                    type="button"
                                    onClick={() => {
                                        const to = `/documents?kind=invoice&id=${encodeURIComponent(inv.id)}`;
                                        navigate({ to });
                                    }}
                                    className="group w-full text-left flex items-center justify-between p-4 rounded-2xl border border-gray-100 hover:border-black hover:bg-gray-50 transition-all cursor-pointer animate-enter"
                                    style={{ animationDelay: `${200 + idx * 50}ms` }}
                                    title={`${inv.number} öffnen`}
                                >
                                    <div className="flex items-center gap-4">
                                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs ${
                                            inv.status === 'paid' ? 'bg-accent text-black' :
                                            inv.status === 'overdue' ? 'bg-error-bg text-error' : 'bg-gray-200 text-gray-600'
                                        }`}>
                                            {inv.status === 'paid' ? <CheckCircle size={16} /> : <Clock size={16} />}
                                        </div>
                                        <div>
                                            <p className="font-bold text-sm">{inv.number}</p>
                                            <p className="text-xs text-gray-400">{new Date(inv.date).toLocaleDateString()}</p>
                                        </div>
                                    </div>
                                    
                                    <div className="text-right">
                                        <p className="font-mono font-bold">{formatCurrency(inv.amount)}</p>
                                        <p className="text-[10px] font-bold uppercase text-gray-400">{inv.status}</p>
                                    </div>
                                    
                                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                        <ArrowRight size={16} />
                                    </div>
                                </button>
                            )) : (
                                <div className="text-center py-12 text-gray-400">
                                    <FileText size={48} className="mx-auto mb-4 opacity-20" />
                                    <p>Keine Rechnungen vorhanden</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Right: Notes & Projects (1 col wide) */}
                    <div className="flex flex-col gap-6">
                        {/* Addresses & Emails */}
                        <div className="bg-surface rounded-[2.5rem] p-6 border border-border animate-enter delay-300">
                            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                                <MapPin size={18} /> Adressen & E-Mails
                            </h3>
                            <div className="space-y-3">
                                <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100">
                                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Rechnungsadresse</p>
                                    <p className="text-sm font-medium text-gray-800">
                                        {billingAddress
                                            ? `${billingAddress.street}${billingAddress.line2 ? `, ${billingAddress.line2}` : ''}, ${billingAddress.zip} ${billingAddress.city}, ${billingAddress.country}`
                                            : (selectedClient.address || '-')}
                                    </p>
                                </div>
                                <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100">
                                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Lieferadresse</p>
                                    <p className="text-sm font-medium text-gray-800">
                                        {shippingAddress
                                            ? `${shippingAddress.street}${shippingAddress.line2 ? `, ${shippingAddress.line2}` : ''}, ${shippingAddress.zip} ${shippingAddress.city}, ${shippingAddress.country}`
                                            : '-'}
                                    </p>
                                </div>
                                 <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100">
                                     <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">E-Mail (Rechnung)</p>
                                     <p className="text-sm font-medium text-gray-800">{billingEmail?.email || selectedClient.email || '-'}</p>
                                 </div>
                                <div className="text-xs text-gray-500">
                                    {addresses.length} Adresse(n) • {emails.length} E-Mail(s) • Bearbeiten über den Stift-Button
                                </div>
                            </div>
                        </div>

                        {/* Projects Mini List */}
                        <div className="bg-surface rounded-[2.5rem] p-6 border border-border flex-1 animate-enter delay-300">
                             <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                                <Briefcase size={18} /> Projekte
                            </h3>
                            <div className="space-y-3">
                                {selectedClient.projects.map(p => (
                                    <button
                                        key={p.id}
                                        onClick={() => navigate({ to: `/projects/${p.id}` })}
                                        className="w-full text-left p-4 bg-gray-50 rounded-2xl border border-gray-100 hover:bg-gray-100 transition-colors"
                                        title="Projekt öffnen"
                                    >
                                        <div className="flex justify-between items-start mb-2">
                                            <div>
                                              <div className="font-bold text-sm">{p.name}</div>
                                              {p.code && <div className="text-xs text-gray-500 font-mono mt-1">{p.code}</div>}
                                            </div>
                                            <span className={`w-2 h-2 rounded-full ${p.status === 'active' ? 'bg-accent' : 'bg-gray-300'}`}></span>
                                        </div>
                                        <div className="flex justify-between items-end">
                                            <span className="text-xs text-gray-500 font-mono">Budget: {formatCurrency(p.budget)}</span>
                                        </div>
                                    </button>
                                ))}
                                {selectedClient.projects.length === 0 && <p className="text-gray-400 text-sm">Keine Projekte.</p>}
                            </div>
                        </div>
                        
                        {/* Notes / Activities */}
                        <div className="bg-surface rounded-[2.5rem] p-6 border border-border flex-1 animate-enter delay-300">
                            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                                <Tag size={18} /> Notizen
                            </h3>
                             <p className="text-sm text-gray-600 leading-relaxed bg-warning-bg p-4 rounded-xl border border-warning-border">
                                {selectedClient.notes || 'Keine Notizen hinterlegt.'}
                             </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    return (
         <div className="bg-surface rounded-[2.5rem] p-6 min-h-full border border-border flex flex-col animate-enter overflow-hidden">
              {isEditorOpen && draft ? (
                  <div className="flex flex-col flex-1 min-h-0">
                      <div className="flex flex-col flex-1 min-h-0">
                          <div className="p-6 border-b border-border flex items-center justify-between">
                              <div>
                                  <h3 className="text-2xl font-bold">
                                      {clients.some((c) => c.id === draft.id) ? 'Kunde bearbeiten' : 'Neuer Kunde'}
                                  </h3>
                                  <p className="text-xs text-muted mt-1">{draft.id}</p>
                              </div>
                              <button
                                  onClick={closeEditor}
                                  className="w-10 h-10 rounded-full hover:bg-gray-200 flex items-center justify-center"
                              >
                                  <X size={18} />
                              </button>
                          </div>
 
                         <div className="p-6 space-y-12 flex-1 overflow-y-auto">
                              {editorErrors.length > 0 && (
                                  <div className="rounded-2xl border border-error/30 bg-error-bg p-4 space-y-1">
                                      {editorErrors.map((error) => (
                                          <p key={error} className="text-sm font-medium text-error">{error}</p>
                                      ))}
                                  </div>
                              )}
                              <section>
                                  <h4 className="text-lg font-bold mb-6 pb-3 border-b border-border">Stammdaten</h4>
                                 <div className="grid grid-cols-2 gap-4">
                                 <div>
                                     <label className="block text-xs font-bold text-gray-500 mb-1">Kundennummer</label>
                                     <input
                                         value={draft.customerNumber ?? ''}
                                         onChange={(e) => setDraft({ ...draft, customerNumber: e.target.value })}
                                         placeholder="Automatisch bei leerem Feld"
                                         className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-mono outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                     />
                                 </div>
                                  <div className="col-span-2">
                                      <label className="block text-xs font-bold text-gray-500 mb-1">Firma</label>
                                      <input
                                         value={draft.company}
                                         onChange={(e) => setDraft({ ...draft, company: e.target.value })}
                                         className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                     />
                                 </div>
                                 <div>
                                     <label className="block text-xs font-bold text-gray-500 mb-1">Ansprechpartner</label>
                                     <input
                                         value={draft.contactPerson}
                                         onChange={(e) => setDraft({ ...draft, contactPerson: e.target.value })}
                                         className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                     />
                                 </div>
                                 <div>
                                     <label className="block text-xs font-bold text-gray-500 mb-1">Telefon</label>
                                     <input
                                         value={draft.phone}
                                         onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                                         className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                     />
                                 </div>
                                 <div>
                                     <label className="block text-xs font-bold text-gray-500 mb-1">Status</label>
                                     <select
                                         value={draft.status}
                                         onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
                                         className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                     >
                                         <option value="active">Aktiv</option>
                                         <option value="inactive">Inaktiv</option>
                                     </select>
                                 </div>
                                 <div>
                                     <label className="block text-xs font-bold text-gray-500 mb-1">Tags (Komma)</label>
                                     <input
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
                                         className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                     />
                                 </div>
                                 <div className="col-span-2">
                                     <label className="block text-xs font-bold text-gray-500 mb-1">Notizen</label>
                                     <textarea
                                         value={draft.notes ?? ''}
                                         onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                                         className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                         rows={3}
                                     />
                                 </div>
                              </div>
                             </section>

                              <section className="space-y-3">
                                  <div className="flex items-center justify-between">
                                      <div>
                                          <h4 className="font-bold text-sm">E-Mails</h4>
                                          <p className="text-[11px] text-gray-500 mt-0.5">
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
                                         className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-gray-800 transition-colors"
                                     >
                                         + E-Mail
                                      </button>
                                  </div>

                                  {(draft.emails ?? []).map((em, idx) => (
                                      <div
                                          key={em.id}
                                          className="p-4 rounded-2xl border border-border bg-surface-muted space-y-3"
                                      >
                                          <div className="grid grid-cols-12 gap-3 items-end">
                                          <div className="col-span-3">
                                              <label className="block text-[10px] font-bold text-gray-500 mb-1">Bezeichnung</label>
                                              <input
                                                  value={em.label}
                                                 onChange={(e) => {
                                                     const next = [...(draft.emails ?? [])];
                                                     next[idx] = { ...em, label: e.target.value };
                                                     setDraft({ ...draft, emails: next });
                                                 }}
                                                  className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                              />
                                          </div>
                                          <div className="col-span-2">
                                              <label className="block text-[10px] font-bold text-gray-500 mb-1">Kategorie</label>
                                              <select
                                                  value={em.kind}
                                                  onChange={(e) => {
                                                      const next = [...(draft.emails ?? [])];
                                                      next[idx] = { ...em, kind: e.target.value as any };
                                                      setDraft({ ...draft, emails: next });
                                                  }}
                                                  className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                              >
                                                  <option value="general">{emailKindLabel.general}</option>
                                                  <option value="billing">{emailKindLabel.billing}</option>
                                                  <option value="shipping">{emailKindLabel.shipping}</option>
                                                  <option value="other">{emailKindLabel.other}</option>
                                              </select>
                                          </div>
                                          <div className="col-span-5">
                                              <label className="block text-[10px] font-bold text-gray-500 mb-1">E-Mail-Adresse</label>
                                              <input
                                                  value={em.email}
                                                  onChange={(e) => {
                                                      const next = [...(draft.emails ?? [])];
                                                     next[idx] = { ...em, email: e.target.value };
                                                     setDraft({ ...draft, emails: next });
                                                 }}
                                                  className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                              />
                                          </div>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <div className="flex items-center gap-2">
                                                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Standard</span>
                                                  <button
                                                      onClick={() => {
                                                          const next = setOnlyOneFlag((draft.emails ?? []) as any, em.id, 'isDefaultBilling') as ClientEmail[];
                                                          setDraft({ ...draft, emails: next });
                                                      }}
                                                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                                                          em.isDefaultBilling ? 'bg-black text-white border-black' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
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
                                                          em.isDefaultGeneral ? 'bg-black text-white border-black' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
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
                                                  className="px-3 py-1.5 rounded-lg border border-error text-error hover:bg-error-bg text-xs font-bold flex items-center gap-1.5 transition-colors"
                                              >
                                                  <Trash2 size={14} />
                                                  Entfernen
                                              </button>
                                          </div>
                                      </div>
                                  ))}
                              </section>

                              <section className="space-y-3">
                                  <div className="flex items-center justify-between">
                                      <div>
                                          <h4 className="font-bold text-sm">Adressen</h4>
                                          <p className="text-[11px] text-gray-500 mt-0.5">
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
                                         className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-gray-800 transition-colors"
                                     >
                                         + Adresse
                                      </button>
                                  </div>

                                  {(draft.addresses ?? []).map((ad, idx) => (
                                      <div key={ad.id} className="p-4 bg-surface-muted rounded-2xl border border-border space-y-3">
                                          <div className="grid grid-cols-12 gap-3">
                                              <div className="col-span-4">
                                                  <label className="block text-[10px] font-bold text-gray-500 mb-1">Bezeichnung</label>
                                                  <input
                                                     value={ad.label}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, label: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                                 />
                                              </div>
                                              <div className="col-span-3">
                                                  <label className="block text-[10px] font-bold text-gray-500 mb-1">Kategorie</label>
                                                  <select
                                                      value={ad.kind}
                                                      onChange={(e) => {
                                                          const next = [...(draft.addresses ?? [])];
                                                          next[idx] = { ...ad, kind: e.target.value as any };
                                                          setDraft({ ...draft, addresses: next });
                                                      }}
                                                      className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
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
                                                          ad.isDefaultBilling ? 'bg-black text-white border-black' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
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
                                                          ad.isDefaultShipping ? 'bg-black text-white border-black' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                                                      }`}
                                                  >
                                                      {ad.isDefaultShipping && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                                                      Standard Lieferung
                                                  </button>
                                              </div>
                                          </div>

                                         <div className="grid grid-cols-12 gap-3">
                                             <div className="col-span-6">
                                                 <label className="block text-[10px] font-bold text-gray-500 mb-1">Straße</label>
                                                 <input
                                                     value={ad.street}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, street: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                                 />
                                             </div>
                                             <div className="col-span-6">
                                                 <label className="block text-[10px] font-bold text-gray-500 mb-1">Zusatz</label>
                                                 <input
                                                     value={ad.line2 ?? ''}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, line2: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                                 />
                                             </div>
                                             <div className="col-span-3">
                                                 <label className="block text-[10px] font-bold text-gray-500 mb-1">PLZ</label>
                                                 <input
                                                     value={ad.zip}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, zip: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                                 />
                                             </div>
                                             <div className="col-span-5">
                                                 <label className="block text-[10px] font-bold text-gray-500 mb-1">Stadt</label>
                                                 <input
                                                     value={ad.city}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, city: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                                 />
                                             </div>
                                             <div className="col-span-4">
                                                 <label className="block text-[10px] font-bold text-gray-500 mb-1">Land</label>
                                                 <input
                                                     value={ad.country}
                                                     onChange={(e) => {
                                                         const next = [...(draft.addresses ?? [])];
                                                         next[idx] = { ...ad, country: e.target.value };
                                                         setDraft({ ...draft, addresses: next });
                                                     }}
                                                     className="w-full bg-surface border border-border rounded-xl p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                                                 />
                                             </div>
                                         </div>

                                         <div className="flex justify-end">
                                             <button
                                                 onClick={() => {
                                                     const next = (draft.addresses ?? []).filter((a) => a.id !== ad.id);
                                                     setDraft({ ...draft, addresses: next });
                                                 }}
                                                 className="px-3 py-1.5 rounded-lg border border-error text-error hover:bg-error-bg text-xs font-bold flex items-center gap-1.5 transition-colors"
                                             >
                                                 <Trash2 size={14} />
                                                 Entfernen
                                             </button>
                                         </div>
                                     </div>
                                  ))}
                              </section>
                          </div>
 
                          <div className="p-6 border-t border-border bg-surface-muted rounded-b-[2.5rem]">
                              <div className="flex justify-end gap-3">
                              <button
                                  onClick={closeEditor}
                                  className="px-4 py-2 bg-surface border border-border text-black rounded-full text-xs font-bold hover:bg-surface-muted transition-colors"
                              >
                                  Abbrechen
                              </button>
                              <button
                                  onClick={() => void saveDraft()}
                                  className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-gray-800 transition-colors"
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
                 <h1 className="text-3xl font-black text-gray-900">Kunden</h1>
                 <div className="flex gap-3">
                    <div className="relative">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                        <input 
                            type="text" 
                            placeholder="Suchen..." 
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-12 pr-6 py-3 bg-gray-50 border-none rounded-full text-sm font-bold outline-none w-64 focus:ring-2 focus:ring-accent transition-shadow"
                        />
                   </div>
                   
                   <div className="bg-gray-100 p-1 rounded-full flex items-center">
                        <button 
                            onClick={() => setViewMode('grid')}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${viewMode === 'grid' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-600'}`}
                            title="Rasteransicht"
                        >
                            <LayoutGrid size={18} />
                        </button>
                        <button 
                            onClick={() => setViewMode('list')}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${viewMode === 'list' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-600'}`}
                            title="Listenansicht"
                        >
                            <List size={18} />
                        </button>
                   </div>

                   <button
                     onClick={() => openEditor()}
                     className="w-12 h-12 bg-black text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-lg"
                   >
                     <Plus size={24} />
                   </button>
                </div>
             </div>

             {viewMode === 'grid' ? (
                 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 overflow-y-auto pb-4">
                     {isLoading ? (
                       <SkeletonLoader variant="card" count={6} />
                     ) : filteredClients.map((client, idx) => (
                         <div 
                            key={client.id} 
                            onClick={() => setSelectedClientId(client.id)}
                            className="group bg-gray-50 rounded-[2rem] p-6 hover:bg-accent transition-all cursor-pointer relative overflow-hidden min-h-[220px] animate-scale-in"
                            style={{ animationDelay: `${idx * 75}ms` }}
                         >
                             <div className="flex justify-between items-start mb-8 relative z-10">
                                 <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-xl font-bold shadow-sm transition-transform group-hover:scale-110">
                                     {client.company.substring(0,2).toUpperCase()}
                                 </div>
                                 <div className="w-8 h-8 rounded-full border border-black/10 flex items-center justify-center group-hover:bg-black group-hover:text-white transition-colors">
                                     <ArrowRight size={14} className="-rotate-45" />
                                 </div>
                             </div>
                             
                             <div className="relative z-10">
                                 <h3 className="text-xl font-bold mb-1 leading-tight line-clamp-1">{client.company}</h3>
                                 <p className="text-sm font-medium opacity-60 mb-6">{client.contactPerson}</p>
                                 
                                 <div className="flex gap-2">
                                     <span className="px-3 py-1 bg-white/50 rounded-full text-xs font-bold backdrop-blur-sm group-hover:bg-white/80 transition-colors">
                                         {client.projects.length} Projekte
                                     </span>
                                     <span className={`px-3 py-1 rounded-full text-xs font-bold backdrop-blur-sm ${client.status === 'active' ? 'bg-success-bg text-success' : 'bg-surface-muted text-muted'}`}>
                                         {client.status}
                                     </span>
                                 </div>
                             </div>
                         </div>
                     ))}
                 </div>
             ) : (
                 <div className="flex-1 overflow-y-auto pb-4 space-y-2">
                     <div className="grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider sticky top-0 bg-white z-10">
                        <div className="col-span-4">Firma / Kontakt</div>
                        <div className="col-span-3">Kontaktinfo</div>
                        <div className="col-span-2">Status</div>
                        <div className="col-span-2">Projekte</div>
                        <div className="col-span-1"></div>
                     </div>

                     {isLoading ? (
                       <SkeletonLoader variant="list" count={5} />
                     ) : filteredClients.map((client, idx) => (
                         <div 
                            key={client.id} 
                            onClick={() => setSelectedClientId(client.id)}
                            className="group bg-gray-50 rounded-2xl p-4 border border-gray-100 hover:border-border hover:bg-surface transition-all grid grid-cols-12 gap-4 items-center cursor-pointer animate-enter"
                            style={{ animationDelay: `${idx * 50}ms` }}
                         >
                            <div className="col-span-4 flex items-center gap-4">
                                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-sm font-bold shadow-sm text-black shrink-0">
                                     {client.company.substring(0,2).toUpperCase()}
                                 </div>
                                 <div className="min-w-0">
                                     <h3 className="font-bold text-sm text-gray-900 truncate">{client.company}</h3>
                                     <p className="text-xs text-gray-500 truncate">{client.contactPerson}</p>
                                 </div>
                            </div>
                            <div className="col-span-3 space-y-1">
                                <div className="flex items-center gap-2 text-xs text-gray-600 truncate">
                                    <Mail size={12} className="opacity-50 shrink-0"/> 
                                    <span className="truncate">{client.email}</span>
                                </div>
                                 <div className="flex items-center gap-2 text-xs text-gray-600 truncate">
                                    <Phone size={12} className="opacity-50 shrink-0"/> 
                                    <span className="truncate">{client.phone}</span>
                                </div>
                            </div>
                            <div className="col-span-2">
                                <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${client.status === 'active' ? 'bg-success-bg text-success' : 'bg-gray-200 text-gray-600'}`}>
                                    {client.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                                </span>
                            </div>
                            <div className="col-span-2">
                                <span className="text-xs font-medium bg-white px-2 py-1 rounded border border-gray-100">
                                    {client.projects.length} Projekte
                                </span>
                            </div>
                            <div className="col-span-1 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight size={16} className="text-gray-400" />
                            </div>
                         </div>
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
