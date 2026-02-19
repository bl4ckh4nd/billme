
import React, { useState } from 'react';
import { InvoiceElement, ElementType, TableColumn } from '../types';
import { Type, AlignLeft, AlignCenter, AlignRight, Bold, Trash2, QrCode, Columns, Eye, EyeOff, AlertTriangle, Database, ChevronDown, ChevronRight } from 'lucide-react';
import { VARIABLE_GROUPS } from '../utils/placeholders';

interface PropertiesPanelProps {
  element: InvoiceElement | null;
  onUpdate: (id: string, updates: Partial<InvoiceElement>) => void;
  onDelete: (id: string) => void;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({ element, onUpdate, onDelete }) => {
  const [openVariableGroup, setOpenVariableGroup] = useState<string | null>('Rechnung');

  if (!element) {
    return (
      <div className="w-80 bg-white border-l border-gray-200 p-8 flex flex-col items-center justify-center text-gray-400 no-print">
        <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mb-4">
            <Type size={32} className="opacity-20 text-black" />
        </div>
        <p className="text-center font-medium">Select an element to edit</p>
      </div>
    );
  }

  const handleStyleChange = (key: string, value: any) => {
    onUpdate(element.id, {
      style: {
        ...element.style,
        [key]: value
      }
    });
  };

  const insertVariable = (variableKey: string) => {
      const placeholder = `{{${variableKey}}}`;
      // Simple append for now. A real cursor insert requires a ref to the textarea
      onUpdate(element.id, { content: (element.content || '') + placeholder });
  };

  // --- Table Column Logic ---
  const handleUpdateColumn = (index: number, field: keyof TableColumn, value: any) => {
      if (!element.tableData?.columns) return;
      const newColumns = [...element.tableData.columns];
      newColumns[index] = { ...newColumns[index], [field]: value };
      onUpdate(element.id, {
          tableData: {
              ...element.tableData,
              columns: newColumns
          }
      });
  };

  const totalColumnWidth = element.tableData?.columns
    ?.filter(c => c.visible)
    .reduce((acc, c) => acc + (c.width || 0), 0) || 0;

  const containerWidth = element.style.width || 0;
  const isOverflowing = totalColumnWidth > containerWidth;


  return (
    <div className="w-80 bg-white border-l border-gray-200 p-6 flex flex-col gap-6 overflow-y-auto no-print h-full shadow-[-10px_0_30px_-15px_rgba(0,0,0,0.05)]">
      <div>
        <h3 className="font-bold text-xl mb-1 text-black">Eigenschaften</h3>
        <span className="inline-block bg-accent px-2 py-1 rounded text-[10px] font-bold tracking-widest uppercase text-black">
            {element.type}
        </span>
      </div>

      {/* Content Editor */}
      {element.type === ElementType.TEXT && (
        <div className="flex flex-col gap-2 animate-enter">
          <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Inhalt</label>
          <textarea
            className="w-full border border-gray-200 bg-gray-50 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent focus:border-transparent outline-none min-h-[100px] text-gray-800 resize-none transition-shadow font-mono"
            value={element.content}
            onChange={(e) => onUpdate(element.id, { content: e.target.value })}
            placeholder="Text eingeben..."
          />
          
          {/* Variable Injection */}
          <div className="border border-gray-100 rounded-xl bg-gray-50 overflow-hidden">
               <div className="p-2 border-b border-gray-200 bg-gray-100 flex items-center gap-2 text-xs font-bold text-gray-600">
                   <Database size={12} />
                   Dynamische Daten einfügen
               </div>
               <div className="p-2 space-y-1">
                   {VARIABLE_GROUPS.map((group, idx) => (
                       <div key={group.title} className="rounded-lg bg-white border border-gray-200 overflow-hidden animate-enter" style={{ animationDelay: `${idx * 30}ms` }}>
                           <button 
                                onClick={() => setOpenVariableGroup(openVariableGroup === group.title ? null : group.title)}
                                className="w-full flex items-center justify-between p-2 text-left hover:bg-gray-50 transition-colors"
                           >
                               <span className="text-[10px] font-bold uppercase">{group.title}</span>
                               {openVariableGroup === group.title ? <ChevronDown size={12} className="text-gray-400"/> : <ChevronRight size={12} className="text-gray-400"/>}
                           </button>
                           {openVariableGroup === group.title && (
                               <div className="p-2 bg-gray-50 grid grid-cols-1 gap-1 border-t border-gray-100">
                                   {group.variables.map(v => (
                                       <button
                                            key={v.key}
                                            onClick={() => insertVariable(v.key)}
                                            className="text-left px-2 py-1.5 rounded hover:bg-indigo-50 hover:text-indigo-600 text-xs font-medium text-gray-600 flex items-center justify-between group/item"
                                            title={v.description}
                                       >
                                           <span>{v.label}</span>
                                           <span className="text-[9px] opacity-0 group-hover/item:opacity-100 text-indigo-400">+ Einfügen</span>
                                       </button>
                                   ))}
                               </div>
                           )}
                       </div>
                   ))}
               </div>
          </div>
        </div>
      )}

      {/* Table Column Configuration */}
      {element.type === ElementType.TABLE && element.tableData?.columns && (
          <div className="space-y-4 animate-enter">
              <div className="flex justify-between items-center border-b pb-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Spaltenkonfiguration</label>
                  <Columns size={14} className="text-gray-400" />
              </div>
              
              {/* Width Warning */}
              <div className={`text-[10px] font-bold p-2 rounded flex items-center gap-2 ${isOverflowing ? 'bg-error-bg text-error' : 'bg-gray-50 text-gray-500'}`}>
                   {isOverflowing && <AlertTriangle size={12} />}
                   <span>Summe: {Math.round(totalColumnWidth)}px / {containerWidth}px</span>
              </div>

              <div className="space-y-3">
                  {element.tableData.columns.map((col, idx) => (
                      <div key={idx} className={`p-3 rounded-lg border transition-all animate-enter ${col.visible ? 'bg-white border-gray-200' : 'bg-gray-50 border-transparent opacity-60'}`} style={{ animationDelay: `${idx * 30}ms` }}>
                          <div className="flex items-center justify-between mb-2">
                              <input 
                                  type="text" 
                                  value={col.label} 
                                  onChange={(e) => handleUpdateColumn(idx, 'label', e.target.value)}
                                  className="text-xs font-bold bg-transparent outline-none border-b border-transparent focus:border-accent w-24"
                              />
                              <button 
                                onClick={() => handleUpdateColumn(idx, 'visible', !col.visible)}
                                className={`p-1 rounded hover:bg-gray-200 ${col.visible ? 'text-black' : 'text-gray-400'}`}
                              >
                                  {col.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                              </button>
                          </div>
                          
                          {col.visible && (
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[9px] text-gray-400 uppercase font-bold">Breite</label>
                                    <div className="relative">
                                        <input 
                                            type="number" 
                                            value={col.width}
                                            onChange={(e) => handleUpdateColumn(idx, 'width', Number(e.target.value))}
                                            className="w-full bg-gray-50 rounded-lg p-1 text-xs outline-none focus:ring-1 focus:ring-accent"
                                        />
                                        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-gray-400">px</span>
                                    </div>
                                </div>
                                <div>
                                    <label className="text-[9px] text-gray-400 uppercase font-bold">Ausr.</label>
                                    <div className="flex bg-gray-50 rounded p-0.5">
                                        {(['left', 'center', 'right'] as const).map(align => (
                                            <button 
                                                key={align}
                                                onClick={() => handleUpdateColumn(idx, 'align', align)}
                                                className={`flex-1 flex justify-center py-1 rounded ${col.align === align ? 'bg-white shadow text-black' : 'text-gray-400'}`}
                                            >
                                                {align === 'left' && <AlignLeft size={10} />}
                                                {align === 'center' && <AlignCenter size={10} />}
                                                {align === 'right' && <AlignRight size={10} />}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                          )}
                      </div>
                  ))}
              </div>
          </div>
      )}

      {/* QR Code Specifics */}
      {element.type === ElementType.QRCODE && (
          <div className="flex flex-col gap-4">
               <label className="text-xs font-bold text-gray-500 uppercase tracking-wide block border-b pb-2">GiroCode Daten</label>
               <div>
                   <label className="text-[10px] text-gray-400 font-medium mb-1 block">IBAN</label>
                   <input
                       type="text"
                       className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                       placeholder="DE12..."
                       value={element.qrData?.iban || ''}
                       onChange={(e) => onUpdate(element.id, { qrData: { ...element.qrData!, iban: e.target.value } })}
                   />
               </div>
               <div>
                   <label className="text-[10px] text-gray-400 font-medium mb-1 block">BIC</label>
                   <input
                       type="text"
                       className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                       value={element.qrData?.bic || ''}
                       onChange={(e) => onUpdate(element.id, { qrData: { ...element.qrData!, bic: e.target.value } })}
                   />
               </div>
          </div>
      )}

      {/* Position */}
      <div className="space-y-4">
        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide block border-b pb-2">Layout</label>
        <div className="grid grid-cols-2 gap-3">
            <div>
            <label className="text-[10px] text-gray-400 font-medium mb-1 block">X Position</label>
            <input
                type="number"
                className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                value={Math.round(element.x)}
                onChange={(e) => onUpdate(element.id, { x: Number(e.target.value) })}
            />
            </div>
            <div>
            <label className="text-[10px] text-gray-400 font-medium mb-1 block">Y Position</label>
            <input
                type="number"
                className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                value={Math.round(element.y)}
                onChange={(e) => onUpdate(element.id, { y: Number(e.target.value) })}
            />
            </div>
            <div>
            <label className="text-[10px] text-gray-400 font-medium mb-1 block">Breite</label>
            <input
                type="number"
                className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                value={element.style.width || ''}
                onChange={(e) => handleStyleChange('width', Number(e.target.value))}
            />
            </div>
            {(element.type === ElementType.IMAGE || element.type === ElementType.BOX) && (
                <div>
                <label className="text-[10px] text-gray-400 font-medium mb-1 block">Höhe</label>
                <input
                type="number"
                className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                value={element.style.height || ''}
                onChange={(e) => handleStyleChange('height', Number(e.target.value))}
                />
            </div>
            )}
        </div>
      </div>

      {/* Typography */}
      {(element.type === ElementType.TEXT || element.type === ElementType.TABLE) && (
        <div className="space-y-4">
          <label className="text-xs font-bold text-gray-500 uppercase tracking-wide block border-b pb-2">Typografie</label>

          <div className="flex items-center gap-3">
            <div className="flex-1">
                <label className="text-[10px] text-gray-400 font-medium mb-1 block">Farbe</label>
                <div className="flex items-center gap-2 bg-gray-50 p-1.5 rounded-lg border border-gray-200">
                    <input
                    type="color"
                    value={element.style.color || '#000000'}
                    onChange={(e) => handleStyleChange('color', e.target.value)}
                    className="h-6 w-6 rounded cursor-pointer border-none bg-transparent"
                    />
                    <span className="text-xs text-gray-600 font-mono">{element.style.color}</span>
                </div>
            </div>
            <div className="w-20">
                <label className="text-[10px] text-gray-400 font-medium mb-1 block">Größe</label>
                <input
                type="number"
                value={element.style.fontSize || 12}
                onChange={(e) => handleStyleChange('fontSize', Number(e.target.value))}
                className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                />
            </div>
          </div>
          
          <div>
               <label className="text-[10px] text-gray-400 font-medium mb-1 block">Schriftart</label>
               <select 
                   value={element.style.fontFamily || 'Inter, sans-serif'}
                   onChange={(e) => handleStyleChange('fontFamily', e.target.value)}
                   className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
               >
                   <option value="Inter, sans-serif">Inter (Modern)</option>
                   <option value="Times New Roman, serif">Times (Classic)</option>
                   <option value="Arial, sans-serif">Arial</option>
                   <option value="Courier New, monospace">Courier (Mono)</option>
               </select>
          </div>

          <div className="flex bg-gray-100 rounded-lg p-1 gap-1 justify-between">
             <button
                onClick={() => handleStyleChange('textAlign', 'left')}
                className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.textAlign === 'left' ? 'bg-white shadow-sm text-black' : 'text-gray-500 hover:bg-gray-200'}`}
             >
               <AlignLeft size={16} />
             </button>
             <button
                onClick={() => handleStyleChange('textAlign', 'center')}
                className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.textAlign === 'center' ? 'bg-white shadow-sm text-black' : 'text-gray-500 hover:bg-gray-200'}`}
             >
               <AlignCenter size={16} />
             </button>
             <button
                onClick={() => handleStyleChange('textAlign', 'right')}
                className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.textAlign === 'right' ? 'bg-white shadow-sm text-black' : 'text-gray-500 hover:bg-gray-200'}`}
             >
               <AlignRight size={16} />
             </button>
             <div className="w-px bg-gray-300 mx-1 my-1"></div>
             <button
                onClick={() => handleStyleChange('fontWeight', element.style.fontWeight === 'bold' ? 'normal' : 'bold')}
                className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.fontWeight === 'bold' ? 'bg-black text-accent' : 'text-gray-500 hover:bg-gray-200'}`}
             >
               <Bold size={16} />
             </button>
          </div>
        </div>
      )}

      {/* Specific Element Type Settings */}
      {element.type === ElementType.LINE && (
          <div className="space-y-4">
             <label className="text-xs font-bold text-gray-500 uppercase tracking-wide block border-b pb-2">Linien Einstellungen</label>
             <div className="grid grid-cols-2 gap-3">
                 <div>
                    <label className="text-[10px] text-gray-400 font-medium mb-1 block">Farbe</label>
                    <input
                    type="color"
                    value={element.style.backgroundColor || '#000000'}
                    onChange={(e) => handleStyleChange('backgroundColor', e.target.value)}
                    className="h-10 w-full rounded-lg cursor-pointer border border-gray-200"
                    />
                 </div>
                 <div>
                    <label className="text-[10px] text-gray-400 font-medium mb-1 block">Dicke</label>
                    <input
                    type="number"
                    value={element.style.height || 1}
                    onChange={(e) => handleStyleChange('height', Number(e.target.value))}
                    className="w-full border border-gray-200 bg-gray-50 rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
                    />
                 </div>
             </div>
          </div>
      )}

      <div className="mt-auto pt-6">
        <button
          onClick={() => onDelete(element.id)}
          className="w-full flex items-center justify-center gap-2 text-error border border-error/30 bg-error-bg hover:bg-error-bg/80 p-3 rounded-xl transition-colors font-medium text-sm"
        >
          <Trash2 size={16} />
          Element löschen
        </button>
      </div>
    </div>
  );
};
