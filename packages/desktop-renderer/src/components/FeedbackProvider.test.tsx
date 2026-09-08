import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FeedbackProvider, useActionFeedback } from '@billme/ui';

const FeedbackActions: React.FC = () => {
  const { notify } = useActionFeedback('documents');

  return (
    <>
      <button type="button" onClick={() => notify('success', 'erste Meldung')}>Erste Meldung</button>
      <button type="button" onClick={() => notify('success', 'ersetzte Meldung')}>Ersetze Meldung</button>
    </>
  );
};

describe('FeedbackProvider', () => {
  it('cancels a replaced scope timer instead of hiding the newer entry', () => {
    vi.useFakeTimers();
    try {
      render(
        <FeedbackProvider>
          <FeedbackActions />
        </FeedbackProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Erste Meldung' }));
      expect(screen.getByText('erste Meldung')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(2500));
      fireEvent.click(screen.getByRole('button', { name: 'Ersetze Meldung' }));
      expect(screen.queryByText('erste Meldung')).not.toBeInTheDocument();
      expect(screen.getByText('ersetzte Meldung')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(500));
      expect(document.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(1);
      expect(screen.getByText('ersetzte Meldung')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2499));
      expect(screen.getByText('ersetzte Meldung')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText('ersetzte Meldung')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
