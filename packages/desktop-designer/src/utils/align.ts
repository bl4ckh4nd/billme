import type { InvoiceElement } from '../types';

export type AlignType = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

interface Box {
  el: InvoiceElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

const toBox = (el: InvoiceElement): Box => ({
  el,
  x: el.x,
  y: el.y,
  w: el.style.width ?? 0,
  h: el.style.height ?? 0,
});

/** Align selected elements within their combined bounding box. */
export function alignElements(elements: InvoiceElement[], ids: string[], type: AlignType): InvoiceElement[] {
  if (ids.length < 2) return elements;
  const idSet = new Set(ids);
  const boxes = elements.filter((e) => idSet.has(e.id)).map(toBox);
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;

  const nextX = (b: Box): number => {
    switch (type) {
      case 'left':
        return left;
      case 'right':
        return right - b.w;
      case 'hcenter':
        return cx - b.w / 2;
      default:
        return b.x;
    }
  };
  const nextY = (b: Box): number => {
    switch (type) {
      case 'top':
        return top;
      case 'bottom':
        return bottom - b.h;
      case 'vmiddle':
        return cy - b.h / 2;
      default:
        return b.y;
    }
  };

  const horizontal = type === 'left' || type === 'right' || type === 'hcenter';
  return elements.map((el) => {
    if (!idSet.has(el.id)) return el;
    const b = toBox(el);
    return horizontal ? { ...el, x: Math.round(nextX(b)) } : { ...el, y: Math.round(nextY(b)) };
  });
}

/** Evenly distribute element centers along an axis (keeps the extremes fixed). */
export function distributeElements(elements: InvoiceElement[], ids: string[], axis: DistributeAxis): InvoiceElement[] {
  if (ids.length < 3) return elements;
  const idSet = new Set(ids);
  const boxes = elements.filter((e) => idSet.has(e.id)).map(toBox);
  const center = (b: Box) => (axis === 'horizontal' ? b.x + b.w / 2 : b.y + b.h / 2);
  const sorted = [...boxes].sort((a, b) => center(a) - center(b));
  const first = center(sorted[0]);
  const last = center(sorted[sorted.length - 1]);
  const gap = (last - first) / (sorted.length - 1);

  const targetCenter = new Map<string, number>();
  sorted.forEach((b, i) => targetCenter.set(b.el.id, first + gap * i));

  return elements.map((el) => {
    if (!idSet.has(el.id)) return el;
    const b = toBox(el);
    const c = targetCenter.get(el.id);
    if (c == null) return el;
    return axis === 'horizontal'
      ? { ...el, x: Math.round(c - b.w / 2) }
      : { ...el, y: Math.round(c - b.h / 2) };
  });
}
