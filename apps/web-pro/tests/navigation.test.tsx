import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const { client } = vi.hoisted(() => ({
  client: {
    getHealth: vi.fn(async () => ({ service: 'server-api', status: 'ok' })),
    getCapabilities: vi.fn(async () => ({ products: ['pro'], auth: { roles: ['owner'] } })),
    getBootstrapStatus: vi.fn(async () => ({ bootstrapped: true, userCount: 1 })),
    getSessionInfo: vi.fn(async () => ({ tenantId: 'tenant-1', role: 'owner' })),
    listClients: vi.fn(async () => []),
    listInvoices: vi.fn(async () => []),
    listOffers: vi.fn(async () => []),
    listRecurringProfiles: vi.fn(async () => []),
    getSettings: vi.fn(async () => null),
    listArticles: vi.fn(async () => []),
    listAccounts: vi.fn(async () => []),
    listTemplates: vi.fn(async () => []),
    getActiveTemplate: vi.fn(async () => null),
    listWorkflowEntries: vi.fn(async () => []),
    listAccountingTransactions: vi.fn(async () => []),
    listAccountingDrafts: vi.fn(async () => []),
    getAccountingPolicy: vi.fn(async () => ({ activeChart: 'SKR03' })),
    getLedgerStats: vi.fn(async () => ({ total: 0 })),
    listLedgerAccounts: vi.fn(async () => []),
    listTaxCases: vi.fn(async () => []),
    listTaxCaseMappings: vi.fn(async () => []),
    listAccountSuggestionRules: vi.fn(async () => []),
  },
}));

vi.mock('../src/api', () => ({
  createProWebClient: () => client,
}));

describe('Pro web shell navigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('billme.web-pro.session.v1', JSON.stringify({
      token: 'test-token',
      user: { fullName: 'Test Owner' },
      apiUrl: 'http://localhost:3100',
    }));
    window.location.hash = '#/';
  });

  it('exposes the active route to assistive technology', async () => {
    render(<App />);

    await screen.findByRole('navigation', { name: 'Web-Pro Navigation' });
    const overview = screen.getByRole('button', { name: /Überblick/ });
    const documents = screen.getByRole('button', { name: /Dokumente/ });

    expect(overview.getAttribute('aria-current')).toBe('page');
    expect(documents.getAttribute('aria-current')).toBeNull();

    fireEvent.click(documents);

    await waitFor(() => {
      expect(documents.getAttribute('aria-current')).toBe('page');
      expect(overview.getAttribute('aria-current')).toBeNull();
    });
  });
});
