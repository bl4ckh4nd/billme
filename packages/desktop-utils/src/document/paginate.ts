/**
 * Distributes measured flow blocks over A4 pages.
 *
 * The renderer measures every body block and table row once, off-screen, at
 * the final content width; this function only does arithmetic on those
 * heights so screen preview and PDF break at exactly the same places.
 */

export type FlowBlock = {
  id: string;
  height: number;
  /** Table rows get the repeated table header when they open a page. */
  isRow?: boolean;
  /** Never the last entry on a page (title, section heading). */
  keepWithNext?: boolean;
  /** Pulls up to two preceding rows along when it has to move (totals). */
  keepWithRows?: boolean;
  /** Never the first entry on a page (subtotal row). */
  keepWithPrevious?: boolean;
};

export type FlowMetrics = {
  /** Top of the body area on page 1, below address field and meta block. */
  firstPageTop: number;
  /** Top of the body area on continuation pages. */
  nextPageTop: number;
  /** Lowest y the body may reach before the reserved footer. */
  bodyBottom: number;
  tableHeaderHeight: number;
};

export type FlowPageEntry = {
  id: string;
  /** Set when a single row is taller than a whole page body. */
  clampHeight?: number;
};

export type FlowPage = { entries: FlowPageEntry[] };

const ROWS_KEPT_WITH_TOTALS = 2;

type Placed = FlowBlock & { clampHeight?: number };

export const paginateFlow = (blocks: readonly FlowBlock[], metrics: FlowMetrics): FlowPage[] => {
  const pages: Placed[][] = [[]];
  const top = (pageIndex: number) => (pageIndex === 0 ? metrics.firstPageTop : metrics.nextPageTop);

  const usedHeight = (page: Placed[]) =>
    page.reduce((sum, entry, index) => {
      const opensTable = entry.isRow && !page[index - 1]?.isRow;
      return sum + (entry.clampHeight ?? entry.height) + (opensTable ? metrics.tableHeaderHeight : 0);
    }, 0);

  const fits = (page: Placed[], pageIndex: number, block: FlowBlock) => {
    const opensTable = block.isRow && !page[page.length - 1]?.isRow;
    return top(pageIndex) + usedHeight(page) + block.height + (opensTable ? metrics.tableHeaderHeight : 0) <= metrics.bodyBottom;
  };

  for (const block of blocks) {
    let pageIndex = pages.length - 1;
    let page = pages[pageIndex]!;
    if (page.length > 0 && !fits(page, pageIndex, block)) {
      // Pull entries along that must not be separated from the moved block.
      // Chains resolve naturally: closing -> totals -> last rows -> heading.
      const carry: Placed[] = [];
      let needPrevious = Boolean(block.keepWithPrevious);
      let rowsToPull = block.keepWithRows ? ROWS_KEPT_WITH_TOTALS : 0;
      let rowsOnPage = page.filter((entry) => entry.isRow).length;
      while (page.length > 1) {
        const last = page[page.length - 1]!;
        const pullRow = rowsToPull > 0 && last.isRow && rowsOnPage > 1;
        if (!needPrevious && !pullRow && !last.keepWithNext) break;
        carry.unshift(page.pop()!);
        if (last.isRow) {
          rowsOnPage -= 1;
          if (pullRow && !needPrevious) rowsToPull -= 1;
        }
        needPrevious = Boolean(last.keepWithPrevious);
        if (last.keepWithRows) rowsToPull = ROWS_KEPT_WITH_TOTALS;
      }
      page = [];
      pages.push(page);
      pageIndex += 1;
      page.push(...carry);
    }
    const available = metrics.bodyBottom - top(pageIndex) - (block.isRow ? metrics.tableHeaderHeight : 0);
    const oversized = page.length === 0 && block.isRow && block.height > available;
    page.push(oversized ? { ...block, clampHeight: available } : block);
  }

  return pages.map((page) => ({
    entries: page.map((entry) => (entry.clampHeight === undefined ? { id: entry.id } : { id: entry.id, clampHeight: entry.clampHeight })),
  }));
};
