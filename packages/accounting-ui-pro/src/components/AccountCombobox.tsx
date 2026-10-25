import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Input } from '@billme/ui';
import { Account } from '../types';

interface AccountComboboxProps {
  accounts: Account[];
  valueAccountId: string;
  valueAccountName?: string;
  disabled?: boolean;
  placeholder?: string;
  /** Visible field label; the accessible name stays "Konto suchen". */
  label?: string;
  onSelect: (account: Account) => void;
}

function displayValue(accountId: string, accountName?: string) {
  if (!accountId) return '';
  return accountName ? `${accountId} - ${accountName}` : accountId;
}

export default function AccountCombobox({
  accounts,
  valueAccountId,
  valueAccountName,
  disabled,
  placeholder = 'Konto suchen...',
  label,
  onSelect,
}: AccountComboboxProps) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const [query, setQuery] = useState(displayValue(valueAccountId, valueAccountName));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const blurTimeout = useRef<number | null>(null);

  useEffect(() => {
    if (!focused) {
      setQuery(displayValue(valueAccountId, valueAccountName));
    }
  }, [valueAccountId, valueAccountName, focused]);

  useEffect(() => {
    return () => {
      if (blurTimeout.current) window.clearTimeout(blurTimeout.current);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts.slice(0, 12);
    return accounts
      .filter((acc) => {
        const hay = [
          acc.number,
          acc.name,
          ...(acc.keywords ?? []),
          ...(acc.aliases ?? []),
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 12);
  }, [accounts, query]);

  const activeOption = filtered[activeIndex];
  const activeDescendantId = open && activeOption ? `${inputId}-opt-${activeOption.id}` : undefined;

  const commitSelect = (account: Account) => {
    onSelect(account);
    setQuery(`${account.number} - ${account.name}`);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        id={inputId}
        type="text"
        label={label}
        fullWidth
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendantId}
        aria-label="Konto suchen"
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
          blurTimeout.current = window.setTimeout(() => setOpen(false), 100);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActiveIndex((idx) => (filtered.length ? (idx + 1) % filtered.length : 0));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setActiveIndex((idx) => (filtered.length ? (idx - 1 + filtered.length) % filtered.length : 0));
          } else if (e.key === 'Enter') {
            if (open && activeOption) {
              e.preventDefault();
              commitSelect(activeOption);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
            setQuery(displayValue(valueAccountId, valueAccountName));
          }
        }}
      />

      {open && !disabled && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 top-full z-[var(--z-dropdown)] mt-1 max-h-56 w-70 min-w-full overflow-auto rounded-control border border-border bg-surface p-1 shadow-lift"
        >
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-control text-muted">
              Kein Konto gefunden
              {/^\d{4}$/.test(query.trim()) ? (
                // B19: DATEV-Automatikkonten wie SKR03 3120 (Bauleistungen § 13b) rechnen die Steuer selbst; billme bucht sie über den Steuerfall.
                <p className="mt-1 max-w-70 text-caption text-pretty">Konto {query.trim()} steht nicht im Kontenrahmen. Automatikkonten für § 13b oder den innergemeinschaftlichen Erwerb (z. B. 3120) bucht billme über den Steuerfall: Aufwandskonto wie 3100 wählen und den Steuerfall setzen.</p>
              ) : null}
            </div>
          ) : (
            filtered.map((account, index) => {
              const selected = account.number === valueAccountId;
              const active = index === activeIndex;
              return (
                <div
                  key={account.id}
                  id={`${inputId}-opt-${account.id}`}
                  role="option"
                  aria-selected={selected}
                  className={`cursor-pointer rounded-sm px-2 py-1.5 text-control text-foreground ${active ? 'bg-surface-sunken' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitSelect(account);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <div className="flex items-baseline gap-2.5">
                    <span className="shrink-0 font-mono font-semibold">{account.number}</span>
                    <span className="min-w-0 flex-1 truncate">{account.name}</span>
                  </div>
                  {!!account.keywords?.length && (
                    <div className="truncate text-micro text-muted">
                      {account.keywords.slice(0, 3).join(', ')}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
