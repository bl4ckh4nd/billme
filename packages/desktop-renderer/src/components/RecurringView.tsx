import { Button, Card, EMPTY_VALUE, EmptyState, ErrorState, IconButton, IconTile, Input, Modal, PageHeader, Select, ValidationSummary, useActionFeedback } from '@billme/ui';
import React, { useState } from 'react';
import { Play, Pause, Plus, Trash2, Edit3, X, Save } from 'lucide-react';
import { Spinner } from '../ui/components/Spinner';
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
import { localIsoDate } from '@billme/desktop-utils';

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
                nextRun: localIsoDate(),
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
        <div className="flex min-h-full flex-col">
            <PageHeader
                title="Wiederkehrend"
                description="Wiederkehrende Rechnungen automatisch erstellen"
                actions={
                    <Button onClick={() => handleEdit()}>
                        <Plus size={16} aria-hidden="true" /> Neues Abo
                    </Button>
                }
            />

            {listIsError ? (
                <Card padding="none">
                    <ErrorState
                        title="Abos konnten nicht geladen werden"
                        description="Die Liste der wiederkehrenden Rechnungen und die Kundenzuordnung sind ohne Datenbank nicht lesbar."
                        onRetry={retryList}
                    />
                </Card>
            ) : listIsLoading ? (
                <Card className="flex flex-col items-center justify-center gap-3 py-10 text-muted">
                    <Spinner size="md" />
                    <p role="status" className="text-control font-medium">Abos werden geladen …</p>
                </Card>
            ) : visibleProfiles.length === 0 ? (
                <Card padding="none">
                    <EmptyState
                        title="Keine wiederkehrenden Rechnungen eingerichtet"
                        description="Ein Abo erstellt Rechnungen automatisch in einem festen Intervall, zum Beispiel monatlich für einen Wartungsvertrag. Lege es über 'Neues Abo' an."
                    />
                </Card>
            ) : (
            <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-2">
                {visibleProfiles.map((profile) => (
                    <div
                        key={profile.id}
                        data-leaving={leavingIds.has(profile.id) || undefined}
                        className={`group relative rounded-card border border-border p-3.5 ${profile.active ? 'bg-surface' : 'bg-surface-muted'}`}
                    >
                        <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div className="flex min-w-0 flex-1 items-center gap-3.25">
                                <IconTile
                                    tone={profile.active ? 'success' : 'neutral'}
                                    icon={<span className="text-label">{INTERVAL_INITIALS[profile.interval]}</span>}
                                />
                                <div className="min-w-0">
                                    <h2 className="break-words text-section text-foreground">{profile.name}</h2>
                                    <p className="text-caption text-muted">{getClientName(profile.clientId)}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => handleToggleActive(profile.id)}
                                    aria-pressed={profile.active}
                                    className={profile.active ? 'border-success-border bg-success-bg text-success-text' : 'text-muted'}
                                >
                                    {profile.active ? <Play size={12} fill="currentColor" aria-hidden="true" /> : <Pause size={12} fill="currentColor" aria-hidden="true" />}
                                    {profile.active ? 'Aktiv' : 'Pausiert'}
                                </Button>
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

                        <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                            <div>
                                <dt className="text-caption text-muted">Intervall</dt>
                                <dd className="mt-0.5 text-control font-medium">
                                    {profile.interval === 'weekly' && 'Wöchentlich'}
                                    {profile.interval === 'monthly' && 'Monatlich'}
                                    {profile.interval === 'quarterly' && 'Quartalsweise'}
                                    {profile.interval === 'yearly' && 'Jährlich'}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-caption text-muted">Nächste Ausführung</dt>
                                <dd className="mt-0.5 text-control font-medium tabular-nums">{formatDate(profile.nextRun)}</dd>
                            </div>
                            <div className="sm:text-right">
                                <dt className="text-caption text-muted">Betrag</dt>
                                <dd className="mt-0.5 text-section font-bold tabular-nums">{formatCurrency(profile.amount)}</dd>
                            </div>
                        </dl>

                        <div className="flex items-center justify-between border-t border-border pt-2.5">
                             <p className="text-caption text-muted">
                                 Zuletzt: <span className="tabular-nums">{profile.lastRun ? formatDate(profile.lastRun) : EMPTY_VALUE}</span>
                             </p>
                             <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRunNow(profile.id)}
                                disabled={runningNowId !== null}
                             >
                                 {runningNowId === profile.id ? 'Generiere …' : 'Jetzt ausführen'}
                             </Button>
                        </div>
                    </div>
                ))}
            </div>
            )}

            <Modal
                open={isEditModalOpen}
                onClose={() => setIsEditModalOpen(false)}
                titleId={editorTitleId}
                className="flex max-h-[84vh] flex-col overflow-hidden"
            >
                    <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
                        <div className="min-w-0 flex-1">
                            <h2 id={editorTitleId} className="text-title text-foreground">{editingProfile ? 'Abo bearbeiten' : 'Neues Abo'}</h2>
                            <p className="text-caption text-muted">{editingProfile?.name || 'Entwurf'}</p>
                        </div>
                        <IconButton aria-label="Abo-Dialog schließen" tooltip={false} onClick={() => setIsEditModalOpen(false)}>
                            <X size={16} aria-hidden="true" />
                        </IconButton>
                    </div>

                    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4.5 pt-1 pb-4">
                        <ValidationSummary
                            className="mb-0"
                            errors={Object.entries(validationErrors)
                                .filter(([field]) => field === 'name' || field === 'clientId')
                                .map(([field, error]) => ({ id: error.targetId, message: error.message }))}
                            onJump={(id) => {
                                const target = document.getElementById(id);
                                if (target instanceof HTMLElement) target.focus();
                            }}
                        />

                        <h3 className="text-eyebrow uppercase text-muted">Einstellungen</h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="col-span-2">
                                <Input
                                    id={inputId('name')}
                                    label="Interne Bezeichnung"
                                    type="text"
                                    fullWidth
                                    value={formData.name || ''}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    placeholder="z.B. Wartungsvertrag 2024"
                                    required
                                    error={validationErrors.name?.message}
                                />
                            </div>
                            <Select
                                id={inputId('clientId')}
                                label="Kunde"
                                fullWidth
                                value={formData.clientId}
                                onChange={e => setFormData({ ...formData, clientId: e.target.value })}
                                required
                                error={validationErrors.clientId?.message}
                            >
                                {clients.map(c => (
                                    <option key={c.id} value={c.id}>{c.company}</option>
                                ))}
                            </Select>
                            <Select
                                id={inputId('interval')}
                                label="Intervall"
                                fullWidth
                                value={formData.interval}
                                onChange={e => setFormData({ ...formData, interval: e.target.value as RecurrenceInterval })}
                            >
                                <option value="weekly">Wöchentlich</option>
                                <option value="monthly">Monatlich</option>
                                <option value="quarterly">Quartalsweise</option>
                                <option value="yearly">Jährlich</option>
                            </Select>
                            <Input
                                id={inputId('nextRun')}
                                label="Start / Nächste Ausführung"
                                type="date"
                                fullWidth
                                value={formData.nextRun}
                                onChange={e => setFormData({ ...formData, nextRun: e.target.value })}
                            />
                            <Input
                                id={inputId('endDate')}
                                label="Endet am (optional)"
                                type="date"
                                fullWidth
                                value={formData.endDate || ''}
                                onChange={e => setFormData({ ...formData, endDate: e.target.value })}
                            />
                        </div>

                        <div className="mt-1 flex items-center justify-between border-t border-border pt-3">
                            <h3 className="text-eyebrow uppercase text-muted">Rechnungspositionen</h3>
                            <Button variant="secondary" size="sm" id={inputId('add-item')} onClick={addItem}>
                                + Position
                            </Button>
                        </div>

                        {validationErrors.items && (
                            <div
                                id={fieldErrorId('items')}
                                className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control font-medium text-error-text"
                                role="alert"
                                aria-live="assertive"
                                aria-atomic="true"
                            >
                                {validationErrors.items.message}
                            </div>
                        )}

                        {formData.items?.map((item, idx) => (
                            <div key={idx} className="flex flex-col gap-2 rounded-card border border-border bg-surface-muted p-3">
                                <div className="flex gap-2">
                                    <Input
                                        id={itemDescriptionId(idx)}
                                        type="text"
                                        placeholder="Beschreibung"
                                        aria-label="Beschreibung"
                                        fullWidth
                                        value={item.description}
                                        onChange={e => updateItem(idx, { description: e.target.value })}
                                        aria-invalid={validationErrors.items?.targetId === itemDescriptionId(idx) ? 'true' : undefined}
                                        aria-describedby={validationErrors.items?.targetId === itemDescriptionId(idx) ? fieldErrorId('items') : undefined}
                                    />
                                    <IconButton
                                        aria-label="Position entfernen"
                                        tooltip={false}
                                        onClick={() => removeItem(idx)}
                                        className="hover:bg-error-bg hover:text-error-text"
                                    >
                                        <Trash2 size={16} aria-hidden="true" />
                                    </IconButton>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <Input
                                        id={itemFieldId(idx, 'quantity')}
                                        label="Menge"
                                        type="number"
                                        fullWidth
                                        className="tabular-nums"
                                        value={item.quantity}
                                        onChange={e => updateItem(idx, { quantity: Number(e.target.value) })}
                                        aria-invalid={validationErrors.items?.targetId === itemFieldId(idx, 'quantity') ? 'true' : undefined}
                                        aria-describedby={validationErrors.items?.targetId === itemFieldId(idx, 'quantity') ? fieldErrorId('items') : undefined}
                                    />
                                    <Input
                                        id={itemFieldId(idx, 'price')}
                                        label="Preis (€)"
                                        type="number"
                                        fullWidth
                                        className="tabular-nums"
                                        value={item.price}
                                        onChange={e => updateItem(idx, { price: Number(e.target.value) })}
                                        aria-invalid={validationErrors.items?.targetId === itemFieldId(idx, 'price') ? 'true' : undefined}
                                        aria-describedby={validationErrors.items?.targetId === itemFieldId(idx, 'price') ? fieldErrorId('items') : undefined}
                                    />
                                    <div className="text-right">
                                        <div className="mb-1 text-caption font-medium text-foreground-secondary">Gesamt</div>
                                        <p className="flex min-h-8.5 items-center justify-end text-control font-semibold tabular-nums">{formatCurrency(item.total)}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                        <div className="flex items-center justify-between border-t border-border-strong pt-2.5">
                            <span className="text-control font-semibold">Gesamtsumme (Netto)</span>
                            <span className="text-heading font-bold tabular-nums">
                                {formatCurrency(recurringTotal(formData.items || []))}
                            </span>
                        </div>
                    </div>

                    <div className="border-t border-border px-4.5 py-3">
                        {saveError && (
                            <div className="mb-3 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control font-medium text-error-text" role="alert" aria-live="assertive">
                                {saveError}
                            </div>
                        )}
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button variant="secondary" onClick={() => setIsEditModalOpen(false)}>Abbrechen</Button>
                            <Button onClick={handleSave} loading={upsertProfile.isPending}>
                                <Save size={16} aria-hidden="true" /> Speichern
                            </Button>
                        </div>
                    </div>
            </Modal>
        </div>
    );
};
