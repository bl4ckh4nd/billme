import React from 'react';
import { ArrowRight, Mail, Phone } from 'lucide-react';
import type { Client } from '../../types';

interface ClientListRowProps {
    client: Client;
    idx: number;
    onClick: () => void;
}

export const ClientListRow: React.FC<ClientListRowProps> = ({ client, idx, onClick }) => (
    <div
        key={client.id}
        onClick={onClick}
        className="group bg-surface-muted rounded-xl p-4 border border-border-subtle hover:border-border hover:bg-surface transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out grid grid-cols-12 gap-4 items-center cursor-pointer animate-enter"
        style={{ animationDelay: `${idx * 50}ms` }}
    >
        <div className="col-span-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center text-sm font-bold shadow-sm text-black shrink-0">
                {client.company.substring(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
                <h3 className="font-bold text-sm text-foreground truncate">{client.company}</h3>
                <p className="text-xs text-muted truncate">{client.contactPerson}</p>
            </div>
        </div>
        <div className="col-span-3 space-y-1">
            <div className="flex items-center gap-2 text-xs text-muted truncate">
                <Mail size={12} className="opacity-50 shrink-0" />
                <span className="truncate">{client.email}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted truncate">
                <Phone size={12} className="opacity-50 shrink-0" />
                <span className="truncate">{client.phone}</span>
            </div>
        </div>
        <div className="col-span-2">
            <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${client.status === 'active' ? 'bg-success-bg text-success' : 'bg-surface-muted text-muted'}`}>
                {client.status === 'active' ? 'Aktiv' : 'Inaktiv'}
            </span>
        </div>
        <div className="col-span-2">
            <span className="text-xs font-medium bg-surface px-2 py-1 rounded border border-border-subtle">
                {client.projects.length} Projekte
            </span>
        </div>
        <div className="col-span-1 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out">
            <ArrowRight size={16} className="text-muted" />
        </div>
    </div>
);
