
import React, { useState, useRef, useEffect } from 'react';
import { CanvasElement } from './CanvasElement';
import { PropertiesPanel } from './PropertiesPanel';
import { LayersPanel } from './LayersPanel';
import { Toolbar } from './Toolbar';
import type { DocumentTemplate, InvoiceElement, SnapGuide } from '../types';
import { ElementType } from '../types';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE, A4_WIDTH_PX, A4_HEIGHT_PX, DEFAULT_TEXT_STYLE, DIN_ZONES, MM_TO_PX } from '../constants';
import { Layers, SlidersHorizontal, ArrowLeft, ZoomIn, ZoomOut, CheckCircle, AlertTriangle } from 'lucide-react';
import {
  useActiveTemplateQuery,
  useSetActiveTemplateMutation,
  useUpsertTemplateMutation,
} from '../hooks/useTemplates';

// Simple UUID generator fallback
const generateId = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

interface InvoiceEditorProps {
  onBack: () => void;
  templateType?: 'invoice' | 'offer';
}

export const InvoiceEditor: React.FC<InvoiceEditorProps> = ({ onBack, templateType = 'invoice' }) => {
  const [elements, setElements] = useState<InvoiceElement[]>(
      templateType === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE
  );
  const [templateId, setTemplateId] = useState<string>(templateType === 'offer' ? 'default-offer' : 'default-invoice');
  const [templateName, setTemplateName] = useState<string>(templateType === 'offer' ? 'Standard Angebot' : 'Standard Rechnung');

  const { data: activeTemplate } = useActiveTemplateQuery(templateType);
  const upsertTemplate = useUpsertTemplateMutation();
  const setActiveTemplate = useSetActiveTemplateMutation();

  useEffect(() => {
    if (activeTemplate) {
      setTemplateId(activeTemplate.id);
      setTemplateName(activeTemplate.name);
      setElements(activeTemplate.elements as InvoiceElement[]);
      return;
    }

    // Fallback: start from default constants.
    setTemplateId(templateType === 'offer' ? 'default-offer' : 'default-invoice');
    setTemplateName(templateType === 'offer' ? 'Standard Angebot' : 'Standard Rechnung');
    setElements(templateType === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE);
  }, [activeTemplate, templateType]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [activeTab, setActiveTab] = useState<'properties' | 'layers'>('properties');
  
  // View State (Zoom/Pan)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number, y: number } | null>(null);

  // Legal Validation
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const [showValidation, setShowValidation] = useState(false);

  const selectedElement = elements.find((el) => el.id === selectedId) || null;

  const handleSaveTemplate = async (mode: 'overwrite' | 'copy' = 'overwrite') => {
    const idToSave = mode === 'copy' ? generateId() : templateId;
    const now = new Date().toISOString();
    const payload: DocumentTemplate = {
      id: idToSave,
      kind: templateType,
      name: templateName.trim() || (templateType === 'offer' ? 'Angebotsvorlage' : 'Rechnungsvorlage'),
      elements,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const saved = await upsertTemplate.mutateAsync(payload);
      await setActiveTemplate.mutateAsync({ kind: templateType, templateId: saved.id });
      setTemplateId(saved.id);
      alert('Vorlage gespeichert.');
    } catch (e) {
      alert(`Speichern fehlgeschlagen: ${String(e)}`);
    }
  };

  // --- Keyboard & Zoom/Pan Effects ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (!selectedId) return;
        
        // Arrow Keys Movement
        const moveAmount = e.shiftKey ? 10 : 1;
        let dx = 0;
        let dy = 0;

        if (e.key === 'ArrowLeft') dx = -moveAmount;
        if (e.key === 'ArrowRight') dx = moveAmount;
        if (e.key === 'ArrowUp') dy = -moveAmount;
        if (e.key === 'ArrowDown') dy = moveAmount;

        if (dx !== 0 || dy !== 0) {
            e.preventDefault();
            setElements(prev => prev.map(el => el.id === selectedId ? { ...el, x: el.x + dx, y: el.y + dy } : el));
        }

        // Delete
        if (e.key === 'Delete' || e.key === 'Backspace') {
            // Don't delete if editing text (handled in input) - simplified check via target
            if ((e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'TEXTAREA' && !(e.target as HTMLElement).isContentEditable) {
                setElements(prev => prev.filter(el => el.id !== selectedId));
                setSelectedId(null);
            }
        }
    };

    const handleWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            setZoom(prev => Math.min(Math.max(0.5, prev + delta), 3));
        }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('wheel', handleWheel);
    };
  }, [selectedId]);

  const handleAddElement = (type: ElementType) => {
    // Find highest zIndex
    const maxZ = elements.length > 0 ? Math.max(...elements.map(e => e.zIndex)) : 0;

    const newElement: InvoiceElement = {
      id: generateId(),
      type,
      x: 100, // Default drop position (relative to canvas 0,0)
      y: 100,
      zIndex: maxZ + 1,
      content: type === ElementType.TEXT ? 'Neuer Text' : undefined,
      style: {
        ...DEFAULT_TEXT_STYLE,
        width: type === ElementType.LINE ? 200 : (type === ElementType.QRCODE ? 100 : DEFAULT_TEXT_STYLE.width),
        height: type === ElementType.LINE ? 2 : (type === ElementType.QRCODE ? 100 : DEFAULT_TEXT_STYLE.height),
        backgroundColor: type === ElementType.BOX || type === ElementType.LINE ? '#cccccc' : undefined
      },
      tableData: type === ElementType.TABLE ? {
        columns: [
            { id: 'c1', label: 'Spalte 1', width: 100, visible: true, align: 'left' },
            { id: 'c2', label: 'Spalte 2', width: 100, visible: true, align: 'left' },
            { id: 'c3', label: 'Spalte 3', width: 100, visible: true, align: 'left' }
        ],
        rows: [{ id: generateId(), cells: ['Daten', 'Daten', 'Daten'] }]
      } : undefined
    };
    setElements([...elements, newElement]);
    setSelectedId(newElement.id);
    setActiveTab('properties'); 
  };

  const handleUpdateElement = (id: string, updates: Partial<InvoiceElement>) => {
    setElements((prev) =>
      prev.map((el) => (el.id === id ? { ...el, ...updates } : el))
    );
  };

  const handleDeleteElement = (id: string) => {
    setElements((prev) => prev.filter((el) => el.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
  };

  const handleBackgroundClick = () => {
    setSelectedId(null);
  };

  const handleReorderElement = (id: string, direction: 'up' | 'down' | 'front' | 'back') => {
       setElements(prev => {
          const current = prev.find(e => e.id === id);
          if (!current) return prev;
          let newElements = [...prev];
          if (direction === 'front') {
              const maxZ = Math.max(...prev.map(e => e.zIndex));
              newElements = newElements.map(e => e.id === id ? { ...e, zIndex: maxZ + 1 } : e);
          } else if (direction === 'back') {
              const minZ = Math.min(...prev.map(e => e.zIndex));
              newElements = newElements.map(e => e.id === id ? { ...e, zIndex: minZ - 1 } : e);
          }
           // Simple swap for up/down could be added here, currently just simple layering
          return newElements;
      });
  };


  // --- Legal Check ---
  const handleLegalCheck = () => {
      const issues = [];
      
      const hasSender = elements.some(e => e.label === 'sender_company' || (e.content && e.content.includes('GmbH')));
      if (!hasSender) issues.push('Absenderangabe fehlt oder unklar.');

      const hasRecipient = elements.some(e => e.label === 'recipient_block');
      if (!hasRecipient) issues.push('Empfängeradresse fehlt (DIN Feld).');
      
      const hasDate = elements.some(e => e.content && e.content.toLowerCase().includes('datum'));
      if (!hasDate) issues.push('Rechnungsdatum fehlt.');

      const hasTaxAmountPlaceholder = elements.some(
        (e) =>
          e.content &&
          (e.content.includes('{{total.tax}}') ||
            e.content.includes('{{total.taxRate}}') ||
            e.content.includes('{{total.gross}}')),
      );
      const hasTaxReasonPlaceholder = elements.some(
        (e) =>
          e.content &&
          (e.content.includes('{{invoice.taxExemptionReason}}') ||
            e.content.includes('{{invoice.taxModeLabel}}')),
      );
      const hasTaxKeyword = elements.some(
        (e) => e.content && (e.content.includes('USt') || e.content.includes('Steuer')),
      );
      if (!hasTaxAmountPlaceholder && !hasTaxReasonPlaceholder && !hasTaxKeyword) {
        issues.push('Steuerblock fehlt (z.B. {{total.tax}} oder {{invoice.taxExemptionReason}}).');
      }

      setValidationIssues(issues);
      setShowValidation(true);
      setTimeout(() => setShowValidation(false), 5000);
  };

  // --- Pan Logic ---
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) { // Middle click or Shift+Left
          setIsPanning(true);
          panStartRef.current = { x: e.clientX, y: e.clientY };
          e.preventDefault();
      } else {
          handleBackgroundClick();
      }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
      if (isPanning && panStartRef.current) {
          const dx = e.clientX - panStartRef.current.x;
          const dy = e.clientY - panStartRef.current.y;
          setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
          panStartRef.current = { x: e.clientX, y: e.clientY };
      }
  };

  const handleCanvasMouseUp = () => {
      setIsPanning(false);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#1c1c1c] font-sans text-slate-800">
        <div className="flex flex-col h-full bg-[#111111] border-r border-[#222] no-print w-72 z-20">
            <button 
                onClick={onBack}
                className="flex items-center gap-2 p-6 text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
                <ArrowLeft size={16} />
                <span className="text-xs font-bold uppercase tracking-wider">Zurück</span>
            </button>
            <div className="px-6 mb-2">
                <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded ${templateType === 'offer' ? 'bg-purple-900 text-purple-200' : 'bg-gray-800 text-gray-300'}`}>
                    {templateType === 'offer' ? 'Angebot Editor' : 'Rechnung Editor'}
                </span>
            </div>
            <div className="px-6 mb-6 animate-enter" style={{ animationDelay: '100ms' }}>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">
                Name
              </label>
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                className="w-full bg-black border border-[#333] text-white text-sm rounded-lg p-3 focus:border-accent outline-none placeholder-gray-700 transition-colors"
                placeholder={templateType === 'offer' ? 'Angebotsvorlage' : 'Rechnungsvorlage'}
              />
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => void handleSaveTemplate('overwrite')}
                  disabled={upsertTemplate.isPending || setActiveTemplate.isPending}
                  className="flex-1 bg-accent hover:bg-[#c2e035] text-black text-xs py-2 rounded-lg font-bold transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Speichern
                </button>
                <button
                  onClick={() => void handleSaveTemplate('copy')}
                  disabled={upsertTemplate.isPending || setActiveTemplate.isPending}
                  className="flex-1 bg-[#1a1a1a] hover:bg-[#222] text-white text-xs py-2 rounded-lg font-bold border border-[#333] transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Als Kopie
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
                <Toolbar
                    onAddElement={handleAddElement}
                    onLegalCheck={handleLegalCheck}
                />
            </div>
        </div>

      {/* Canvas Area */}
      <div
        className="flex-1 overflow-hidden relative flex justify-center bg-[#1c1c1c] cursor-crosshair"
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleCanvasMouseMove}
        onMouseUp={handleCanvasMouseUp}
        onMouseLeave={handleCanvasMouseUp}
      >
         {/* Top Ruler Simulation */}
         <div className="absolute top-0 left-0 right-0 h-6 bg-[#2a2a2a] border-b border-[#333] flex items-end px-12 z-10 pointer-events-none">
             {Array.from({ length: 40 }).map((_, i) => (
                 <div key={i} className="flex-1 border-r border-[#444] h-2 text-[8px] text-[#666] flex justify-end pr-1">
                     {i * 10}
                 </div>
             ))}
         </div>

        <div className="flex flex-col items-center justify-center min-h-full transition-transform duration-75 ease-linear"
             style={{
                 transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                 transformOrigin: 'center'
             }}
        >
            {/* The A4 Page */}
            <div
              className="bg-white shadow-2xl relative print-area transition-shadow"
              style={{
                width: `${A4_WIDTH_PX}px`,
                height: `${A4_HEIGHT_PX}px`,
              }}
              onMouseDown={(e) => e.stopPropagation()} // Stop pan on canvas interaction
            >
              {/* DIN Zones Visualization (Subtle) */}
              {DIN_ZONES.map((zone, i) => (
                  <div key={i} className="absolute border border-dashed border-red-300 pointer-events-none opacity-20 hover:opacity-100 transition-opacity"
                       style={{ 
                           left: zone.x, top: zone.y, 
                           width: zone.width, height: zone.height 
                       }}
                  >
                      <span className="text-[8px] text-error absolute top-1 left-1">{zone.label}</span>
                  </div>
              ))}

              {elements.map((el) => (
                <CanvasElement
                  key={el.id}
                  element={el}
                  elements={elements}
                  isSelected={selectedId === el.id}
                  onSelect={handleSelect}
                  onUpdate={handleUpdateElement}
                  onDelete={handleDeleteElement}
                  onSnap={setSnapGuides}
                  scale={zoom}
                />
              ))}

              {/* Snap Guides */}
              {snapGuides.map((guide, i) => (
                <div
                  key={i}
                  className="absolute bg-accent z-[10000] pointer-events-none no-print shadow-[0_0_4px_rgba(0,0,0,0.2)]"
                  style={{
                    left: guide.orientation === 'vertical' ? `${guide.position}px` : 0,
                    top: guide.orientation === 'horizontal' ? `${guide.position}px` : 0,
                    width: guide.orientation === 'vertical' ? '1px' : '100%',
                    height: guide.orientation === 'horizontal' ? '1px' : '100%',
                  }}
                />
              ))}
            </div>
        </div>
        
        {/* Zoom Controls Overlay */}
        <div className="absolute bottom-8 left-8 flex items-center gap-2 bg-[#111] p-2 rounded-lg border border-[#333] shadow-xl z-20">
            <button onClick={() => setZoom(z => Math.max(0.2, z - 0.1))} className="p-2 text-gray-400 hover:text-white"><ZoomOut size={16}/></button>
            <span className="text-xs text-white font-mono w-12 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(3, z + 0.1))} className="p-2 text-gray-400 hover:text-white"><ZoomIn size={16}/></button>
        </div>

        {/* Validation Overlay */}
        {showValidation && (
            <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-2xl p-4 z-50 animate-enter max-w-sm">
                <div className="flex items-center gap-2 mb-2 font-bold text-black">
                   {validationIssues.length === 0 ? <CheckCircle className="text-success" /> : <AlertTriangle className="text-error" />}
                   {validationIssues.length === 0 ? "Alles in Ordnung" : "Prüfung: Handlungsbedarf"}
                </div>
                {validationIssues.map((issue, i) => (
                    <p key={i} className="text-xs text-error flex items-center gap-2 mt-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-error"></span>
                        {issue}
                    </p>
                ))}
            </div>
        )}
      </div>

      {/* Right Sidebar */}
      <div className="flex flex-col no-print bg-[#111111] border-l border-[#222] w-80 z-20">
          <div className="flex border-b border-[#222]">
             <button 
                onClick={() => setActiveTab('properties')}
                className={`flex-1 py-4 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 ${activeTab === 'properties' ? 'text-accent bg-[#1a1a1a]' : 'text-gray-500 hover:text-white'}`}
             >
                 <SlidersHorizontal size={14} />
                 Eigenschaften
             </button>
             <button 
                onClick={() => setActiveTab('layers')}
                className={`flex-1 py-4 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 ${activeTab === 'layers' ? 'text-accent bg-[#1a1a1a]' : 'text-gray-500 hover:text-white'}`}
             >
                 <Layers size={14} />
                 Ebenen
             </button>
          </div>
          
          <div className="flex-1 overflow-hidden bg-white">
            {activeTab === 'properties' ? (
                <PropertiesPanel
                    element={selectedElement}
                    onUpdate={handleUpdateElement}
                    onDelete={handleDeleteElement}
                />
            ) : (
                <LayersPanel 
                    elements={elements}
                    selectedId={selectedId}
                    onSelect={handleSelect}
                    onReorder={handleReorderElement}
                    onDelete={handleDeleteElement}
                />
            )}
          </div>
      </div>
    </div>
  );
};
