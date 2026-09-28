import React from 'react';
import type { DocumentViewModel } from '@billme/desktop-utils/document';
import { DocumentFlowPages } from './DocumentFlowPages';

const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
/** Gap between pages in the scaled preview, in unscaled mm. */
const PAGE_GAP_MM = 6;

export type ScaledFlowPreviewProps = {
  model: DocumentViewModel;
  /** Rendered width in CSS pixels; the pages scale down to it. */
  width: number;
  /** Show only the first page (thumbnails). */
  firstPageOnly?: boolean;
  className?: string;
  onReady?: (pageCount: number) => void;
};

const MM_TO_PX = 96 / 25.4;

/**
 * The exact print layout, scaled to fit a card or side panel. Scaling is a
 * transform, so pagination is measured at full size and matches the PDF.
 */
export const ScaledFlowPreview = ({ model, width, firstPageOnly, className, onReady }: ScaledFlowPreviewProps) => {
  const [pages, setPages] = React.useState(1);
  const scale = width / (PAGE_WIDTH_MM * MM_TO_PX);
  const visiblePages = firstPageOnly ? 1 : pages;
  const height = (visiblePages * PAGE_HEIGHT_MM + (visiblePages - 1) * PAGE_GAP_MM) * MM_TO_PX * scale;
  const handleReady = React.useCallback((count: number) => {
    setPages(count);
    onReady?.(count);
  }, [onReady]);

  return (
    <div className={className} style={{ width, height, overflow: 'hidden', position: 'relative' }}>
      <div style={{ width: `${PAGE_WIDTH_MM}mm`, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <DocumentFlowPages model={model} pageClassName="bf-page-preview" onReady={handleReady} />
      </div>
    </div>
  );
};
