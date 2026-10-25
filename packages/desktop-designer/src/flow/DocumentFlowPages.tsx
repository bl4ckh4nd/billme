import React from 'react';
import { paginateFlow, type DocumentColumn, type DocumentRow, type DocumentViewModel, type FlowBlock, type FlowPage } from '@billme/desktop-utils/document';
import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4';
import './flow.css';

const MM = 96 / 25.4;
const PAGE_HEIGHT = 297 * MM;
/** DIN 5008 Form B: the body starts two lines below the address field. */
const FIRST_BODY_TOP = 98.5 * MM;
const NEXT_BODY_TOP = 26 * MM;
const META_TOP = 50 * MM;
const FOOTER_BOTTOM = 10 * MM;
const FOOTER_GAP = 4 * MM;
/** Room reserved above the footer for the page number line. */
const PAGE_NUMBER_HEIGHT = 5 * MM;

const COLUMN_WIDTHS: Record<DocumentColumn['id'], string> = {
  pos: '8mm',
  desc: 'minmax(0, 1fr)',
  qty: '20mm',
  unit: '14mm',
  price: '23mm',
  discount: '20mm',
  taxRate: '12mm',
  total: '25mm',
  date: '31mm',
  dueDate: '28mm',
};

const FONTS: Record<DocumentViewModel['font'], string> = {
  inter: '"Inter Variable"',
  serif: '"Source Serif 4 Variable"',
};

type Layout = { key: string; pages: FlowPage[]; firstPageTop: number };

export type DocumentFlowPagesProps = {
  model: DocumentViewModel;
  className?: string;
  pageClassName?: string;
  /** Called after the paginated pages have been painted. */
  onReady?: (pageCount: number) => void;
};

const Row = ({ row, columns, clampHeight }: { row: DocumentRow; columns: DocumentColumn[]; clampHeight?: number }) => {
  const style = clampHeight !== undefined ? { maxHeight: clampHeight } : undefined;
  const className = `bf-row bf-row-${row.kind}${clampHeight !== undefined ? ' bf-row-clamped' : ''}`;
  const hasPos = columns[0]?.id === 'pos';
  const start = hasPos ? 2 : 1;
  if (row.kind === 'group' || row.kind === 'text') {
    return (
      <div className={className} style={style}>
        {hasPos && <div />}
        <div className="bf-cell-desc" style={{ gridColumn: `${start} / -1` }}>{row.cells.desc}</div>
      </div>
    );
  }
  if (row.kind === 'summary') {
    const lastIsTotal = columns[columns.length - 1]?.id === 'total';
    return (
      <div className={className} style={style}>
        {hasPos && <div />}
        <div className="bf-cell-desc" style={{ gridColumn: `${start} / ${lastIsTotal ? -2 : -1}` }}>{row.cells.desc}</div>
        {lastIsTotal && <div className="bf-right">{row.cells.total}</div>}
      </div>
    );
  }
  return (
    <div className={className} style={style}>
      {columns.map((column) => (
        <div key={column.id} className={column.id === 'desc' ? 'bf-cell-desc' : column.align === 'right' ? 'bf-right' : undefined}>
          {row.cells[column.id]}
          {column.id === 'desc' && row.kind === 'optional' && <span className="bf-optional-tag">optional</span>}
        </div>
      ))}
    </div>
  );
};

const TableHeader = ({ columns }: { columns: DocumentColumn[] }) => (
  <div className="bf-row bf-thead">
    {columns.map((column) => (
      <div key={column.id} className={column.align === 'right' ? 'bf-right' : undefined}>{column.label}</div>
    ))}
  </div>
);

const Footer = ({ model, pageLabel }: { model: DocumentViewModel; pageLabel?: string }) => (
  <>
    {pageLabel !== undefined && <div className="bf-pageno">{pageLabel}</div>}
    {model.footerColumns.length > 0 && (
      <div className="bf-footer-cols">
        {model.footerColumns.map((lines, index) => <div key={index}>{lines.join('\n')}</div>)}
      </div>
    )}
  </>
);

