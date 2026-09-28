import React from 'react';
import { BrowserDocumentShell, type BrowserMountContext } from '@billme/desktop-renderer/browser-shell';
import { mountProDesktopRendererApp } from '@billme/desktop-renderer/pro';
import { createProWebBillmeApi } from './createProWebApi';

const mount = (element: HTMLElement, { apiUrl, token, onLogout, signal }: BrowserMountContext) => {
  const api = createProWebBillmeApi({ baseUrl: apiUrl, token, onRequestClose: onLogout });
  return mountProDesktopRendererApp(element, { api, signal, runtime: { shell: 'web', product: 'pro', onLogout } });
};

export default function App() {
  return <BrowserDocumentShell product="pro" mount={mount}
    defaultApiUrl={import.meta.env.VITE_SERVER_API_URL ?? 'http://127.0.0.1:3100'}
    sessionStorageKey="billme.web-pro.session.v1" apiUrlStorageKey="billme.web-pro.api-url.v1"
    initialCredentials={import.meta.env.DEV ? { email: 'owner@example.com', password: 'billme-server-123', fullName: 'Billme Pro Owner' } : undefined} />;
}
