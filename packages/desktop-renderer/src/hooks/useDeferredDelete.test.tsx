import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FeedbackProvider } from '@billme/ui';
import { describe, expect, it, vi } from 'vitest';
import { DEFERRED_DELETE_DELAY_MS, useDeferredDelete } from './useDeferredDelete';

const DeferredDeleteHarness: React.FC<{ commit: (id: string) => Promise<unknown> }> = ({ commit }) => {
  const { pendingIds, requestDelete, undo } = useDeferredDelete({
    scope: 'deferred-delete-test',
    commit,
    label: (count) => `${count} Element${count === 1 ? '' : 'e'} gelöscht`,
  });

  return (
    <>
      <output data-testid="pending">{pendingIds.has('item-1') ? 'hidden' : 'visible'}</output>
      <button type="button" onClick={() => requestDelete(['item-1'])}>Löschen</button>
      <button type="button" data-testid="undo-hook" onClick={undo}>Rückgängig</button>
    </>
  );
};

const renderHarness = (commit: (id: string) => Promise<unknown>) => render(
  <FeedbackProvider>
    <DeferredDeleteHarness commit={commit} />
  </FeedbackProvider>,
);

describe('useDeferredDelete', () => {
  it('hides an id immediately and undo prevents its deferred commit', () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn().mockResolvedValue(undefined);
      renderHarness(commit);

      act(() => fireEvent.click(screen.getByRole('button', { name: 'Löschen' })));
      expect(screen.getByTestId('pending')).toHaveTextContent('hidden');

      act(() => fireEvent.click(screen.getByTestId('undo-hook')));
      expect(screen.getByTestId('pending')).toHaveTextContent('visible');

      act(() => vi.advanceTimersByTime(DEFERRED_DELETE_DELAY_MS));
      expect(commit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits once when the deferred window elapses', async () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn().mockResolvedValue(undefined);
      renderHarness(commit);

      act(() => fireEvent.click(screen.getByRole('button', { name: 'Löschen' })));
      await act(async () => {
        vi.advanceTimersByTime(DEFERRED_DELETE_DELAY_MS);
        await Promise.resolve();
      });

      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith('item-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits on unmount and removes the Undo toast so it cannot lie', async () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn().mockResolvedValue(undefined);
      // provider stays mounted (it lives above the router); only the view goes away
      const Shell: React.FC = () => {
        const [open, setOpen] = React.useState(true);
        return (
          <FeedbackProvider>
            {open ? <DeferredDeleteHarness commit={commit} /> : null}
            <button type="button" onClick={() => setOpen(false)}>Verlassen</button>
          </FeedbackProvider>
        );
      };
      render(<Shell />);

      act(() => fireEvent.click(screen.getByRole('button', { name: 'Löschen' })));
      expect(screen.getAllByRole('button', { name: 'Rückgängig' }).length).toBeGreaterThan(1);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Verlassen' }));
        await Promise.resolve();
      });

      expect(commit).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Rückgängig' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
