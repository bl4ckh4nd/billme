import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Account } from '../types';

interface AccountComboboxProps {
  accounts: Account[];
  valueAccountId: string;
  valueAccountName?: string;
  disabled?: boolean;
  placeholder?: string;
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
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" size={14} />
        <input
          id={inputId}
          type="text"
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
          className="w-full border border-border rounded-lg pl-8 pr-2 py-2 text-sm disabled:bg-surface-muted"
        />
      </div>

      {open && !disabled && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-xl shadow-lg z-20 max-h-56 overflow-auto"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted">Kein Konto gefunden</div>
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
                  className={`px-3 py-2 cursor-pointer border-b border-border-subtle last:border-0 ${
                    active ? 'bg-canvas' : 'hover:bg-surface-muted'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitSelect(account);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <div className="text-sm font-bold text-foreground">
                    {account.number} - {account.name}
                  </div>
                  {!!account.keywords?.length && (
                    <div className="text-xs text-muted mt-0.5">
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
