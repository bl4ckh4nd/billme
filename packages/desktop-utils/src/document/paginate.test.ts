import { describe, expect, it } from 'vitest';
import { paginateFlow, type FlowBlock } from './paginate';

const metrics = { firstPageTop: 370, nextPageTop: 110, bodyBottom: 1000, tableHeaderHeight: 30 };
const rows = (count: number, height = 28): FlowBlock[] =>
  Array.from({ length: count }, (_, index) => ({ id: `r${index}`, height, isRow: true }));
const ids = (pages: ReturnType<typeof paginateFlow>) => pages.map((page) => page.entries.map((entry) => entry.id));

describe('paginateFlow', () => {
  it('keeps a short document on one page', () => {
    const pages = paginateFlow([{ id: 'title', height: 30, keepWithNext: true }, ...rows(3), { id: 'totals', height: 80, keepWithRows: true }], metrics);
    expect(pages).toHaveLength(1);
  });

  it('spreads 40 rows over several pages without exceeding the body and keeps order', () => {
    const blocks = [{ id: 'title', height: 30, keepWithNext: true }, { id: 'intro', height: 60 }, ...rows(40), { id: 'totals', height: 90, keepWithRows: true }, { id: 'closing', height: 70 }];
    const pages = paginateFlow(blocks, metrics);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(ids(pages).flat()).toEqual(blocks.map((block) => block.id));
    pages.forEach((page, index) => {
      const top = index === 0 ? metrics.firstPageTop : metrics.nextPageTop;
      const used = page.entries.reduce((sum, entry, position) => {
        const block = blocks.find((candidate) => candidate.id === entry.id)!;
        const prev = blocks.find((candidate) => candidate.id === page.entries[position - 1]?.id);
        return sum + block.height + (block.isRow && !prev?.isRow ? metrics.tableHeaderHeight : 0);
      }, 0);
      expect(top + used).toBeLessThanOrEqual(metrics.bodyBottom);
    });
  });

  it('never leaves the totals alone on a page', () => {
    // Exactly fills page 1 with rows so the totals would open page 2 alone.
    const count = Math.floor((metrics.bodyBottom - metrics.firstPageTop - metrics.tableHeaderHeight) / 28);
    const pages = paginateFlow([...rows(count), { id: 'totals', height: 90, keepWithRows: true }], metrics);
    const last = pages[pages.length - 1]!.entries.map((entry) => entry.id);
    expect(last).toEqual([`r${count - 2}`, `r${count - 1}`, 'totals']);
  });

  it('keeps the closing with the totals, which keep two rows', () => {
    const count = Math.floor((metrics.bodyBottom - metrics.firstPageTop - metrics.tableHeaderHeight - 90) / 28);
    const pages = paginateFlow([...rows(count), { id: 'totals', height: 90, keepWithRows: true }, { id: 'closing', height: 80, keepWithPrevious: true }], metrics);
    expect(pages).toHaveLength(2);
    expect(pages[1]!.entries.map((entry) => entry.id)).toEqual([`r${count - 2}`, `r${count - 1}`, 'totals', 'closing']);
  });

  it('moves a section heading that would end a page to the next page', () => {
    const count = Math.floor((metrics.bodyBottom - metrics.firstPageTop - metrics.tableHeaderHeight) / 28) - 1;
    const pages = paginateFlow([...rows(count), { id: 'group', height: 28, isRow: true, keepWithNext: true }, { id: 'next', height: 28, isRow: true }], metrics);
    expect(pages[0]!.entries.at(-1)!.id).not.toBe('group');
    expect(pages[1]!.entries.map((entry) => entry.id)).toEqual(['group', 'next']);
  });

  it('clamps a single row taller than a page body', () => {
    const pages = paginateFlow([...rows(1), { id: 'huge', height: 5000, isRow: true }], metrics);
    const huge = pages.flatMap((page) => page.entries).find((entry) => entry.id === 'huge')!;
    expect(huge.clampHeight).toBe(metrics.bodyBottom - metrics.nextPageTop - metrics.tableHeaderHeight);
  });
});
