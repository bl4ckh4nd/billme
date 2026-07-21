import React, { useEffect, useMemo, useRef, useState } from 'react';

export const RULER_SIZE = 24; // px thickness

export interface RulersProps {
  zoom: number;
  pan: { x: number; y: number };
  mmToPx: number;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

interface Tick {
  pos: number; // screen px along the ruler
  mm: number;
}

const LABEL_TARGET_PX = 50;
const STEP_CANDIDATES = [1, 2, 5, 10, 20, 50, 100, 200];

function buildTicks(panOffset: number, zoom: number, mmToPx: number, length: number): Tick[] {
  if (length <= 0) return [];
  const pxPerMm = zoom * mmToPx;
  const step = STEP_CANDIDATES.find((s) => s * pxPerMm >= LABEL_TARGET_PX) ?? 200;
  const firstMm = Math.floor((0 - panOffset) / pxPerMm / step) * step;
  const lastMm = Math.ceil((length - panOffset) / pxPerMm / step) * step;
  const ticks: Tick[] = [];
  for (let mm = firstMm; mm <= lastMm; mm += step) {
    const pos = panOffset + mm * pxPerMm;
    if (pos >= -1 && pos <= length + 1) ticks.push({ pos, mm });
  }
  return ticks;
}

/**
 * Figma-style mm rulers that track zoom + pan. Self-contained: it observes the
 * viewport size and pointer itself, so moving the mouse only re-renders the
 * rulers — never the whole designer tree.
 */
export const Rulers: React.FC<RulersProps> = ({ zoom, pan, mmToPx, viewportRef }) => {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    const onLeave = () => setPointer(null);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      ro.disconnect();
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [viewportRef]);

  const topTicks = useMemo(() => buildTicks(pan.x, zoom, mmToPx, size.w), [pan.x, zoom, mmToPx, size.w]);
  const leftTicks = useMemo(() => buildTicks(pan.y, zoom, mmToPx, size.h), [pan.y, zoom, mmToPx, size.h]);

  return (
    <>
      <div
        className="absolute top-0 left-0 z-30 bg-dark-2 border-r border-b border-dark-border-subtle"
        style={{ width: RULER_SIZE, height: RULER_SIZE }}
      />

      {/* Top ruler */}
      <div
        className="absolute top-0 z-20 bg-dark-2 border-b border-dark-border-subtle overflow-hidden no-print"
        style={{ left: RULER_SIZE, right: 0, height: RULER_SIZE }}
      >
        {topTicks.map((t) => (
          <div key={t.mm} className="absolute top-0 h-full" style={{ left: t.pos - RULER_SIZE }}>
            <div className="absolute bottom-0 w-px h-1.5 bg-dark-muted" />
            <span className="absolute top-0.5 left-1 text-[9px] leading-none text-dark-muted tabular-nums">{t.mm}</span>
          </div>
        ))}
        {pointer && pointer.x >= RULER_SIZE && (
          <div className="absolute top-0 h-full w-px bg-accent/80" style={{ left: pointer.x - RULER_SIZE }} />
        )}
      </div>

      {/* Left ruler */}
      <div
        className="absolute left-0 z-20 bg-dark-2 border-r border-dark-border-subtle overflow-hidden no-print"
        style={{ top: RULER_SIZE, bottom: 0, width: RULER_SIZE }}
      >
        {leftTicks.map((t) => (
          <div key={t.mm} className="absolute left-0 w-full" style={{ top: t.pos - RULER_SIZE }}>
            <div className="absolute right-0 h-px w-1.5 bg-dark-muted" />
            <span
              className="absolute left-0.5 top-0.5 text-[9px] leading-none text-dark-muted tabular-nums"
              style={{ writingMode: 'vertical-rl' }}
            >
              {t.mm}
            </span>
          </div>
        ))}
        {pointer && pointer.y >= RULER_SIZE && (
          <div className="absolute left-0 w-full h-px bg-accent/80" style={{ top: pointer.y - RULER_SIZE }} />
        )}
      </div>
    </>
  );
};
