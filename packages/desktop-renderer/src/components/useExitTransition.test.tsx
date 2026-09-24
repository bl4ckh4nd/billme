import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { Modal, OVERLAY_EXIT_MS } from '@billme/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setReducedMotion = (reduce: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

const renderModal = (open: boolean) => (
  <Modal open={open} onClose={() => {}} titleId="t">
    <h2 id="t">Titel</h2>
  </Modal>
);

describe('overlay exit transition', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a closing modal mounted with its exit classes until the exit duration elapses', () => {
    setReducedMotion(false);
    const { rerender } = render(renderModal(true));
    rerender(renderModal(false));

    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).toHaveClass('opacity-0');

    act(() => { vi.advanceTimersByTime(OVERLAY_EXIT_MS - 1); });
    expect(screen.queryByRole('dialog', { hidden: true })).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
  });

  it('unmounts immediately under reduced motion', () => {
    setReducedMotion(true);
    const { rerender } = render(renderModal(true));
    rerender(renderModal(false));
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
  });

  it('cancels a pending exit when the overlay reopens', () => {
    setReducedMotion(false);
    const { rerender } = render(renderModal(true));
    rerender(renderModal(false));
    rerender(renderModal(true));
    act(() => { vi.advanceTimersByTime(OVERLAY_EXIT_MS * 2); });

    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveClass('opacity-0');
  });
});
