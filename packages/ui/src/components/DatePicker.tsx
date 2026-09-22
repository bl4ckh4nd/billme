import React, { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../utils/cn';
import { Portal } from './Portal';

export interface DatePickerProps {
  value: string; // YYYY-MM-DD or empty string
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  min?: string;
  max?: string;
  isDateDisabled?: (value: string) => boolean;
  'aria-label'?: string;
}

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
const DAYS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const parseIso = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const date = new Date(parts[0]!, parts[1]! - 1, parts[2]!);
  return toIso(date) === value ? date : null;
};

const toIso = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const formatDe = (value: string): string => {
  const date = parseIso(value);
  if (!date) return '';
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const parseGermanDate = (value: string): string | null => {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[3]);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const date = new Date(year, month - 1, day);
  const iso = toIso(date);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? iso : null;
};

const daysInMonth = (year: number, month: number): number => new Date(year, month + 1, 0).getDate();

const weekdayIndex = (date: Date): number => (date.getDay() + 6) % 7;

const dateLabel = (value: string): string => {
  const date = parseIso(value);
  return date
    ? date.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '';
};

export const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  placeholder = 'Datum wählen',
  className,
  min,
  max,
  isDateDisabled,
  'aria-label': ariaLabel,
}) => {
  const todayIso = toIso(new Date());
  const selectedDate = parseIso(value);
  const triggerRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const calendarId = React.useId();
  const popupId = `${calendarId}-dialog`;
  const titleId = `${calendarId}-title`;
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(formatDe(value));
  const [view, setView] = useState(() => {
    const base = selectedDate ?? new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const isDateUnavailable = (iso: string): boolean => Boolean(
    (min && iso < min) ||
    (max && iso > max) ||
    isDateDisabled?.(iso),
  );

  const findEnabledDate = (year: number, month: number, preferredDay = 1): string | null => {
    const lastDay = daysInMonth(year, month);
    const start = Math.min(Math.max(preferredDay, 1), lastDay);
    for (let distance = 0; distance < lastDay; distance += 1) {
      const candidates = distance === 0 ? [start] : [start - distance, start + distance];
      for (const day of candidates) {
        if (day < 1 || day > lastDay) continue;
        const iso = toIso(new Date(year, month, day));
        if (!isDateUnavailable(iso)) return iso;
      }
    }
    return null;
  };

  useEffect(() => {
    setDraftValue(formatDe(value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const today = new Date();
    const fallback = !isDateUnavailable(todayIso)
      ? today
      : (parseIso(min ?? '') ?? parseIso(max ?? '') ?? today);
    const baseDate = selectedDate && !isDateUnavailable(value) ? selectedDate : fallback;
    setView({ year: baseDate.getFullYear(), month: baseDate.getMonth() });
    setFocusedDate(
      selectedDate && !isDateUnavailable(value)
        ? value
        : findEnabledDate(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !focusedDate) return;
    document.getElementById(`${calendarId}-day-${focusedDate}`)?.focus();
  }, [calendarId, focusedDate, open, popupPosition]);

  useEffect(() => {
    if (!open) {
      setPopupPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;

      if (anchor.bottom <= 0 || anchor.top >= window.innerHeight || anchor.right <= 0 || anchor.left >= window.innerWidth) {
        setOpen(false);
        setPopupPosition(null);
        return;
      }

      const width = Math.min(256, Math.max(window.innerWidth - 16, 0));
      const left = Math.min(Math.max(anchor.left, 8), Math.max(window.innerWidth - width - 8, 8));
      // ponytail: collision uses a conservative fixed height; replace with measured overlay geometry if the calendar gains variable-height content.
      const estimatedHeight = 360;
      const spaceBelow = window.innerHeight - anchor.bottom - 8;
      const spaceAbove = anchor.top - 8;
      const opensAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const top = opensAbove
        ? Math.max(8, anchor.top - Math.min(estimatedHeight, spaceAbove))
        : Math.min(anchor.bottom + 6, Math.max(8, window.innerHeight - 8));

      setPopupPosition({ top, left, width });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const closeCalendar = (returnFocus: boolean, nextValue = value) => {
    setOpen(false);
    setDraftValue(formatDe(nextValue));
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      closeCalendar(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open, value]);

  const shiftMonth = (delta: number) => {
    setView((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
    setFocusedDate((current) => {
      const base = parseIso(current ?? value) ?? new Date();
      const next = new Date(view.year, view.month + delta, 1);
      return findEnabledDate(next.getFullYear(), next.getMonth(), base.getDate());
    });
  };

  const buildGrid = (): (number | null)[] => {
    const firstDow = weekdayIndex(new Date(view.year, view.month, 1));
    const cells: (number | null)[] = Array(firstDow).fill(null);
    for (let day = 1; day <= daysInMonth(view.year, view.month); day += 1) cells.push(day);
    while (cells.length < 42) cells.push(null);
    return cells;
  };

  const cells = buildGrid();
  const isToday = (day: number) => toIso(new Date(view.year, view.month, day)) === todayIso;
  const isSelected = (day: number) => selectedDate !== null &&
    selectedDate.getFullYear() === view.year && selectedDate.getMonth() === view.month && selectedDate.getDate() === day;

  const commitValue = (nextValue: string) => {
    onChange(nextValue);
    closeCalendar(true, nextValue);
  };

  const pick = (day: number) => {
    const nextValue = toIso(new Date(view.year, view.month, day));
    if (!isDateUnavailable(nextValue)) commitValue(nextValue);
  };

  const moveFocus = (delta: number) => {
    const current = parseIso(focusedDate ?? value) ?? new Date(view.year, view.month, 1);
    const next = new Date(current);
    for (let attempt = 0; attempt < 366; attempt += 1) {
      next.setDate(next.getDate() + delta);
      const nextValue = toIso(next);
      if (!isDateUnavailable(nextValue)) {
        setView({ year: next.getFullYear(), month: next.getMonth() });
        setFocusedDate(nextValue);
        return;
      }
    }
  };

  const moveToWeekEdge = (currentValue: string, edge: 'start' | 'end') => {
    const current = parseIso(currentValue);
    if (!current) return;
    const monday = new Date(current);
    monday.setDate(current.getDate() - weekdayIndex(current));
    const target = new Date(monday);
    if (edge === 'end') target.setDate(target.getDate() + 6);
    const targetValue = findEnabledDate(target.getFullYear(), target.getMonth(), target.getDate());
    if (targetValue) {
      const targetDate = parseIso(targetValue)!;
      setView({ year: targetDate.getFullYear(), month: targetDate.getMonth() });
      setFocusedDate(targetValue);
    }
  };

  const handleDayKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, dayValue: string) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(7);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-7);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveToWeekEdge(dayValue, 'start');
    } else if (event.key === 'End') {
      event.preventDefault();
      moveToWeekEdge(dayValue, 'end');
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      shiftMonth(event.shiftKey ? -12 : -1);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      shiftMonth(event.shiftKey ? 12 : 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(parseIso(dayValue)!.getDate());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeCalendar(true);
    }
  };

  const handleDraftChange = (nextDraft: string) => {
    setDraftValue(nextDraft);
    const parsed = parseGermanDate(nextDraft);
    if (parsed && !isDateUnavailable(parsed)) commitValue(parsed);
  };

  return (
    <div className={cn('relative', className)}>
      <div className="relative">
        <input
          ref={triggerRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          value={draftValue}
          placeholder={placeholder}
          aria-label={ariaLabel ?? 'Datum wählen'}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={popupId}
          onFocus={(event) => {
            setOpen(true);
            event.currentTarget.select();
          }}
          onClick={() => setOpen(true)}
          onChange={(event) => handleDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              closeCalendar(true);
            }
          }}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget as Node | null;
            if (nextTarget && popupRef.current?.contains(nextTarget)) return;
            requestAnimationFrame(() => {
              const activeTarget = document.activeElement;
              if (activeTarget && popupRef.current?.contains(activeTarget)) return;
              if (draftValue !== formatDe(value)) setDraftValue(formatDe(value));
            });
          }}
          className="w-full rounded-xl border border-control-border bg-surface-muted p-2.5 pr-9 text-sm font-medium text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-[border-color,box-shadow,outline-color] motion-reduce:transition-none"
        />
        <Calendar size={14} strokeWidth={1.5} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
      </div>

      {open && popupPosition ? (
        <Portal>
          <div
            ref={popupRef}
            id={popupId}
            role="dialog"
            aria-label={`Datum auswählen: ${MONTHS_DE[view.month]} ${view.year}`}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeCalendar(true);
              }
            }}
            className="ui-enter-popover fixed z-[var(--z-dropdown)] select-none rounded-2xl border border-border bg-surface p-3 shadow-xl"
            style={{ top: popupPosition.top, left: popupPosition.left, width: popupPosition.width }}
          >
            <div className="mb-2.5 flex items-center justify-between">
              <button
                type="button"
                aria-label="Vorheriger Monat"
                onClick={() => shiftMonth(-1)}
                className="ui-press inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-colors"
              >
                <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <span id={titleId} className="text-xs font-bold text-foreground">
                {MONTHS_DE[view.month]} {view.year}
              </span>
              <button
                type="button"
                aria-label="Nächster Monat"
                onClick={() => shiftMonth(1)}
                className="ui-press inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-colors"
              >
                <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>

            <div role="grid" aria-label={`Kalender ${MONTHS_DE[view.month]} ${view.year}`}>
              <div role="row" className="mb-1 grid grid-cols-7">
                {DAYS_DE.map((day) => (
                  <div key={day} role="columnheader" className="py-0.5 text-center text-xs font-bold text-muted">
                    {day}
                  </div>
                ))}
              </div>
              {Array.from({ length: 6 }, (_, rowIndex) => (
                <div key={rowIndex} role="row" className="grid grid-cols-7 gap-y-0.5">
                  {cells.slice(rowIndex * 7, rowIndex * 7 + 7).map((day, cellIndex) => {
                    const index = rowIndex * 7 + cellIndex;
                    if (day === null) return <span key={`empty-${index}`} role="gridcell" aria-hidden="true" />;
                    const dayValue = toIso(new Date(view.year, view.month, day));
                    const selected = isSelected(day);
                    const today = isToday(day);
                    const disabled = isDateUnavailable(dayValue);
                    return (
                      <button
                        key={dayValue}
                        id={`${calendarId}-day-${dayValue}`}
                        type="button"
                        role="gridcell"
                        tabIndex={focusedDate === dayValue ? 0 : -1}
                        aria-label={dateLabel(dayValue)}
                        aria-selected={selected}
                        aria-current={today ? 'date' : undefined}
                        disabled={disabled}
                        onClick={() => pick(day)}
                        onKeyDown={(event) => handleDayKeyDown(event, dayValue)}
                        className={cn(
                          'h-7 w-full rounded-lg text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-colors',
                          disabled
                            ? 'cursor-not-allowed bg-disabled-surface text-disabled-foreground'
                            : selected
                            ? cn('bg-accent font-bold text-accent-foreground', today && 'ring-2 ring-foreground')
                            : today
                            ? 'bg-surface-muted font-bold text-foreground ring-1 ring-foreground'
                            : 'text-foreground hover:bg-surface-muted',
                        )}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
              <button
                type="button"
                onClick={() => commitValue(todayIso)}
                disabled={isDateUnavailable(todayIso)}
                className="-mx-2 inline-flex min-h-9 items-center px-2 text-xs font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-colors disabled:cursor-not-allowed disabled:text-disabled-foreground"
              >
                Heute
              </button>
              {value && (
                <button
                  type="button"
                  onClick={() => commitValue('')}
                  className="-mx-2 inline-flex min-h-9 items-center px-2 text-xs text-muted hover:text-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-colors"
                >
                  Entfernen
                </button>
              )}
            </div>
          </div>
        </Portal>
      ) : null}
    </div>
  );
};
