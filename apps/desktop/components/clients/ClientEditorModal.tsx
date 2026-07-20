import React from 'react';
import { X } from 'lucide-react';
import type { Client } from '../../types';
import { EmailSubEditor } from './EmailSubEditor';
import { AddressSubEditor } from './AddressSubEditor';

interface ClientEditorModalProps {
    draft: Client;
    onDraftChange: (client: Client) => void;
    editorErrors: string[];
    isExistingClient: boolean;
    onClose: () => void;
    onSave: () => Promise<void>;
}

export const ClientEditorModal: React.FC<ClientEditorModalProps> = ({
    draft,
    onDraftChange,
    editorErrors,
    isExistingClient,
    onClose,
    onSave,
}) => (
    <div className="flex flex-col flex-1 min-h-0">
        <div className="p-6 border-b border-border flex items-center justify-between">
            <div>
                <h3 className="text-2xl font-bold">
                    {isExistingClient ? 'Kunde bearbeiten' : 'Neuer Kunde'}
                </h3>
                <p className="text-xs text-muted mt-1">{draft.id}</p>
            </div>
            <button
                onClick={onClose}
                className="w-10 h-10 rounded-full hover:bg-canvas flex items-center justify-center transition-colors ease-out duration-150"
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
                        <label className="block text-xs font-bold text-muted mb-1">Kundennummer</label>
                        <input
                            value={draft.customerNumber ?? ''}
                            onChange={(e) => onDraftChange({ ...draft, customerNumber: e.target.value })}
                            placeholder="Automatisch bei leerem Feld"
                            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-mono outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>
                    <div className="col-span-2">
                        <label className="block text-xs font-bold text-muted mb-1">Firma</label>
                        <input
                            value={draft.company}
                            onChange={(e) => onDraftChange({ ...draft, company: e.target.value })}
                            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-muted mb-1">Ansprechpartner</label>
                        <input
                            value={draft.contactPerson}
                            onChange={(e) => onDraftChange({ ...draft, contactPerson: e.target.value })}
                            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-muted mb-1">Telefon</label>
                        <input
                            value={draft.phone}
                            onChange={(e) => onDraftChange({ ...draft, phone: e.target.value })}
                            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-muted mb-1">Status</label>
                        <select
                            value={draft.status}
                            onChange={(e) => onDraftChange({ ...draft, status: e.target.value as Client['status'] })}
                            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        >
                            <option value="active">Aktiv</option>
                            <option value="inactive">Inaktiv</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-muted mb-1">Tags (Komma)</label>
                        <input
                            value={(draft.tags ?? []).join(', ')}
                            onChange={(e) =>
                                onDraftChange({
                                    ...draft,
                                    tags: e.target.value
                                        .split(',')
                                        .map((t) => t.trim())
                                        .filter(Boolean),
                                })
                            }
                            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>
                    <div className="col-span-2">
                        <label className="block text-xs font-bold text-muted mb-1">Notizen</label>
                        <textarea
                            value={draft.notes ?? ''}
                            onChange={(e) => onDraftChange({ ...draft, notes: e.target.value })}
                            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow"
                            rows={3}
                        />
                    </div>
                </div>
            </section>

            <EmailSubEditor
                emails={draft.emails ?? []}
                draftId={draft.id}
                onChange={(emails) => onDraftChange({ ...draft, emails })}
            />

            <AddressSubEditor
                addresses={draft.addresses ?? []}
                draftId={draft.id}
                onChange={(addresses) => onDraftChange({ ...draft, addresses })}
            />
        </div>

        <div className="p-6 border-t border-border bg-surface-muted rounded-b-2xl">
            <div className="flex justify-end gap-3">
                <button
                    onClick={onClose}
                    className="px-4 py-2 bg-surface border border-border text-black rounded-full text-xs font-bold hover:bg-surface-muted transition-colors"
                >
                    Abbrechen
                </button>
                <button
                    onClick={() => void onSave()}
                    className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-dark-1 transition-colors ease-out duration-150"
                >
                    Speichern
                </button>
            </div>
        </div>
    </div>
);
