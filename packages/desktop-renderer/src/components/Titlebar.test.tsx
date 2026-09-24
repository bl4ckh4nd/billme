import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Titlebar } from './Titlebar';

const setRuntime = (runtime: object | undefined) => {
  (globalThis as { billmeRuntime?: object }).billmeRuntime = runtime;
};

describe('Titlebar', () => {
  afterEach(() => setRuntime(undefined));

  it('shows window controls in the desktop shell', () => {
    render(<Titlebar logoSrc="logo.svg" />);
    expect(screen.getByRole('button', { name: 'Fenster schließen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Abmelden/ })).not.toBeInTheDocument();
  });

  it('swaps window controls for sign-out in the web shell', () => {
    const onLogout = vi.fn();
    setRuntime({ shell: 'web', onLogout });
    render(<Titlebar logoSrc="logo.svg" />);
    expect(screen.queryByRole('button', { name: 'Fenster schließen' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Abmelden/ }));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
