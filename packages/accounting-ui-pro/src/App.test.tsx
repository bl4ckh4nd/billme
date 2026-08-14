import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('Pro accounting shell', () => {
  it('keeps the accounting tabs reachable without widening the page', () => {
    render(<App />);
    const navigation = screen.getByRole('navigation', { name: 'Buchhaltungsbereiche' });
    expect(navigation.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
    expect(navigation.classList.contains('min-w-max')).toBe(true);
    expect(screen.getByRole('main').classList.contains('min-w-0')).toBe(true);
  });
});
