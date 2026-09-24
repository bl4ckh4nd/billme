import { Button, EMPTY_VALUE, EmptyState, ErrorState, Modal, ValidationSummary, useActionFeedback, IconButton } from '@billme/ui';
import React, { useState } from 'react';
import {
    Repeat, Calendar, Play, Pause, Plus, Trash2,
    Edit3, X, Clock,
    Save, Calculator
} from 'lucide-react';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import type { RecurringProfile, RecurrenceInterval, InvoiceItem } from '@billme/desktop-core/types';
import { v4 as uuidv4 } from 'uuid';
import { useClientsQuery } from '../hooks/useClients';
import {
  useDeleteRecurringProfileMutation,
  useRecurringProfilesQuery,
  useUpsertRecurringProfileMutation,
} from '../hooks/useRecurring';
import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { useQueryClient } from '@tanstack/react-query';
import { ipc } from '../runtime-api';

type RecurringValidationError = {
    message: string;
    targetId: string;
};

const isBillableItem = (item: InvoiceItem): boolean =>
    item.kind === undefined || item.kind === 'item' || item.kind === 'time';

const itemTotal = (item: InvoiceItem): number => {
    const total = Number(item.total);
    return Number.isFinite(total) ? total : 0;
};

const recurringTotal = (items: readonly InvoiceItem[]): number =>
    items.filter(isBillableItem).reduce((sum, item) => sum + itemTotal(item), 0);

const germanSaveError = 'Abo konnte nicht gespeichert werden. Bitte prüfe die Angaben und versuche es erneut.';

const INTERVAL_INITIALS: Record<RecurringProfile['interval'], string> = {
  daily: 'T',
  weekly: 'W',
  monthly: 'M',
  quarterly: 'Q',
  yearly: 'J',
};