const Meta = ({ model }: { model: DocumentViewModel }) => (
  <dl className="bf-meta-grid">
    {model.meta.map((entry, index) => (
      <React.Fragment key={index}>
        <dt>{entry.label}</dt>
        <dd>{entry.value}</dd>
      </React.Fragment>
    ))}
  </dl>
);

/** Body blocks in document order, keyed by the ids used for pagination. */
const bodyBlocks = (model: DocumentViewModel) => {
  const blocks: Array<{ id: string; flow: Omit<FlowBlock, 'height'>; node: (clampHeight?: number) => React.ReactNode }> = [];
  if (model.title) blocks.push({ id: 'title', flow: { id: 'title', keepWithNext: true }, node: () => <div className="bf-title">{model.title}</div> });
  if (model.intro) blocks.push({ id: 'intro', flow: { id: 'intro' }, node: () => <div className="bf-text">{model.intro}</div> });
  model.rows.forEach((row) => {
    blocks.push({
      id: row.id,
      flow: { id: row.id, isRow: true, keepWithNext: row.kind === 'group', keepWithPrevious: row.kind === 'summary' },
      node: (clampHeight) => <Row row={row} columns={model.columns} clampHeight={clampHeight} />,
    });
  });
  if (model.totals.length) {
    blocks.push({
      id: 'totals',
      flow: { id: 'totals', keepWithRows: true },
      node: () => (
        <div className="bf-totals">
          <div className="bf-totals-list">
            {model.totals.map((line) => (
              <div key={line.label} className={`bf-total-line${line.emphasis ? ' bf-total-strong' : ''}`}>
                <span>{line.label}</span>
                <span className="bf-value">{line.value}</span>
              </div>
            ))}
          </div>
        </div>
      ),
    });
  }
  if (model.notice) blocks.push({ id: 'notice', flow: { id: 'notice', keepWithPrevious: true }, node: () => <div className="bf-notice">{model.notice}</div> });
  if (model.closing) blocks.push({ id: 'closing', flow: { id: 'closing', keepWithPrevious: true }, node: () => <div className="bf-closing">{model.closing}</div> });
  return blocks;
};

const waitForFonts = async (font: DocumentViewModel['font']) => {
  if (typeof document === 'undefined' || !document.fonts) return;
  const family = FONTS[font];
  await Promise.all([
    document.fonts.load(`400 10pt ${family}`),
    document.fonts.load(`600 10pt ${family}`),
  ]).catch(() => undefined);
  await document.fonts.ready;
};

