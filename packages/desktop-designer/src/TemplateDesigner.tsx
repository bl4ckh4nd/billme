import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, AlertTriangle, SlidersHorizontal, Layers } from 'lucide-react';
import {
  ElementType,
  type DesignerConfig,
  type InvoiceElement,
  type LegalRule,
  type RenderText,
  type VariableGroup,
} from './types';
import { A4_WIDTH_PX, A4_HEIGHT_PX, MM_TO_PX, DIN_ZONES } from './constants';
import { TopBar } from './TopBar';
import { ElementRail } from './ElementRail';
import { CanvasStage } from './CanvasStage';
import { Inspector } from './Inspector';
import { LayersPanel } from './LayersPanel';
import { Rulers, RULER_SIZE } from './Rulers';
import { useHistory } from './hooks/useHistory';
import { useZoomPan } from './hooks/useZoomPan';
import { useDesignerKeyboard } from './hooks/useDesignerKeyboard';
import {
  addElement as addElementOp,
  duplicateElements,
  nudgeElements,
  removeElements,
  reorderElement,
  type ReorderDirection,
} from './utils/elements';
import { alignElements, distributeElements, type AlignType, type DistributeAxis } from './utils/align';
import { generateId } from './utils/id';

export interface TemplateDesignerProps {
  templateType: 'invoice' | 'offer';
  onBack: () => void;
  activeTemplate: { id: string; name: string; elements: InvoiceElement[] } | null | undefined;
  /** Persist the template. Returns the saved id (for copies). */
  onSave: (payload: {
    id: string;
    name: string;
    elements: InvoiceElement[];
    mode: 'overwrite' | 'copy';
  }) => Promise<string | void> | string | void;
  saving?: boolean;
  legalRules: LegalRule[];
  variableGroups: VariableGroup[];
  renderText: RenderText;
  /** Optional overrides for page geometry / DIN zones. */
  configOverrides?: Partial<Pick<DesignerConfig, 'pageWidthPx' | 'pageHeightPx' | 'mmToPx' | 'dinZones'>>;
  initialTemplate: InvoiceElement[];
  /** Show a toast/notification. */
  notify?: (message: string, type?: 'success' | 'error') => void;
  /** Export hook (defaults to window.print). */
  onExport?: () => void;
}

const GRID_DEFAULT_MM = 5;

