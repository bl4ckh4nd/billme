import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../utils/cn';

export interface ComboboxItem {
  id: string;
}

export interface ComboboxProps<T extends ComboboxItem> {
  items: T[];
  value: string;
  onValueChange?: (text: string) => void;
  onSelect: (item: T) => void;
  getLabel: (item: T) => string;
  getSublabel?: (item: T) => string | undefined;
  getSearchText: (item: T) => string;
  allowFreeText?: boolean;
  placeholder?: string;
  disabled?: boolean;
  maxResults?: number;
  showSearchIcon?: boolean;
  inputClassName?: string;
  'aria-label'?: string;
}

function ComboboxInner<T extends ComboboxItem>(
  {
    items,
    value,
    onValueChange,
    onSelect,
    getLabel,
    getSublabel,
    getSearchText,
    allowFreeText = false,
    placeholder,
    disabled,
    maxResults = 12,
    showSearchIcon = true,
    inputClassName,
    'aria-label': ariaLabel,
  }: ComboboxProps<T>,
  forwardedRef: React.ForwardedRef<HTMLInputElement>,
) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const blurTimeout = useRef<number | null>(null);

  useEffect(() => {
    if (!focused) setQuery(value);
  }, [focused, value]);

  useEffect(() => () => {
    if (blurTimeout.current) window.clearTimeout(blurTimeout.current);
  }, []);

  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('de-DE');
    return items
      .filter((item) => !search || getSearchText(item).toLocaleLowerCase('de-DE').includes(search))
      .slice(0, maxResults);
  }, [getSearchText, items, maxResults, query]);
  const activeOption = filtered[activeIndex];

  const commitSelect = (item: T) => {
    onSelect(item);
    setQuery(getLabel(item));
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="relative">
        {showSearchIcon ? (
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" size={14} />
        ) : null}
        <input
          ref={forwardedRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeOption ? `${inputId}-opt-${activeOption.id}` : undefined}
          aria-label={ariaLabel}
          disabled={disabled}
          value={query}
          placeholder={placeholder}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
            setActiveIndex(0);
          }}
          onBlur={() => {
            setFocused(false);
            blurTimeout.current = window.setTimeout(() => {
              setOpen(false);
              if (!allowFreeText) setQuery(value);
            }, 100);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            onValueChange?.(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => filtered.length ? (index + 1) % filtered.length : 0);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0);
            } else if (event.key === 'Enter' && open && activeOption) {
              event.preventDefault();
              commitSelect(activeOption);
            } else if (event.key === 'Escape') {
              setOpen(false);
              setQuery(value);
            }
          }}
          className={cn(
            'w-full border border-border rounded-lg pr-2 py-2 text-sm bg-surface-muted outline-none focus:ring-2 focus:ring-accent disabled:opacity-50',
            showSearchIcon ? 'pl-8' : 'pl-2',
            inputClassName,
          )}
        />
      </div>

      {open && !disabled ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-xl shadow-lg z-20 max-h-56 overflow-auto"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted">Keine Treffer</div>
          ) : filtered.map((item, index) => (
            <div
              key={item.id}
              id={`${inputId}-opt-${item.id}`}
              role="option"
              aria-selected={getLabel(item) === value}
              className={cn(
                'px-3 py-2 cursor-pointer border-b border-border-subtle last:border-0',
                index === activeIndex ? 'bg-canvas' : 'hover:bg-surface-muted',
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                commitSelect(item);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <div className="text-sm font-bold text-foreground">{getLabel(item)}</div>
              {getSublabel?.(item) ? (
                <div className="text-xs text-muted mt-0.5">{getSublabel(item)}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const Combobox = forwardRef(ComboboxInner) as <T extends ComboboxItem>(
  props: ComboboxProps<T> & { ref?: React.ForwardedRef<HTMLInputElement> },
) => React.ReactElement;
