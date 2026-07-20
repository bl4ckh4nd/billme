import React from 'react';
import {
    Plus, MapPin, Phone, Mail, FileText,
    ArrowRight, ArrowLeft, Trash2, Edit3,
    CheckCircle, Clock, AlertCircle, Tag, Briefcase,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import type { Client, Invoice } from '../../types';
import { formatCurrency } from './helpers';

interface ClientDetailPanelProps {
    selectedClient: Client;
    invoices: Invoice[];
    onBack: () => void;
    onEdit: () => void;
    onDelete: () => Promise<void>;
    onCreateInvoice: () => Promise<void>;
    onCreateOffer: () => Promise<void>;
}

export const ClientDetailPanel: React.FC<ClientDetailPanelProps> = ({
    selectedClient,
    invoices,
    onBack,
    onEdit,
    onDelete,
    onCreateInvoice,
    onCreateOffer,
}) => {
    const navigate = useNavigate();

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
                <button onClick={onBack} className="flex items-center gap-2 text-muted hover:text-foreground font-bold transition-colors duration-150 ease-out">
                    <ArrowLeft size={20} />
                    <span className="text-sm uppercase tracking-wider">Zurück zur Übersicht</span>
                </button>
                <div className="flex gap-2">
                    <button
                      onClick={async () => {
                         try {
                           await onCreateInvoice();
                         } catch (error) {
                           alert(`Rechnung konnte nicht erstellt werden: ${String(error)}`);
                         }
                       }}
                      className="px-3 py-1.5 bg-foreground text-white rounded-lg text-xs font-bold hover:bg-dark-1 transition-colors duration-150 ease-out flex items-center gap-2"
                    >
                        <Plus size={14} /> Neue Rechnung
                    </button>
                    <button
                      onClick={async () => {
                         try {
                           await onCreateOffer();
                         } catch (error) {
                           alert(`Angebot konnte nicht erstellt werden: ${String(error)}`);
                         }
                       }}
                      className="px-4 py-2 bg-surface border border-border text-foreground rounded-full text-xs font-bold hover:bg-surface-muted transition-colors duration-150 ease-out flex items-center gap-2"
                    >
                        <Plus size={14} /> Neues Angebot
                    </button>
                    <button
                      onClick={onEdit}
                      className="w-10 h-10 border border-border rounded-full flex items-center justify-center hover:bg-surface-muted transition-colors duration-150 ease-out"
                    >
                        <Edit3 size={16} />
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm('Kunde wirklich löschen?')) return;
                        try {
                          await onDelete();
                        } catch (error) {
                          alert(`Kunde konnte nicht gelöscht werden: ${String(error)}`);
                        }
                      }}
                      className="w-10 h-10 border border-border rounded-full flex items-center justify-center hover:bg-error-bg transition-colors duration-150 ease-out text-error"
                    >
                      <Trash2 size={16} />
                    </button>
                </div>
            </div>

            {/* Top Section: Identity & KPIs */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Identity Card */}
                <div className="bg-accent rounded-xl p-6 text-black relative overflow-hidden border border-black/10 flex flex-col justify-between min-h-[240px] animate-scale-in">
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
                    <div className="bg-dark-3 text-white rounded-xl p-6 flex flex-col justify-between relative overflow-hidden group animate-scale-in delay-75">
                        <div className="relative z-10">
                            <p className="text-dark-muted text-xs font-bold uppercase tracking-wider mb-1">Gesamtumsatz (LTV)</p>
                            <h3 className="text-3xl tabular-nums font-bold text-accent">{formatCurrency(totalRevenue)}</h3>
                        </div>
                        <div className="relative z-10 mt-4 flex items-center gap-2">
                            <span className="bg-white/10 px-2 py-1 rounded text-[10px] font-bold">{paidCount} bezahlte Rechnungen</span>
                        </div>
                        <div className="absolute top-0 right-0 w-32 h-32 bg-accent rounded-full blur-[60px] opacity-10 group-hover:opacity-20 transition-opacity"></div>
                    </div>

                    {/* Outstanding KPI */}
                    <div className="bg-surface border border-border rounded-xl p-6 flex flex-col justify-between relative overflow-hidden animate-scale-in delay-100">
                         <div>
                            <p className="text-muted text-xs font-bold uppercase tracking-wider mb-1">Offene Forderungen</p>
                            <h3 className={`text-3xl tabular-nums font-bold ${outstandingAmount > 0 ? 'text-error' : 'text-foreground'}`}>{formatCurrency(outstandingAmount)}</h3>
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
                    <div className="bg-surface border border-border rounded-xl p-6 flex flex-col justify-between animate-scale-in delay-150">
                        <div>
                            <p className="text-muted text-xs font-bold uppercase tracking-wider mb-1">Aktive Projekte</p>
                            <h3 className="text-3xl tabular-nums font-bold">{selectedClient.projects.filter(p => p.status === 'active').length}</h3>
                        </div>
                        <div className="mt-4">
                            <p className="text-xs text-muted font-medium">Insgesamt {selectedClient.projects.length} Projekte</p>
                        </div>
                    </div>

                     {/* Last Activity KPI */}
                     <div className="bg-surface-muted border border-border rounded-xl p-6 flex flex-col justify-between animate-scale-in delay-200">
                        <div>
                            <p className="text-muted text-xs font-bold uppercase tracking-wider mb-1">Letzte Aktivität</p>
                            <h3 className="text-xl font-bold truncate">
                                {selectedClient.activities[0]
                                    ? new Date(selectedClient.activities[0].date).toLocaleDateString()
                                    : '-'}
                            </h3>
                        </div>
                        <div className="mt-4">
                            <p className="text-xs text-muted font-medium truncate">
                                {selectedClient.activities[0]?.content || 'Keine Aktivitäten'}
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Bottom Section: Invoices & History */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left: Invoice List (2 cols wide) */}
                <div className="lg:col-span-2 bg-surface rounded-xl p-6 border border-border min-h-[400px] animate-enter delay-200">
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
                                className="group w-full text-left flex items-center justify-between p-4 rounded-xl border border-border-subtle hover:border-foreground hover:bg-surface-muted transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out cursor-pointer animate-enter"
                                style={{ animationDelay: `${200 + idx * 50}ms` }}
                                title={`${inv.number} öffnen`}
                            >
                                <div className="flex items-center gap-4">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs ${
                                        inv.status === 'paid' ? 'bg-accent text-black' :
                                        inv.status === 'overdue' ? 'bg-error-bg text-error' : 'bg-surface-muted text-muted'
                                    }`}>
                                        {inv.status === 'paid' ? <CheckCircle size={16} /> : <Clock size={16} />}
                                    </div>
                                    <div>
                                        <p className="font-bold text-sm">{inv.number}</p>
                                        <p className="text-xs text-muted">{new Date(inv.date).toLocaleDateString()}</p>
                                    </div>
                                </div>

                                <div className="text-right">
                                    <p className="tabular-nums font-bold">{formatCurrency(inv.amount)}</p>
                                    <p className="text-[10px] font-bold uppercase text-muted">{inv.status}</p>
                                </div>

                                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                    <ArrowRight size={16} />
                                </div>
                            </button>
                        )) : (
                            <div className="text-center py-12 text-muted">
                                <FileText size={48} className="mx-auto mb-4 opacity-20" />
                                <p>Keine Rechnungen vorhanden</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Right: Notes & Projects (1 col wide) */}
                <div className="flex flex-col gap-6">
                    {/* Addresses & Emails */}
                    <div className="bg-surface rounded-xl p-6 border border-border animate-enter delay-300">
                        <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                            <MapPin size={18} /> Adressen & E-Mails
                        </h3>
                        <div className="space-y-3">
                            <div className="p-4 bg-surface-muted rounded-xl border border-border-subtle">
                                <p className="text-[10px] font-bold text-muted uppercase mb-1">Rechnungsadresse</p>
                                <p className="text-sm font-medium text-foreground">
                                    {billingAddress
                                        ? `${billingAddress.street}${billingAddress.line2 ? `, ${billingAddress.line2}` : ''}, ${billingAddress.zip} ${billingAddress.city}, ${billingAddress.country}`
                                        : (selectedClient.address || '-')}
                                </p>
                            </div>
                            <div className="p-4 bg-surface-muted rounded-xl border border-border-subtle">
                                <p className="text-[10px] font-bold text-muted uppercase mb-1">Lieferadresse</p>
                                <p className="text-sm font-medium text-foreground">
                                    {shippingAddress
                                        ? `${shippingAddress.street}${shippingAddress.line2 ? `, ${shippingAddress.line2}` : ''}, ${shippingAddress.zip} ${shippingAddress.city}, ${shippingAddress.country}`
                                        : '-'}
                                </p>
                            </div>
                             <div className="p-4 bg-surface-muted rounded-xl border border-border-subtle">
                                 <p className="text-[10px] font-bold text-muted uppercase mb-1">E-Mail (Rechnung)</p>
                                 <p className="text-sm font-medium text-foreground">{billingEmail?.email || selectedClient.email || '-'}</p>
                             </div>
                            <div className="text-xs text-muted">
                                {addresses.length} Adresse(n) • {emails.length} E-Mail(s) • Bearbeiten über den Stift-Button
                            </div>
                        </div>
                    </div>

                    {/* Projects Mini List */}
                    <div className="bg-surface rounded-xl p-6 border border-border flex-1 animate-enter delay-300">
                         <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                            <Briefcase size={18} /> Projekte
                        </h3>
                        <div className="space-y-3">
                            {selectedClient.projects.map(p => (
                                <button
                                    key={p.id}
                                    onClick={() => navigate({ to: `/projects/${p.id}` })}
                                    className="w-full text-left p-4 bg-surface-muted rounded-xl border border-border-subtle hover:bg-canvas transition-colors duration-150 ease-out"
                                    title="Projekt öffnen"
                                >
                                    <div className="flex justify-between items-start mb-2">
                                        <div>
                                          <div className="font-bold text-sm">{p.name}</div>
                                          {p.code && <div className="text-xs text-muted font-mono mt-1">{p.code}</div>}
                                        </div>
                                        <span className={`w-2 h-2 rounded-full ${p.status === 'active' ? 'bg-accent' : 'bg-border'}`}></span>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <span className="text-xs text-muted tabular-nums">Budget: {formatCurrency(p.budget)}</span>
                                    </div>
                                </button>
                            ))}
                            {selectedClient.projects.length === 0 && <p className="text-muted text-sm">Keine Projekte.</p>}
                        </div>
                    </div>

                    {/* Notes / Activities */}
                    <div className="bg-surface rounded-xl p-6 border border-border flex-1 animate-enter delay-300">
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
