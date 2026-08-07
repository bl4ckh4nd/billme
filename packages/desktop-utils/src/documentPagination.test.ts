import { describe, expect, it } from 'vitest';
import { paginateDocumentElements, type PaginationElement } from './documentPagination';

const PAGE_HEIGHT = 1123;
const PAGE_WIDTH = 794;
const ROW_HEIGHT = 33;
const HEADER_HEIGHT = 32;
/** Footer line y in the stock template; nothing may be painted below it. */
const FOOTER_Y = 1002;

const template = (rowCount: number): PaginationElement[] => [
  { id: 'logo', type: 'TEXT', x: 76, y: 40, style: { width: 200, height: 40 } },
  { id: 'recipient', type: 'TEXT', x: 76, y: 189, style: { width: 250, height: 150 } },
  {
    id: 'main_table',
    type: 'TABLE',
    label: 'items_table',
    x: 76,
    y: 510,
    style: { width: 642 },
    tableData: {
      columns: [{ id: 'pos' }],
      rows: Array.from({ length: rowCount }, (_, i) => ({ id: `r${i}`, cells: [String(i + 1)] })),
    },
  },
  { id: 'totals_block', type: 'TEXT', x: 472, y: 680, style: { width: 245, height: 80 } },
  { id: 'payment_terms', type: 'TEXT', x: 76, y: 756, style: { width: 700, height: 50 } },
  { id: 'footer_line', type: 'LINE', x: 76, y: FOOTER_Y, style: { width: 642, height: 1 } },
  { id: 'footer_company', type: 'TEXT', x: 76, y: 1021, style: { width: 200, height: 60 } },
];

const paginate = (rowCount: number) =>
  paginateDocumentElements(template(rowCount), {
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
    tableHeaderHeight: HEADER_HEIGHT,
    rowHeights: Array.from({ length: rowCount }, () => ROW_HEIGHT),
  });

const tableOf = (page: PaginationElement[]) => page.find((el) => el.label === 'items_table');
const idsOf = (page: PaginationElement[]) => page.map((el) => el.id);
const rowIdsOf = (pages: PaginationElement[][]) =>
  pages.flatMap((page) => ((tableOf(page)?.tableData?.rows ?? []) as Array<{ id: string }>).map((row) => row.id));

describe('paginateDocumentElements', () => {
  it('keeps a short document on one page with the authored layout', () => {
    const pages = paginate(3);
    expect(pages).toHaveLength(1);
    expect(tableOf(pages[0])?.y).toBe(510);
    expect(pages[0].find((el) => el.id === 'totals_block')?.y).toBe(680);
    expect(idsOf(pages[0])).not.toContain('__page_number_0');
  });

  it('splits the item table instead of running over the footer', () => {
    const pages = paginate(60);
    expect(pages.length).toBeGreaterThan(1);
    // No row and no shifted block may reach into the footer zone.
    for (const page of pages) {
      const table = tableOf(page);
      if (table) {
        const rows = (table.tableData?.rows ?? []).length;
        expect(table.y + HEADER_HEIGHT + rows * ROW_HEIGHT).toBeLessThanOrEqual(FOOTER_Y);
      }
      for (const el of page) {
        if (el.label === 'items_table' || el.y >= FOOTER_Y) continue;
        expect(el.y + (Number(el.style?.height) || 0)).toBeLessThanOrEqual(FOOTER_Y);
      }
    }
  });

  it('keeps every item exactly once and in order', () => {
    const rowIds = rowIdsOf(paginate(60));
    expect(rowIds).toEqual(Array.from({ length: 60 }, (_, i) => `r${i}`));
  });

  it('repeats the footer, keeps the header on page one and the totals on the last page', () => {
    const pages = paginate(60);
    const tailPages = pages.filter((page) => idsOf(page).includes('totals_block'));
    expect(tailPages).toHaveLength(1);
    expect(tailPages[0]).toBe(pages[pages.length - 1]);
    expect(idsOf(pages[0])).toContain('recipient');
    for (const page of pages.slice(1)) expect(idsOf(page)).not.toContain('recipient');
    for (const page of pages) expect(idsOf(page)).toContain('footer_company');
  });

  it('numbers the pages of a multi-page document', () => {
    const pages = paginate(60);
    const numbers = pages.map((page) => page.find((el) => el.label === 'page_number')?.content);
    expect(numbers).toEqual(pages.map((_, i) => `Seite ${i + 1} von ${pages.length}`));
  });

  it('leaves documents without an item table untouched', () => {
    const elements = template(0);
    expect(paginateDocumentElements(elements, {
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
      tableHeaderHeight: HEADER_HEIGHT,
      rowHeights: [],
    })).toEqual([elements]);
  });
});
