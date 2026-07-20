import React from 'react';
import { Download, Printer, Trash2 } from 'lucide-react';
import { Button } from '@billme/ui';

interface SelectionBarProps {
  selectedCount: number;
  documentType: 'invoice' | 'offer';
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkExport: (opts: { openFolderAfter?: boolean }) => void;
  onBulkDelete: () => void;
}

export const SelectionBar: React.FC<SelectionBarProps> = ({
  selectedCount,
  documentType,
  onSelectAll,
  onClearSelection,
  onBulkExport,
  onBulkDelete,
}) => {
  return (
    <div className="mb-5 bg-black text-white rounded-3xl px-5 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 shadow-xl">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center font-bold text-xs">
          {selectedCount}
        </div>
        <div className="font-bold">
          Auswahl aktiv
          <span className="ml-2 text-xs font-bold text-white/60">
            ({documentType === 'invoice' ? 'Rechnungen' : 'Angebote'})
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onSelectAll}
          className="h-10 px-4 bg-white/10 hover:bg-white/15 border border-white/15 rounded-full text-xs font-bold transition-colors"
          title="Alle in der aktuellen Liste auswählen"
        >
          Alle auswählen
        </button>
        <button
          onClick={onClearSelection}
          className="h-10 px-4 bg-white/10 hover:bg-white/15 border border-white/15 rounded-full text-xs font-bold transition-colors"
        >
          Aufheben
        </button>
        <div className="w-px h-6 bg-white/15 mx-1"></div>
        <button
          onClick={() => onBulkExport({ openFolderAfter: false })}
          className="h-10 px-4 bg-white rounded-full text-xs font-bold text-black hover:bg-canvas transition-colors ease-out duration-150 flex items-center gap-2"
          title="PDFs exportieren (in App-Exports)"
        >
          <Download size={16} /> Export
        </button>
        <Button
          onClick={() => onBulkExport({ openFolderAfter: true })}
          size="sm"
          title="PDFs erstellen und Export-Ordner öffnen"
        >
          <Printer size={16} /> Drucken
        </Button>
        <button
          onClick={onBulkDelete}
          className="h-10 px-4 bg-error text-white rounded-full text-xs font-bold hover:bg-error/90 transition-colors flex items-center gap-2"
          title="Ausgewählte Einträge löschen"
        >
          <Trash2 size={16} /> Löschen
        </button>
      </div>
    </div>
  );
};
