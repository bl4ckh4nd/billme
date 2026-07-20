import React, { useState } from 'react';
import { ElementType, type InvoiceElement, type ElementStyle, type TableColumn, type VariableGroup } from './types';
import {
  Type,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Underline,
  Trash2,
  Columns,
  Eye,
  EyeOff,
  AlertTriangle,
  Database,
  ChevronDown,
  ChevronRight,
  Link2,
  Unlink2,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
} from 'lucide-react';
import type { AlignType, DistributeAxis } from './utils/align';

export interface InspectorProps {
  elements: InvoiceElement[];
  selectedIds: string[];
  onUpdate: (id: string, updates: Partial<InvoiceElement>) => void;
  onDelete: (ids: string[]) => void;
  onAlign: (type: AlignType) => void;
  onDistribute: (axis: DistributeAxis) => void;
  variableGroups: VariableGroup[];
}

const numberField =
  'w-full border border-border bg-surface-muted rounded-lg p-2 text-sm focus:ring-2 focus:ring-accent outline-none tabular-nums';
const fieldLabel = 'text-[10px] text-muted font-medium mb-1 block';
// Group sections with whitespace (gap-6 between blocks), not hard dividers.
const sectionLabel = 'text-[11px] font-bold text-muted uppercase tracking-wider block';

const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-full p-8 text-muted">
    <div className="w-16 h-16 bg-surface-muted rounded-2xl flex items-center justify-center mb-4">
      <Type size={32} className="opacity-20 text-black" />
    </div>
    <p className="text-center font-medium">Element auswählen, um es zu bearbeiten</p>
    <p className="text-center text-xs mt-1 text-muted">Mehrfachauswahl mit Umschalt-Klick oder Rahmen ziehen</p>
  </div>
);

const AlignButton: React.FC<{ title: string; onClick: () => void; children: React.ReactNode }> = ({
  title,
  onClick,
  children,
}) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={title}
    className="flex h-9 flex-1 items-center justify-center rounded-lg border border-border bg-white text-muted hover:border-black hover:bg-black hover:text-accent transition-colors"
  >
    {children}
  </button>
);

const MultiPanel: React.FC<{
  count: number;
  onAlign: (t: AlignType) => void;
  onDistribute: (a: DistributeAxis) => void;
  onDelete: () => void;
}> = ({ count, onAlign, onDistribute, onDelete }) => (
  <div className="flex flex-col gap-6 p-6 h-full overflow-y-auto">
    <div>
      <h3 className="font-bold text-xl mb-1 text-black">{count} Elemente</h3>
      <span className="inline-block bg-accent px-2 py-1 rounded text-[10px] font-bold tracking-widest uppercase text-black">
        Mehrfachauswahl
      </span>
    </div>
    <div className="space-y-3">
      <label className={sectionLabel}>Ausrichten</label>
      <div className="flex gap-2">
        <AlignButton title="Links ausrichten" onClick={() => onAlign('left')}>
          <AlignStartVertical size={16} />
        </AlignButton>
        <AlignButton title="Horizontal zentrieren" onClick={() => onAlign('hcenter')}>
          <AlignCenterVertical size={16} />
        </AlignButton>
        <AlignButton title="Rechts ausrichten" onClick={() => onAlign('right')}>
          <AlignEndVertical size={16} />
        </AlignButton>
      </div>
      <div className="flex gap-2">
        <AlignButton title="Oben ausrichten" onClick={() => onAlign('top')}>
          <AlignStartHorizontal size={16} />
        </AlignButton>
        <AlignButton title="Vertikal zentrieren" onClick={() => onAlign('vmiddle')}>
          <AlignCenterHorizontal size={16} />
        </AlignButton>
        <AlignButton title="Unten ausrichten" onClick={() => onAlign('bottom')}>
          <AlignEndHorizontal size={16} />
        </AlignButton>
      </div>
    </div>
    <div className="space-y-3">
      <label className={sectionLabel}>Verteilen (3+)</label>
      <div className="flex gap-2">
        <AlignButton title="Horizontal verteilen" onClick={() => onDistribute('horizontal')}>
          <AlignHorizontalSpaceAround size={16} />
        </AlignButton>
        <AlignButton title="Vertikal verteilen" onClick={() => onDistribute('vertical')}>
          <AlignVerticalSpaceAround size={16} />
        </AlignButton>
      </div>
    </div>
    <div className="mt-auto pt-6">
      <button
        onClick={onDelete}
        className="w-full flex items-center justify-center gap-2 text-error border border-error/30 bg-error-bg hover:bg-error-bg/80 p-3 rounded-xl transition-colors font-medium text-sm"
      >
        <Trash2 size={16} />
        {count} Elemente löschen
      </button>
    </div>
  </div>
);

