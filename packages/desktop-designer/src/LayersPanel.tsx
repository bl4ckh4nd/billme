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

/** 24x24 minimum hit area; the focus ring follows the row, which flips to black when selected. */
const rowControl = (selected: boolean) =>
  `inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 ${
    selected ? 'focus-visible:outline-focus-ring-dark' : 'focus-visible:outline-focus-ring'
  }`;

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
        <Layers size={20} className="text-muted" />
        <h3 className="font-semibold text-xl text-black">Ebenen</h3>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {sorted.map((el) => {
          const selected = selectedIds.includes(el.id);
          return (
            <div
              key={el.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={(e) => onSelect(el.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(el.id, event.shiftKey || event.metaKey || event.ctrlKey);
              }}
              className={`group flex items-center justify-between p-3 rounded-xl border motion-safe:transition-colors motion-reduce:transition-none cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                selected
                  ? 'bg-black border-black text-white'
                  : 'bg-white border-border-subtle hover:border-border text-foreground'
              } ${el.hidden ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div className={`p-2 rounded-sm ${selected ? 'bg-dark-border-subtle text-background' : 'bg-surface-muted text-muted'}`}>
                  {iconFor(el.type)}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-semibold truncate">{labelFor(el)}</span>
                  <span className={`text-xs tabular-nums ${selected ? 'text-dark-muted' : 'text-muted'}`}>z: {el.zIndex}</span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleHidden(el.id);
                  }}
                  title={el.hidden ? 'Einblenden' : 'Ausblenden'}
                  className={`${rowControl(selected)} p-1.5 ${selected ? 'text-muted hover:text-white' : 'text-muted hover:text-foreground'}`}
                >
                  {el.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLock(el.id);
                  }}
                  title={el.locked ? 'Entsperren' : 'Sperren'}
                  className={`${rowControl(selected)} p-1.5 ${selected ? 'text-muted hover:text-white' : 'text-muted hover:text-foreground'}`}
                >
                  {el.locked ? <Lock size={14} /> : <Unlock size={14} />}
                </button>
                <div className="ui-reveal flex flex-col gap-0.5 group-focus-within:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onReorder(el.id, 'up');
                    }}
                    title="Eine Ebene nach vorne"
                    className={`${rowControl(selected)} p-0.5 ${selected ? 'text-white hover:bg-white/20' : 'text-muted hover:bg-surface-muted'}`}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onReorder(el.id, 'down');
                    }}
                    title="Eine Ebene nach hinten"
                    className={`${rowControl(selected)} p-0.5 ${selected ? 'text-white hover:bg-white/20' : 'text-muted hover:bg-surface-muted'}`}
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
                  className={`ui-reveal ${rowControl(selected)} p-1.5 text-muted group-focus-within:opacity-100 ${selected ? 'hover:text-error' : 'hover:text-error-text'}`}
                >
                  <Trash2 size={14} />
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
            className="flex items-center justify-center gap-2 bg-white border border-border py-2 rounded-lg text-xs font-semibold hover:bg-black hover:text-accent hover:border-black motion-safe:transition-colors motion-reduce:transition-none"
          >
            <ArrowUp size={14} />
            Ganz nach vorne
          </button>
          <button
            onClick={() => onReorder(primary, 'back')}
            className="flex items-center justify-center gap-2 bg-white border border-border py-2 rounded-lg text-xs font-semibold hover:bg-black hover:text-accent hover:border-black motion-safe:transition-colors motion-reduce:transition-none"
          >
            <ArrowDown size={14} />
            Ganz nach hinten
          </button>
        </div>
      )}
    </div>
  );
};
