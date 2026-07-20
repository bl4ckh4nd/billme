import React, { useState } from 'react';
import { Plus, ArrowUpRight } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  useActiveTemplateQuery,
  useSetActiveTemplateMutation,
  useTemplatesQuery,
  useUpsertTemplateMutation,
} from '../../hooks/useTemplates';
import type { DocumentTemplate, InvoiceElement } from '../../types';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '../../constants';

export const TemplatesView: React.FC<{ onOpenEditor: (type: 'invoice' | 'offer') => void }> = ({ onOpenEditor }) => {
    const [activeTab, setActiveTab] = useState<'invoice' | 'offer'>('invoice');
    const { data: templates = [] } = useTemplatesQuery(activeTab);
    const { data: activeTemplate } = useActiveTemplateQuery(activeTab);
    const setActiveTemplateMutation = useSetActiveTemplateMutation();
    const upsertTemplateMutation = useUpsertTemplateMutation();

    const handleCreateNewTemplate = async () => {
        const baseElements =
            activeTemplate?.elements ??
            (activeTab === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE);

        const now = new Date();
        const ts = now.toISOString();
        const template: DocumentTemplate = {
            id: uuidv4(),
            kind: activeTab,
            name:
                activeTab === 'offer'
                    ? `Angebotsvorlage ${now.toLocaleDateString('de-DE')}`
                    : `Rechnungsvorlage ${now.toLocaleDateString('de-DE')}`,
            elements: baseElements as unknown as InvoiceElement[],
            createdAt: ts,
            updatedAt: ts,
        };

        try {
            const saved = await upsertTemplateMutation.mutateAsync(template);
            await setActiveTemplateMutation.mutateAsync({ kind: activeTab, templateId: saved.id });
            onOpenEditor(activeTab);
        } catch (e) {
            alert(`Vorlage anlegen fehlgeschlagen: ${String(e)}`);
        }
    };

    return (
        <div className="bg-surface rounded-xl shadow-sm p-8 min-h-[80vh] animate-enter">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h3 className="font-bold text-2xl text-foreground mb-1">Vorlagen</h3>
                    <p className="text-sm text-muted">Gestalten Sie Ihre Geschäftsdokumente.</p>
                </div>
                <div className="bg-canvas p-1 rounded-full flex items-center">
                    <button
                        onClick={() => setActiveTab('invoice')}
                        className={`px-6 py-2 rounded-full text-xs font-bold transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out ${activeTab === 'invoice' ? 'bg-surface shadow text-foreground' : 'text-muted hover:text-foreground'}`}
                    >
                        Rechnungen
                    </button>
                    <button
                        onClick={() => setActiveTab('offer')}
                        className={`px-6 py-2 rounded-full text-xs font-bold transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out ${activeTab === 'offer' ? 'bg-surface shadow text-foreground' : 'text-muted hover:text-foreground'}`}
                    >
                        Angebote
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Create New Card */}
                <div
                    onClick={() => void handleCreateNewTemplate()}
                    className="aspect-[3/4] bg-surface-muted rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-4 cursor-pointer hover:border-foreground hover:bg-canvas transition-[background-color,border-color,color,box-shadow,opacity,transform,width] ease-out group animate-scale-in"
                >
                    <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform ease-out">
                        <Plus size={24} className="text-muted group-hover:text-foreground" />
                    </div>
                    <span className="font-bold text-muted group-hover:text-foreground text-center px-4">
                        Neue {activeTab === 'invoice' ? 'Rechnungsvorlage' : 'Angebotsvorlage'}
                    </span>
                </div>

                {/* Templates */}
                {templates.map((t, idx) => (
                <div
                    key={t.id}
                    className="aspect-[3/4] bg-surface rounded-xl border border-border p-4 flex flex-col hover:border-border hover:-translate-y-2 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] cursor-pointer group relative overflow-hidden animate-scale-in"
                    style={{ animationDelay: `${100 + idx * 50}ms` }}
                    onClick={() => onOpenEditor(activeTab)}
                >
                    <div className="flex-1 bg-surface-muted rounded-xl mb-4 relative overflow-hidden flex flex-col p-4 gap-2 border border-border-subtle">
                         {/* Mini preview abstraction */}
                         <div className="w-1/3 h-2 bg-border rounded-full self-end"></div>
                         <div className="w-1/2 h-2 bg-border rounded-full mt-4"></div>
                         <div className="w-full h-1 bg-border-subtle rounded-full mt-2"></div>
                         <div className="w-full h-1 bg-border-subtle rounded-full"></div>

                         <div className="mt-auto bg-surface border border-border-subtle p-2 rounded-md">
                             <div className="w-full h-1 bg-border-subtle rounded-full mb-1"></div>
                             <div className="flex justify-between">
                                 <div className="w-1/4 h-1 bg-border-subtle rounded-full"></div>
                                 <div className="w-1/4 h-1 bg-border rounded-full"></div>
                             </div>
                         </div>
                    </div>
                    <h4 className="font-bold text-lg text-foreground">{t.name}</h4>
                    <p className="text-xs text-muted">A4 • {t.id === activeTemplate?.id ? 'Aktiv' : 'Vorlage'}</p>

                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            void setActiveTemplateMutation.mutateAsync({ kind: activeTab, templateId: t.id });
                        }}
                        className={`absolute top-4 left-4 px-3 py-1 rounded-full text-[10px] font-bold uppercase border transition-colors ${
                            t.id === activeTemplate?.id
                                ? 'bg-accent text-black border-accent'
                                : 'bg-surface text-muted border-border hover:bg-surface-muted'
                        }`}
                    >
                        {t.id === activeTemplate?.id ? 'Aktiv' : 'Aktivieren'}
                    </button>

                    <button onClick={(e) => { e.stopPropagation(); onOpenEditor(activeTab); }} className="absolute bottom-4 right-4 bg-black text-white w-10 h-10 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] translate-y-2 group-hover:translate-y-0">
                        <ArrowUpRight size={18} />
                    </button>

                    <div className="absolute top-4 right-4">
                        {activeTab === 'offer' && (
                            <span className="bg-surface-muted text-muted border border-border px-2 py-1 rounded text-[10px] font-bold uppercase">Angebot</span>
                        )}
                    </div>
                </div>
                ))}
            </div>
        </div>
    );
};
