import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Moveable from 'react-moveable';
import Selecto from 'react-selecto';
import { ElementType, type DesignerConfig, type InvoiceElement, type RenderText } from './types';
import { ElementRenderer } from './ElementRenderer';
import { GridOverlay } from './GridOverlay';
import { buildGuidelines } from './utils/snapping';

// Moveable / Selecto emit richly-typed dynamic event objects; we annotate them
// as `any` deliberately to avoid coupling to library-internal type names.
type AnyEvent = any;

export interface GridState {
  enabled: boolean;
  size: number; // px
}

export interface CanvasStageProps {
  elements: InvoiceElement[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  /** Commit a new elements array (creates one undo entry). */
  onElementsCommit: (next: InvoiceElement[]) => void;
  zoom: number;
  pan: { x: number; y: number };
  config: DesignerConfig;
  grid: GridState;
  snapEnabled: boolean;
  bypassSnap: boolean;
  renderText: RenderText;
  editingId: string | null;
  onEditingChange: (id: string | null) => void;
  onCommitText: (id: string, content: string) => void;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  /** When true (e.g. while panning), pointer selection is suppressed. */
  paused?: boolean;
}

const getId = (node: Element | null): string => (node as HTMLElement | null)?.dataset?.elementId || '';

export const CanvasStage: React.FC<CanvasStageProps> = ({
  elements,
  selectedIds,
  onSelectionChange,
  onElementsCommit,
  zoom,
  pan,
  config,
  grid,
  snapEnabled,
  bypassSnap,
  renderText,
  editingId,
  onEditingChange,
  onCommitText,
  viewportRef,
  paused = false,
}) => {
  const { pageWidthPx: pageW, pageHeightPx: pageH, mmToPx, dinZones } = config;

  const moveableRef = useRef<Moveable>(null);
  const selectoRef = useRef<Selecto>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const registry = useRef<Map<string, HTMLElement>>(new Map());
  const liveRef = useRef<Map<string, { x?: number; y?: number; width?: number; height?: number }>>(new Map());

  // Keep a fresh handle on the latest elements for gesture-end commits.
  const elementsRef = useRef(elements);
  elementsRef.current = elements;

  const setElementRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) registry.current.set(id, el);
    else registry.current.delete(id);
  };

  // Force one re-render after mount so Selecto receives the (now-attached)
  // viewport ref as its drag container.
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const immovable = useMemo(
    () => new Set(elements.filter((e) => e.locked || e.hidden).map((e) => e.id)),
    [elements],
  );

  // Resolve selected ids -> live DOM nodes after refs are attached.
  const [moveableTargets, setMoveableTargets] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    if (editingId) {
      setMoveableTargets([]);
      return;
    }
    const out: HTMLElement[] = [];
    for (const id of selectedIds) {
      if (immovable.has(id)) continue;
      const node = registry.current.get(id);
      if (node) out.push(node);
    }
    setMoveableTargets(out);
  }, [selectedIds, editingId, elements, immovable]);

  // Reposition control box when geometry changes outside of a gesture
  // (inspector edits, undo/redo, zoom, pan).
  useEffect(() => {
    moveableRef.current?.updateRect();
  }, [elements, zoom, pan]);

  const guidelines = useMemo(
    () => buildGuidelines(pageW, pageH, mmToPx, dinZones),
    [pageW, pageH, mmToPx, dinZones],
  );

  const elementGuidelines = useMemo(
    () => Array.from(registry.current.values()),
    // Recompute when the set of elements or selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [elements, selectedIds],
  );

  const flushLive = () => {
    if (liveRef.current.size === 0) return;
    const patches = liveRef.current;
    const next = elementsRef.current.map((el) => {
      const p = patches.get(el.id);
      if (!p) return el;
      const styleChanged = p.width != null || p.height != null;
      return {
        ...el,
        x: p.x != null ? Math.round(p.x) : el.x,
        y: p.y != null ? Math.round(p.y) : el.y,
        style: styleChanged
          ? {
              ...el.style,
              ...(p.width != null ? { width: Math.max(1, Math.round(p.width)) } : {}),
              ...(p.height != null ? { height: Math.max(1, Math.round(p.height)) } : {}),
            }
          : el.style,
      };
    });
    liveRef.current = new Map();
    onElementsCommit(next);
  };

  // --- Single-target gestures ---
  const onDrag = (e: AnyEvent) => {
    e.target.style.left = `${e.left}px`;
    e.target.style.top = `${e.top}px`;
    liveRef.current.set(getId(e.target), { x: e.left, y: e.top });
  };
  const onResize = (e: AnyEvent) => {
    e.target.style.width = `${e.width}px`;
    e.target.style.height = `${e.height}px`;
    e.target.style.left = `${e.drag.left}px`;
    e.target.style.top = `${e.drag.top}px`;
    liveRef.current.set(getId(e.target), { x: e.drag.left, y: e.drag.top, width: e.width, height: e.height });
  };

  // --- Group gestures ---
  const onDragGroup = (e: AnyEvent) => {
    for (const ev of e.events) {
      ev.target.style.left = `${ev.left}px`;
      ev.target.style.top = `${ev.top}px`;
      liveRef.current.set(getId(ev.target), { x: ev.left, y: ev.top });
    }
  };
  const onResizeGroup = (e: AnyEvent) => {
    for (const ev of e.events) {
      ev.target.style.width = `${ev.width}px`;
      ev.target.style.height = `${ev.height}px`;
      ev.target.style.left = `${ev.drag.left}px`;
      ev.target.style.top = `${ev.drag.top}px`;
      liveRef.current.set(getId(ev.target), { x: ev.drag.left, y: ev.drag.top, width: ev.width, height: ev.height });
    }
  };

  // --- Selecto integration ---
  const onSelectoDragStart = (e: AnyEvent) => {
    if (editingId || paused) {
      e.stop();
      return;
    }
    const moveable = moveableRef.current;
    const target = e.inputEvent.target as HTMLElement;
    if (moveable && (moveable.isMoveableElement(target) || moveableTargets.some((t) => t === target || t.contains(target)))) {
      e.stop();
    }
  };
  const onSelectEnd = (e: AnyEvent) => {
    const moveable = moveableRef.current;
    const ids = (e.selected as HTMLElement[]).map(getId).filter(Boolean);
    onSelectionChange(ids);
    if (e.isDragStart && moveable) {
      e.inputEvent.preventDefault();
      requestAnimationFrame(() => {
        moveable.waitToChangeTarget().then(() => {
          try {
            moveable.dragStart(e.inputEvent);
          } catch {
            /* target not ready — ignore */
          }
        });
      });
    }
  };

  const snappable = snapEnabled && !bypassSnap;

  return (
    <>
      {/* Scaled, pannable stage */}
      <div
        className="absolute top-0 left-0"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        <div
          ref={pageRef}
          className="bg-white shadow-2xl relative print-area"
          style={{ width: `${pageW}px`, height: `${pageH}px` }}
        >
          <GridOverlay enabled={grid.enabled} size={grid.size} width={pageW} height={pageH} />

          {/* DIN 5008 zone hints */}
          {dinZones.map((zone, i) => (
            <div
              key={i}
              className="absolute border border-dashed border-error/40 pointer-events-none opacity-15 hover:opacity-60 transition-opacity"
              style={{ left: zone.x, top: zone.y, width: zone.width, height: zone.height }}
            >
              <span className="text-[8px] text-error absolute top-0.5 left-1">{zone.label}</span>
            </div>
          ))}

          {elements.map((el) => (
            <ElementRenderer
              key={el.id}
              ref={setElementRef(el.id)}
              element={el}
              renderText={renderText}
              selected={selectedIds.includes(el.id)}
              editing={editingId === el.id}
              onTextCommit={onCommitText}
              className={el.locked || el.hidden ? undefined : 'designer-element'}
              onDoubleClick={() => {
                if (!el.locked && el.type === ElementType.TEXT) onEditingChange(el.id);
              }}
            />
          ))}
        </div>
      </div>

      {/* Transform controller (rendered outside the scaled wrapper; targets nodes inside it) */}
      <Moveable
        ref={moveableRef}
        target={moveableTargets}
        draggable
        resizable
        origin={false}
        zoom={1}
        throttleDrag={0}
        throttleResize={0}
        keepRatio={false}
        edge={false}
        renderDirections={['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']}
        snappable={snappable}
        snapThreshold={5}
        snapDirections={{ top: true, left: true, bottom: true, right: true, center: true, middle: true }}
        elementSnapDirections={{ top: true, left: true, bottom: true, right: true, center: true, middle: true }}
        elementGuidelines={elementGuidelines}
        verticalGuidelines={guidelines.vertical}
        horizontalGuidelines={guidelines.horizontal}
        snapGridWidth={grid.enabled ? grid.size : undefined}
        snapGridHeight={grid.enabled ? grid.size : undefined}
        isDisplaySnapDigit
        bounds={{
          left: pan.x,
          top: pan.y,
          right: pan.x + pageW * zoom,
          bottom: pan.y + pageH * zoom,
          position: 'client',
        }}
        onDrag={onDrag}
        onDragEnd={flushLive}
        onResize={onResize}
        onResizeEnd={flushLive}
        onDragGroup={onDragGroup}
        onDragGroupEnd={flushLive}
        onResizeGroup={onResizeGroup}
        onResizeGroupEnd={flushLive}
        onClickGroup={(e: AnyEvent) => {
          selectoRef.current?.clickTarget(e.inputEvent, e.inputTarget);
        }}
      />

      <Selecto
        ref={selectoRef}
        dragContainer={viewportRef.current ?? undefined}
        selectableTargets={['.designer-element']}
        hitRate={0}
        selectByClick
        selectFromInside={false}
        toggleContinueSelect={['shift']}
        ratio={0}
        onDragStart={onSelectoDragStart}
        onSelectEnd={onSelectEnd}
      />
    </>
  );
};
