import { ElementType, type InvoiceElement } from '../types';
import { DEFAULT_TEXT_STYLE } from '../constants';
import { generateId } from './id';

const maxZ = (elements: InvoiceElement[]) => (elements.length ? Math.max(...elements.map((e) => e.zIndex)) : 0);
const minZ = (elements: InvoiceElement[]) => (elements.length ? Math.min(...elements.map((e) => e.zIndex)) : 0);

const DEFAULT_ELEMENT_SIZE: Record<ElementType, { width: number; height: number }> = {
  [ElementType.TEXT]: { width: 200, height: 30 },
  [ElementType.IMAGE]: { width: 200, height: 80 },
  [ElementType.BOX]: { width: 200, height: 100 },
  [ElementType.TABLE]: { width: 620, height: 180 },
  [ElementType.LINE]: { width: 200, height: 2 },
  [ElementType.QRCODE]: { width: 100, height: 100 },
};

/** Create a new element of `type` at the given page position. */
export function createElement(type: ElementType, position: { x: number; y: number }): InvoiceElement {
  const size = DEFAULT_ELEMENT_SIZE[type];
  const base: InvoiceElement = {
    id: generateId(),
    type,
    x: Math.round(position.x),
    y: Math.round(position.y),
    zIndex: 1,
    content: type === ElementType.TEXT ? 'Neuer Text' : undefined,
    style: {
      ...DEFAULT_TEXT_STYLE,
      width: size.width,
      height: size.height,
      imageFit: type === ElementType.IMAGE ? 'contain' : undefined,
      backgroundColor: type === ElementType.BOX || type === ElementType.LINE ? '#cccccc' : undefined,
    },
    tableData:
      type === ElementType.TABLE
        ? {
            columns: [
              { id: 'c1', label: 'Spalte 1', width: 100, visible: true, align: 'left' },
              { id: 'c2', label: 'Spalte 2', width: 100, visible: true, align: 'left' },
              { id: 'c3', label: 'Spalte 3', width: 100, visible: true, align: 'left' },
            ],
            rows: [{ id: generateId(), cells: ['Daten', 'Daten', 'Daten'] }],
          }
        : undefined,
  };
  return base;
}

export function addElement(
  elements: InvoiceElement[],
  type: ElementType,
  position: { x: number; y: number },
  bounds?: { width: number; height: number },
): { elements: InvoiceElement[]; id: string } {
  const draft = createElement(type, position);
  const maxX = bounds ? Math.max(0, bounds.width - (draft.style.width ?? 0)) : Number.POSITIVE_INFINITY;
  const maxY = bounds ? Math.max(0, bounds.height - (draft.style.height ?? 0)) : Number.POSITIVE_INFINITY;
  const baseX = Math.min(maxX, Math.max(0, position.x));
  const baseY = Math.min(maxY, Math.max(0, position.y));
  let x = baseX;
  let y = baseY;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const occupied = elements.some((element) => Math.abs(element.x - x) < 8 && Math.abs(element.y - y) < 8);
    if (!occupied) break;
    const offset = (attempt + 1) * 16;
    x = baseX + offset <= maxX ? baseX + offset : Math.max(0, baseX - offset);
    y = baseY + offset <= maxY ? baseY + offset : Math.max(0, baseY - offset);
  }

  const el = { ...draft, x: Math.round(x), y: Math.round(y), zIndex: maxZ(elements) + 1 };
  return { elements: [...elements, el], id: el.id };
}

export function duplicateElements(
  elements: InvoiceElement[],
  ids: string[],
  offset = 16,
): { elements: InvoiceElement[]; ids: string[] } {
  if (ids.length === 0) return { elements, ids: [] };
  const idSet = new Set(ids);
  let z = maxZ(elements);
  const clones: InvoiceElement[] = [];
  for (const el of elements) {
    if (!idSet.has(el.id)) continue;
    z += 1;
    clones.push({
      ...el,
      id: generateId(),
      x: el.x + offset,
      y: el.y + offset,
      zIndex: z,
      style: { ...el.style },
      tableData: el.tableData
        ? {
            columns: el.tableData.columns.map((c) => ({ ...c })),
            rows: el.tableData.rows.map((r) => ({ id: generateId(), cells: [...r.cells] })),
          }
        : undefined,
      qrData: el.qrData ? { ...el.qrData } : undefined,
    });
  }
  return { elements: [...elements, ...clones], ids: clones.map((c) => c.id) };
}

export function nudgeElements(elements: InvoiceElement[], ids: string[], dx: number, dy: number): InvoiceElement[] {
  const idSet = new Set(ids);
  return elements.map((el) => (idSet.has(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el));
}

export function removeElements(elements: InvoiceElement[], ids: string[]): InvoiceElement[] {
  const idSet = new Set(ids);
  return elements.filter((el) => !idSet.has(el.id));
}

export type ReorderDirection = 'up' | 'down' | 'front' | 'back';

/** True z-order reorder: up/down swaps with the adjacent layer; front/back jumps to an extreme. */
export function reorderElement(elements: InvoiceElement[], id: string, direction: ReorderDirection): InvoiceElement[] {
  const current = elements.find((e) => e.id === id);
  if (!current) return elements;

  if (direction === 'front') {
    return elements.map((e) => (e.id === id ? { ...e, zIndex: maxZ(elements) + 1 } : e));
  }
  if (direction === 'back') {
    return elements.map((e) => (e.id === id ? { ...e, zIndex: minZ(elements) - 1 } : e));
  }

  // up/down: swap zIndex with the nearest neighbour in that direction.
  const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex((e) => e.id === id);
  const neighbourIdx = direction === 'up' ? idx + 1 : idx - 1;
  if (neighbourIdx < 0 || neighbourIdx >= sorted.length) return elements;
  const neighbour = sorted[neighbourIdx];
  return elements.map((e) => {
    if (e.id === id) return { ...e, zIndex: neighbour.zIndex };
    if (e.id === neighbour.id) return { ...e, zIndex: current.zIndex };
    return e;
  });
}