export const Inspector: React.FC<InspectorProps> = ({
  elements,
  selectedIds,
  onUpdate,
  onDelete,
  onAlign,
  onDistribute,
  variableGroups,
}) => {
  const [openVariableGroup, setOpenVariableGroup] = useState<string | null>('Rechnung');
  const [aspectLocked, setAspectLocked] = useState(false);

  if (selectedIds.length === 0) return <EmptyState />;
  if (selectedIds.length > 1) {
    return (
      <MultiPanel
        count={selectedIds.length}
        onAlign={onAlign}
        onDistribute={onDistribute}
        onDelete={() => onDelete(selectedIds)}
      />
    );
  }

  const element = elements.find((e) => e.id === selectedIds[0]);
  if (!element) return <EmptyState />;

  const setStyle = (patch: Partial<ElementStyle>) => onUpdate(element.id, { style: { ...element.style, ...patch } });
  const styleVal = (k: keyof ElementStyle) => element.style[k];

  const onWidth = (w: number) => {
    if (aspectLocked && element.style.width && element.style.height) {
      const ratio = element.style.height / element.style.width;
      setStyle({ width: w, height: Math.round(w * ratio) });
    } else {
      setStyle({ width: w });
    }
  };
  const onHeight = (h: number) => {
    if (aspectLocked && element.style.width && element.style.height) {
      const ratio = element.style.width / element.style.height;
      setStyle({ height: h, width: Math.round(h * ratio) });
    } else {
      setStyle({ height: h });
    }
  };

  const insertVariable = (key: string) => onUpdate(element.id, { content: (element.content || '') + `{{${key}}}` });

  const updateColumn = (index: number, field: keyof TableColumn, value: unknown) => {
    if (!element.tableData?.columns) return;
    const cols = [...element.tableData.columns];
    cols[index] = { ...cols[index], [field]: value } as TableColumn;
    onUpdate(element.id, { tableData: { ...element.tableData, columns: cols } });
  };
  const totalColWidth = element.tableData?.columns?.filter((c) => c.visible).reduce((a, c) => a + (c.width || 0), 0) || 0;
  const isOverflowing = totalColWidth > (element.style.width || 0);

  const isText = element.type === ElementType.TEXT;
  const isTable = element.type === ElementType.TABLE;
  const isLine = element.type === ElementType.LINE;

  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-y-auto">
      <div>
        <h3 className="font-bold text-xl mb-1 text-black">Eigenschaften</h3>
        <span className="inline-block bg-accent px-2 py-1 rounded text-[10px] font-bold tracking-widest uppercase text-black">
          {element.type}
        </span>
      </div>

      {/* Text content + variables */}
      {isText && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-bold text-muted uppercase tracking-wide">Inhalt</label>
          <textarea
            className="w-full border border-border bg-surface-muted rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent focus:border-transparent outline-none min-h-[100px] text-foreground resize-none font-mono"
            value={element.content || ''}
            onChange={(e) => onUpdate(element.id, { content: e.target.value })}
            placeholder="Text eingeben…"
          />
          <div className="border border-border-subtle rounded-xl bg-surface-muted overflow-hidden">
            <div className="p-2 border-b border-border bg-canvas flex items-center gap-2 text-xs font-bold text-muted">
              <Database size={12} />
              Dynamische Daten einfügen
            </div>
            <div className="p-2 space-y-1">
              {variableGroups.map((group) => (
                <div key={group.title} className="rounded-lg bg-white border border-border overflow-hidden">
                  <button
                    onClick={() => setOpenVariableGroup(openVariableGroup === group.title ? null : group.title)}
                    className="w-full flex items-center justify-between p-2 text-left hover:bg-surface-muted transition-colors"
                  >
                    <span className="text-[10px] font-bold uppercase">{group.title}</span>
                    {openVariableGroup === group.title ? (
                      <ChevronDown size={12} className="text-muted" />
                    ) : (
                      <ChevronRight size={12} className="text-muted" />
                    )}
                  </button>
                  {openVariableGroup === group.title && (
                    <div className="p-2 bg-surface-muted grid grid-cols-1 gap-1 border-t border-border-subtle">
                      {group.variables.map((v) => (
                        <button
                          key={v.key}
                          onClick={() => insertVariable(v.key)}
                          className="text-left px-2 py-1.5 rounded hover:bg-accent/15 hover:text-foreground text-xs font-medium text-muted flex items-center justify-between group/item"
                          title={v.description}
                        >
                          <span>{v.label}</span>
                          <span className="text-[9px] opacity-0 group-hover/item:opacity-100 text-muted">+ Einfügen</span>
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

      {/* Table columns */}
      {isTable && element.tableData?.columns && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <label className="text-[11px] font-bold text-muted uppercase tracking-wider">Spaltenkonfiguration</label>
            <Columns size={14} className="text-muted" />
          </div>
          <div
            className={`text-[10px] font-bold p-2 rounded flex items-center gap-2 ${
              isOverflowing ? 'bg-error-bg text-error' : 'bg-surface-muted text-muted'
            }`}
          >
            {isOverflowing && <AlertTriangle size={12} />}
            <span>
              Summe: {Math.round(totalColWidth)}px / {element.style.width || 0}px
            </span>
          </div>
          <div className="space-y-3">
            {element.tableData.columns.map((col, idx) => (
              <div
                key={col.id}
                className={`p-3 rounded-lg border transition-all ${
                  col.visible ? 'bg-white border-border' : 'bg-surface-muted border-transparent opacity-60'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <input
                    type="text"
                    value={col.label}
                    onChange={(e) => updateColumn(idx, 'label', e.target.value)}
                    className="text-xs font-bold bg-transparent outline-none border-b border-transparent focus:border-accent w-24"
                  />
                  <button
                    onClick={() => updateColumn(idx, 'visible', !col.visible)}
                    className={`p-1 rounded hover:bg-canvas ${col.visible ? 'text-black' : 'text-muted'}`}
                  >
                    {col.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                </div>
                {col.visible && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[9px] text-muted uppercase font-bold">Breite</label>
                      <input
                        type="number"
                        value={col.width}
                        onChange={(e) => updateColumn(idx, 'width', Number(e.target.value))}
                        className="w-full bg-surface-muted rounded-lg p-1 text-xs outline-none focus:ring-1 focus:ring-accent tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] text-muted uppercase font-bold">Ausr.</label>
                      <div className="flex bg-surface-muted rounded p-0.5">
                        {(['left', 'center', 'right'] as const).map((align) => (
                          <button
                            key={align}
                            onClick={() => updateColumn(idx, 'align', align)}
                            className={`flex-1 flex justify-center py-1 rounded ${
                              col.align === align ? 'bg-white shadow text-black' : 'text-muted'
                            }`}
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

      {/* QR */}
      {element.type === ElementType.QRCODE && (
        <div className="flex flex-col gap-4">
          <label className={sectionLabel}>GiroCode Daten</label>
          <div>
            <label className={fieldLabel}>IBAN</label>
            <input
              type="text"
              className="w-full border border-border bg-surface-muted rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
              placeholder="DE12…"
              value={element.qrData?.iban || ''}
              onChange={(e) =>
                onUpdate(element.id, {
                  qrData: { iban: e.target.value, bic: element.qrData?.bic || '', amount: element.qrData?.amount || 0, reference: element.qrData?.reference || '' },
                })
              }
            />
          </div>
          <div>
            <label className={fieldLabel}>BIC</label>
            <input
              type="text"
              className="w-full border border-border bg-surface-muted rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none"
              value={element.qrData?.bic || ''}
              onChange={(e) =>
                onUpdate(element.id, {
                  qrData: { iban: element.qrData?.iban || '', bic: e.target.value, amount: element.qrData?.amount || 0, reference: element.qrData?.reference || '' },
                })
              }
            />
          </div>
        </div>
      )}

      {/* Layout */}
      <div className="space-y-4">
        <label className={sectionLabel}>Layout</label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={fieldLabel}>X</label>
            <input type="number" className={numberField} value={Math.round(element.x)} onChange={(e) => onUpdate(element.id, { x: Number(e.target.value) })} />
          </div>
          <div>
            <label className={fieldLabel}>Y</label>
            <input type="number" className={numberField} value={Math.round(element.y)} onChange={(e) => onUpdate(element.id, { y: Number(e.target.value) })} />
          </div>
          <div>
            <label className={fieldLabel}>Breite</label>
            <input type="number" className={numberField} value={element.style.width ?? ''} onChange={(e) => onWidth(Number(e.target.value))} />
          </div>
          <div>
            <label className={fieldLabel}>Höhe</label>
            <input type="number" className={numberField} value={element.style.height ?? ''} onChange={(e) => onHeight(Number(e.target.value))} />
          </div>
        </div>
        <button
          onClick={() => setAspectLocked((v) => !v)}
          className={`flex items-center gap-2 text-xs font-medium rounded-lg px-3 py-2 border transition-colors ${
            aspectLocked ? 'bg-black text-accent border-black' : 'bg-surface-muted text-muted border-border hover:border-border'
          }`}
        >
          {aspectLocked ? <Link2 size={14} /> : <Unlink2 size={14} />}
          Seitenverhältnis sperren
        </button>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className={fieldLabel}>Deckkraft</label>
            <span className="text-[10px] text-muted tabular-nums">{Math.round((element.style.opacity ?? 1) * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((element.style.opacity ?? 1) * 100)}
            onChange={(e) => setStyle({ opacity: Number(e.target.value) / 100 })}
            className="w-full accent-black"
          />
        </div>
      </div>

      {/* Typography */}
      {(isText || isTable) && (
        <div className="space-y-4">
          <label className={sectionLabel}>Typografie</label>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className={fieldLabel}>Farbe</label>
              <div className="flex items-center gap-2 bg-surface-muted p-1.5 rounded-lg border border-border">
                <input type="color" value={(styleVal('color') as string) || '#000000'} onChange={(e) => setStyle({ color: e.target.value })} className="h-6 w-6 rounded cursor-pointer border-none bg-transparent" />
                <span className="text-xs text-muted font-mono">{element.style.color}</span>
              </div>
            </div>
            <div className="w-20">
              <label className={fieldLabel}>Größe</label>
              <input type="number" value={element.style.fontSize || 12} onChange={(e) => setStyle({ fontSize: Number(e.target.value) })} className={numberField} />
            </div>
          </div>
          <div>
            <label className={fieldLabel}>Schriftart</label>
            <select value={element.style.fontFamily || 'Inter, sans-serif'} onChange={(e) => setStyle({ fontFamily: e.target.value })} className="w-full border border-border bg-surface-muted rounded-xl p-2 text-sm focus:ring-2 focus:ring-accent outline-none">
              <option value="Inter, sans-serif">Inter (Modern)</option>
              <option value="Times New Roman, serif">Times (Classic)</option>
              <option value="Arial, sans-serif">Arial</option>
              <option value="Courier New, monospace">Courier (Mono)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>Zeilenhöhe</label>
              <input type="number" step={0.1} value={element.style.lineHeight ?? ''} placeholder="1.2" onChange={(e) => setStyle({ lineHeight: e.target.value ? Number(e.target.value) : undefined })} className={numberField} />
            </div>
            <div>
              <label className={fieldLabel}>Laufweite</label>
              <input type="number" step={0.1} value={element.style.letterSpacing ?? ''} placeholder="0" onChange={(e) => setStyle({ letterSpacing: e.target.value ? Number(e.target.value) : undefined })} className={numberField} />
            </div>
          </div>
          <div className="flex bg-canvas rounded-lg p-1 gap-1 justify-between">
            <button onClick={() => setStyle({ textAlign: 'left' })} className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.textAlign === 'left' ? 'bg-white shadow-sm text-black' : 'text-muted hover:bg-canvas'}`}>
              <AlignLeft size={16} />
            </button>
            <button onClick={() => setStyle({ textAlign: 'center' })} className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.textAlign === 'center' ? 'bg-white shadow-sm text-black' : 'text-muted hover:bg-canvas'}`}>
              <AlignCenter size={16} />
            </button>
            <button onClick={() => setStyle({ textAlign: 'right' })} className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.textAlign === 'right' ? 'bg-white shadow-sm text-black' : 'text-muted hover:bg-canvas'}`}>
              <AlignRight size={16} />
            </button>
            <div className="w-px bg-border mx-1 my-1" />
            <button onClick={() => setStyle({ fontWeight: element.style.fontWeight === 'bold' ? 'normal' : 'bold' })} className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.fontWeight === 'bold' ? 'bg-black text-accent' : 'text-muted hover:bg-canvas'}`}>
              <Bold size={16} />
            </button>
            <button onClick={() => setStyle({ textDecoration: element.style.textDecoration === 'underline' ? 'none' : 'underline' })} className={`flex-1 py-1.5 rounded-lg flex justify-center transition-all ${element.style.textDecoration === 'underline' ? 'bg-black text-accent' : 'text-muted hover:bg-canvas'}`}>
              <Underline size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Fill + border (box/image/text) */}
      {!isLine && (
        <div className="space-y-4">
          <label className={sectionLabel}>Füllung & Rahmen</label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>Hintergrund</label>
              <input type="color" value={element.style.backgroundColor || '#ffffff'} onChange={(e) => setStyle({ backgroundColor: e.target.value })} className="h-9 w-full rounded-lg cursor-pointer border border-border" />
            </div>
            <div>
              <label className={fieldLabel}>Radius</label>
              <input type="number" value={element.style.borderRadius ?? ''} placeholder="0" onChange={(e) => setStyle({ borderRadius: e.target.value ? Number(e.target.value) : undefined })} className={numberField} />
            </div>
            <div>
              <label className={fieldLabel}>Rahmen px</label>
              <input type="number" value={element.style.borderWidth ?? ''} placeholder="0" onChange={(e) => setStyle({ borderWidth: e.target.value ? Number(e.target.value) : undefined })} className={numberField} />
            </div>
            <div>
              <label className={fieldLabel}>Rahmenfarbe</label>
              <input type="color" value={element.style.borderColor || '#000000'} onChange={(e) => setStyle({ borderColor: e.target.value })} className="h-9 w-full rounded-lg cursor-pointer border border-border" />
            </div>
            <div>
              <label className={fieldLabel}>Innenabstand</label>
              <input type="number" value={element.style.padding ?? ''} placeholder={isText ? '4' : '0'} onChange={(e) => setStyle({ padding: e.target.value ? Number(e.target.value) : undefined })} className={numberField} />
            </div>
          </div>
        </div>
      )}

      {/* Line settings */}
      {isLine && (
        <div className="space-y-4">
          <label className={sectionLabel}>Linien-Einstellungen</label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>Farbe</label>
              <input type="color" value={element.style.backgroundColor || '#000000'} onChange={(e) => setStyle({ backgroundColor: e.target.value })} className="h-10 w-full rounded-lg cursor-pointer border border-border" />
            </div>
            <div>
              <label className={fieldLabel}>Dicke</label>
              <input type="number" value={element.style.height || 1} onChange={(e) => setStyle({ height: Number(e.target.value) })} className={numberField} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-auto pt-6">
        <button
          onClick={() => onDelete([element.id])}
          className="w-full flex items-center justify-center gap-2 text-error border border-error/30 bg-error-bg hover:bg-error-bg/80 p-3 rounded-xl transition-colors font-medium text-sm"
        >
          <Trash2 size={16} />
          Element löschen
        </button>
      </div>
    </div>
  );
};
