import React from 'react';
import { InvoiceElement, ElementType } from '../types';
import { ArrowUp, ArrowDown, ChevronUp, ChevronDown, Layers, Type, Image as ImageIcon, Box, Table, Minus, Trash2 } from 'lucide-react';

interface LayersPanelProps {
  elements: InvoiceElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReorder: (id: string, direction: 'up' | 'down' | 'front' | 'back') => void;
  onDelete: (id: string) => void;
}

const getIcon = (type: ElementType | 'TEXT' | 'IMAGE' | 'BOX' | 'TABLE' | 'LINE' | 'QRCODE') => {
  switch (type) {
    case ElementType.TEXT:
    case 'TEXT': return <Type size={14} />;
    case ElementType.IMAGE:
    case 'IMAGE': return <ImageIcon size={14} />;
    case ElementType.BOX:
    case 'BOX': return <Box size={14} />;
    case ElementType.TABLE:
    case 'TABLE': return <Table size={14} />;
    case ElementType.LINE:
    case 'LINE': return <Minus size={14} />;
    default: return <Box size={14} />;
  }
};

const getPreviewText = (el: InvoiceElement) => {
    if (el.label) return el.label;
    if (el.type === ElementType.TEXT && el.content) {
        return el.content.substring(0, 20) + (el.content.length > 20 ? '...' : '');
    }
    return el.type;
};

export const LayersPanel: React.FC<LayersPanelProps> = ({ elements, selectedId, onSelect, onReorder, onDelete }) => {
  // Sort elements by zIndex descending for the list (Visual top = Logical Front)
  const sortedElements = [...elements].sort((a, b) => b.zIndex - a.zIndex);

  return (
    <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full shadow-[-10px_0_30px_-15px_rgba(0,0,0,0.05)] no-print">
      <div className="p-6 border-b border-gray-100 flex items-center gap-2">
        <Layers size={20} className="text-accent fill-black" />
        <h3 className="font-bold text-xl text-black">Ebenen</h3>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {sortedElements.map((el, idx) => (
          <div
            key={el.id}
            onClick={() => onSelect(el.id)}
            className={`group flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer animate-enter ${
              selectedId === el.id
                ? 'bg-black border-black text-white shadow-lg'
                : 'bg-white border-gray-100 hover:border-gray-300 text-gray-700 hover:shadow-sm'
            }`}
            style={{ animationDelay: `${idx * 30}ms` }}
          >
            <div className="flex items-center gap-3 overflow-hidden">
                <div className={`p-2 rounded-lg ${selectedId === el.id ? 'bg-[#333] text-accent' : 'bg-gray-50 text-gray-500'}`}>
                    {getIcon(el.type)}
                </div>
                <div className="flex flex-col min-w-0">
                    <span className="text-xs font-bold truncate">{getPreviewText(el)}</span>
                    <span className="text-[10px] opacity-60 font-mono">z: {el.zIndex}</span>
                </div>
            </div>

            <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${selectedId === el.id ? 'opacity-100' : ''}`}>
                <div className="flex flex-col gap-0.5">
                    <button
                        onClick={(e) => { e.stopPropagation(); onReorder(el.id, 'up'); }}
                        className={`p-1 rounded hover:bg-white/20 ${selectedId === el.id ? 'text-white' : 'text-gray-500 hover:bg-gray-100'}`}
                        title="Nach vorne"
                    >
                        <ChevronUp size={12} />
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onReorder(el.id, 'down'); }}
                        className={`p-1 rounded hover:bg-white/20 ${selectedId === el.id ? 'text-white' : 'text-gray-500 hover:bg-gray-100'}`}
                        title="Nach hinten"
                    >
                        <ChevronDown size={12} />
                    </button>
                </div>
                <button
                    onClick={(e) => { e.stopPropagation(); onDelete(el.id); }}
                    className={`p-1.5 rounded ml-1 hover:bg-red-500/20 hover:text-red-500 ${selectedId === el.id ? 'text-gray-400' : 'text-gray-300'}`}
                    title="Löschen"
                >
                    <Trash2 size={14} />
                </button>
            </div>
          </div>
        ))}

        {sortedElements.length === 0 && (
            <div className="text-center py-10 text-gray-400 text-sm">
                Keine Elemente
            </div>
        )}
      </div>
      
      {/* Quick Actions for Selected */}
      {selectedId && (
        <div className="p-4 bg-gray-50 border-t border-gray-200 grid grid-cols-2 gap-2 animate-enter">
            <button 
                onClick={() => onReorder(selectedId, 'front')}
                className="flex items-center justify-center gap-2 bg-white border border-gray-200 py-2 rounded-lg text-xs font-bold hover:bg-black hover:text-accent hover:border-black transition-colors"
            >
                <ArrowUp size={14} />
                Ganz nach vorne
            </button>
            <button 
                onClick={() => onReorder(selectedId, 'back')}
                className="flex items-center justify-center gap-2 bg-white border border-gray-200 py-2 rounded-lg text-xs font-bold hover:bg-black hover:text-accent hover:border-black transition-colors"
            >
                <ArrowDown size={14} />
                Ganz nach hinten
            </button>
        </div>
      )}
    </div>
  );
};
