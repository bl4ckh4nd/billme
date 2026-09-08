import React from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentCanvasEditor, INITIAL_INVOICE_TEMPLATE } from '@billme/desktop-designer';
import type { DocumentCanvasDocumentFields, DocumentDraft, DraftItem } from '@billme/desktop-designer/document-editor';
import { getPreviewElements } from '@billme/desktop-utils/documentPreview';
import { calculateInvoiceTaxSnapshot } from '@billme/server-core/services';
import '@billme/ui/styles.css';
import './styles.css';

type Fixture = 'construction' | 'page-break' | 'all-line-types' | 'long-text' | 'mixed-vat';
type PlaygroundLine = DraftItem;

const base = (description: string, quantity = 1, price = 100, extra: Partial<PlaygroundLine> = {}): PlaygroundLine => ({ description, quantity, price, total: quantity * price, ...extra });
const makeLines = (fixture: Fixture): PlaygroundLine[] => {
  if (fixture === 'construction') return [
    { kind: 'group', description: 'Bauabschnitt 1 · Rohbau', quantity: 0, price: 0, total: 0 },
    base('Baustelleneinrichtung', 1, 950, { unit: 'pauschal' }),
    base('Fundament und Bodenplatte', 42, 85, { unit: 'm²' }),
    { kind: 'summary', description: 'Zwischensumme Bauabschnitt 1', quantity: 0, price: 0, total: 0, unit: 'EUR' },
    { kind: 'group', description: 'Bauabschnitt 2 · Ausbau', quantity: 0, price: 0, total: 0 },
    base('Innenputz', 120, 19, { unit: 'm²' }),
    base('Elektroinstallation', 18, 95, { unit: 'Std.' }),
    { kind: 'text', description: 'Ausführung nach freigegebenem Bauzeitenplan.', quantity: 0, price: 0, total: 0 },
  ];
  if (fixture === 'all-line-types') return [
    base('Normalposition', 2, 120),
    { kind: 'time', description: 'Projektberatung', quantity: 3.5, price: 90, total: 315, unit: 'Std.' },
    { kind: 'optional', description: 'Premium Support', quantity: 1, price: 190, total: 190, optionNote: 'nur bei Beauftragung' },
    { kind: 'text', description: 'Hinweis: Lieferzeit 5 Werktage.', quantity: 0, price: 0, total: 0 },
    { kind: 'group', description: 'Bauabschnitt 1', quantity: 0, price: 0, total: 0 },
    base('Montage', 4, 80, { unit: 'Std.' }),
    { kind: 'summary', description: 'Abschnittssumme', quantity: 0, price: 0, total: 0 },
  ];
  if (fixture === 'long-text') return Array.from({ length: 32 }, (_, index) => base(`Position ${index + 1}: Ausführliche Beschreibung mit mehreren Worten für einen echten Seitenumbruch`, 1, 35 + index, { unit: 'Stk.' }));
  if (fixture === 'mixed-vat') return [base('Standard 19%', 1, 100, { taxRate: 19 }), base('Ermäßigt 7%', 2, 50, { taxRate: 7 }), base('Steuerfrei', 1, 40, { taxRate: 0 })];
  return Array.from({ length: 46 }, (_, index) => base(`Seitenumbruch Position ${index + 1}`, 1, 25, { unit: 'Stk.' }));
};

const settings = {
  legal: { smallBusinessRule: false, defaultVatRate: 19, countryCode: 'DE' as const },
  company: { name: 'Musterbau GmbH', owner: 'Max Mustermann', street: 'Baustraße 4', zip: '10115', city: 'Berlin', email: 'hallo@example.de', phone: '', website: '' },
  finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '' },
  catalog: { categories: [{ name: 'Rohbau' }, { name: 'Ausbau' }, { name: 'Elektro' }] },
};

const playgroundClients = [{ id: 'client-1', company: 'Bauherr Beispiel', customerNumber: 'KD-001', email: 'kunde@example.de', address: 'Musterweg 7\n10115 Berlin' }];
const playgroundProjects = [{ id: 'project-1', name: 'Neubau Berlin', code: 'NB-01' }];
const playgroundArticles = [
  { id: 'article-1', sku: 'ROH-001', title: 'Betonfundament', description: 'Fundament und Bodenplatte', price: 85, unit: 'm²', category: 'Rohbau', taxRate: 19 },
  { id: 'article-2', sku: 'AUS-001', title: 'Innenputz', description: 'Innenputz Q3', price: 19, unit: 'm²', category: 'Ausbau', taxRate: 19 },
  { id: 'article-3', sku: 'ELE-001', title: 'Elektroinstallation', description: 'Installationsstunde', price: 95, unit: 'Std.', category: 'Elektro', taxRate: 19 },
];