export const DocumentFlowPages = ({ model, className, pageClassName, onReady }: DocumentFlowPagesProps) => {
  const measureRef = React.useRef<HTMLDivElement>(null);
  const key = React.useMemo(() => JSON.stringify(model), [model]);
  const [layout, setLayout] = React.useState<Layout | null>(null);
  const blocks = React.useMemo(() => bodyBlocks(model), [model]);
  const blockById = React.useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);

  React.useLayoutEffect(() => {
    let cancelled = false;
    void waitForFonts(model.font).then(() => {
      const root = measureRef.current;
      if (cancelled || !root) return;
      // Ancestors may scale the preview; measure in unscaled CSS pixels.
      const scale = root.getBoundingClientRect().width / root.offsetWidth || 1;
      const height = (element: Element | null) => (element ? element.getBoundingClientRect().height / scale : 0);
      const footerHeight = height(root.querySelector('[data-measure="footer"]'));
      const metaHeight = height(root.querySelector('[data-measure="meta"]'));
      const flowBlocks = blocks.map((block) => ({ ...block.flow, height: height(root.querySelector(`[data-measure-id="${block.id}"]`)) }));
      const firstPageTop = Math.max(FIRST_BODY_TOP, META_TOP + metaHeight + 8 * MM);
      const paginate = (pageNumberHeight: number) => paginateFlow(flowBlocks, {
        firstPageTop,
        nextPageTop: NEXT_BODY_TOP,
        bodyBottom: PAGE_HEIGHT - FOOTER_BOTTOM - footerHeight - pageNumberHeight - FOOTER_GAP,
        tableHeaderHeight: height(root.querySelector('[data-measure="thead"]')),
      });
      // A single page prints no page number, so it does not need the room for one.
      const single = paginate(0);
      const pages = single.length === 1 ? single : paginate(PAGE_NUMBER_HEIGHT);
      setLayout({ key, pages, firstPageTop });
    });
    return () => {
      cancelled = true;
    };
  }, [key, blocks, model.font]);

  const ready = layout?.key === key;
  React.useEffect(() => {
    if (!ready || !layout) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => onReady?.(layout.pages.length));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready, layout, onReady]);

  const docClass = [
    'bf-doc',
    `bf-preset-${model.presetId}`,
    model.font === 'serif' ? 'bf-font-serif' : '',
    className ?? '',
  ].filter(Boolean).join(' ');
  const docStyle = {
    '--bf-accent': model.accentColor,
    '--bf-cols': model.columns.map((column) => COLUMN_WIDTHS[column.id]).join(' '),
  } as React.CSSProperties;

  const pageCount = ready && layout ? layout.pages.length : 0;
  const logo = model.letterhead?.logo;

  return (
    <div className={docClass} style={docStyle} data-theme="light" data-flow-ready={ready ? 'true' : 'false'} data-flow-pages={pageCount}>
      <div ref={measureRef} className="bf-measure" aria-hidden="true">
        <div style={{ width: '165mm' }}>
          {blocks.map((block) => (
            <div key={block.id} data-measure-id={block.id}>{block.node()}</div>
          ))}
          <div data-measure="thead"><TableHeader columns={model.columns} /></div>
          <div data-measure="footer"><Footer model={model} /></div>
        </div>
        <div style={{ width: '65mm' }} data-measure="meta"><Meta model={model} /></div>
      </div>

      {ready && layout && (
        <div className="bf-pages">
          {layout.pages.map((page, pageIndex) => {
            const first = pageIndex === 0;
            return (
              <section
                key={pageIndex}
                className={`bf-page${first ? ' bf-page-first' : ''}${pageClassName ? ` ${pageClassName}` : ''}`}
                data-page-index={pageIndex}
              >
                {first && model.din.foldMarks && (
                  <>
                    <div className="bf-mark" style={{ top: '105mm' }} />
                    <div className="bf-mark" style={{ top: '210mm' }} />
                  </>
                )}
                {first && model.din.holeMark && <div className="bf-mark bf-mark-hole" style={{ top: '148.5mm' }} />}

                {first ? (
                  <>
                    {model.letterhead && (
                      <>
                        <div className={`bf-letterhead${logo ? ` bf-logo-${logo.position}` : ''}`}>
                          {logo ? (
                            <img src={logo.dataUrl} alt={model.letterhead.companyName} style={{ width: `${logo.widthMm}mm` }} />
                          ) : (
                            <div className="bf-company">{model.letterhead.companyName}</div>
                          )}
                        </div>
                        <div className="bf-lh-rule" />
                      </>
                    )}
                    {model.senderLine && <div className="bf-sender-line">{model.senderLine}</div>}
                    {model.recipient.length > 0 && (
                      <div className="bf-recipient">{model.recipient.map((line, index) => <div key={index}>{line || ' '}</div>)}</div>
                    )}
                    {model.meta.length > 0 && <div className="bf-meta"><Meta model={model} /></div>}
                  </>
                ) : (
                  <div className="bf-running">
                    <strong>{model.letterhead?.companyName}</strong>
                    <span>{model.runningTitle}</span>
                  </div>
                )}

                <div className="bf-body" style={{ top: first ? layout.firstPageTop : NEXT_BODY_TOP }}>
                  {page.entries.map((entry, index) => {
                    const block = blockById.get(entry.id);
                    if (!block) return null;
                    const previous = blockById.get(page.entries[index - 1]?.id ?? '');
                    const opensTable = block.flow.isRow && !previous?.flow.isRow;
                    return (
                      <React.Fragment key={entry.id}>
                        {opensTable && <TableHeader columns={model.columns} />}
                        {block.node(entry.clampHeight)}
                      </React.Fragment>
                    );
                  })}
                </div>

                <div className="bf-footer">
                  <Footer model={model} pageLabel={pageCount > 1 ? `Seite ${pageIndex + 1} von ${pageCount}` : undefined} />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
