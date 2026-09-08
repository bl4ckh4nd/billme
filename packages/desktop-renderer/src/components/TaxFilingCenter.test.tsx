import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaxFilingCenter } from './TaxFilingCenter';

const api = {
  getStatus: vi.fn(async () => ({ provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' }, certificates: [] })),
  listRecords: vi.fn(async () => [{ id: 'euer-2025', kind: 'euer' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31', sourceHash: 'a'.repeat(64), status: 'frozen' as const }]),
  validate: vi.fn(), export: vi.fn(), submit: vi.fn(),
};

describe('TaxFilingCenter', () => {
  it('only exposes approved frozen records and keeps submit disabled without server approval', async () => {
    Object.assign(window, { billmeApi: { taxFiling: api } });
    render(<TaxFilingCenter />);
    expect(await screen.findByText(/EÜR 2025/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Provider: In dieser Umgebung ist kein ELSTER-/Filing-Provider installiert. Validierung und Export sind nicht verfügbar.',
    );
    expect(screen.queryByText(/Payload JSON/)).toBeNull();
    expect(screen.getByRole('button', { name: /Übermitteln/ })).toHaveProperty('disabled', true);
  });

  it('shows a non-generic provider error code in German prose', async () => {
    Object.assign(window, {
      billmeApi: {
        taxFiling: {
          ...api,
          getStatus: vi.fn(async () => ({ provider: { available: false, provider: null, errorCode: 'PROVIDER_INVALID' }, certificates: [] })),
        },
      },
    });

    render(<TaxFilingCenter />);

    expect((await screen.findByRole('status')).textContent).toBe(
      'Provider: In dieser Umgebung ist kein ELSTER-/Filing-Provider installiert. Validierung und Export sind nicht verfügbar. Fehlercode: PROVIDER_INVALID',
    );
  });

  it('renders a readable message when tax filing IPC is unavailable', async () => {
    const unavailableApi = {
      getStatus: vi.fn().mockRejectedValue(new Error('route unavailable')),
      listRecords: vi.fn().mockRejectedValue(new Error('route unavailable')),
      validate: vi.fn(),
      export: vi.fn(),
      submit: vi.fn(),
    };
    Object.assign(window, { billmeApi: { taxFiling: unavailableApi } });

    render(<TaxFilingCenter />);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Steuer-Filing-Center nicht verfügbar: route unavailable',
    );
  });
});
