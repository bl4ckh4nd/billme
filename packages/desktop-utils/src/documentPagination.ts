/**
 * Splits an absolutely positioned document template (one A4 canvas) into as many
 * pages as the item table needs.
 *
 * The template is authored as a single fixed page: every element sits at a fixed
 * x/y and the item table has no height, so a table with more rows than the
 * authored gap simply grows over the totals/footer and off the page. This module
 * turns that one canvas into N page canvases:
 *
 *   - elements above the table  -> page 1 only
 *   - elements in the footer zone -> repeated on every page
 *   - elements between table and footer (totals, payment terms) -> last page,
 *     pushed below the last table row when the table grew past their authored y
 *   - the table itself -> sliced, header repeated on each page
 *
 * Row heights are measured by the caller (see DocumentPages) because they depend
 * on fonts/styles, not on the template data.
 */

/** Structural subset of the designer's InvoiceElement that pagination needs. */
export type PaginationElement = {
  id: string;
  type?: string;
  label?: string;
  x: number;
  y: number;
  zIndex?: number;
  content?: string;
  style?: {
    width?: number;
    height?: number;
    fontSize?: number;
    color?: string;
    textAlign?: 'left' | 'center' | 'right';
    padding?: number;
  };
  tableData?: { columns?: unknown; rows?: unknown[] };
};

export type PaginationMetrics = {
  /** Height of the repeated table header row. */
  tableHeaderHeight: number;
  /** Measured height of every item row, in document order. */
  rowHeights: number[];
};

export type PaginateOptions = PaginationMetrics & {
  pageWidth: number;
  pageHeight: number;
  /** Emit a "Seite x von y" element when the document has more than one page. */
  pageNumbers?: boolean;
};

/** Elements at or below this share of the page height are treated as footer. */
const FOOTER_ZONE_RATIO = 0.85;
/** ~20mm at 96dpi: where the table restarts on continuation pages. */
const CONTINUATION_TOP = 76;
/** ~20mm side margin used for the generated page number. */
const SIDE_MARGIN = 76;
/** Vertical breathing room between the table and what follows it. */
const BLOCK_GAP = 16;
/** Fallback when a row could not be measured. */
const FALLBACK_ROW_HEIGHT = 32;

const bottomOf = (el: PaginationElement) => el.y + (Number(el.style?.height) || 0);

const isTable = (el: PaginationElement) => el.label === 'items_table' || el.type === 'TABLE';

export const paginateDocumentElements = (
  elements: PaginationElement[],
  options: PaginateOptions,
): PaginationElement[][] => {
  const table = elements.find(isTable);
  const rows = (table?.tableData?.rows ?? []) as unknown[];
  if (!table || rows.length === 0) return [elements];

  const footerZoneTop = options.pageHeight * FOOTER_ZONE_RATIO;
  const rest = elements.filter((el) => el !== table);
  const footer = rest.filter((el) => el.y >= footerZoneTop);
  const header = rest.filter((el) => el.y < footerZoneTop && el.y < table.y);
  const tail = rest.filter((el) => el.y < footerZoneTop && el.y >= table.y);

  const contentBottom = footer.length
    ? Math.min(...footer.map((el) => el.y)) - BLOCK_GAP
    : options.pageHeight - CONTINUATION_TOP;

  const tailTop = tail.length ? Math.min(...tail.map((el) => el.y)) : 0;
  const tailHeight = tail.length ? Math.max(...tail.map(bottomOf)) - tailTop : 0;

  const rowHeight = (index: number) => options.rowHeights[index] || FALLBACK_ROW_HEIGHT;
  const topOfPage = (pageIndex: number) => (pageIndex === 0 ? table.y : CONTINUATION_TOP);

  // Slice rows into pages. The page that ends up carrying the remaining rows
  // also has to fit the totals/payment block, so rows are pushed to a further
  // page when they would collide with it.
  const slices: number[][] = [];
  let cursor = 0;
  while (cursor < rows.length) {
    const top = topOfPage(slices.length);
    const limit = contentBottom - top - options.tableHeaderHeight;
    const slice: number[] = [];
    let used = 0;
    while (cursor < rows.length) {
      const height = rowHeight(cursor);
      if (slice.length > 0 && used + height > limit) break;
      slice.push(cursor);
      used += height;
      cursor += 1;
    }
    if (cursor >= rows.length && tail.length > 0) {
      // Last page: give the tail block room by moving rows to the next page.
      const tailBaseline = slices.length === 0 ? tailTop : 0;
      while (
        slice.length > 1 &&
        Math.max(tailBaseline, top + options.tableHeaderHeight + used + BLOCK_GAP) + tailHeight > contentBottom
      ) {
        used -= rowHeight(slice[slice.length - 1]);
        slice.pop();
        cursor -= 1;
      }
    }
    slices.push(slice);
  }

  // Place the tail block on the last page, or on an extra page if even a single
  // row page leaves no room for it. On page 1 the authored y is kept (that is
  // the template's design); continuation pages have no header, so the block
  // simply follows the table.
  let tailPage = slices.length - 1;
  const lastTop = topOfPage(tailPage);
  const lastTableBottom =
    lastTop + options.tableHeaderHeight + slices[tailPage].reduce((sum, index) => sum + rowHeight(index), 0);
  let tailY = tailPage === 0 ? Math.max(tailTop, lastTableBottom + BLOCK_GAP) : lastTableBottom + BLOCK_GAP;
  if (tail.length > 0 && tailY + tailHeight > contentBottom) {
    tailPage = slices.length;
    tailY = CONTINUATION_TOP;
    slices.push([]);
  }
  const tailShift = tailY - tailTop;

  const columns = table.tableData?.columns;
  return slices.map((slice, pageIndex) => {
    const pageElements: PaginationElement[] = [
      ...(pageIndex === 0 ? header : []),
      ...footer,
    ];
    if (slice.length > 0) {
      pageElements.push({
        ...table,
        y: topOfPage(pageIndex),
        tableData: { columns, rows: slice.map((index) => rows[index]) },
      });
    }
    if (pageIndex === tailPage) {
      pageElements.push(...tail.map((el) => ({ ...el, y: el.y + tailShift })));
    }
    if (options.pageNumbers !== false && slices.length > 1) {
      pageElements.push({
        id: `__page_number_${pageIndex}`,
        type: 'TEXT',
        label: 'page_number',
        x: options.pageWidth - SIDE_MARGIN - 200,
        y: contentBottom,
        zIndex: 20,
        content: `Seite ${pageIndex + 1} von ${slices.length}`,
        style: { width: 200, height: 14, fontSize: 8, color: '#666666', textAlign: 'right', padding: 0 },
      });
    }
    return pageElements;
  });
};
