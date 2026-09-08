import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '@billme/ui';
import { describe, expect, it, vi } from 'vitest';

describe('ConfirmDialog', () => {
  it('opens with focus on cancel, cancels on Escape, and confirms on click', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmDialog
        open
        title="Kunde löschen?"
        description="Diese Aktion kann nicht rückgängig gemacht werden."
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Kunde löschen?' });
    const cancelButton = screen.getByRole('button', { name: 'Abbrechen' });
    expect(dialog).toBeInTheDocument();
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
