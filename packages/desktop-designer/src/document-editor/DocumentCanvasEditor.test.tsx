// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocumentCanvasEditor, type DocumentCanvasDocumentFields } from './DocumentCanvasEditor';
import type { DraftItem } from './types';

vi.mock('@billme/ui', () => ({
  Combobox: ({ value, onValueChange, onSelect, items, getLabel, ...props }: any) => <input role="combobox" value={value} onChange={(event) => onValueChange?.(event.target.value)} onClick={() => items[0] && onSelect(items[0])} aria-label={props['aria-label']} />,
  DatePicker: ({ value, onChange, ...props }: any) => <button type="button" aria-label={props['aria-label']} onClick={() => onChange(value)}>{value}</button>,
}));

vi.mock('../DocumentPages', () => ({
  DocumentPages: ({ elements, onReady, renderTableRow, tableFooter, tableHeaderOverlay, pageOverlay }: { elements: any[]; onReady?: () => void; renderTableRow?: (row: any, columns: any[]) => React.ReactNode; tableFooter?: React.ReactNode; tableHeaderOverlay?: React.ReactNode; pageOverlay?: (index: number) => React.ReactNode }) => {
    const table = elements.find((element) => element.label === 'items_table');
    const rows = table?.tableData?.rows ?? [];
    return <div data-testid="document-pages" data-element-count={elements.length} data-visible-template-labels={elements.filter((element) => !element.hidden).map((element) => element.label).filter(Boolean).join(',')} data-hidden-template-labels={elements.filter((element) => element.hidden).map((element) => element.label).filter(Boolean).join(',')}><button type="button" onClick={onReady}>ready</button>{rows.length && renderTableRow ? <table><thead><tr><th>{tableHeaderOverlay}</th></tr></thead><tbody>{rows.map((row: any) => renderTableRow(row, table.tableData.columns))}</tbody>{tableFooter ? <tfoot><tr><td>{tableFooter}</td></tr></tfoot> : null}</table> : null}{pageOverlay?.(0)}</div>;
  },
}));

const tableElements = [{
  id: 'table', type: 'TABLE', label: 'items_table', x: 76, y: 510, zIndex: 1,
  style: { width: 642, height: 200 },
  tableData: {
    columns: [
      { id: 'pos', label: 'Pos.', width: 40, visible: true, align: 'left' },
      { id: 'desc', label: 'Bezeichnung', width: 280, visible: true, align: 'left' },
      { id: 'qty', label: 'Menge', width: 60, visible: true, align: 'right' },
      { id: 'price', label: 'Einzelpreis', width: 90, visible: true, align: 'right' },
      { id: 'total', label: 'Gesamt', width: 90, visible: true, align: 'right' },
    ],
    rows: [
      { id: '0', kind: 'item', cells: ['1', 'Leistung A', '1 Stk.', '100,00 €', '100,00 €'] },
      { id: '1', kind: 'item', cells: ['2', 'Leistung B', '1 Stk.', '50,00 €', '50,00 €'] },
    ],
  },
}];

const items: DraftItem[] = [
  { kind: 'item' as const, description: 'Leistung A', quantity: 1, price: 100, total: 100, unit: 'Stk.' },
  { kind: 'item' as const, description: 'Leistung B', quantity: 1, price: 50, total: 50, unit: 'Stk.' },
];
const distantItems: DraftItem[] = Array.from({ length: 41 }, (_, index) => ({ kind: 'item' as const, description: `Position ${index}`, quantity: 1, price: index, total: index, unit: 'Stk.' }));
const distantTableElements = [{
  ...tableElements[0],
  tableData: {
    ...tableElements[0].tableData,
    rows: distantItems.map((item, index) => ({ id: String(index), kind: 'item' as const, cells: [String(index + 1), item.description, '1 Stk.', `${item.price},00 €`, `${item.price},00 €`] })),
  },
}];

afterEach(cleanup);

