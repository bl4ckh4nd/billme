import React from 'react';
import { renderTextWithPlaceholders } from '@billme/desktop-utils/placeholders';
import { paginateDocumentElements } from '@billme/desktop-utils/documentPagination';
import { A4_HEIGHT_PX, A4_WIDTH_PX } from './constants';
import { ElementRenderer } from './ElementRenderer';
import type { InvoiceElement } from './types';

export interface DocumentPagesProps {
  /** Preview elements (placeholders already replaced). */
  elements: InvoiceElement[];
  pageWidth?: number;
  pageHeight?: number;
  /** Classes for each page container (e.g. shadow in the on-screen preview). */
  pageClassName?: string;
  /** Space between pages on screen. Keep 0 for print/PDF. */
  pageGap?: number;
  /** Fired once pages are laid out (used to gate printToPDF). */
  onReady?: () => void;
}

type Metrics = { tableHeaderHeight: number; rowHeights: number[] };

const findTable = (elements: InvoiceElement[]) =>
  elements.find((el) => el.label === 'items_table' || el.type === 'TABLE');

/**
 * Renders a document across as many A4 pages as its item table needs.
 *
 * Row heights are measured from a hidden copy of the real table (same renderer,
 * same styles) and then fed to the pure paginator, so the split matches what is
 * actually painted instead of an estimate.
 */
export const DocumentPages: React.FC<DocumentPagesProps> = ({
  elements,
  pageWidth = A4_WIDTH_PX,
  pageHeight = A4_HEIGHT_PX,
  pageClassName,
  pageGap = 0,
  onReady,
}) => {
  const [metrics, setMetrics] = React.useState<Metrics>({ tableHeaderHeight: 0, rowHeights: [] });
  const [measured, setMeasured] = React.useState(false);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const table = findTable(elements);

  React.useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const node = measureRef.current?.querySelector('table');
      setMetrics({
        tableHeaderHeight: node?.tHead?.getBoundingClientRect().height ?? 0,
        rowHeights: Array.from(node?.tBodies[0]?.rows ?? []).map((row) => row.getBoundingClientRect().height),
      });
      setMeasured(true);
    };
    // Measuring with a fallback font and painting with the real one would make
    // rows taller than the page split assumed, i.e. overflow again.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts && fonts.status !== 'loaded') fonts.ready.then(measure).catch(measure);
    else measure();
    return () => {
      cancelled = true;
    };
  }, [elements]);

  const pages = React.useMemo(
    () => paginateDocumentElements(elements, { ...metrics, pageWidth, pageHeight }),
    [elements, metrics, pageWidth, pageHeight],
  );

  React.useEffect(() => {
    if (measured) onReady?.();
  }, [measured, pages.length, onReady]);

  return (
    <>
      {/* Measuring copy: the real table, off-screen, at its real width. Stays
          mounted so edits re-measure without blanking the preview. */}
      <div
        ref={measureRef}
        aria-hidden
        style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0, overflow: 'hidden' }}
      >
        {table ? (
          <div style={{ position: 'absolute', top: 0, left: 0, width: table.style?.width ?? pageWidth }}>
            <ElementRenderer element={{ ...table, x: 0, y: 0 }} renderText={renderTextWithPlaceholders} readOnly />
          </div>
        ) : null}
      </div>

      {pages.map((pageElements, index) => (
        <div
          key={index}
          data-page-index={index}
          className={pageClassName}
          style={{
            width: `${pageWidth}px`,
            height: `${pageHeight}px`,
            background: 'white',
            position: 'relative',
            overflow: 'hidden',
            marginBottom: index < pages.length - 1 ? `${pageGap}px` : undefined,
            breakAfter: index < pages.length - 1 ? 'page' : undefined,
          }}
        >
          {(pageElements as unknown as InvoiceElement[]).map((el) => (
            <ElementRenderer key={el.id} element={el} renderText={renderTextWithPlaceholders} readOnly />
          ))}
        </div>
      ))}
    </>
  );
};
