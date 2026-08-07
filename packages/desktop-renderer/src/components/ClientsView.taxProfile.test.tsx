import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Client } from '@billme/desktop-core/types';

const upsertClient = vi.fn(async (client: Client) => client);
const client: Client = {
  id: 'client-tax-ui',
  customerNumber: 'KD-001',
  company: 'Alpen GmbH',
  contactPerson: 'Ada',
  email: 'billing@alpen.example',
  phone: '+43',
  address: 'Ringstraße 1, 1010 Wien, AT',
  status: 'active',
  tags: [],
  notes: '',
  projects: [],
  activities: [],
  addresses: [{ id: 'address-1', clientId: 'client-tax-ui', label: 'Rechnung', kind: 'billing', street: 'Ringstraße 1', zip: '1010', city: 'Wien', country: 'AT', isDefaultBilling: true, isDefaultShipping: true }],
  emails: [{ id: 'email-1', clientId: 'client-tax-ui', label: 'Buchhaltung', kind: 'billing', email: 'billing@alpen.example', isDefaultBilling: true, isDefaultGeneral: true }],
};

vi.mock('../hooks/useClients', () => ({
  useClientsQuery: () => ({ data: [client], isLoading: false }),
  useUpsertClientMutation: () => ({ mutateAsync: upsertClient }),
  useDeleteClientMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useInvoices', () => ({ useInvoicesQuery: () => ({ data: [] }) }));
vi.mock('../hooks/useDocuments', () => ({ useCreateDocumentFromClientMutation: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('../ui-store', () => ({ useUiStore: (selector: (state: { setEditingInvoice: () => void }) => unknown) => selector({ setEditingInvoice: vi.fn() }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

import { ClientsView } from './ClientsView';

describe('ClientsView tax profile', () => {
  it('edits and persists business country and VAT ID fields through the client mutation', async () => {
    const user = userEvent.setup();
    const { container } = render(<ClientsView />);

    await user.click(screen.getByText('Alpen GmbH'));
    const editButton = [...container.querySelectorAll('button')].find((button) => button.className.includes('w-10') && button.className.includes('border-gray-200'));
    expect(editButton).toBeTruthy();
    await user.click(editButton!);

    await user.selectOptions(screen.getByDisplayValue('Unternehmen'), 'business');
    const countryInput = container.querySelector('input[placeholder="DE"]') as HTMLInputElement;
    const vatInput = container.querySelector('input[placeholder="DE123456789"]') as HTMLInputElement;
    await user.type(countryInput, 'AT');
    await user.type(vatInput, 'ATU12345678');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(upsertClient).toHaveBeenCalledOnce();
    expect(upsertClient.mock.calls[0]![0]).toMatchObject({
      id: client.id,
      taxProfile: { type: 'business', countryCode: 'AT', vatId: 'ATU12345678' },
    });
  });
});
