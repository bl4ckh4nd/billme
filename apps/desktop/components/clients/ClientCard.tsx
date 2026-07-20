import React from 'react';
import { ArrowRight } from 'lucide-react';
import type { Client } from '../../types';

interface ClientCardProps {
    client: Client;
    idx: number;
    onClick: () => void;
}

export const ClientCard: React.FC<ClientCardProps> = ({ client, idx, onClick }) => (
    <div
        key={client.id}
        onClick={onClick}
        className="group bg-surface-muted rounded-xl p-6 hover:bg-accent transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out duration-150 cursor-pointer relative overflow-hidden min-h-[220px] animate-scale-in"
        style={{ animationDelay: `${idx * 75}ms` }}
    >
        <div className="flex justify-between items-start mb-8 relative z-10">
            <div className="w-12 h-12 bg-surface rounded-xl flex items-center justify-center text-xl font-bold shadow-sm transition-transform group-hover:scale-110">
                {client.company.substring(0, 2).toUpperCase()}
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
);