const fieldClass = 'w-full rounded-xl border border-control-border bg-surface-muted p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const itemFieldClass = 'w-full rounded-sm border border-control-border bg-surface p-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export const RecurringView: React.FC = () => {
    const profilesQuery = useRecurringProfilesQuery();
    const clientsQuery = useClientsQuery();
    const profiles = profilesQuery.data ?? [];
    const clients = clientsQuery.data ?? [];
    const listIsLoading = profilesQuery.isLoading || clientsQuery.isLoading;
    const listIsError = profilesQuery.isError || clientsQuery.isError;
    const retryList = () => {
        void profilesQuery.refetch();
        void clientsQuery.refetch();
    };
    const upsertProfile = useUpsertRecurringProfileMutation();
    const deleteProfile = useDeleteRecurringProfileMutation();
    const { pendingIds, leavingIds, requestDelete } = useDeferredDelete({
        scope: 'recurring',
        commit: (id) => deleteProfile.mutateAsync(id),
        label: (count) => count === 1 ? 'Abo gelöscht' : `${count} Abos gelöscht`,
    });
    const queryClient = useQueryClient();
    const { notify } = useActionFeedback('recurring');
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingProfile, setEditingProfile] = useState<RecurringProfile | null>(null);
    const [runningNowId, setRunningNowId] = useState<string | null>(null);
    const [validationErrors, setValidationErrors] = useState<Record<string, RecurringValidationError>>({});
    const [saveError, setSaveError] = useState<string | null>(null);
    const editorId = React.useId();
    const editorTitleId = React.useId();

    // Form State
    const [formData, setFormData] = useState<Partial<RecurringProfile>>({});

    const formatCurrency = (amount: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
    const formatDate = (dateString: string) => new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const inputId = (field: string) => `${editorId}-${field}`;
    const fieldErrorId = (field: string) => `${inputId(field)}-error`;
    const itemFieldId = (index: number, field: 'description' | 'quantity' | 'price') => inputId(`item-${index}-${field}`);
    const itemDescriptionId = (index: number) => itemFieldId(index, 'description');

    const focusValidationError = (error: RecurringValidationError | undefined) => {
        if (!error) return;
        const target = document.getElementById(error.targetId);
        if (target instanceof HTMLElement) {
            target.focus();
            target.scrollIntoView?.({ block: 'center' });
        }
    };

    React.useEffect(() => {
        if (!isEditModalOpen) return;
        const firstError = validationErrors.items ?? Object.values(validationErrors)[0];
        focusValidationError(firstError);
    }, [isEditModalOpen, validationErrors]);

    const getClientName = (id: string) => clients.find(c => c.id === id)?.company || 'Unbekannt';

    const handleEdit = (profile?: RecurringProfile) => {
        setValidationErrors({});
        setSaveError(null);
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
        requestDelete([id]);
    };

    const handleToggleActive = async (id: string) => {
        const profile = profiles.find(p => p.id === id);
        if (!profile) return;
        const nextState = !profile.active ? 'aktiviert' : 'pausiert';
        try {
            await upsertProfile.mutateAsync({ ...profile, active: !profile.active });
        } catch {
            notify('error', `Abo konnte nicht ${nextState} werden.`);
        }
    };

    const handleSave = async () => {
        const errors: Record<string, RecurringValidationError> = {};
        const name = formData.name?.trim() ?? '';
        const clientId = formData.clientId?.trim() ?? '';
        const items = formData.items ?? [];
        const billableItems = items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => isBillableItem(item));
        const validBillableItems = billableItems.filter(({ item }) =>
            item.description.trim().length > 0 &&
            Number.isFinite(item.quantity) && item.quantity > 0 &&
            itemTotal(item) > 0,
        );
        const total = recurringTotal(items);

        if (!name) {
            errors.name = { message: 'Eine Bezeichnung ist erforderlich.', targetId: inputId('name') };
        }
        if (!clientId) {
            errors.clientId = { message: 'Bitte wähle einen Kunden aus.', targetId: inputId('clientId') };
        }

        if (validBillableItems.length === 0 || validBillableItems.length !== billableItems.length || total <= 0) {
            const firstItem = billableItems[0];
            const firstInvalidItem = billableItems.find(({ item }) =>
                item.description.trim().length === 0 ||
                !Number.isFinite(item.quantity) || item.quantity <= 0 ||
                itemTotal(item) <= 0,
            );
            const targetItem = firstInvalidItem ?? firstItem;
            let message = 'Mindestens eine abrechenbare Position mit Beschreibung, Menge und einem Gesamtbetrag größer als 0 ist erforderlich.';
            if (billableItems.length > 0 && !billableItems.some(({ item }) => item.description.trim().length > 0)) {
                message = 'Die abrechenbare Position benötigt eine Beschreibung.';
            } else if (billableItems.length > 0 && !billableItems.some(({ item }) => Number.isFinite(item.quantity) && item.quantity > 0)) {
                message = 'Die Menge der abrechenbaren Position muss größer als 0 sein.';
            } else if (billableItems.length > 0 && !billableItems.some(({ item }) => itemTotal(item) > 0)) {
                message = 'Die Gesamtsumme der abrechenbaren Positionen muss größer als 0 sein.';
            }
            const targetId = targetItem
                ? !targetItem.item.description.trim()
                    ? itemFieldId(targetItem.index, 'description')
                    : !(Number.isFinite(targetItem.item.quantity) && targetItem.item.quantity > 0)
                        ? itemFieldId(targetItem.index, 'quantity')
                        : itemFieldId(targetItem.index, 'price')
                : inputId('add-item');
            errors.items = {
                message,
                targetId,
            };
        }

        setValidationErrors(errors);
        if (Object.keys(errors).length > 0) return;

        const finalData = {
            ...formData,
            name,
            clientId,
            amount: total,
        } as RecurringProfile;

        setSaveError(null);
        try {
            await upsertProfile.mutateAsync(finalData);
            setIsEditModalOpen(false);
        } catch {
            setSaveError(germanSaveError);
            notify('error', germanSaveError);
        }
    };

    // Item Management inside Modal
    const updateItem = (index: number, patch: Partial<InvoiceItem>) => {
        if (!formData.items) return;
        const newItems = formData.items.map((item, itemIndex) => {
            if (itemIndex !== index) return item;
            const next = { ...item, ...patch };
            if (patch.quantity !== undefined || patch.price !== undefined) {
                next.total = next.price * next.quantity;
            }
            return next;
        });
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
                const skippedProfiles = result.result.errors.length;
                notify(
                    skippedProfiles > 0 ? 'info' : 'success',
                    `${result.result.generated} erstellt, ${skippedProfiles} ${skippedProfiles === 1 ? 'Profil' : 'Profile'} übersprungen`,
                );

                // Refresh profile list
                void queryClient.invalidateQueries({ queryKey: ['recurringProfiles'] });
            } else {
                notify('error', 'Abo-Lauf konnte nicht abgeschlossen werden.');
            }
        } catch {
            notify('error', 'Abo-Lauf konnte nicht abgeschlossen werden.');
        } finally {
            setRunningNowId(null);
        }
    };

    const visibleProfiles = profiles.filter((profile) => !pendingIds.has(profile.id) || leavingIds.has(profile.id));

    return (
        <div className="min-h-full rounded-panel bg-surface p-6 lg:p-8 shadow-xs flex flex-col relative">
            <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="flex flex-wrap items-center gap-3 text-title text-foreground">
                        <Repeat className="text-foreground" />
                        Abo-Rechnungen
                    </h1>
                    <p className="text-muted font-medium text-sm mt-1">
                        Wiederkehrende Rechnungen automatisch erstellen
                    </p>
                </div>
                <Button onClick={() => handleEdit()}>
                    <Plus size={16} /> Neues Abo
                </Button>
            </div>

            {listIsError ? (
                <ErrorState
                    title="Abos konnten nicht geladen werden"
                    description="Die Liste der wiederkehrenden Rechnungen und die Kundenzuordnung sind ohne Datenbank nicht lesbar."
                    onRetry={retryList}
                />
            ) : listIsLoading ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-muted">
                    <Spinner size="md" />
                    <p role="status" className="text-sm font-medium">Abos werden geladen …</p>
                </div>
            ) : visibleProfiles.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-8">
                    <EmptyState
                        title="Keine wiederkehrenden Rechnungen eingerichtet"
                        description="Ein Abo erstellt Rechnungen automatisch in einem festen Intervall, zum Beispiel monatlich für einen Wartungsvertrag. Lege es über 'Neues Abo' an."
                        className="max-w-lg"
                    />
                </div>
            ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 overflow-y-auto p-0.5 pb-4">
                {visibleProfiles.map((profile) => (
                    <div
                        key={profile.id}
                        data-leaving={leavingIds.has(profile.id) || undefined}
                        className={`group relative rounded-card p-5 transition-shadow ${profile.active ? 'bg-surface shadow-xs hover:shadow-md' : 'bg-surface-muted'}`}
                    >
                        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div className="flex min-w-0 flex-1 items-center gap-4">
                                <span aria-hidden="true" className={`flex size-9 shrink-0 items-center justify-center rounded-control text-label ${profile.active ? 'bg-accent-100 text-accent-800' : 'bg-surface-sunken text-muted'}`}>
                                    {INTERVAL_INITIALS[profile.interval]}
                                </span>
                                <div className="min-w-0">
                                    <h3 className="break-words text-section text-foreground">{profile.name}</h3>
                                    <p className="text-sm text-muted">{getClientName(profile.clientId)}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleToggleActive(profile.id)}
                                    aria-pressed={profile.active}
                                    className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${profile.active ? 'border-success-text bg-success-bg text-success-text' : 'border-ink-500 bg-surface text-ink-700'}`}
                                >
                                    {profile.active ? <Play size={12} fill="currentColor" aria-hidden="true" /> : <Pause size={12} fill="currentColor" aria-hidden="true" />}
                                    {profile.active ? 'Aktiv' : 'Pausiert'}
                                </button>
                                <div className="ui-reveal flex gap-0.5">
                                    <IconButton size="sm" tooltip="Bearbeiten" onClick={() => handleEdit(profile)} aria-label={`Abo ${profile.name} bearbeiten`}>
                                        <Edit3 size={14} aria-hidden="true" />
                                    </IconButton>
                                    <IconButton size="sm" tooltip="Löschen" onClick={() => handleDelete(profile.id)} aria-label={`Abo ${profile.name} löschen`} className="hover:bg-error-bg hover:text-error-text">
                                        <Trash2 size={14} aria-hidden="true" />
                                    </IconButton>
                                </div>
                            </div>
                        </div>

                        <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
                            <div>
                                <dt className="text-caption text-muted">Intervall</dt>
                                <dd className="mt-0.5 text-sm font-medium">
                                    {profile.interval === 'weekly' && 'Wöchentlich'}
                                    {profile.interval === 'monthly' && 'Monatlich'}
                                    {profile.interval === 'quarterly' && 'Quartalsweise'}
                                    {profile.interval === 'yearly' && 'Jährlich'}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-caption text-muted">Nächste Ausführung</dt>
                                <dd className="mt-0.5 text-sm font-medium tabular-nums">{formatDate(profile.nextRun)}</dd>
                            </div>
                            <div className="sm:text-right">
                                <dt className="text-caption text-muted">Betrag</dt>
                                <dd className="mt-0.5 text-lg font-semibold tabular-nums">{formatCurrency(profile.amount)}</dd>
                            </div>
                        </dl>

                        <div className="flex items-center justify-between pt-4 border-t border-border-subtle">
                             <p className="text-caption text-muted">
                                 Zuletzt: <span className="tabular-nums">{profile.lastRun ? formatDate(profile.lastRun) : EMPTY_VALUE}</span>
                             </p>
                             <button
                                type="button"
                                onClick={() => handleRunNow(profile.id)}
                                disabled={runningNowId !== null}
                                className="h-8 rounded-control px-3 text-label text-foreground transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                             >
                                 {runningNowId === profile.id ? 'Generiere …' : 'Jetzt ausführen'}
                             </button>
                        </div>
                    </div>
                ))}
            </div>
            )}

            <Modal
                open={isEditModalOpen}
                onClose={() => setIsEditModalOpen(false)}
                titleId={editorTitleId}
                className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden"
            >
                    <div className="p-8 border-b border-border-subtle flex justify-between items-center bg-surface-muted">
                        <div>
                            <h2 id={editorTitleId} className="text-xl font-semibold text-foreground">{editingProfile ? 'Abo bearbeiten' : 'Neues Abo'}</h2>
                            <p className="text-xs text-muted">{editingProfile?.name || 'Entwurf'}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setIsEditModalOpen(false)}
                            aria-label="Abo-Dialog schließen"
                            className="p-2 rounded-full text-muted transition-colors hover:bg-border-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                            <X size={20} aria-hidden="true" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-8 space-y-8">
                        <ValidationSummary
                            errors={Object.entries(validationErrors)
                                .filter(([field]) => field === 'name' || field === 'clientId')
                                .map(([field, error]) => ({ id: error.targetId, message: error.message }))}
                            onJump={(id) => {
                                const target = document.getElementById(id);
                                if (target instanceof HTMLElement) target.focus();
                            }}
                        />

                        {/* General Settings */}
                        <section className="space-y-4">
                            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted flex items-center gap-2">
                                <Repeat size={14} aria-hidden="true" /> Einstellungen
                            </h3>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="col-span-2">
                                    <label htmlFor={inputId('name')} className="block text-xs font-semibold text-muted mb-1">Interne Bezeichnung</label>
                                    <input
                                        id={inputId('name')}
                                        type="text"
                                        className={fieldClass}
                                        value={formData.name || ''}
                                        onChange={e => setFormData({ ...formData, name: e.target.value })}
                                        placeholder="z.B. Wartungsvertrag 2024"
                                        required
                                        aria-required="true"
                                        aria-invalid={validationErrors.name ? 'true' : undefined}
                                        aria-describedby={validationErrors.name ? fieldErrorId('name') : undefined}
                                    />
                                    {validationErrors.name && <p id={fieldErrorId('name')} className="mt-1 text-xs font-medium text-error-text">{validationErrors.name.message}</p>}
                                </div>
                                <div>
                                    <label htmlFor={inputId('clientId')} className="block text-xs font-semibold text-muted mb-1">Kunde</label>
                                    <select
                                        id={inputId('clientId')}
                                        className={fieldClass}
                                        value={formData.clientId}
                                        onChange={e => setFormData({ ...formData, clientId: e.target.value })}
                                        required
                                        aria-required="true"
                                        aria-invalid={validationErrors.clientId ? 'true' : undefined}
                                        aria-describedby={validationErrors.clientId ? fieldErrorId('clientId') : undefined}
                                    >
                                        {clients.map(c => (
                                            <option key={c.id} value={c.id}>{c.company}</option>
                                        ))}
                                    </select>
                                    {validationErrors.clientId && <p id={fieldErrorId('clientId')} className="mt-1 text-xs font-medium text-error-text">{validationErrors.clientId.message}</p>}
                                </div>
                                <div>
                                    <label htmlFor={inputId('interval')} className="block text-xs font-semibold text-muted mb-1">Intervall</label>
                                    <select
                                        id={inputId('interval')}
                                        className={fieldClass}
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
                                    <label htmlFor={inputId('nextRun')} className="block text-xs font-semibold text-muted mb-1">Start / Nächste Ausführung</label>
                                    <input
                                        id={inputId('nextRun')}
                                        type="date"
                                        className={fieldClass}
                                        value={formData.nextRun}
                                        onChange={e => setFormData({ ...formData, nextRun: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label htmlFor={inputId('endDate')} className="block text-xs font-semibold text-muted mb-1">Endet am (optional)</label>
                                    <input
                                        id={inputId('endDate')}
                                        type="date"
                                        className={fieldClass}
                                        value={formData.endDate || ''}
                                        onChange={e => setFormData({ ...formData, endDate: e.target.value })}
                                    />
                                </div>
                            </div>
                        </section>

                        <hr className="border-border-subtle" />

                        {/* Items Editor */}
                        <section className="space-y-4">
                            <div className="flex justify-between items-center">
                                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted flex items-center gap-2">
                                    <Calculator size={14} aria-hidden="true" /> Rechnungspositionen
                                </h3>
                                <button
                                    type="button"
                                    id={inputId('add-item')}
                                    onClick={addItem}
                                    className="text-xs font-semibold bg-dark-base text-accent px-2 py-1 rounded-sm transition-colors hover:bg-dark-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
                                >
                                    + Position
                                </button>
                            </div>

                            {validationErrors.items && (
                                <div
                                    id={fieldErrorId('items')}
                                    className="rounded-lg border border-error-border bg-error-bg p-3 text-sm font-medium text-error-text"
                                    role="alert"
                                    aria-live="assertive"
                                    aria-atomic="true"
                                >
                                    {validationErrors.items.message}
                                </div>
                            )}

                            <div className="space-y-3">
                                {formData.items?.map((item, idx) => (
                                    <div key={idx} className="bg-surface-muted rounded-xl p-3 border border-border-subtle">
                                        <div className="flex gap-2 mb-2">
                                            <input
                                                id={itemDescriptionId(idx)}
                                                type="text"
                                                placeholder="Beschreibung"
                                                aria-label="Beschreibung"
                                                className="px-2.5 h-8 hover:border-ink-500 flex-1 rounded-sm border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                                value={item.description}
                                                onChange={e => updateItem(idx, { description: e.target.value })}
                                                aria-invalid={validationErrors.items?.targetId === itemDescriptionId(idx) ? 'true' : undefined}
                                                aria-describedby={validationErrors.items?.targetId === itemDescriptionId(idx) ? fieldErrorId('items') : undefined}
                                            />
                                            <button
                                                type="button"
                                                aria-label="Position entfernen"
                                                onClick={() => removeItem(idx)}
                                                className="p-2 rounded-sm text-muted transition-colors hover:text-error-text hover:bg-error-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                            >
                                                <Trash2 size={16} aria-hidden="true" />
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-3 gap-2">
                                            <div>
                                                <label htmlFor={itemFieldId(idx, 'quantity')} className="text-label text-foreground">Menge</label>
                                                <input
                                                    id={itemFieldId(idx, 'quantity')}
                                                    type="number"
                                                    className={itemFieldClass}
                                                    value={item.quantity}
                                                    onChange={e => updateItem(idx, { quantity: Number(e.target.value) })}
                                                    aria-invalid={validationErrors.items?.targetId === itemFieldId(idx, 'quantity') ? 'true' : undefined}
                                                    aria-describedby={validationErrors.items?.targetId === itemFieldId(idx, 'quantity') ? fieldErrorId('items') : undefined}
                                                />
                                            </div>
                                            <div>
                                                <label htmlFor={itemFieldId(idx, 'price')} className="text-label text-foreground">Preis (€)</label>
                                                <input
                                                    id={itemFieldId(idx, 'price')}
                                                    type="number"
                                                    className={itemFieldClass}
                                                    value={item.price}
                                                    onChange={e => updateItem(idx, { price: Number(e.target.value) })}
                                                    aria-invalid={validationErrors.items?.targetId === itemFieldId(idx, 'price') ? 'true' : undefined}
                                                    aria-describedby={validationErrors.items?.targetId === itemFieldId(idx, 'price') ? fieldErrorId('items') : undefined}
                                                />
                                            </div>
                                            <div className="text-right">
                                                <label className="text-label text-foreground">Gesamt</label>
                                                <p className="text-sm font-semibold pt-2 tabular-nums">{formatCurrency(item.total)}</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="flex justify-between items-center pt-4 border-t border-border-subtle">
                                <span className="font-semibold">Gesamtsumme (Netto)</span>
                                <span className="font-semibold text-xl tabular-nums">
                                    {formatCurrency(recurringTotal(formData.items || []))}
                                </span>
                            </div>
                        </section>
                    </div>

                    <div className="p-6 border-t border-border-subtle bg-surface-muted">
                        {saveError && (
                            <div className="mb-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm font-medium text-error-text" role="alert" aria-live="assertive">
                                {saveError}
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                        <Button variant="ghost" onClick={() => setIsEditModalOpen(false)}>Abbrechen</Button>
                        <Button onClick={handleSave} loading={upsertProfile.isPending}>
                            <Save size={16} /> Speichern
                        </Button>
                        </div>
                    </div>
            </Modal>
        </div>
    );
};
