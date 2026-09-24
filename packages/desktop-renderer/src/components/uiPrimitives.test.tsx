import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  Checkbox,
  IconButton,
  Menu,
  SegmentedControl,
  Sparkline,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  nextSort,
} from '@billme/ui';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

describe('SegmentedControl', () => {
  it('is a radio group whose arrow keys move the selection and focus', () => {
    const Harness = () => {
      const [value, setValue] = React.useState<'month' | 'year'>('month');
      return (
        <SegmentedControl
          aria-label="Zeitraum"
          value={value}
          onChange={setValue}
          options={[{ value: 'month', label: 'Monat' }, { value: 'year', label: 'Jahr' }]}
        />
      );
    };
    render(<Harness />);

    const month = screen.getByRole('radio', { name: 'Monat' });
    expect(month).toHaveAttribute('aria-checked', 'true');
    expect(month).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(month, { key: 'ArrowRight' });
    const year = screen.getByRole('radio', { name: 'Jahr' });
    expect(year).toHaveAttribute('aria-checked', 'true');
    expect(year).toHaveFocus();
  });
});

describe('Table', () => {
  it('announces sort state and activates interactive rows by keyboard', () => {
    const onSort = vi.fn();
    const onOpen = vi.fn();
    render(
      <Table aria-label="Rechnungen">
        <TableHeader>
          <TableRow>
            <TableHead sort="asc" onSort={onSort}>Nummer</TableHead>
            <TableHead numeric>Betrag</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow interactive onClick={onOpen}>
            <TableCell>RE-1</TableCell>
            <TableCell numeric>10,00 €</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByRole('columnheader', { name: /Nummer/ })).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: /Nummer/ }));
    expect(onSort).toHaveBeenCalledTimes(1);

    const row = screen.getByRole('row', { name: /RE-1/ });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('flips direction on the same key and starts ascending on a new key', () => {
    expect(nextSort({ key: 'date', direction: 'asc' }, 'date')).toEqual({ key: 'date', direction: 'desc' });
    expect(nextSort({ key: 'date', direction: 'desc' }, 'amount')).toEqual({ key: 'amount', direction: 'asc' });
  });
});

describe('Checkbox', () => {
  it('keeps native checkbox semantics and reports the mixed state', () => {
    render(<Checkbox label="Alle auswählen" indeterminate onChange={() => {}} />);
    const box = screen.getByRole('checkbox', { name: 'Alle auswählen' });
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    expect((box as HTMLInputElement).indeterminate).toBe(true);
  });
});

describe('Menu', () => {
  it('opens from the keyboard, skips disabled items, and returns focus on Escape', () => {
    const onDuplicate = vi.fn();
    render(
      <Menu
        aria-label="Aktionen"
        trigger={(props) => <button type="button" {...props}>Aktionen</button>}
        items={[
          { id: 'edit', label: 'Bearbeiten', onSelect: () => {} },
          { id: 'archive', label: 'Archivieren', onSelect: () => {}, disabled: true },
          { id: 'duplicate', label: 'Duplizieren', onSelect: onDuplicate },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Aktionen' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Bearbeiten' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Duplizieren' })).toHaveFocus();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplizieren' }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
});

describe('IconButton tooltip', () => {
  it('shows its label on hover without describing the button twice', () => {
    vi.useFakeTimers();
    try {
      render(<IconButton aria-label="Einstellungen">x</IconButton>);
      const button = screen.getByRole('button', { name: 'Einstellungen' });
      fireEvent.pointerEnter(button, { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByRole('tooltip')).toHaveTextContent('Einstellungen');
      expect(button).not.toHaveAttribute('aria-describedby');
      fireEvent.pointerDown(button);
      expect(button.getAttribute('aria-describedby')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('links shorter tooltip text as a description and stays hidden while expanded', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<IconButton aria-label="Aktionen für Konto A" tooltip="Aktionen">x</IconButton>);
      const button = screen.getByRole('button', { name: 'Aktionen für Konto A' });
      fireEvent.pointerEnter(button, { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(500); });
      expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);

      rerender(<IconButton aria-label="Aktionen für Konto A" tooltip="Aktionen" aria-expanded>x</IconButton>);
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Sparkline', () => {
  it('names the trend for assistive tech and renders nothing without a series', () => {
    const { rerender, container } = render(<Sparkline values={[0, 200, 150, 400]} aria-label="Umsatz der letzten 4 Monate" />);
    expect(screen.getByRole('img', { name: 'Umsatz der letzten 4 Monate, zuletzt steigend' })).toBeInTheDocument();
    expect(container.querySelector('polyline')?.getAttribute('points')).toBe('0,100 33.33333333333333,50 66.66666666666666,62.5 100,0');

    rerender(<Sparkline values={[400, 100]} aria-label="Umsatz" />);
    expect(screen.getByRole('img', { name: 'Umsatz, zuletzt fallend' })).toBeInTheDocument();

    rerender(<Sparkline values={[5]} aria-label="Umsatz" />);
    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});
