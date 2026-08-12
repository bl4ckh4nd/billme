import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DatevExportPanel from './DatevExportPanel';

const historyRow = {
  id: 'datev-1',
  filePath: '/exports/datev-1.CSV',
  recordCount: 12,
  fromDate: '2026-03-01',
  toDate: '2026-03-31',
  createdAt: '2026-03-31T12:00:00.000Z',
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  encoding: 'cp1252' as const,
  chart: 'SKR03' as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('DatevExportPanel', () => {
  it('offers a retry when immutable history loading fails', async () => {
    const listDatevExports = vi.fn()
      .mockRejectedValueOnce(new Error('DATEV-Verlauf vorübergehend nicht erreichbar'))
      .mockResolvedValueOnce([historyRow]);

    render(<DatevExportPanel dataAdapter={{ listDatevExports }} />);

    expect((await screen.findByRole('alert')).textContent).toContain('vorübergehend');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));

    await waitFor(() => expect(listDatevExports).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/12 Buchungen/)).toBeTruthy();
  });

  it('ignores a stale history response after a newer refresh succeeds', async () => {
    const stale = deferred<typeof historyRow[]>();
    const fresh = deferred<typeof historyRow[]>();
    const staleRow = { ...historyRow, id: 'datev-stale', recordCount: 99 };
    const listDatevExports = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    const { rerender } = render(<DatevExportPanel dataAdapter={{ listDatevExports }} />);

    await waitFor(() => expect(listDatevExports).toHaveBeenCalledTimes(1));
    rerender(<DatevExportPanel dataAdapter={{ listDatevExports }} />);
    await waitFor(() => expect(listDatevExports).toHaveBeenCalledTimes(2));

    fresh.resolve([historyRow]);
    expect(await screen.findByText(/12 Buchungen/)).toBeTruthy();
    stale.resolve([staleRow]);
    await waitFor(() => expect(screen.queryByText(/99 Buchungen/)).toBeNull());
  });

  it('does not surface a stale history error after a newer refresh succeeds', async () => {
    const stale = deferred<typeof historyRow[]>();
    const fresh = deferred<typeof historyRow[]>();
    const listDatevExports = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    const { rerender } = render(<DatevExportPanel dataAdapter={{ listDatevExports }} />);

    await waitFor(() => expect(listDatevExports).toHaveBeenCalledTimes(1));
    rerender(<DatevExportPanel dataAdapter={{ listDatevExports }} />);
    await waitFor(() => expect(listDatevExports).toHaveBeenCalledTimes(2));

    fresh.resolve([historyRow]);
    expect(await screen.findByText(/12 Buchungen/)).toBeTruthy();
    stale.reject(new Error('veralteter DATEV-Verlauf-Fehler'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('loads immutable history and exports through the productive adapter', async () => {
    const listDatevExports = vi.fn(async () => [historyRow]);
    const exportDatevBuchungsstapel = vi.fn(async () => ({ ...historyRow, id: 'datev-2', recordCount: 4 }));
    const adapter = { listDatevExports, exportDatevBuchungsstapel };

    render(<DatevExportPanel dataAdapter={adapter} chartFramework="SKR03" />);

    expect(await screen.findByText(/12 Buchungen/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Beraternummer'), { target: { value: '1001' } });
    fireEvent.change(screen.getByLabelText('Mandantennummer'), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Buchungsstapel exportieren/i }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Buchungsstapel exportieren/i }));

    await waitFor(() => expect(exportDatevBuchungsstapel).toHaveBeenCalledWith(expect.objectContaining({
      consultantNumber: '1001',
      clientNumber: '1',
      accountLength: 4,
      encoding: 'cp1252',
    })));
    expect(await screen.findByText(/Export erstellt: 4 Buchungen/)).toBeTruthy();
    expect(listDatevExports).toHaveBeenCalledWith(20);
  });

  it('makes the browser/read-only path explicit and never falls back to example data', async () => {
    render(<DatevExportPanel dataAdapter={{}} />);

    expect(await screen.findByText(/nur im Pro Desktop verfügbar/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Buchungsstapel exportieren/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/MacBook|Beispiel/)).toBeNull();
  });

  it('shows validation feedback before calling the adapter', async () => {
    const exportDatevBuchungsstapel = vi.fn();
    render(<DatevExportPanel dataAdapter={{ exportDatevBuchungsstapel }} />);

    fireEvent.change(screen.getByLabelText('Beraternummer'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Mandantennummer'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Buchungsstapel exportieren/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('Beraternummer');
    expect(exportDatevBuchungsstapel).not.toHaveBeenCalled();
  });
});
