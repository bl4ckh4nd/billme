import { Button } from '@billme/ui';
import React, { useState } from 'react';
import {
    Repeat, Calendar, Play, Pause, Plus, Trash2,
    CheckCircle, AlertCircle, Edit3, X, Clock,
    Save, Calculator
} from 'lucide-react';
import { RecurringProfile, RecurrenceInterval, InvoiceItem } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { useClientsQuery } from '../hooks/useClients';
import {
  useDeleteRecurringProfileMutation,
  useRecurringProfilesQuery,
  useUpsertRecurringProfileMutation,
} from '../hooks/useRecurring';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../hooks/useToast';
import { Toast } from './Toast';
import { ipc } from '../ipc/client';

export const RecurringView: React.FC = () => {
    const { data: profiles = [] } = useRecurringProfilesQuery();
    const { data: clients = [] } = useClientsQuery();
    const upsertProfile = useUpsertRecurringProfileMutation();
    const deleteProfile = useDeleteRecurringProfileMutation();
    const queryClient = useQueryClient();
    const { toast, toastState, closeToast } = useToast();
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingProfile, setEditingProfile] = useState<RecurringProfile | null>(null);
    const [runningNowId, setRunningNowId] = useState<string | null>(null);

    // Form State
    const [formData, setFormData] = useState<Partial<RecurringProfile>>({});

    const formatCurrency = (amount: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
    const formatDate = (dateString: string) => new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const getClientName = (id: string) => clients.find(c => c.id === id)?.company || 'Unbekannt';

    const handleEdit = (profile?: RecurringProfile) => {
        if (profile) {
            setEditingProfile(profile);
            setFormData(JSON.parse(JSON.stringify(profile))); // Deep copy
        } else {
            setEditingProfile(null);
            setFormData({
                id: uuidv4(),
                active: true,
                name: '',
                clientId: clients[0]?.id || '',
                interval: 'monthly',
                nextRun: new Date().toISOString().split('T')[0],
                items: [{ description: 'Neue Position', quantity: 1, price: 0, total: 0 }],
                amount: 0
            });
        }
        setIsEditModalOpen(true);
    };

    const handleDelete = (id: string) => {
        if (confirm('Abo wirklich löschen?')) {
            deleteProfile.mutate(id);
        }
    };

    const handleToggleActive = (id: string) => {
        const profile = profiles.find(p => p.id === id);
        if (!profile) return;
        upsertProfile.mutate({ ...profile, active: !profile.active });
    };

    const handleSave = () => {
        if (!formData.name || !formData.clientId) return;

        // Recalculate total just in case
        const total = (formData.items || []).reduce((acc, item) => acc + item.total, 0);
        const finalData = { ...formData, amount: total } as RecurringProfile;

        upsertProfile.mutate(finalData);
        setIsEditModalOpen(false);
    };

    // Item Management inside Modal
    const handleItemChange = (index: number, field: keyof InvoiceItem, value: any) => {
        if (!formData.items) return;
        const newItems = [...formData.items];
        newItems[index] = { ...newItems[index], [field]: value };
        if (field === 'price' || field === 'quantity') {
            newItems[index].total = newItems[index].price * newItems[index].quantity;
        }
        setFormData({ ...formData, items: newItems });
    };

    const addItem = () => {
        setFormData({
            ...formData,
            items: [...(formData.items || []), { description: '', quantity: 1, price: 0, total: 0 }]
        });
    };

    const removeItem = (index: number) => {
        if (!formData.items) return;
        setFormData({
            ...formData,
            items: formData.items.filter((_, i) => i !== index)
        });
    };

    // Simulation of "Running" the invoice generation
    const handleRunNow = async (id: string) => {
        try {
            setRunningNowId(id);

            // Call real IPC endpoint
            const result = await ipc.recurring.manualRun();

            if (result.success && result.result) {
                toast({
                    title: 'Abo-Rechnungen generiert',
                    description: `${result.result.generated} Rechnung(en) erstellt. ${
                        result.result.deactivated > 0
                            ? `${result.result.deactivated} Profil(e) deaktiviert (Enddatum erreicht).`
                            : ''
                    }`,
                    variant: result.result.errors.length > 0 ? 'warning' : 'default'
                });

                if (result.result.errors.length > 0) {
                    console.error('Generation errors:', result.result.errors);
                }

                // Refresh profile list
                void queryClient.invalidateQueries({ queryKey: ['recurringProfiles'] });
            } else {
                toast({
                    title: 'Fehler',
                    description: result.error || 'Unbekannter Fehler beim Generieren',
                    variant: 'destructive'
                });
            }
        } catch (error) {
            toast({
                title: 'Fehler',
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive'
            });
        } finally {
            setRunningNowId(null);
        }
    };

    return (
        <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm flex flex-col animate-enter relative">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
                        <Repeat className="text-black" />
                        Abo-Rechnungen
                    </h1>
                    <p className="text-gray-500 font-medium text-sm mt-1">
                        Wiederkehrende Rechnungen automatisch erstellen
                    </p>
                </div>
                <button 
                    onClick={() => handleEdit()}
                    className="bg-accent text-black px-6 py-3 rounded-full font-bold hover:scale-105 active:scale-95 transition-all shadow-lg shadow-accent/20 flex items-center gap-2"
                >
                    <Plus size={18} /> Neues Abo
                </button>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 overflow-y-auto pb-4">
                {profiles.map((profile, idx) => (
                    <div 
                        key={profile.id}
                        className={`p-6 rounded-[2rem] border transition-all relative overflow-hidden group animate-scale-in ${profile.active ? 'bg-white border-gray-200 hover:border-black hover:shadow-xl' : 'bg-gray-50 border-gray-100 opacity-70'}`}
                        style={{ animationDelay: `${idx * 50}ms` }}
                    >
                        <div className="flex justify-between items-start mb-6">
                            <div className="flex items-center gap-4">
                                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-xl shadow-sm ${profile.active ? 'bg-black text-accent' : 'bg-gray-200 text-gray-400'}`}>
                                    {profile.interval === 'monthly' ? 'M' : profile.interval === 'yearly' ? 'J' : 'W'}
                                </div>
                                <div>
                                    <h3 className="font-bold text-lg text-gray-900">{profile.name}</h3>
                                    <p className="text-sm font-medium text-gray-500">{getClientName(profile.clientId)}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button 
                                    onClick={() => handleToggleActive(profile.id)}
                                    className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 transition-colors ${profile.active ? 'bg-success-bg text-success' : 'bg-gray-200 text-gray-500'}`}
                                >
                                    {profile.active ? <Play size={10} fill="currentColor" /> : <Pause size={10} fill="currentColor" />}
                                    {profile.active ? 'Aktiv' : 'Pausiert'}
                                </button>
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onClick={() => handleEdit(profile)} className="p-2 bg-gray-100 hover:bg-black hover:text-white rounded-lg transition-colors"><Edit3 size={14}/></button>
                                    <button onClick={() => handleDelete(profile.id)} className="p-2 bg-error-bg text-error hover:bg-error hover:text-white rounded-lg transition-colors"><Trash2 size={14}/></button>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-3 gap-4 mb-6">
                            <div className="bg-gray-50 rounded-xl p-3">
                                <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Intervall</p>
                                <p className="text-sm font-bold flex items-center gap-1">
                                    <Clock size={12} />
                                    {profile.interval === 'weekly' && 'Wöchentlich'}
                                    {profile.interval === 'monthly' && 'Monatlich'}
                                    {profile.interval === 'quarterly' && 'Quartalsweise'}
                                    {profile.interval === 'yearly' && 'Jährlich'}
                                </p>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-3">
                                <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Nächste Ausführung</p>
                                <p className="text-sm font-bold flex items-center gap-1">
                                    <Calendar size={12} />
                                    {formatDate(profile.nextRun)}
                                </p>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-3 text-right">
                                <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Betrag</p>
                                <p className="text-lg font-mono font-bold text-gray-900">{formatCurrency(profile.amount)}</p>
                            </div>
                        </div>

                        <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                             <p className="text-xs text-gray-400 font-medium">
                                 Zuletzt: {profile.lastRun ? formatDate(profile.lastRun) : '-'}
                             </p>
                             <button
                                onClick={() => handleRunNow(profile.id)}
                                disabled={runningNowId !== null}
                                className="text-xs font-bold text-black hover:text-accent hover:bg-black px-3 py-1.5 rounded-lg transition-colors border border-transparent hover:border-black disabled:opacity-50 disabled:cursor-not-allowed"
                             >
                                 {runningNowId === profile.id ? 'Generiere...' : 'Jetzt ausführen'}
                             </button>
                        </div>
                    </div>
                ))}

                {profiles.length === 0 && (
                     <div className="col-span-full text-center py-16 text-gray-400">
                        <Repeat size={48} className="mx-auto mb-4 opacity-20" />
                        <p>Keine wiederkehrenden Rechnungen eingerichtet.</p>
                    </div>
                )}
            </div>

            {/* Toast Notification */}
            <Toast
                message={toastState.message}
                type={toastState.type}
                isVisible={toastState.isVisible}
                onClose={closeToast}
            />

            {/* Edit Modal */}
            {isEditModalOpen && (
                <div className="absolute inset-0 z-50 bg-black/50 backdrop-blur-sm flex justify-end">
                    <div className="w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300 rounded-l-[2.5rem] overflow-hidden">
                        <div className="p-8 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                            <div>
                                <h2 className="text-xl font-bold">{editingProfile ? 'Abo bearbeiten' : 'Neues Abo'}</h2>
                                <p className="text-xs text-gray-500">{editingProfile?.id || 'Entwurf'}</p>
                            </div>
                            <button onClick={() => setIsEditModalOpen(false)} className="p-2 hover:bg-gray-200 rounded-full transition-colors"><X size={20} /></button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-8 space-y-8">
                            {/* General Settings */}
                            <section className="space-y-4">
                                <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400 flex items-center gap-2">
                                    <Repeat size={14} /> Einstellungen
                                </h3>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="col-span-2">
                                        <label className="block text-xs font-bold text-gray-500 mb-1">Interne Bezeichnung</label>
                                        <input 
                                            type="text" 
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-bold focus:ring-2 focus:ring-accent outline-none"
                                            value={formData.name || ''}
                                            onChange={e => setFormData({ ...formData, name: e.target.value })}
                                            placeholder="z.B. Wartungsvertrag 2024"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 mb-1">Kunde</label>
                                        <select 
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                                            value={formData.clientId}
                                            onChange={e => setFormData({ ...formData, clientId: e.target.value })}
                                        >
                                            {clients.map(c => (
                                                <option key={c.id} value={c.id}>{c.company}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 mb-1">Intervall</label>
                                        <select 
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                                            value={formData.interval}
                                            onChange={e => setFormData({ ...formData, interval: e.target.value as RecurrenceInterval })}
                                        >
                                            <option value="weekly">Wöchentlich</option>
                                            <option value="monthly">Monatlich</option>
                                            <option value="quarterly">Quartalsweise</option>
                                            <option value="yearly">Jährlich</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 mb-1">Start / Nächste Ausführung</label>
                                        <input 
                                            type="date" 
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                                            value={formData.nextRun}
                                            onChange={e => setFormData({ ...formData, nextRun: e.target.value })}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 mb-1">Endet am (Optional)</label>
                                        <input 
                                            type="date" 
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none"
                                            value={formData.endDate || ''}
                                            onChange={e => setFormData({ ...formData, endDate: e.target.value })}
                                        />
                                    </div>
                                </div>
                            </section>

                            <hr className="border-gray-100" />

                            {/* Items Editor */}
                            <section className="space-y-4">
                                <div className="flex justify-between items-center">
                                    <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400 flex items-center gap-2">
                                        <Calculator size={14} /> Rechnungspositionen
                                    </h3>
                                    <button onClick={addItem} className="text-xs font-bold bg-black text-accent px-2 py-1 rounded hover:bg-gray-800 transition-colors">
                                        + Position
                                    </button>
                                </div>
                                
                                <div className="space-y-3">
                                    {formData.items?.map((item, idx) => (
                                        <div key={idx} className="bg-gray-50 rounded-xl p-3 border border-gray-100">
                                            <div className="flex gap-2 mb-2">
                                                <input 
                                                    type="text" 
                                                    placeholder="Beschreibung"
                                                    className="flex-1 bg-white border border-gray-200 rounded p-2 text-sm font-bold outline-none focus:border-accent"
                                                    value={item.description}
                                                    onChange={e => handleItemChange(idx, 'description', e.target.value)}
                                                />
                                                <button onClick={() => removeItem(idx)} className="text-gray-400 hover:text-error p-1"><Trash2 size={16}/></button>
                                            </div>
                                            <div className="grid grid-cols-3 gap-2">
                                                <div>
                                                    <label className="text-[10px] text-gray-400 font-bold uppercase">Menge</label>
                                                    <input 
                                                        type="number" 
                                                        className="w-full bg-white border border-gray-200 rounded p-2 text-sm outline-none"
                                                        value={item.quantity}
                                                        onChange={e => handleItemChange(idx, 'quantity', Number(e.target.value))}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-[10px] text-gray-400 font-bold uppercase">Preis (€)</label>
                                                    <input 
                                                        type="number" 
                                                        className="w-full bg-white border border-gray-200 rounded p-2 text-sm outline-none"
                                                        value={item.price}
                                                        onChange={e => handleItemChange(idx, 'price', Number(e.target.value))}
                                                    />
                                                </div>
                                                <div className="text-right">
                                                    <label className="text-[10px] text-gray-400 font-bold uppercase">Gesamt</label>
                                                    <p className="text-sm font-bold pt-2">{formatCurrency(item.total)}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex justify-between items-center pt-4 border-t border-gray-100">
                                    <span className="font-bold">Gesamtsumme (Netto)</span>
                                    <span className="font-mono font-bold text-xl">
                                        {formatCurrency((formData.items || []).reduce((acc, i) => acc + i.total, 0))}
                                    </span>
                                </div>
                            </section>
                        </div>

                        <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-end gap-3">
                            <button onClick={() => setIsEditModalOpen(false)} className="px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-200 transition-colors">Abbrechen</button>
                            <button 
                                onClick={handleSave}
                                disabled={!formData.name}
                                className="px-6 py-3 rounded-xl font-bold bg-accent text-black hover:bg-accent-hover shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                            >
                                <Save size={18} /> Speichern
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
