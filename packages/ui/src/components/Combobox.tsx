import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import { cn } from '../utils/cn';
import { Portal } from './Portal';

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
  const anchorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const popupPointerDownRef = useRef(false);
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (disabled || !focused) setQuery(value);
  }, [disabled, focused, value]);

  const filtered = useMemo(() => {
    const search = normalizeSearchText((focused && !edited ? '' : query).trim());
    return items
      .filter((item) => !search || normalizeSearchText(`${getLabel(item)} ${getSearchText(item)}`).includes(search))
      .slice(0, maxResults);
  }, [edited, focused, getLabel, getSearchText, items, maxResults, query]);
  const activeOption = filtered[activeIndex];

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open || !activeOption) return;
    document.getElementById(`${inputId}-opt-${activeOption.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, activeOption, inputId, open]);

  useEffect(() => {
    if (!open) {
      setPopupPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;

      const hasLayoutBox = anchor.width > 0 || anchor.height > 0;
      if (hasLayoutBox && (anchor.bottom <= 0 || anchor.top >= window.innerHeight || anchor.right <= 0 || anchor.left >= window.innerWidth)) {
        setOpen(false);
        setPopupPosition(null);
        return;
      }

      const width = Math.min(anchor.width, Math.max(window.innerWidth - 16, 0));
      const left = Math.min(Math.max(anchor.left, 8), Math.max(window.innerWidth - width - 8, 8));
      // ponytail: collision uses a conservative fixed height; replace with measured overlay geometry if row heights become dynamic.
      const estimatedHeight = footer ? 320 : 240;
      const spaceBelow = window.innerHeight - anchor.bottom - 8;
      const spaceAbove = anchor.top - 8;
      const opensAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const top = opensAbove
        ? Math.max(8, anchor.top - Math.min(estimatedHeight, spaceAbove))
        : Math.min(anchor.bottom + 4, Math.max(8, window.innerHeight - 8));

      setPopupPosition({ top, left, width });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [filtered.length, footer, open]);

  const closePopup = () => {
    setOpen(false);
    setFocused(false);
    if (!allowFreeText) setQuery(value);
  };

  useEffect(() => {
    if (!open) return;

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      closePopup();
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target)) {
        popupPointerDownRef.current = true;
        return;
      }
      if (anchorRef.current?.contains(target)) return;
      closePopup();
    };

    const handlePointerUp = () => {
      popupPointerDownRef.current = false;
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointerup', handlePointerUp);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [open, allowFreeText, value]);

  const commitSelect = (item: T) => {
    onSelect(item);
    setQuery(getLabel(item));
    setEdited(false);
    setOpen(false);
    setFocused(false);
  };

  const selectFooter = () => {
    setQuery('');
    setEdited(false);
    footer?.onSelect();
    setOpen(false);
    setFocused(false);
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
        aria-label={getLabel(item)}
        className={cn(
          richRow
            ? 'flex cursor-pointer items-start gap-2 border-b border-border-subtle px-3 py-2 last:border-0'
            : 'flex min-w-0 cursor-pointer flex-col border-b border-border-subtle px-3 py-2 last:border-0',
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
            {showAvatar ? <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-bold text-foreground">{getLabel(item).trim().charAt(0).toUpperCase()}</span> : null}
            <div className="min-w-0 flex-1">
              <div className="truncate whitespace-nowrap text-sm font-bold text-foreground" title={getLabel(item)}>{getLabel(item)}</div>
              {getSublabel?.(item) ? (
                <div className="mt-0.5 truncate whitespace-nowrap text-xs text-muted">{getSublabel(item)}</div>
              ) : null}
            </div>
            {selectedId !== undefined && selected ? <Check className="mt-0.5 shrink-0 text-foreground" size={14} aria-hidden="true" /> : null}
          </>
        ) : (
          <>
            <div className="min-w-0 max-w-full truncate whitespace-nowrap text-sm font-bold text-foreground" title={getLabel(item)}>{getLabel(item)}</div>
            {getSublabel?.(item) ? <div className="mt-0.5 max-w-full truncate whitespace-nowrap text-xs text-muted">{getSublabel(item)}</div> : null}
          </>
        )}
      </div>
    );
  });

  return (
    <div ref={anchorRef} className="relative">
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
            className={cn('pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted motion-safe:transition-transform motion-reduce:transition-none', open ? 'rotate-180' : '')}
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
          onBlur={(event) => {
            // ponytail: keep the popup open while focus moves into the portalled footer; replace only if focus-within is native across portals.
            const nextTarget = event.relatedTarget as Node | null;
            if (nextTarget && (popupRef.current?.contains(nextTarget) || anchorRef.current?.contains(nextTarget))) return;
            requestAnimationFrame(() => {
              if (popupPointerDownRef.current) return;
              const activeTarget = document.activeElement;
              if (activeTarget && (popupRef.current?.contains(activeTarget) || anchorRef.current?.contains(activeTarget))) return;
              closePopup();
            });
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
            } else if (event.key === 'Home' && open && filtered.length) {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === 'End' && open && filtered.length) {
              event.preventDefault();
              setActiveIndex(filtered.length - 1);
            } else if (event.key === 'Tab' && open && activeOption) {
              commitSelect(activeOption);
            } else if (event.key === 'Enter' && open && activeOption) {
              event.preventDefault();
              commitSelect(activeOption);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              closePopup();
              setEdited(false);
            }
          }}
          className={cn(
            'w-full rounded-lg border border-control-border bg-surface-muted py-2 pr-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground disabled:placeholder:text-disabled-foreground disabled:opacity-100',
            leadingIcon || showSearchIcon ? null : 'pl-2',
            inputClassName,
            leadingIcon ? 'pl-6' : showSearchIcon ? 'pl-7' : null,
            showChevron ? 'pr-6' : null,
          )}
        />
      </div>

      {open && !disabled ? (
        <Portal>
          <div
            ref={popupRef}
            onPointerDown={() => { popupPointerDownRef.current = true; }}
            className="ui-enter-popover fixed z-[var(--z-dropdown)] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
            style={popupPosition ? { top: popupPosition.top, left: popupPosition.left, width: popupPosition.width } : { visibility: 'hidden' }}
          >
            <div id={listboxId} role="listbox" className="max-h-56 overflow-auto">
              {optionRows}
            </div>
            {footer ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectFooter();
                }}
              >
                <Plus size={14} aria-hidden="true" />
                {footer.label}
              </button>
            ) : null}
          </div>
        </Portal>
      ) : null}
    </div>
  );
}

export const Combobox = forwardRef(ComboboxInner) as <T extends ComboboxItem>(
  props: ComboboxProps<T> & { ref?: React.ForwardedRef<HTMLInputElement> },
) => React.ReactElement;
