import { useCallback, useEffect, useRef, useState } from 'react';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export interface Pan {
  x: number;
  y: number;
}

export interface ZoomPan {
  zoom: number;
  pan: Pan;
  setPan: (pan: Pan) => void;
  /** Zoom to an absolute level, optionally anchored at a viewport-client point. */
  zoomTo: (next: number, anchor?: { clientX: number; clientY: number }) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** 100%, centered horizontally at the top of the page. */
  resetZoom: () => void;
  /** Scale + center so the whole page fits the viewport. */
  fitToScreen: () => void;
  isPanning: boolean;
  spaceDown: boolean;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * Owns zoom + pan for the canvas viewport. Attaches non-passive wheel and
 * pointer listeners to `viewportRef` so ctrl/cmd+wheel zooms toward the cursor,
 * plain wheel pans, and middle-drag / space-drag pans the page.
 */
export function useZoomPan(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  pageWidth: number,
  pageHeight: number,
): ZoomPan {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 40, y: 40 });
  const [isPanning, setIsPanning] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);

  // Mirror state into refs so the imperative listeners read fresh values.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const spaceRef = useRef(false);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const viewportPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
    },
    [viewportRef],
  );

  const zoomTo = useCallback(
    (next: number, anchor?: { clientX: number; clientY: number }) => {
      const target = clamp(next, MIN_ZOOM, MAX_ZOOM);
      const prev = zoomRef.current;
      if (target === prev) return;
      const rect = viewportRef.current?.getBoundingClientRect();
      const c = anchor
        ? { x: anchor.clientX - (rect?.left ?? 0), y: anchor.clientY - (rect?.top ?? 0) }
        : { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
      const p = panRef.current;
      const ratio = target / prev;
      setPan({ x: c.x - ratio * (c.x - p.x), y: c.y - ratio * (c.y - p.y) });
      setZoom(target);
    },
    [viewportRef],
  );

  const zoomIn = useCallback(() => zoomTo(roundStep(zoomRef.current, 1)), [zoomTo]);
  const zoomOut = useCallback(() => zoomTo(roundStep(zoomRef.current, -1)), [zoomTo]);

  const resetZoom = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width ?? 0;
    setZoom(1);
    setPan({ x: Math.max(40, (vw - pageWidth) / 2), y: 40 });
  }, [viewportRef, pageWidth]);

  const fitToScreen = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pad = 48;
    const next = clamp(Math.min((rect.width - pad) / pageWidth, (rect.height - pad) / pageHeight), MIN_ZOOM, MAX_ZOOM);
    setZoom(next);
    setPan({ x: (rect.width - next * pageWidth) / 2, y: (rect.height - next * pageHeight) / 2 });
  }, [viewportRef, pageWidth, pageHeight]);

  // Wheel: ctrl/cmd = zoom-to-cursor, otherwise pan. Non-passive to allow preventDefault.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015);
        zoomTo(zoomRef.current * factor, { clientX: e.clientX, clientY: e.clientY });
      } else {
        e.preventDefault();
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        const p = panRef.current;
        setPan({ x: p.x - dx, y: p.y - dy });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportRef, zoomTo]);

  // Space-to-pan modifier.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !spaceRef.current && !isTyping(e.target)) {
        spaceRef.current = true;
        setSpaceDown(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Middle-drag / space+drag panning.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onPointerDown = (e: PointerEvent) => {
      const middle = e.button === 1;
      const spacePan = e.button === 0 && spaceRef.current;
      if (!middle && !spacePan) return;
      e.preventDefault();
      panStart.current = { x: e.clientX, y: e.clientY, panX: panRef.current.x, panY: panRef.current.y };
      setIsPanning(true);
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!panStart.current) return;
      setPan({
        x: panStart.current.panX + (e.clientX - panStart.current.x),
        y: panStart.current.panY + (e.clientY - panStart.current.y),
      });
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!panStart.current) return;
      panStart.current = null;
      setIsPanning(false);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    };
  }, [viewportRef]);

  return { zoom, pan, setPan, zoomTo, zoomIn, zoomOut, resetZoom, fitToScreen, isPanning, spaceDown };
}

// Step through pleasant zoom stops.
const ZOOM_STOPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
function roundStep(current: number, dir: 1 | -1): number {
  if (dir === 1) {
    const next = ZOOM_STOPS.find((z) => z > current + 0.0001);
    return next ?? MAX_ZOOM;
  }
  const lower = [...ZOOM_STOPS].reverse().find((z) => z < current - 0.0001);
  return lower ?? MIN_ZOOM;
}
