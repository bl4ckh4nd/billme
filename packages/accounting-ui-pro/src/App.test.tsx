import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';

describe('Pro accounting shell', () => {
  it('keeps the accounting tabs reachable without widening the page', () => {
    render(<App />);
    const navigation = screen.getByRole('navigation', { name: 'Buchhaltungsbereiche' });
    expect(navigation.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
    expect(navigation.classList.contains('min-w-max')).toBe(true);
    expect(screen.getByRole('main').classList.contains('min-w-0')).toBe(true);
  });

  it('exposes the active accounting tab to assistive technology', () => {
    render(<App />);
    const inbox = screen.getByRole('button', { name: 'Inbox' });
    const reports = screen.getByRole('button', { name: 'Auswertungen' });

    expect(inbox.getAttribute('aria-current')).toBe('page');
    expect(reports.getAttribute('aria-current')).toBeNull();

    fireEvent.click(reports);

    expect(reports.getAttribute('aria-current')).toBe('page');
    expect(inbox.getAttribute('aria-current')).toBeNull();
  });

  it('keeps Inbox active while a transaction is open in BookingEditor', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Software GmbH öffnen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Erweitern' }));

    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
  });
});
