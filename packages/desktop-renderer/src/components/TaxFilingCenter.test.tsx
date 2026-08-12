import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaxFilingCenter } from './TaxFilingCenter';

const api = {
  status: vi.fn(async () => ({ provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' }, certificates: [] })),
  records: vi.fn(async () => [{ id: 'euer-2025', kind: 'euer' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31', sourceHash: 'a'.repeat(64), status: 'frozen' as const }]),
  validate: vi.fn(), export: vi.fn(), submit: vi.fn(),
};

describe('TaxFilingCenter', () => {
  it('only exposes approved frozen records and keeps submit disabled without server approval', async () => {
    Object.assign(window, { billmeApi: { taxFiling: api } });
    render(<TaxFilingCenter />);
    expect(await screen.findByText(/EÜR 2025/)).toBeTruthy();
    expect(screen.queryByText(/Payload JSON/)).toBeNull();
    expect(screen.getByRole('button', { name: /Übermitteln/ })).toHaveProperty('disabled', true);
  });
});
