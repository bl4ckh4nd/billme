import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserDocumentShell, type BrowserMountContext } from '../../../packages/desktop-renderer/src/BrowserDocumentShell';
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
// Server A of servers.mts; the specs switch to server B on 4192.
createRoot(document.getElementById('root')!).render(params.has('real') ? <React.Suspense fallback="Lädt…"><RealApp /></React.Suspense> : <BrowserDocumentShell
  product={product} defaultApiUrl="http://127.0.0.1:4191" sessionStorageKey={`${product}.session`} apiUrlStorageKey={`${product}.url`}
  mount={mount} />);