export const TemplateDesigner: React.FC<TemplateDesignerProps> = ({
  templateType,
  onBack,
  activeTemplate,
  onSave,
  saving = false,
  legalRules,
  variableGroups,
  renderText,
  configOverrides,
  initialTemplate,
  notify,
  onExport,
}) => {
  const config: DesignerConfig = useMemo(
    () => ({
      pageWidthPx: configOverrides?.pageWidthPx ?? A4_WIDTH_PX,
      pageHeightPx: configOverrides?.pageHeightPx ?? A4_HEIGHT_PX,
      mmToPx: configOverrides?.mmToPx ?? MM_TO_PX,
      dinZones: configOverrides?.dinZones ?? DIN_ZONES,
      variableGroups,
      renderText,
      legalRules,
    }),
    [configOverrides, variableGroups, renderText, legalRules],
  );
  const { pageWidthPx: pageW, pageHeightPx: pageH, mmToPx } = config;

  const viewportRef = useRef<HTMLDivElement>(null);
  const clipboardRef = useRef<InvoiceElement[]>([]);

  const history = useHistory<InvoiceElement[]>(initialTemplate);
  const elements = history.state;

  const [templateId, setTemplateId] = useState<string>(activeTemplate?.id ?? generateId());
  const [templateName, setTemplateName] = useState<string>(
    activeTemplate?.name ?? (templateType === 'offer' ? 'Standard Angebot' : 'Standard Rechnung'),
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'inspector' | 'layers'>('inspector');

  const [grid, setGrid] = useState({ enabled: false, size: GRID_DEFAULT_MM * mmToPx });
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [bypassSnap, setBypassSnap] = useState(false);

  const [validation, setValidation] = useState<{ issues: string[]; show: boolean }>({ issues: [], show: false });

  const zoomPan = useZoomPan(viewportRef, pageW, pageH);

  // Load active template (or fall back to the initial template).
  useEffect(() => {
    if (activeTemplate) {
      setTemplateId(activeTemplate.id);
      setTemplateName(activeTemplate.name);
      history.reset(activeTemplate.elements as InvoiceElement[]);
    } else {
      history.reset(initialTemplate);
    }
    setSelectedIds([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate, templateType]);

  // --- Mutations (all go through history) ---
  const patchElement = useCallback(
    (id: string, updates: Partial<InvoiceElement>) => {
      history.set((prev) => prev.map((el) => (el.id === id ? { ...el, ...updates } : el)), { coalesce: true });
    },
    [history],
  );

  const deleteElements = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      history.set((prev) => removeElements(prev, ids));
      setSelectedIds((cur) => cur.filter((id) => !ids.includes(id)));
    },
    [history],
  );

  const handleAddElement = useCallback(
    (type: ElementType) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const vw = rect?.width ?? pageW;
      const vh = rect?.height ?? pageH;
      const cx = (vw / 2 - zoomPan.pan.x) / zoomPan.zoom;
      const cy = (vh / 2 - zoomPan.pan.y) / zoomPan.zoom;
      const x = Math.max(0, Math.min(pageW - 120, cx - 60));
      const y = Math.max(0, Math.min(pageH - 40, cy - 20));
      let newId = '';
      history.set((prev) => {
        const res = addElementOp(prev, type, { x, y }, { width: pageW, height: pageH });
        newId = res.id;
        return res.elements;
      });
      setSelectedIds(newId ? [newId] : []);
      setActiveTab('inspector');
    },
    [history, zoomPan.pan, zoomPan.zoom, pageW, pageH],
  );

  const duplicateSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    let created: string[] = [];
    history.set((prev) => {
      const res = duplicateElements(prev, selectedIds);
      created = res.ids;
      return res.elements;
    });
    if (created.length) setSelectedIds(created);
  }, [history, selectedIds]);

  const copySelected = useCallback(() => {
    clipboardRef.current = elements.filter((el) => selectedIds.includes(el.id));
  }, [elements, selectedIds]);

  const paste = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip.length) return;
    let created: string[] = [];
    history.set((prev) => {
      const ids = clip.map((c) => c.id);
      // Re-add the clipboard items first so duplicateElements can offset them.
      const withClip = [...prev, ...clip.filter((c) => !prev.some((p) => p.id === c.id))];
      const res = duplicateElements(withClip, ids);
      created = res.ids;
      // Only keep originals that already existed plus the fresh clones.
      return [...prev, ...res.elements.filter((e) => res.ids.includes(e.id))];
    });
    if (created.length) setSelectedIds(created);
  }, [history]);

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (selectedIds.length === 0) return;
      history.set((prev) => nudgeElements(prev, selectedIds, dx, dy), { coalesce: true });
    },
    [history, selectedIds],
  );

  const reorder = useCallback(
    (id: string, direction: ReorderDirection) => history.set((prev) => reorderElement(prev, id, direction)),
    [history],
  );

  const toggleLock = useCallback(
    (id: string) => history.set((prev) => prev.map((el) => (el.id === id ? { ...el, locked: !el.locked } : el))),
    [history],
  );
  const toggleHidden = useCallback(
    (id: string) => history.set((prev) => prev.map((el) => (el.id === id ? { ...el, hidden: !el.hidden } : el))),
    [history],
  );

  const align = useCallback((type: AlignType) => history.set((prev) => alignElements(prev, selectedIds, type)), [history, selectedIds]);
  const distribute = useCallback((axis: DistributeAxis) => history.set((prev) => distributeElements(prev, selectedIds, axis)), [history, selectedIds]);

  const commitText = useCallback(
    (id: string, content: string) => {
      history.set((prev) => prev.map((el) => (el.id === id ? { ...el, content } : el)));
      setEditingId(null);
    },
    [history],
  );

  const onEscape = useCallback(() => {
    if (editingId) setEditingId(null);
    else setSelectedIds([]);
  }, [editingId]);

  // --- Save / legal / export ---
  const handleSave = useCallback(
    async (mode: 'overwrite' | 'copy') => {
      const id = mode === 'copy' ? generateId() : templateId;
      const name = templateName.trim() || (templateType === 'offer' ? 'Angebotsvorlage' : 'Rechnungsvorlage');
      try {
        const saved = await onSave({ id, name, elements, mode });
        const nextId = typeof saved === 'string' ? saved : id;
        setTemplateId(nextId);
        notify?.('Vorlage gespeichert.', 'success');
      } catch (e) {
        notify?.(`Speichern fehlgeschlagen: ${String(e)}`, 'error');
      }
    },
    [templateId, templateName, templateType, elements, onSave, notify],
  );

  const handleLegalCheck = useCallback(() => {
    const issues = legalRules.flatMap((rule) => rule(elements));
    setValidation({ issues, show: true });
    window.setTimeout(() => setValidation((v) => ({ ...v, show: false })), 6000);
  }, [legalRules, elements]);

  const handleExport = useCallback(() => {
    if (onExport) onExport();
    else window.print();
  }, [onExport]);

  // Keyboard shortcuts
  useDesignerKeyboard({
    enabled: editingId === null,
    onNudge: nudge,
    onDelete: () => deleteElements(selectedIds),
    onDuplicate: duplicateSelected,
    onCopy: copySelected,
    onPaste: paste,
    onUndo: history.undo,
    onRedo: history.redo,
    onSelectAll: () => setSelectedIds(elements.map((el) => el.id)),
    onEscape,
    onSave: () => void handleSave('overwrite'),
    onBypassSnapChange: setBypassSnap,
  });

  const cursor = zoomPan.isPanning ? 'grabbing' : zoomPan.spaceDown ? 'grab' : 'default';

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-dark-3 font-sans text-dark-muted">
      <TopBar
        templateName={templateName}
        onRenameTemplate={setTemplateName}
        templateType={templateType}
        onBack={onBack}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={history.undo}
        onRedo={history.redo}
        zoom={zoomPan.zoom}
        onZoomIn={zoomPan.zoomIn}
        onZoomOut={zoomPan.zoomOut}
        onZoomTo={(z) => zoomPan.zoomTo(z)}
        onFit={zoomPan.fitToScreen}
        onReset={zoomPan.resetZoom}
        gridEnabled={grid.enabled}
        onToggleGrid={() => setGrid((g) => ({ ...g, enabled: !g.enabled }))}
        gridSize={grid.size}
        onGridSize={(px) => setGrid((g) => ({ ...g, size: px }))}
        mmToPx={mmToPx}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled((s) => !s)}
        onSave={() => void handleSave('overwrite')}
        onSaveCopy={() => void handleSave('copy')}
        saving={saving}
        onLegalCheck={handleLegalCheck}
        onExport={handleExport}
      />

      <div className="flex flex-1 overflow-hidden">
        <ElementRail onAddElement={handleAddElement} />

        {/* Canvas viewport */}
        <div ref={viewportRef} className="relative flex-1 overflow-hidden bg-editor-viewport" style={{ cursor }}>
          <CanvasStage
            elements={elements}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            onElementsCommit={(next) => history.set(next)}
            zoom={zoomPan.zoom}
            pan={zoomPan.pan}
            config={config}
            grid={grid}
            snapEnabled={snapEnabled}
            bypassSnap={bypassSnap}
            renderText={renderText}
            editingId={editingId}
            onEditingChange={setEditingId}
            onCommitText={commitText}
            viewportRef={viewportRef}
            paused={zoomPan.isPanning || zoomPan.spaceDown}
          />

          <Rulers zoom={zoomPan.zoom} pan={zoomPan.pan} mmToPx={mmToPx} viewportRef={viewportRef} />

          {/* Validation overlay */}
          {validation.show && (
            <div className="absolute left-1/2 top-8 z-40 max-w-sm -translate-x-1/2 rounded-xl bg-white p-4 shadow-2xl no-print">
              <div className="mb-2 flex items-center gap-2 font-bold text-black">
                {validation.issues.length === 0 ? <CheckCircle className="text-success" /> : <AlertTriangle className="text-error" />}
                {validation.issues.length === 0 ? 'Alles in Ordnung' : 'Prüfung: Handlungsbedarf'}
              </div>
              {validation.issues.map((issue, i) => (
                <p key={i} className="mt-1 flex items-center gap-2 text-xs text-error">
                  <span className="h-1.5 w-1.5 rounded-full bg-error" />
                  {issue}
                </p>
              ))}
            </div>
          )}

          {/* Hint */}
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-dark-1/80 px-3 py-1 text-[10px] text-dark-muted no-print">
            Leertaste/Mittelklick zum Verschieben · Strg+Scroll zum Zoomen · Alt hält Einrasten an
          </div>
        </div>

        {/* Right inspector / layers */}
        <div className="z-20 flex w-80 flex-col border-l border-dark-border bg-white no-print">
          <div className="flex border-b border-border">
            <button
              onClick={() => setActiveTab('inspector')}
              className={`flex flex-1 items-center justify-center gap-2 py-4 text-xs font-bold uppercase tracking-wider transition-colors ${
                activeTab === 'inspector' ? 'border-b-2 border-black text-black' : 'text-muted hover:text-foreground'
              }`}
            >
              <SlidersHorizontal size={14} />
              Eigenschaften
            </button>
            <button
              onClick={() => setActiveTab('layers')}
              className={`flex flex-1 items-center justify-center gap-2 py-4 text-xs font-bold uppercase tracking-wider transition-colors ${
                activeTab === 'layers' ? 'border-b-2 border-black text-black' : 'text-muted hover:text-foreground'
              }`}
            >
              <Layers size={14} />
              Ebenen
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            {activeTab === 'inspector' ? (
              <Inspector
                elements={elements}
                selectedIds={selectedIds}
                pageWidthPx={pageW}
                pageHeightPx={pageH}
                onUpdate={patchElement}
                onDelete={deleteElements}
                onAlign={align}
                onDistribute={distribute}
                variableGroups={variableGroups}
              />
            ) : (
              <LayersPanel
                elements={elements}
                selectedIds={selectedIds}
                onSelect={(id, additive) =>
                  setSelectedIds((cur) =>
                    additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id],
                  )
                }
                onReorder={reorder}
                onDelete={deleteElements}
                onToggleLock={toggleLock}
                onToggleHidden={toggleHidden}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
