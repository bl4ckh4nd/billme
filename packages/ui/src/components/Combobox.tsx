import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import { cn } from '../utils/cn';

const normalizeSearchText = (value: string) => value
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/ß/g, 'ss')
  .toLocaleLowerCase('de-DE');

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
  leadingIcon?: React.ReactNode;
  showChevron?: boolean;
  selectedId?: string;
  showAvatar?: boolean;
  footer?: { label: string; onSelect: () => void };
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
    leadingIcon,
    showChevron = false,
    selectedId,
    showAvatar = false,
    footer,
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
  const [edited, setEdited] = useState(false);
  const blurTimeout = useRef<number | null>(null);

  useEffect(() => {
    if (disabled || !focused) setQuery(value);
  }, [disabled, focused, value]);

  useEffect(() => () => {
    if (blurTimeout.current) window.clearTimeout(blurTimeout.current);
  }, []);

  const filtered = useMemo(() => {
    const search = normalizeSearchText((focused && !edited ? '' : query).trim());
    return items
      .filter((item) => !search || normalizeSearchText(`${getLabel(item)} ${getSearchText(item)}`).includes(search))
      .slice(0, maxResults);
  }, [edited, focused, getLabel, getSearchText, items, maxResults, query]);
  const activeOption = filtered[activeIndex];

  const commitSelect = (item: T) => {
    onSelect(item);
    setQuery(getLabel(item));
    setEdited(false);
    setOpen(false);
  };

  const selectFooter = () => {
    setQuery('');
    setEdited(false);
    footer?.onSelect();
    setOpen(false);
  };

  const optionRows = filtered.length === 0 ? (
    <div className="px-3 py-2 text-sm text-muted">Keine Treffer</div>
  ) : filtered.map((item, index) => {
    const selected = selectedId === undefined ? getLabel(item) === value : item.id === selectedId;
    const richRow = showAvatar || selectedId !== undefined;
    return (
      <div
        key={item.id}
        id={`${inputId}-opt-${item.id}`}
        role="option"
        aria-selected={selected}
        className={cn(
          richRow
            ? 'flex cursor-pointer items-start gap-2 border-b border-border-subtle px-3 py-2 last:border-0'
            : 'px-3 py-2 cursor-pointer border-b border-border-subtle last:border-0',
          index === activeIndex ? 'bg-surface-muted' : null,
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          commitSelect(item);
        }}
        onMouseEnter={() => setActiveIndex(index)}
      >
        {richRow ? (
          <>
            {showAvatar ? <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">{getLabel(item).trim().charAt(0).toUpperCase()}</span> : null}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-foreground">{getLabel(item)}</div>
              {getSublabel?.(item) ? (
                <div className="mt-0.5 truncate whitespace-nowrap text-xs text-muted">{getSublabel(item)}</div>
              ) : null}
            </div>
            {selectedId !== undefined && selected ? <Check className="mt-0.5 shrink-0 text-accent" size={14} aria-hidden="true" /> : null}
          </>
        ) : (
          <>
            <div className="text-sm font-bold text-foreground">{getLabel(item)}</div>
            {getSublabel?.(item) ? (
              <div className="text-xs text-muted mt-0.5">{getSublabel(item)}</div>
            ) : null}
          </>
        )}
      </div>
    );
  });

  return (
    <div className="relative">
      <div className="relative">
        {leadingIcon ? (
          <span className="pointer-events-none absolute left-2.5 top-1/2 flex -translate-y-1/2 items-center text-muted" aria-hidden="true">
            {leadingIcon}
          </span>
        ) : showSearchIcon ? (
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" size={14} strokeWidth={1.5} />
        ) : null}
        {showChevron ? (
          <ChevronDown
            className={cn('pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted transition-transform', open ? 'rotate-180' : '')}
            size={14}
            strokeWidth={1.5}
            aria-hidden="true"
          />
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
            setEdited(false);
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
            setEdited(true);
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
              setEdited(false);
            }
          }}
          className={cn(
            'w-full border border-border rounded-lg pr-2 py-2 text-sm bg-surface-muted outline-none focus:ring-2 focus:ring-accent disabled:opacity-50',
            leadingIcon || showSearchIcon ? null : 'pl-2',
            inputClassName,
            leadingIcon ? 'pl-6' : showSearchIcon ? 'pl-7' : null,
            showChevron ? 'pr-6' : null,
          )}
        />
      </div>

      {open && !disabled && footer ? (
        <div className="absolute top-full left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <div id={listboxId} role="listbox" className="max-h-56 overflow-auto">
            {optionRows}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm font-semibold text-accent hover:bg-surface-muted"
            onMouseDown={(event) => {
              event.preventDefault();
              selectFooter();
            }}
          >
            <Plus size={14} aria-hidden="true" />
            {footer.label}
          </button>
        </div>
      ) : open && !disabled ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-20 max-h-56 overflow-auto"
        >
          {optionRows}
        </div>
      ) : null}
    </div>
  );
}

export const Combobox = forwardRef(ComboboxInner) as <T extends ComboboxItem>(
  props: ComboboxProps<T> & { ref?: React.ForwardedRef<HTMLInputElement> },
) => React.ReactElement;