describe('DocumentCanvasEditor', () => {
  it('keeps an editable overlay on the public A4 page seam', () => {
    render(<DocumentCanvasEditor elements={[{ id: 'table' } as never]}><button type="button">Position bearbeiten</button></DocumentCanvasEditor>);
    expect(screen.getByTestId('document-pages').getAttribute('data-element-count')).toBe('1');
    expect(screen.getByTestId('document-pages').parentElement?.getAttribute('data-document-canvas-editor')).toBe('true');
    expect(screen.getByRole('button', { name: 'Position bearbeiten' })).toBeTruthy();
  });

  it('edits cells and exposes add, reorder, duplicate and delete at the page edge', () => {
    const onItemsChange = vi.fn();
    render(<DocumentCanvasEditor elements={tableElements as never[]} items={items} onItemsChange={onItemsChange} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Beschreibung 1' }), { target: { value: 'Geänderte Leistung' } });
    expect(onItemsChange.mock.lastCall?.[0][0].description).toBe('Geänderte Leistung');
    fireEvent.click(screen.getByRole('button', { name: 'Position hinzufügen' }));
    expect(onItemsChange.mock.lastCall?.[0]).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Zeile 1 nach unten' }));
    expect(onItemsChange.mock.lastCall?.[0].map((item: { description: string }) => item.description)).toEqual(['Leistung B', 'Leistung A']);
    fireEvent.click(screen.getByRole('button', { name: 'Zeile 1 duplizieren' }));
    expect(onItemsChange.mock.lastCall?.[0]).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Zeile 1 löschen' }));
    expect(onItemsChange.mock.lastCall?.[0]).toHaveLength(1);
  });

  it('supports parent-owned undo while keeping reflow input on the canvas seam', () => {
    const Wrapper = () => {
      const [value, setValue] = React.useState(items);
      const [previous, setPrevious] = React.useState<typeof items | null>(null);
      return <><button type="button" onClick={() => previous && setValue(previous)}>Undo</button><DocumentCanvasEditor elements={tableElements as never[]} items={value} onItemsChange={(next) => { setPrevious(value); setValue(next); }} /></>;
    };
    render(<Wrapper />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Beschreibung 1' }), { target: { value: 'Neue Beschreibung' } });
    expect((screen.getByRole('textbox', { name: 'Beschreibung 1' }) as HTMLInputElement).value).toBe('Neue Beschreibung');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByRole('textbox', { name: 'Beschreibung 1' }) as HTMLInputElement).value).toBe('Leistung A');
  });

  it('keeps header and recipient fields on the A4 overlay and exposes column controls without flow', () => {
    const onChange = vi.fn();
    const onTemplateTextChange = vi.fn();
    const documentFields: DocumentCanvasDocumentFields = {
      document: { id: 'draft', number: 'RE-1', date: '2026-08-07', dueDate: '2026-08-21', client: 'Bauherr', clientEmail: 'kunde@example.de', clientAddress: 'Straße 1', amount: 0, items },
      templateElements: [
        { id: 'title', type: 'TEXT', label: 'invoice_title', x: 76, y: 378, zIndex: 1, style: { width: 700, height: 50, fontSize: 20 }, content: 'Rechnung {{invoice.number}}' },
        { id: 'intro', type: 'TEXT', label: 'intro_text', x: 76, y: 378, zIndex: 1, style: { width: 700, height: 50 }, content: 'Alt' },
        { id: 'payment', type: 'TEXT', label: 'payment_terms', x: 76, y: 756, zIndex: 1, style: { width: 700, height: 50 }, content: 'Alt' },
        { id: 'outro', type: 'TEXT', label: 'outro_text', x: 76, y: 820, zIndex: 1, style: { width: 700, height: 50 }, content: 'Alt' },
      ],
      templateType: 'invoice', clients: [{ id: 'client-1', company: 'Bauherr' }], projects: [], selectedClientId: 'client-1', selectedClientLabel: 'Bauherr', selectedProjectLabel: '',
      onChange, onStartManualRecipient: vi.fn(), onSelectClient: vi.fn(), onSelectProject: vi.fn(), onTemplateTextChange, taxRateOptions: [0, 19], resolvedTaxMode: 'standard_vat',
    };
    render(<DocumentCanvasEditor elements={[...tableElements,
      { id: 'meta', type: 'TEXT', label: 'invoice_meta', x: 470, y: 180, zIndex: 1, style: { width: 250, height: 120 }, content: '' },
      { id: 'recipient', type: 'TEXT', label: 'recipient_block', x: 76, y: 180, zIndex: 1, style: { width: 320, height: 150 }, content: '' },
      { id: 'intro', type: 'TEXT', label: 'intro_text', x: 76, y: 378, zIndex: 1, style: { width: 700, height: 50 }, content: 'Alt' },
      { id: 'payment', type: 'TEXT', label: 'payment_terms', x: 76, y: 756, zIndex: 1, style: { width: 700, height: 50 }, content: 'Alt' },
      { id: 'outro', type: 'TEXT', label: 'outro_text', x: 76, y: 820, zIndex: 1, style: { width: 700, height: 50 }, content: 'Alt' },
    ] as never[]} items={items} onItemsChange={vi.fn()} documentFields={documentFields} />);
    expect((screen.getByRole('textbox', { name: 'Rechnungs-Nr.' }) as HTMLInputElement).value).toBe('RE-1');
    expect(screen.queryByRole('textbox', { name: 'Dokumenttitel' })).toBeNull();
    const intro = screen.getByRole('textbox', { name: 'Einleitung' });
    fireEvent.change(intro, { target: { value: 'Neue Einleitung' } });
    fireEvent.blur(intro);
    expect(onTemplateTextChange).toHaveBeenCalledWith('intro', 'Neue Einleitung');
    const pages = screen.getByTestId('document-pages');
    const hiddenLabels = pages.getAttribute('data-hidden-template-labels') ?? '';
    for (const label of ['recipient_block', 'invoice_meta', 'intro_text', 'payment_terms', 'outro_text']) expect(hiddenLabels).toContain(label);
    expect(pages.getAttribute('data-visible-template-labels')).not.toMatch(/recipient_block|invoice_meta|intro_text|payment_terms|outro_text/);
    const recipientField = screen.getByRole('combobox', { name: 'Kunde auswählen' });
    expect(screen.getAllByRole('combobox', { name: 'Kunde auswählen' })).toHaveLength(1);
    fireEvent.change(recipientField, { target: { value: 'Neue Bauherr GmbH' } });
    expect(onChange).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Spalten ein- oder ausblenden' }));
    expect(screen.getByRole('dialog', { name: 'Spalten anzeigen' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Menge' }));
    expect(screen.getByRole('dialog', { name: 'Spalten anzeigen' })).toBeTruthy();
  });

  it('reorders inline rows through the dnd-kit keyboard sensor', async () => {
    const onItemsChange = vi.fn();
    render(<DocumentCanvasEditor elements={tableElements as never[]} items={items} onItemsChange={onItemsChange} />);

    const handles = screen.getAllByRole('button', { name: /Zeile \d+ verschieben/ });
    expect(handles).toHaveLength(2);
    expect(handles[0].getAttribute('draggable')).toBeNull();
    const rows = [...document.querySelectorAll<HTMLElement>('[data-line-row-id]')];
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ x: 0, y: index * 40, top: index * 40, left: 0, right: 640, bottom: index * 40 + 40, width: 640, height: 40, toJSON: () => ({}) });
    });
    handles[0].focus();
    fireEvent.keyDown(handles[0], { code: 'Space', key: ' ' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(handles[0], { code: 'ArrowDown', key: 'ArrowDown' });
    fireEvent.keyDown(handles[0], { code: 'Space', key: ' ' });

    expect(onItemsChange.mock.lastCall?.[0].map((item: DraftItem) => item.description)).toEqual(['Leistung B', 'Leistung A']);
  });

  it('keeps a distant paginated target in the same sortable order', async () => {
    const onItemsChange = vi.fn();
    render(<DocumentCanvasEditor elements={distantTableElements as never[]} items={distantItems} onItemsChange={onItemsChange} />);
    const sourceHandle = screen.getByRole('button', { name: 'Zeile 1 verschieben' });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-line-row-id]')];
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ x: 0, y: index * 32, top: index * 32, left: 0, right: 640, bottom: index * 32 + 32, width: 640, height: 32, toJSON: () => ({}) });
    });
    sourceHandle.focus();
    fireEvent.keyDown(sourceHandle, { code: 'Space', key: ' ' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 40; index += 1) fireEvent.keyDown(sourceHandle, { code: 'ArrowDown', key: 'ArrowDown' });
    fireEvent.keyDown(sourceHandle, { code: 'Space', key: ' ' });

    expect(onItemsChange.mock.lastCall?.[0][40].description).toBe('Position 0');
    expect(onItemsChange.mock.lastCall?.[0][39].description).toBe('Position 40');
  });

  it('opens the public command palette, searches customers/articles, and supports keyboard selection', () => {
    const onItemsChange = vi.fn();
    const onSelectClient = vi.fn();
    const client = { id: 'client-2', company: 'Nordbau GmbH', customerNumber: 'KD-42', address: 'Hafenstraße 8' };
    const documentFields: DocumentCanvasDocumentFields = {
      document: { id: 'draft', number: 'RE-2', date: '2026-08-07', client: '', clientEmail: '', amount: 0, items },
      templateType: 'invoice', clients: [client], projects: [], selectedClientId: '', selectedClientLabel: '', selectedProjectLabel: '',
      onChange: vi.fn(), onStartManualRecipient: vi.fn(), onSelectClient, onSelectProject: vi.fn(),
    };
    const article = { id: 'article-1', sku: 'MON-1', title: 'Montage', description: 'Montagearbeiten', price: 85, unit: 'Std.', category: 'Ausbau', taxRate: 19 };
    render(<DocumentCanvasEditor elements={tableElements as never[]} items={items} onItemsChange={onItemsChange} documentFields={documentFields} articles={[article]} />);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('textbox', { name: 'Aktion suchen …' });
    fireEvent.change(input, { target: { value: 'Hafenstraße' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectClient).toHaveBeenCalledWith(client);

    fireEvent.click(screen.getByRole('button', { name: /Aktionen/ }));
    const articleSearch = screen.getByRole('textbox', { name: 'Aktion suchen …' });
    fireEvent.change(articleSearch, { target: { value: 'MON-1' } });
    fireEvent.keyDown(articleSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(articleSearch, { key: 'Enter' });
    expect(onItemsChange.mock.lastCall?.[0].at(-1)).toMatchObject({ kind: 'item', articleId: 'article-1', description: 'Montage', price: 85, unit: 'Std.', category: 'Ausbau', taxRate: 19 });

    fireEvent.click(screen.getByRole('button', { name: /Aktionen/ }));
    const groupSearch = screen.getByRole('textbox', { name: 'Aktion suchen …' });
    fireEvent.change(groupSearch, { target: { value: 'Abschnitt' } });
    fireEvent.keyDown(groupSearch, { key: 'Enter' });
    expect(onItemsChange.mock.lastCall?.[0].at(-1)).toMatchObject({ kind: 'group' });
  });

  it('does not expose command or drag affordances in preview mode', () => {
    render(<DocumentCanvasEditor elements={tableElements as never[]} />);

    expect(screen.queryByRole('button', { name: /Aktionen/ })).toBeNull();
    expect(screen.queryByTestId('line-drag-handle')).toBeNull();
    expect(document.querySelector('[data-line-drag-handle]')).toBeNull();
  });
});
