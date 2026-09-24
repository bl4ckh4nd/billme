import React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../utils/cn';
import { useAnchoredPosition, type AnchorAlign } from '../utils/useAnchoredPosition';
import { popoverExitClass, useExitTransition } from '../utils/useExitTransition';
import { Portal } from './Portal';

export interface MenuItem {
  id: string;
  label: React.ReactNode;
  /** Plain-text label for typeahead when `label` is not a string. */
  textValue?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Renders the item as a checked choice (menuitemradio). */
  checked?: boolean;
  tone?: 'default' | 'danger';
  /** Draws a separator above this item. */
  separated?: boolean;
}

export interface MenuTriggerProps {
  ref: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
}

export interface MenuProps {
  trigger: (props: MenuTriggerProps) => React.ReactElement;
  items: ReadonlyArray<MenuItem>;
  'aria-label': string;
  align?: AnchorAlign;
  className?: string;
}

/** Anchored action menu: arrow keys, Home/End, typeahead, Escape returns focus to the trigger. */
export const Menu: React.FC<MenuProps> = ({ trigger, items, 'aria-label': ariaLabel, align = 'start', className }) => {
  const menuId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const { mounted, closing } = useExitTransition(open);
  const anchored = useAnchoredPosition(triggerRef, menuRef, mounted, { align });

  const enabledIndexes = items.flatMap((item, index) => (item.disabled ? [] : [index]));

  const close = React.useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openAt = (index: number) => {
    setOpen(true);
    setActive(index);
  };

  // The menu mounts one render after `open` (useExitTransition) and stays
  // visibility:hidden until it is measured; a hidden element cannot take focus.
  React.useEffect(() => {
    if (open && mounted && anchored.ready && active >= 0) itemRefs.current[active]?.focus();
  }, [open, mounted, anchored.ready, active]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const step = (direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return;
    const position = enabledIndexes.indexOf(active);
    const next = enabledIndexes[(position + direction + enabledIndexes.length) % enabledIndexes.length];
    if (next !== undefined) setActive(next);
  };

  const typeahead = (key: string) => {
    const lower = key.toLowerCase();
    const text = (item: MenuItem) => (item.textValue ?? (typeof item.label === 'string' ? item.label : '')).toLowerCase();
    const ordered = [...enabledIndexes.filter((index) => index > active), ...enabledIndexes.filter((index) => index <= active)];
    const match = ordered.find((index) => text(items[index]!).startsWith(lower));
    if (match !== undefined) setActive(match);
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => (open ? close(false) : openAt(enabledIndexes[0] ?? -1)),
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openAt(enabledIndexes[0] ?? -1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openAt(enabledIndexes[enabledIndexes.length - 1] ?? -1);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            close(true);
          }
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
      })}
      {mounted && (
        <Portal>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={ariaLabel}
            style={anchored.style}
            className={cn(
              'ui-enter-popover z-[var(--z-dropdown)] min-w-44 max-w-80 rounded-card bg-surface p-1 shadow-md',
              closing && popoverExitClass,
              className,
            )}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
              else if (event.key === 'Home') { event.preventDefault(); setActive(enabledIndexes[0] ?? -1); }
              else if (event.key === 'End') { event.preventDefault(); setActive(enabledIndexes[enabledIndexes.length - 1] ?? -1); }
              else if (event.key === 'Escape') { event.preventDefault(); close(true); }
              else if (event.key === 'Tab') { close(false); }
              else if (event.key.length === 1 && /\S/.test(event.key)) typeahead(event.key);
            }}
          >
            {items.map((item, index) => (
              <React.Fragment key={item.id}>
                {item.separated && <div role="separator" className="-mx-1 my-1 h-px bg-border-subtle" />}
                <button
                  ref={(node) => { itemRefs.current[index] = node; }}
                  type="button"
                  role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={item.checked === undefined ? undefined : item.checked}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={index === active ? 0 : -1}
                  onClick={() => select(item)}
                  onPointerMove={() => { if (!item.disabled && active !== index) setActive(index); }}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
                    item.tone === 'danger' ? 'text-error-text' : 'text-foreground',
                    index === active && (item.tone === 'danger' ? 'bg-error-bg' : 'bg-surface-sunken'),
                    item.disabled && 'cursor-not-allowed text-disabled-foreground',
                  )}
                >
                  {item.icon && <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-muted">{item.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.checked && <Check size={14} aria-hidden="true" className="shrink-0" />}
                </button>
              </React.Fragment>
            ))}
          </div>
        </Portal>
      )}
    </>
  );
};

Menu.displayName = 'Menu';
