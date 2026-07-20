import React from 'react';
import { FileText, Check, ArrowUpRight } from 'lucide-react';
import { Badge } from '@billme/ui';
import { Invoice } from '../../types';
import { getDunningBadge, formatCurrency, formatDate } from './helpers';

interface DocumentListItemProps {
  doc: Invoice;
  index: number;
  documentType: 'invoice' | 'offer';
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  onEditInvoice: (invoice: Invoice, type: 'invoice' | 'offer') => void;
}

export const DocumentListItem: React.FC<DocumentListItemProps> = ({
  doc,
  index,
  documentType,
  isSelected,
  isSelecting,
  onToggleSelect,
  onOpenDetail,
  onEditInvoice,
}) => {
  return (
    <div
      onClick={() => {
        if (isSelecting) onToggleSelect(doc.id);
        else onOpenDetail(doc.id);
      }}
      className={`group flex items-center gap-4 p-4 rounded-xl border hover:shadow-xl hover:-translate-y-1 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-150 ease-out cursor-pointer relative animate-enter ${
        isSelected
          ? 'border-foreground bg-surface-muted'
          : 'border-border-subtle hover:border-foreground bg-surface'
      }`}
      style={{ animationDelay: `${index * 50}ms` }}
    >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(doc.id);
          }}
          className="shrink-0"
          title={isSelected ? 'Auswahl entfernen' : 'Auswählen'}
        >
          <div
            className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ease-out duration-150 ${
              isSelected
                ? 'bg-foreground border-foreground text-accent'
                : 'border-border bg-surface group-hover:border-foreground/40'
            }`}
          >
            {isSelected && <Check size={12} />}
          </div>
        </button>
        {/* Flex Column 1: Info (Flex 1 to take remaining space) */}
        <div className="flex-1 flex items-center gap-4 min-w-0">
            <div className={`w-12 h-12 rounded-lg flex items-center justify-center font-bold text-muted group-hover:text-accent group-hover:bg-foreground transition-colors ease-out duration-150 shrink-0 ${documentType === 'offer' ? 'bg-purple-50 text-purple-400' : 'bg-surface-muted'}`}>
                <FileText size={20} />
           </div>
           <div className="min-w-0">
               <p className="font-bold text-lg text-foreground flex items-center gap-2 flex-wrap">
                   <span className="truncate">{doc.number}</span>
                   {getDunningBadge(doc.dunningLevel)}
               </p>
               <p className="text-xs font-bold text-muted truncate">{doc.client}</p>
           </div>
       </div>

       {/* Flex Column 2: Date (Fixed Width) */}
       <div className="hidden md:block w-32 text-right shrink-0">
           <p className="text-xs font-bold text-muted uppercase">Datum</p>
           <p className="text-sm font-bold">{formatDate(doc.date)}</p>
       </div>

       {/* Flex Column 3: Due Date (Fixed Width) */}
       <div className="hidden md:block w-32 text-right shrink-0">
           <p className="text-xs font-bold text-muted uppercase">{documentType === 'offer' ? 'Gültig bis' : 'Fällig'}</p>
           <p className={`text-sm font-bold ${doc.status === 'overdue' ? 'text-error' : ''}`}>{formatDate(doc.dueDate)}</p>
       </div>

       {/* Flex Column 4: Amount (Fixed Width) */}
       <div className="w-32 text-right shrink-0">
           <p className="text-lg tabular-nums font-bold truncate">{formatCurrency(doc.amount)}</p>
       </div>

       {/* Flex Column 5: Status (Fixed Width) */}
       <div className="w-28 flex justify-end shrink-0">
           <Badge status={doc.status} />
       </div>

       {/* Flex Column 6: Arrow (Fixed Width) */}
       <div className="w-10 flex justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
           <button className="p-2 hover:bg-canvas rounded-full transition-colors ease-out duration-150" onClick={(e) => {
             e.stopPropagation();
             onEditInvoice(doc, documentType);
           }}>
               <ArrowUpRight size={18} />
           </button>
       </div>
    </div>
  );
};
