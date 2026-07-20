import React from 'react';
import { ElementType, type InvoiceElement } from './types';
import type { ReorderDirection } from './utils/elements';
import {
  ArrowUp,
  ArrowDown,
  ChevronUp,
  ChevronDown,
  Layers,
  Type,
  Image as ImageIcon,
  Box,
  Table,
  Minus,
  QrCode,
  Trash2,
  Lock,
  Unlock,
  Eye,
  EyeOff,
} from 'lucide-react';

export interface LayersPanelProps {
  elements: InvoiceElement[];
  selectedIds: string[];
  onSelect: (id: string, additive: boolean) => void;
  onReorder: (id: string, direction: ReorderDirection) => void;
  onDelete: (ids: string[]) => void;
  onToggleLock: (id: string) => void;
  onToggleHidden: (id: string) => void;
}

const iconFor = (type: InvoiceElement['type']) => {
  switch (type) {
    case ElementType.TEXT:
      return <Type size={14} />;
    case ElementType.IMAGE:
      return <ImageIcon size={14} />;
    case ElementType.BOX:
      return <Box size={14} />;
    case ElementType.TABLE:
      return <Table size={14} />;
    case ElementType.LINE:
      return <Minus size={14} />;
    case ElementType.QRCODE:
      return <QrCode size={14} />;
    default:
      return <Box size={14} />;
  }
};

const labelFor = (el: InvoiceElement): string => {
  if (el.label) return el.label;
  if (el.type === ElementType.TEXT && el.content) {
    return el.content.substring(0, 22) + (el.content.length > 22 ? '…' : '');
  }
  return String(el.type);
};

export const LayersPanel: React.FC<LayersPanelProps> = ({
  elements,
  selectedIds,
  onSelect,
  onReorder,
  onDelete,
  onToggleLock,
  onToggleHidden,
}) => {
  const sorted = [...elements].sort((a, b) => b.zIndex - a.zIndex);
  const primary = selectedIds[selectedIds.length - 1];

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="p-6 border-b border-border-subtle flex items-center gap-2">
        <Layers size={20} className="text-accent fill-black" />
        <h3 className="font-bold text-xl text-black">Ebenen</h3>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {sorted.map((el) => {
          const selected = selectedIds.includes(el.id);
          return (
            <div
              key={el.id}
              onClick={(e) => onSelect(el.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              className={`group flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                selected
                  ? 'bg-black border-black text-white shadow-lg'
                  : 'bg-white border-border-subtle hover:border-border text-foreground hover:shadow-sm'
              } ${el.hidden ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div className={`p-2 rounded-lg ${selected ? 'bg-dark-border-subtle text-accent' : 'bg-surface-muted text-muted'}`}>
                  {iconFor(el.type)}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold truncate">{labelFor(el)}</span>
                  <span className="text-[10px] opacity-60 font-mono tabular-nums">z: {el.zIndex}</span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleHidden(el.id);
                  }}
                  title={el.hidden ? 'Einblenden' : 'Ausblenden'}
                  className={`p-1.5 rounded ${selected ? 'text-muted hover:text-white' : 'text-muted hover:text-foreground'}`}
                >
                  {el.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLock(el.id);
                  }}
                  title={el.locked ? 'Entsperren' : 'Sperren'}
                  className={`p-1.5 rounded ${selected ? 'text-muted hover:text-white' : 'text-muted hover:text-foreground'}`}
                >
                  {el.locked ? <Lock size={13} /> : <Unlock size={13} />}
                </button>
                <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onReorder(el.id, 'up');
                    }}
                    title="Eine Ebene nach vorne"
                    className={`p-0.5 rounded ${selected ? 'text-white hover:bg-white/20' : 'text-muted hover:bg-canvas'}`}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onReorder(el.id, 'down');
                    }}
                    title="Eine Ebene nach hinten"
                    className={`p-0.5 rounded ${selected ? 'text-white hover:bg-white/20' : 'text-muted hover:bg-canvas'}`}
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete([el.id]);
                  }}
                  title="Löschen"
                  className={`p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:text-error ${selected ? 'text-muted' : 'text-muted'}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        })}

        {sorted.length === 0 && <div className="text-center py-10 text-muted text-sm">Keine Elemente</div>}
      </div>

      {primary && (
        <div className="p-4 bg-surface-muted border-t border-border grid grid-cols-2 gap-2">
          <button
            onClick={() => onReorder(primary, 'front')}
            className="flex items-center justify-center gap-2 bg-white border border-border py-2 rounded-lg text-xs font-bold hover:bg-black hover:text-accent hover:border-black transition-colors"
          >
            <ArrowUp size={14} />
            Ganz nach vorne
          </button>
          <button
            onClick={() => onReorder(primary, 'back')}
            className="flex items-center justify-center gap-2 bg-white border border-border py-2 rounded-lg text-xs font-bold hover:bg-black hover:text-accent hover:border-black transition-colors"
          >
            <ArrowDown size={14} />
            Ganz nach hinten
          </button>
        </div>
      )}
    </div>
  );
};
