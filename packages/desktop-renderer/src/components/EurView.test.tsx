import React from 'react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeedbackProvider } from '@billme/ui';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

import { EurView } from './EurView';

const reportFor = (taxYear: number) => ({
  taxYear,
  from: `${taxYear}-01-01`,
  to: `${taxYear}-12-31`,
  rows: [{ lineId: `line-${taxYear}`, kennziffer: '112', label: 'Betriebseinnahmen', kind: 'income' as const, exportable: true, sortOrder: 0, total: 42 }],
  summary: { incomeTotal: 42, expenseTotal: 0, surplus: 42 },
  unclassifiedCount: 0,
  warnings: [],
  catalog: { id: `anlage-euer-${taxYear}`, version: `BMF-${taxYear}`, sourceHash: 'a'.repeat(64), delivery: 'print-form-only' as const, elsterReady: false },
});

describe('EurView tax year selection', () => {
  it('defaults to the newest supported year and refetches report and items for the selected year', async () => {
    const getReport = vi.fn(async ({ taxYear }: { taxYear: number }) => reportFor(taxYear));
    const listItems = vi.fn(async () => []);
    const api = {
      eur: {
        getReport,
        listItems,
        upsertClassification: vi.fn(),
        exportCsv: vi.fn(async () => ''),
        exportPdf: vi.fn(async () => ({ path: '/tmp/euer.pdf' })),
        listRules: vi.fn(async () => []),
        upsertRule: vi.fn(),
        deleteRule: vi.fn(),
      },
    };
    Object.assign(globalThis, {
      billmeApi: api,
      billmeRuntime: { product: 'lite', shell: 'desktop' },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <FeedbackProvider>
          <EurView />
        </FeedbackProvider>
      </QueryClientProvider>,
    );

    const yearSelect = await screen.findByDisplayValue('2026');
    expect([...((yearSelect as HTMLSelectElement).options)].map((option) => option.value)).toEqual(['2025', '2026']);
    expect(getReport).toHaveBeenCalledWith({ taxYear: 2026 });
    expect(listItems).toHaveBeenCalledWith({ taxYear: 2026 });

    await user.selectOptions(yearSelect, '2025');
    await waitFor(() => {
      expect(getReport).toHaveBeenLastCalledWith({ taxYear: 2025 });
      expect(listItems).toHaveBeenLastCalledWith({ taxYear: 2025 });
    });
    expect(screen.getByText(/Steuerjahr 2025/)).toBeInTheDocument();
  });
});
