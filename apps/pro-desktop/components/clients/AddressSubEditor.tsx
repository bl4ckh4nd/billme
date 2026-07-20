import React from 'react';
import { Trash2, Check } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { ClientAddress } from '../../types';
import { addressKindLabel, setOnlyOneFlag } from './helpers';

interface AddressSubEditorProps {
    addresses: ClientAddress[];
    draftId: string;
    onChange: (addresses: ClientAddress[]) => void;
}

export const AddressSubEditor: React.FC<AddressSubEditorProps> = ({ addresses, draftId, onChange }) => (
    <section className="space-y-3">
        <div className="flex items-center justify-between">
            <div>
                <h4 className="font-bold text-sm">Adressen</h4>
                <p className="text-[11px] text-muted mt-0.5">
                    Kategorie = Zweck. Standard = wird automatisch übernommen.
                </p>
            </div>
            <button
                onClick={() =>
                    onChange([
                        ...addresses,
                        {
                            id: uuidv4(),
                            clientId: draftId,
                            label: 'Neu',
                            kind: 'other',
                            street: '',
                            zip: '',
                            city: '',
                            country: 'DE',
                        } as ClientAddress,
                    ])
                }
                className="px-4 py-2 bg-foreground text-white rounded-full text-xs font-bold hover:bg-dark-1 transition-colors duration-150 ease-out"
            >
                + Adresse
            </button>
        </div>

        {addresses.map((ad, idx) => (
            <div key={ad.id} className="p-4 bg-surface-muted rounded-xl border border-border space-y-3">
                <div className="grid grid-cols-12 gap-3">
                    <div className="col-span-4">
                        <label className="block text-[10px] font-bold text-muted mb-1">Bezeichnung</label>
                        <input
                           value={ad.label}
                           onChange={(e) => {
                               const next = [...addresses];
                               next[idx] = { ...ad, label: e.target.value };
                               onChange(next);
                           }}
                           className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
                        />
                    </div>
                    <div className="col-span-3">
                        <label className="block text-[10px] font-bold text-muted mb-1">Kategorie</label>
                        <select
                            value={ad.kind}
                            onChange={(e) => {
                                const next = [...addresses];
                                next[idx] = { ...ad, kind: e.target.value as ClientAddress['kind'] };
                                onChange(next);
                            }}
                            className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
                        >
                            <option value="billing">{addressKindLabel.billing}</option>
                            <option value="shipping">{addressKindLabel.shipping}</option>
                            <option value="other">{addressKindLabel.other}</option>
                        </select>
                    </div>
                    <div className="col-span-5 flex items-end justify-end gap-2">
                        <button
                            onClick={() => {
                                const next = setOnlyOneFlag(addresses as (ClientAddress & { id: string })[], ad.id, 'isDefaultBilling') as ClientAddress[];
                                onChange(next);
                            }}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors duration-150 ease-out ${
                                ad.isDefaultBilling ? 'bg-foreground text-white border-foreground' : 'bg-surface text-foreground border-border hover:bg-surface-muted'
                            }`}
                        >
                            {ad.isDefaultBilling && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                            Standard Rechnung
                        </button>
                        <button
                            onClick={() => {
                                const next = setOnlyOneFlag(addresses as (ClientAddress & { id: string })[], ad.id, 'isDefaultShipping') as ClientAddress[];
                                onChange(next);
                            }}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors duration-150 ease-out ${
                                ad.isDefaultShipping ? 'bg-foreground text-white border-foreground' : 'bg-surface text-foreground border-border hover:bg-surface-muted'
                            }`}
                        >
                            {ad.isDefaultShipping && <Check size={14} className="inline-block -mt-0.5 mr-1" />}
                            Standard Lieferung
                        </button>
                    </div>
                </div>

               <div className="grid grid-cols-12 gap-3">
                   <div className="col-span-6">
                       <label className="block text-[10px] font-bold text-muted mb-1">Straße</label>
                       <input
                           value={ad.street}
                           onChange={(e) => {
                               const next = [...addresses];
                               next[idx] = { ...ad, street: e.target.value };
                               onChange(next);
                           }}
                           className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
                       />
                   </div>
                   <div className="col-span-6">
                       <label className="block text-[10px] font-bold text-muted mb-1">Zusatz</label>
                       <input
                           value={ad.line2 ?? ''}
                           onChange={(e) => {
                               const next = [...addresses];
                               next[idx] = { ...ad, line2: e.target.value };
                               onChange(next);
                           }}
                           className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
                       />
                   </div>
                   <div className="col-span-3">
                       <label className="block text-[10px] font-bold text-muted mb-1">PLZ</label>
                       <input
                           value={ad.zip}
                           onChange={(e) => {
                               const next = [...addresses];
                               next[idx] = { ...ad, zip: e.target.value };
                               onChange(next);
                           }}
                           className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
                       />
                   </div>
                   <div className="col-span-5">
                       <label className="block text-[10px] font-bold text-muted mb-1">Stadt</label>
                       <input
                           value={ad.city}
                           onChange={(e) => {
                               const next = [...addresses];
                               next[idx] = { ...ad, city: e.target.value };
                               onChange(next);
                           }}
                           className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
                       />
                   </div>
                   <div className="col-span-4">
                       <label className="block text-[10px] font-bold text-muted mb-1">Land</label>
                       <input
                           value={ad.country}
                           onChange={(e) => {
                               const next = [...addresses];
                               next[idx] = { ...ad, country: e.target.value };
                               onChange(next);
                           }}
                           className="w-full bg-surface border border-border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
                       />
                   </div>
               </div>

               <div className="flex justify-end">
                   <button
                       onClick={() => {
                           const next = addresses.filter((a) => a.id !== ad.id);
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
