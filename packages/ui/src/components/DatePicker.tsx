import React, { useState, useRef, useEffect } from 'react';
import { cn } from '../utils/cn';

export interface DatePickerProps {
  value: string; // YYYY-MM-DD or empty string
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
const DAYS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const parseIso = (value: string): Date | null => {
  if (!value) return null;
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return new Date(parts[0]!, parts[1]! - 1, parts[2]!);
};

const toIso = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const formatDe = (value: string): string => {
  const d = parseIso(value);
  if (!d) return '';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  placeholder = 'Datum wählen',
  className,
}) => {
  const today = new Date();
  const todayIso = toIso(today);
  const selectedDate = parseIso(value);

  const getInitView = () => {
    const base = selectedDate ?? today;
    return { year: base.getFullYear(), month: base.getMonth() };
  };

  const [open, setOpen] = useState(false);
  const [view, setView] = useState(getInitView);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setView(getInitView());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const shiftMonth = (delta: number) => {
    setView(v => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  // Build a flat array of 42 cells (null = padding, number = day)
  const buildGrid = () => {
    const firstDow = (new Date(view.year, view.month, 1).getDay() + 6) % 7; // Mon=0
    const dim = new Date(view.year, view.month + 1, 0).getDate();
    const cells: (number | null)[] = Array(firstDow).fill(null);
    for (let d = 1; d <= dim; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  };

  const cells = buildGrid();

  const isToday = (day: number) =>
    toIso(new Date(view.year, view.month, day)) === todayIso;

  const isSelected = (day: number) =>
    selectedDate !== null &&
    selectedDate.getFullYear() === view.year &&
    selectedDate.getMonth() === view.month &&
    selectedDate.getDate() === day;

  const pick = (day: number) => {
    onChange(toIso(new Date(view.year, view.month, day)));
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full bg-gray-50 border border-gray-200 rounded-xl p-2.5 text-sm font-medium outline-none flex items-center justify-between gap-2 hover:border-gray-300 focus:ring-2 focus:ring-accent transition-colors"
      >
        <span className={value ? 'text-gray-900' : 'text-gray-400'}>
          {value ? formatDe(value) : placeholder}
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0">
          <rect width="18" height="18" x="3" y="4" rx="2" ry="2"/>
          <line x1="16" x2="16" y1="2" y2="6"/>
          <line x1="8" x2="8" y1="2" y2="6"/>
          <line x1="3" x2="21" y1="10" y2="10"/>
        </svg>
      </button>

      {/* Popup calendar */}
      {open && (
        <div className="absolute z-50 mt-1.5 left-0 bg-white border border-gray-200 rounded-2xl shadow-xl p-3 w-64 select-none">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-2.5">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              className="p-1 rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <span className="text-xs font-bold text-gray-800">
              {MONTHS_DE[view.month]} {view.year}
            </span>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              className="p-1 rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 mb-1">
            {DAYS_DE.map(d => (
              <div key={d} className="text-center text-[10px] font-bold text-gray-400 py-0.5">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((day, i) => (
              <div key={i} className="flex items-center justify-center">
                {day !== null && (
                  <button
                    type="button"
                    onClick={() => pick(day)}
                    className={cn(
                      'w-7 h-7 rounded-lg text-xs font-medium transition-colors',
                      isSelected(day)
                        ? 'bg-gray-900 text-white'
                        : isToday(day)
                        ? 'bg-accent/20 text-accent font-bold ring-1 ring-accent'
                        : 'text-gray-700 hover:bg-gray-100',
                    )}
                  >
                    {day}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Shortcut: Today */}
          <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => { onChange(todayIso); setOpen(false); }}
              className="text-xs text-gray-500 hover:text-gray-900 transition-colors font-medium"
            >
              Heute
            </button>
            {value && (
              <button
                type="button"
                onClick={() => { onChange(''); setOpen(false); }}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors"
              >
                Entfernen
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
