import React, { forwardRef } from 'react';
import { ElementType, type InvoiceElement, type RenderText, type TableColumn, type TableRow } from './types';

// Screen readers announce these instead of the internal template identifiers.
const TEMPLATE_ELEMENT_NAMES: Record<string, string> = {
  sender_company: 'Absenderfirma',
  sender_line: 'Absenderzeile',
  recipient_block: 'Empfänger',
  invoice_meta: 'Belegdaten',
  invoice_title: 'Belegtitel',
  intro_text: 'Einleitung',
  items_table: 'Positionstabelle',
  totals_block: 'Summenblock',
  payment_terms: 'Zahlungsbedingungen',
  footer_company: 'Fußzeile Firma',
  footer_contact: 'Fußzeile Kontakt',
  footer_bank: 'Fußzeile Bankverbindung',
};

export type TableRowRenderer = (row: TableRow, columns: TableColumn[]) => React.ReactNode;

export interface ElementRendererProps {
  element: InvoiceElement;
  /** Renders raw template text ({{placeholders}}) into nodes. */
  renderText: RenderText;
  /** Read-only (preview/print), no editor affordances. */
  readOnly?: boolean;
  /** Editor: element is the active selection (subtle ring). */
  selected?: boolean;
  /** Editor: TEXT element is in inline-edit mode (contentEditable). */
  editing?: boolean;
  /** Called when inline editing commits new text. */
  onTextCommit?: (id: string, content: string) => void;
  /** Extra classes for the positioned root (e.g. selecto target class). */
  className?: string;
  /** Merged into the positioned root style. */
  style?: React.CSSProperties;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Inline table editor hook. Omitted for preview/print. */
  renderTableRow?: TableRowRenderer;
  /** Editor: Enter/Space on the focused canvas element selects it (LayersPanel detour no longer required). */
  onKeySelect?: (id: string, additive: boolean) => void;
  tableFooter?: React.ReactNode;
  /** Zero-flow controls anchored to the table header in edit mode. */
  tableHeaderOverlay?: React.ReactNode;
}

/**
 * The single source of truth for rendering one template element. Used by the
 * interactive editor stage AND the read-only document preview/print path, so
 * the two stay pixel-identical by construction.
 *
 * Renders a position:absolute box (left/top/size/zIndex + element styling) and
 * the type-specific content. It owns NO drag/selection logic: Moveable/Selecto
 * in the stage operate on this node via the forwarded ref.
 */
