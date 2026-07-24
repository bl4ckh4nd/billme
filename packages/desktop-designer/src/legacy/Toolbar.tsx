
import React from 'react';
import { ElementType } from '../types';
import { Type, Image as ImageIcon, Box, Table, Minus, Printer, QrCode, ShieldCheck } from 'lucide-react';

interface ToolbarProps {
  onAddElement: (type: ElementType) => void;
  onLegalCheck: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({ onAddElement, onLegalCheck }) => {

  return (
    <div className="w-full text-white flex flex-col h-full z-10 no-print">
      <div className="p-8 pb-4">
        <h2 className="text-xl font-bold text-white tracking-tight">
            Editor
        </h2>
        <p className="text-xs text-gray-500 font-medium">Design & Layout</p>
      </div>

      <div className="px-6 pb-6 flex-1 overflow-y-auto space-y-8 scrollbar-thin scrollbar-thumb-gray-800">
        <div>
          <h2 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-4">Elemente</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { type: ElementType.TEXT, icon: Type, label: 'Text' },
              { type: ElementType.IMAGE, icon: ImageIcon, label: 'Bild' },
              { type: ElementType.TABLE, icon: Table, label: 'Tabelle' },
              { type: ElementType.BOX, icon: Box, label: 'Box' },
              { type: ElementType.LINE, icon: Minus, label: 'Linie' },
              { type: ElementType.QRCODE, icon: QrCode, label: 'GiroCode' },
            ].map((item, idx) => (
              <button
                key={item.type}
                onClick={() => onAddElement(item.type)}
                className="flex flex-col items-center justify-center p-4 bg-[#1a1a1a] rounded-xl hover:bg-accent transition-all duration-200 group border border-[#333] hover:border-accent hover:scale-[1.02] animate-enter"
                style={{ animationDelay: `${idx * 40}ms` }}
              >
                <item.icon className="text-gray-400 group-hover:text-black mb-2 transition-colors" size={24} strokeWidth={1.5} />
                <span className="text-xs font-semibold text-gray-400 group-hover:text-black transition-colors">{item.label}</span>
              </button>
            ))}
          </div>
        </div>


         <div className="border-t border-[#222] pt-6 animate-enter" style={{ animationDelay: '240ms' }}>
            <button onClick={onLegalCheck} className="w-full flex items-center gap-3 p-3 rounded-xl bg-[#1a1a1a] hover:bg-[#222] transition-colors text-left border border-[#333]">
                <div className="p-2 bg-success/10 text-success rounded-lg">
                    <ShieldCheck size={18} />
                </div>
                <div>
                    <p className="text-xs font-bold text-white">Rechts-Check</p>
                    <p className="text-[10px] text-gray-500">DIN & Pflichtangaben</p>
                </div>
            </button>
         </div>
      </div>

      <div className="p-6 border-t border-[#222] bg-[#111111] mt-auto">
        <button
           onClick={() => window.print()}
           className="w-full bg-white text-black py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors flex items-center justify-center gap-2 shadow-lg"
        >
          <Printer size={18} />
          PDF Export
        </button>
      </div>
    </div>
  );
};
