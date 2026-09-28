import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserDocumentShell, type BrowserMountContext } from '../../../packages/desktop-renderer/src/BrowserDocumentShell';
import Workspace from '../../../packages/accounting-ui-pro/src/App';
import { mockTransactions } from '../../../packages/accounting-ui-pro/src/mocks/transactions';
import { mockBookingDrafts } from '../../../packages/accounting-ui-pro/src/mocks/bookings';
import '../../../apps/desktop/index.css';

const params = new URLSearchParams(location.search);
const product = params.get('product') === 'pro' ? 'pro' : 'lite';
const RealApp = React.lazy(() => product === 'pro' ? import('../../../apps/web-pro/src/App') : import('../../../apps/web/src/App'));
const mount = async (element: HTMLElement, context: BrowserMountContext) => {
  const label = document.createElement('p');
  label.textContent = `${product} angemeldet: ${context.apiUrl}`;
  const button = document.createElement('button');
  button.textContent = 'Abmelden'; button.onclick = context.onLogout;
  element.append(label, button);
  return () => element.replaceChildren();
};
const makeSeed = (name: string) => ({
  transactions: structuredClone(mockTransactions).map(tx => ({ ...tx, payee: `${name} ${tx.payee}` })),
  drafts: structuredClone(mockBookingDrafts).map(draft => ({ ...draft, bookingText: `${name} original` })),
});
const seedA = makeSeed('A');
let rejectA: ((error: Error) => void) | undefined;
const persistA = () => new Promise<void>((_, reject) => { rejectA = reject; });
function Workspaces() {
  const [showA, setShowA] = useState(true);
  const [seedB, setSeedB] = useState(() => makeSeed('B'));
  return <>
    <button onClick={() => setShowA(false)}>A schließen</button>
    <button onClick={() => rejectA?.(new Error('A offline'))}>A Fehler freigeben</button>
    <button onClick={() => setSeedB(makeSeed('B'))}>B aktualisieren</button>
    {showA && <section aria-label="Workspace A"><Workspace seed={seedA} onPersistEntry={persistA} /></section>}
    <section aria-label="Workspace B"><Workspace seed={seedB} /></section>
  </>;
}
createRoot(document.getElementById('root')!).render(params.has('real') ? <React.Suspense fallback="Lädt…"><RealApp /></React.Suspense> : params.has('workspace') ? <Workspaces /> : <BrowserDocumentShell
  product={product} defaultApiUrl="http://server-a.test" sessionStorageKey={`${product}.session`} apiUrlStorageKey={`${product}.url`}
  mount={mount} />);