const App = () => {
  const queryFixture = new URLSearchParams(location.search).get('fixture') as Fixture | null;
  const [fixture, setFixture] = React.useState<Fixture>(queryFixture ?? 'construction');
  const [lines, setLines] = React.useState(() => makeLines(queryFixture ?? 'construction'));
  const [past, setPast] = React.useState<PlaygroundLine[][]>([]);
  const [future, setFuture] = React.useState<PlaygroundLine[][]>([]);
  const [draft, setDraft] = React.useState<DocumentDraft>(() => ({ id: 'playground', number: 'PLAY-001', date: '2026-08-07', dueDate: '2026-08-21', client: 'Bauherr Beispiel', clientId: 'client-1', clientEmail: 'kunde@example.de', clientAddress: 'Musterweg 7\n10115 Berlin', projectId: 'project-1', amount: 0, items: makeLines(queryFixture ?? 'construction'), taxMeta: { defaultVatRate: 19 } }));
  const [pageCount, setPageCount] = React.useState(0);
  const [overflow, setOverflow] = React.useState<string[]>([]);
  const taxSnapshot = calculateInvoiceTaxSnapshot({ items: lines, taxMode: 'standard_vat' }, settings);
  const elements = React.useMemo(() => getPreviewElements({ ...draft, items: lines }, INITIAL_INVOICE_TEMPLATE, settings as never) as never[], [draft, lines]);
  const commit = React.useCallback((next: PlaygroundLine[]) => {
    setPast((entries) => [...entries, lines]);
    setLines(next);
    setFuture([]);
  }, [lines]);
  const reset = (next: Fixture = fixture) => { setFixture(next); const nextLines = makeLines(next); setLines(nextLines); setDraft((current) => ({ ...current, items: nextLines })); setPast([]); setFuture([]); history.replaceState(null, '', `?fixture=${next}`); };
  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((entries) => entries.slice(0, -1));
    setFuture((entries) => [lines, ...entries]);
    setLines(previous);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((entries) => entries.slice(1));
    setPast((entries) => [...entries, lines]);
    setLines(next);
  };

  React.useEffect(() => {
    const check = () => {
      const pages = [...document.querySelectorAll<HTMLElement>('[data-page-index]')];
      setPageCount(pages.length);
      setOverflow(pages.flatMap((page, index) => [...page.querySelectorAll<HTMLElement>('table')].flatMap((table) => {
        const footer = page.querySelector<HTMLElement>('[data-element-label="footer_company"]');
        return footer && table.getBoundingClientRect().bottom > footer.getBoundingClientRect().top ? [`Seite ${index + 1}: Tabelle über Footer`] : [];
      })));
    };
    const id = requestAnimationFrame(check);
    return () => cancelAnimationFrame(id);
  }, [elements]);

  const documentFields = React.useMemo<DocumentCanvasDocumentFields>(() => ({
    document: { ...draft, items: lines }, templateType: 'invoice', clients: playgroundClients, projects: playgroundProjects,
    selectedClientId: draft.clientId ?? '', selectedClientLabel: draft.client, selectedProjectLabel: 'NB-01 – Neubau Berlin',
    onChange: (next) => setDraft((current) => typeof next === 'function' ? next({ ...current, items: lines }) : next),
    onClientNameChange: (value) => setDraft((current) => ({ ...current, client: value })),
    onAddressChange: (value) => setDraft((current) => ({ ...current, clientAddress: value })),
    onSelectClient: (client) => setDraft((current) => ({ ...current, clientId: client.id, client: client.company, clientEmail: client.email ?? current.clientEmail, clientAddress: client.address ?? current.clientAddress })),
    onSelectProject: (project) => setDraft((current) => ({ ...current, projectId: project.id })),
    fieldErrors: {}, taxRateOptions: [0, 7, 19], resolvedTaxMode: 'standard_vat',
  }), [draft, lines]);

  return <main className="playground-shell">
    <header className="playground-toolbar"><div><strong>Billme Editor Playground</strong><span>A4-Arbeitsfläche · Zeilen direkt im Dokument bearbeiten</span></div><label>Fixture <select value={fixture} onChange={(event) => reset(event.target.value as Fixture)}>{(['construction', 'page-break', 'all-line-types', 'long-text', 'mixed-vat'] as Fixture[]).map((value) => <option key={value} value={value}>{value}</option>)}</select></label><button type="button" onClick={() => reset()}>Zurücksetzen</button><button type="button" onClick={undo} disabled={!past.length}>Rückgängig</button><button type="button" onClick={redo} disabled={!future.length}>Wiederholen</button></header>
    <section className="playground-stats"><span data-testid="page-count">{pageCount} Seiten</span><span>Netto {taxSnapshot.netAmount.toFixed(2)} €</span><span>USt {taxSnapshot.vatAmount.toFixed(2)} €</span><span>Brutto {taxSnapshot.grossAmount.toFixed(2)} €</span><span className={overflow.length ? 'bad' : 'good'}>{overflow.length ? overflow.join(', ') : 'Kein Überlauf'}</span></section>
    <DocumentCanvasEditor elements={elements as never[]} items={lines} onItemsChange={(next) => { commit(next); setDraft((current) => ({ ...current, items: next })); }} documentFields={documentFields} articles={playgroundArticles} formatCurrency={(amount) => `${amount.toFixed(2).replace('.', ',')} €`} taxRateOptions={[0, 7, 19]} />
  </main>;
};

createRoot(document.getElementById('root')!).render(<App />);
