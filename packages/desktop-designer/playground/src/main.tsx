import React from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentEditor, type DocumentDraft, type DraftItem } from '@billme/desktop-designer/document-editor';
import { createDefaultTemplateBody } from '@billme/server-core/domain';
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

const FIXTURES: Fixture[] = ['construction', 'page-break', 'all-line-types', 'long-text', 'mixed-vat'];
const templateBody = createDefaultTemplateBody('invoice');

// Playground for the document editor: edit on the sheet, check page breaks in "Vorschau".
const App = () => {
  const [fixture, setFixture] = React.useState<Fixture>(() => (new URLSearchParams(location.search).get('fixture') as Fixture | null) ?? 'construction');
  const document = React.useMemo<DocumentDraft>(() => ({
    id: `playground-${fixture}`, number: 'PLAY-001', date: '2026-08-07', dueDate: '2026-08-21', client: 'Bauherr Beispiel', clientId: 'client-1',
    clientEmail: 'kunde@example.de', clientAddress: 'Musterweg 7\n10115 Berlin', projectId: 'project-1', amount: 0, items: makeLines(fixture), taxMeta: { defaultVatRate: 19 },
  }), [fixture]);
  const select = (next: Fixture) => {
    setFixture(next);
    history.replaceState(null, '', `?fixture=${next}`);
  };
  return <main className="playground-shell">
    <header className="playground-toolbar"><div><strong>Billme Editor Playground</strong><span>Belegeditor im Fluss-Layout · Seitenumbrüche in der Vorschau</span></div><label>Fixture <select value={fixture} onChange={(event) => select(event.target.value as Fixture)}>{FIXTURES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></header>
    <div style={{ height: 'calc(100vh - 64px)' }}>
      <DocumentEditor
        document={document}
        templateType="invoice"
        mode="edit"
        clients={playgroundClients}
        articles={playgroundArticles}
        projects={playgroundProjects}
        settings={settings as never}
        templateKind="invoice"
        templateOptions={[]}
        defaultTemplateName="Modern"
        resolveTemplateBody={() => templateBody}
        onSave={(saved) => console.info('Gespeichert', saved)}
        onCancel={() => undefined}
      />
    </div>
  </main>;
};

createRoot(document.getElementById('root')!).render(<App />);
