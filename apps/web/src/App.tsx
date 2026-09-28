import React from 'react';
import { BrowserDocumentShell, type BrowserMountContext } from '@billme/desktop-renderer/browser-shell';
import { mountDesktopRendererApp } from '@billme/desktop-renderer';
import { createLiteWebBillmeApi } from './api/createLiteWebApi';

const mount = (element: HTMLElement, { apiUrl, token, onLogout, signal }: BrowserMountContext) => {
  const api = createLiteWebBillmeApi({ baseUrl: apiUrl, token, onAuthFailure: onLogout, onRequestClose: onLogout });
  return mountDesktopRendererApp(element, { api, signal, runtime: {
    shell: 'web', product: 'lite', navigation: ['dashboard', 'clients', 'documents', 'finance'],
    onLogout, validateVatId: api.validateVatId,
  } });
};

export default function App() {
  return <BrowserDocumentShell product="lite" mount={mount}
    defaultApiUrl={import.meta.env.VITE_SERVER_API_URL ?? 'http://127.0.0.1:3100'}
    sessionStorageKey="billme.web.lite.session.v1" apiUrlStorageKey="billme.web.lite.api-url.v1"
    initialCredentials={import.meta.env.DEV ? { email: 'owner@example.com', password: 'billme-server-123', fullName: 'Billme Lite Owner' } : undefined} />;
}