export const ElementRenderer = forwardRef<HTMLDivElement, ElementRendererProps>(function ElementRenderer(
  { element, renderText, readOnly = false, selected = false, editing = false, onTextCommit, className, style, onPointerDown, onDoubleClick, renderTableRow, tableFooter, tableHeaderOverlay, onKeySelect },
  ref,
) {
  if (element.hidden) return null;

  const s = element.style;
  const rootStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${element.x}px`,
    top: `${element.y}px`,
    width: s.width ? `${s.width}px` : 'auto',
    height: s.height ? `${s.height}px` : 'auto',
    fontSize: `${s.fontSize ?? 12}px`,
    fontWeight: s.fontWeight || 'normal',
    textAlign: s.textAlign || 'left',
    color: s.color || '#000',
    backgroundColor: s.backgroundColor || 'transparent',
    fontFamily: s.fontFamily || 'Inter, sans-serif',
    textDecoration: s.textDecoration || 'none',
    lineHeight: s.lineHeight != null ? s.lineHeight : undefined,
    letterSpacing: s.letterSpacing != null ? `${s.letterSpacing}px` : undefined,
    opacity: s.opacity != null ? s.opacity : 1,
    borderRadius: s.borderRadius != null ? `${s.borderRadius}px` : undefined,
    border: s.borderWidth ? `${s.borderWidth}px solid ${s.borderColor || '#000'}` : undefined,
    padding: element.type === ElementType.TEXT ? `${s.padding ?? 4}px` : s.padding ? `${s.padding}px` : 0,
    zIndex: element.zIndex,
    boxSizing: 'border-box',
    userSelect: editing ? 'text' : 'none',
    outline: selected && !readOnly ? '1px solid var(--color-accent)' : undefined,
    cursor: readOnly ? 'default' : editing ? 'text' : 'move',
    // Read-only text is never clipped: the authored box height is a layout hint,
    // and cutting off a line of the footer/address in the PDF loses content.
    overflow:
      (element.type === ElementType.LINE && !readOnly) ||
      (readOnly && element.type === ElementType.TEXT)
        ? 'visible'
        : 'hidden',
  };

  return (
    <div
      ref={ref}
      data-element-id={element.id}
      data-element-label={element.label}
      className={className}
      style={{ ...rootStyle, ...style }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      tabIndex={readOnly || editing ? undefined : 0}
      role={readOnly ? undefined : 'button'}
      aria-label={readOnly ? undefined : (element.label && TEMPLATE_ELEMENT_NAMES[element.label]) || element.label || `Element ${element.id}`}
      aria-pressed={readOnly ? undefined : selected}
      onKeyDown={readOnly ? undefined : (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onKeySelect?.(element.id, event.shiftKey || event.metaKey || event.ctrlKey);
      }}
    >
      {renderContent(element, renderText, editing, onTextCommit, readOnly, renderTableRow, tableFooter, tableHeaderOverlay)}
    </div>
  );
});

function renderContent(
  element: InvoiceElement,
  renderText: RenderText,
  editing: boolean,
  onTextCommit: ((id: string, content: string) => void) | undefined,
  readOnly: boolean,
  renderTableRow: TableRowRenderer | undefined,
  tableFooter: React.ReactNode,
  tableHeaderOverlay: React.ReactNode,
): React.ReactNode {
  switch (element.type) {
    case ElementType.TEXT:
    case 'TEXT':
      if (editing) {
        return (
          <div
            contentEditable
            suppressContentEditableWarning
            ref={(node) => {
              if (node && document.activeElement !== node) {
                node.focus();
                // Place caret at end on first focus.
                const sel = window.getSelection();
                if (sel) {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  range.collapse(false);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }
            }}
            // Inset ring: the element box clips to its own bounds, so an outset ring would be swallowed.
            className="w-full h-full focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring"
            style={{ whiteSpace: 'pre-wrap', cursor: 'text' }}
            onBlur={(e) => {
              const next = e.currentTarget.textContent || '';
              if (onTextCommit && next !== element.content) onTextCommit(element.id, next);
            }}
          >
            {element.content || 'Neuer Text'}
          </div>
        );
      }
      return (
        <div className="w-full h-full" style={{ whiteSpace: 'pre-wrap' }}>
          {renderText(element.content || '') || 'Neuer Text'}
        </div>
      );

    case ElementType.IMAGE:
    case 'IMAGE':
      if (!element.src) {
        return readOnly ? null : (
          <div className="flex h-full w-full items-center justify-center border border-dashed border-control-border bg-surface-muted text-[10px] font-medium text-muted">
            Bild hochladen
          </div>
        );
      }
      return (
        <img
          src={element.src}
          alt="Element"
          style={{ width: '100%', height: '100%', objectFit: element.style.imageFit ?? 'contain' }}
          draggable={false}
        />
      );

    case ElementType.BOX:
    case 'BOX':
      return <div style={{ width: '100%', height: '100%', backgroundColor: element.style.backgroundColor || '#eee' }} />;

    case ElementType.LINE:
    case 'LINE':
      return (
        <div style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: element.style.backgroundColor || '#000' }}>
          {!readOnly ? (
            <div
              aria-hidden="true"
              style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: '16px', transform: 'translateY(-50%)' }}
            />
          ) : null}
        </div>
      );

    case ElementType.QRCODE:
    case 'QRCODE':
      return (
        <div className="w-full h-full bg-white flex flex-col items-center justify-center border-2 border-black relative overflow-hidden">
          <div className="absolute inset-2 grid grid-cols-4 grid-rows-4 gap-1 opacity-80">
            <div className="bg-black col-span-2 row-span-2"></div>
            <div className="bg-black col-span-1 row-start-1 col-start-4"></div>
            <div className="bg-black col-span-1 row-start-4 col-start-1"></div>
            <div className="bg-black col-span-2 row-span-2 row-start-3 col-start-3"></div>
          </div>
          <div className="z-10 bg-white px-2 py-1 text-[10px] font-bold border border-black">GIROCODE</div>
        </div>
      );

    case ElementType.TABLE:
    case 'TABLE': {
      const columns = element.tableData?.columns || [];
      return (
        <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              {columns.map((col) => {
                if (!col.visible) return null;
                return (
                  <th
                    key={col.id}
                    style={{ width: `${col.width}px`, textAlign: col.align || 'left' }}
                    className="relative border-b-2 border-border-subtle p-2 bg-surface-muted text-xs font-bold uppercase tracking-wide text-muted"
                  >
                    <span className="block truncate">{col.label}</span>
                    {tableHeaderOverlay && columns.filter((candidate) => candidate.visible).at(-1)?.id === col.id ? (
                      <span className="absolute left-1 top-1/2 z-30 -translate-y-1/2 print:hidden">{tableHeaderOverlay}</span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {element.tableData?.rows.map((row) => renderTableRow?.(row, columns) ?? (
              <tr
                key={row.id}
                data-line-kind={row.kind}
                className={`border-b border-border-subtle ${row.kind === 'group' || row.kind === 'group-continuation' ? 'bg-surface-muted font-bold' : ''} ${row.kind === 'summary' ? 'border-t border-border font-bold' : ''} ${row.kind === 'text' ? 'italic text-muted' : ''} ${row.kind === 'optional' ? 'text-muted' : ''}`}
              >
                {columns.map((col, i) => {
                  if (!col.visible) return null;
                  return (
                    <td key={`${row.id}-${col.id}`} style={{ textAlign: col.align || 'left' }} className="p-2 truncate">
                      {row.cells[i]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {tableFooter ? <tfoot><tr style={{ height: 0 }}><td colSpan={columns.filter((column) => column.visible).length} style={{ height: 0, padding: 0, border: 0 }}><div className="relative h-0"><div className="absolute left-0 top-1 z-10">{tableFooter}</div></div></td></tr></tfoot> : null}
        </table>
      );
    }

    default:
      return null;
  }
}
