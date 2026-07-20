import React from 'react';
import { Trash2, Check } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { ClientEmail } from '../../types';
import { emailKindLabel, setOnlyOneFlag } from './helpers';

interface EmailSubEditorProps {
    emails: ClientEmail[];
    draftId: string;
    onChange: (emails: ClientEmail[]) => void;
}

export const EmailSubEditor: React.FC<EmailSubEditorProps> = ({ emails, draftId, onChange }) => (
    <section className="space-y-3">
        <div className="flex items-center justify-between">
            <div>
                <h4 className="font-bold text-sm">E-Mails</h4>
                <p className="text-[11px] text-muted mt-0.5">
                    Kategorie = Zweck. Standard = wird automatisch vorausgewählt.
                </p>
            </div>
            <button
                onClick={() =>
                    onChange([
                        ...emails,
                        {
                            id: uuidv4(),
                            clientId: draftId,
                            label: 'Neu',
                            kind: 'general',
                            email: '',
                        } as ClientEmail,
                    ])
                }
                className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-dark-1 transition-colors ease-out duration-150"
            >
                + E-Mail
            </button>
        </div>

        {emails.map((em, idx) => (
            <div
                key={em.id}
                className="p-4 rounded-xl border border-border bg-surface-muted space-y-3"
            >
                <div className="grid grid-cols-12 gap-3 items-end">
                    <div className="col-span-3">
                        <label className="block text-[10px] font-bold text-muted mb-1">Bezeichnung</label>
                        <input
                            value={em.label}
                            onChange={(e) => {
                                const next = [...emails];
                                next[idx] = { ...em, label: e.target.value };
                                onChange(next);
                            }}
                            className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>
                    <div className="col-span-2">
                        <label className="block text-[10px] font-bold text-muted mb-1">Kategorie</label>
                        <select
                            value={em.kind}
                            onChange={(e) => {
                                const next = [...emails];
                                next[idx] = { ...em, kind: e.target.value as ClientEmail['kind'] };
                                onChange(next);
                            }}
                            className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        >
                            <option value="general">{emailKindLabel.general}</option>
                            <option value="billing">{emailKindLabel.billing}</option>
                            <option value="shipping">{emailKindLabel.shipping}</option>
                            <option value="other">{emailKindLabel.other}</option>
                        </select>
                    </div>
                    <div className="col-span-5">
                        <label className="block text-[10px] font-bold text-muted mb-1">E-Mail-Adresse</label>
                        <input
                            value={em.email}
                            onChange={(e) => {
                                const next = [...emails];
                                next[idx] = { ...em, email: e.target.value };
                                onChange(next);
                            }}
                            className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-muted uppercase tracking-wider">Standard</span>
                        <button
                            onClick={() => {
                                const next = setOnlyOneFlag(emails as (ClientEmail & { id: string })[], em.id, 'isDefaultBilling') as ClientEmail[];
                                onChange(next);
                            }}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                                em.isDefaultBilling ? 'bg-black text-white border-black' : 'bg-surface text-foreground border-border hover:bg-surface-muted'
                            }`}
                        >
                            {em.isDefaultBilling && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                            Rechnung
                        </button>
                        <button
                            onClick={() => {
                                const next = setOnlyOneFlag(emails as (ClientEmail & { id: string })[], em.id, 'isDefaultGeneral') as ClientEmail[];
                                onChange(next);
                            }}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                                em.isDefaultGeneral ? 'bg-black text-white border-black' : 'bg-surface text-foreground border-border hover:bg-surface-muted'
                            }`}
                        >
                            {em.isDefaultGeneral && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                            Allgemein
                        </button>
                    </div>
                    <button
                        onClick={() => {
                            const next = emails.filter((e) => e.id !== em.id);
                            onChange(next);
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
);
