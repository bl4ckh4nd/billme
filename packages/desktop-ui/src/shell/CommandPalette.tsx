import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Briefcase, FileText, Package, Search, Users, type LucideIcon } from 'lucide-react';
import { Kbd, Portal, cn } from '@billme/ui';
import { ipc } from '@billme/desktop-renderer/runtime-api';

type SearchResult = {
  key: string;
  title: string;
  subtitle: string;
  badge: 'Rechnung' | 'Angebot' | 'Kunde' | 'Projekt' | 'Artikel';
  to: string;
  search?: Record<string, string>;
  score: number;
};

/** A palette entry: create something, jump to a page, or run a shell action. */
export type ShellCommand = {
  key: string;
  title: string;
  icon: LucideIcon;
  keywords: string[];
  run: () => void;
};

type PaletteItem =
  | { kind: 'command'; key: string; command: ShellCommand }
  | { kind: 'result'; key: string; result: SearchResult };

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

const normalize = (value: string): string => value.trim().toLocaleLowerCase('de-DE');

const getScore = (query: string, fields: Array<string | undefined>): number | null => {
  let score: number | null = null;
  for (const field of fields) {
    const normalized = normalize(field ?? '');
    if (!normalized) continue;
    if (normalized === query) return 0;
    if (normalized.startsWith(query)) {
      score = score === null ? 1 : Math.min(score, 1);
      continue;
    }
    if (normalized.includes(query)) {
      score = score === null ? 2 : Math.min(score, 2);
    }
  }
  return score;
};

const resultIcon = (badge: SearchResult['badge']): LucideIcon =>
  badge === 'Kunde' ? Users : badge === 'Projekt' ? Briefcase : badge === 'Artikel' ? Package : FileText;

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: ShellCommand[];
  includeProjects: boolean;
  includeArticles: boolean;
}

/**
 * Ctrl/⌘K: commands and destinations with an empty field, plus a data search
 * over invoices, offers, clients, projects and articles from two characters on.
 * Opens and closes without motion, it is a frequent interaction (DESIGN.md Motion).
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, commands, includeProjects, includeArticles }) => {
  const navigate = useNavigate();
  const [term, setTerm] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const query = normalize(term);

  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    setTerm('');
    setHighlight(0);
    return () => previous?.focus?.();
  }, [open]);

  const matchingCommands = React.useMemo(() => {
    if (!query) return commands;
    return commands
      .map((command) => ({ command, score: getScore(query, [command.title, ...command.keywords]) }))
      .filter((entry): entry is { command: ShellCommand; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 6)
      .map((entry) => entry.command);
  }, [commands, query]);

  const { data: results = [], isFetching: loading } = useQuery({
    queryKey: ['header-search', query],
    enabled: open && query.length >= 2,
    staleTime: 15_000,
    queryFn: async () => {
      const [invoices, offers, clients, projects, articles] = await Promise.all([
        ipc.invoices.list(),
        ipc.offers.list(),
        ipc.clients.list(),
        includeProjects ? ipc.projects.list({ includeArchived: true }) : Promise.resolve([]),
        includeArticles ? ipc.articles.list() : Promise.resolve([]),
      ]);
      const out: SearchResult[] = [];
      for (const inv of invoices) {
        const score = getScore(query, [inv.number, inv.client, inv.clientEmail, inv.clientNumber]);
        if (score !== null) out.push({ key: `invoice:${inv.id}`, title: inv.number, subtitle: inv.client || 'Ohne Kunde', badge: 'Rechnung', to: '/documents', search: { kind: 'invoice', id: inv.id }, score });
      }
      for (const offer of offers) {
        const score = getScore(query, [offer.number, offer.client, offer.clientEmail, offer.clientNumber]);
        if (score !== null) out.push({ key: `offer:${offer.id}`, title: offer.number, subtitle: offer.client || 'Ohne Kunde', badge: 'Angebot', to: '/documents', search: { kind: 'offer', id: offer.id }, score });
      }
      for (const client of clients) {
        const score = getScore(query, [client.company, client.customerNumber, client.contactPerson, client.email]);
        if (score !== null) out.push({ key: `client:${client.id}`, title: client.company, subtitle: client.customerNumber || client.contactPerson || client.email || '', badge: 'Kunde', to: '/clients', search: { id: client.id }, score });
      }
      for (const project of projects) {
        const score = getScore(query, [project.code, project.name, project.description]);
        if (score !== null) out.push({ key: `project:${project.id}`, title: project.name, subtitle: project.code || 'Projekt', badge: 'Projekt', to: `/projects/${encodeURIComponent(project.id)}`, score });
      }
      for (const article of articles) {
        const score = getScore(query, [article.title, article.sku, article.category, article.description]);
        if (score !== null) out.push({ key: `article:${article.id}`, title: article.title, subtitle: article.sku || article.category || 'Artikel', badge: 'Artikel', to: '/articles', search: { query: article.sku || article.title }, score });
      }
      out.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title, 'de-DE'));
      return out.slice(0, 12);
    },
  });

  const dataResults = query.length >= 2 && !loading ? results : [];
  const items: PaletteItem[] = [
    ...matchingCommands.map((command) => ({ kind: 'command' as const, key: command.key, command })),
    ...dataResults.map((result) => ({ kind: 'result' as const, key: result.key, result })),
  ];
  const active = Math.min(highlight, Math.max(0, items.length - 1));

  const run = (item: PaletteItem) => {
    onClose();
    if (item.kind === 'command') item.command.run();
    else void navigate({ to: item.result.to, search: item.result.search });
  };

  React.useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const row = (item: PaletteItem, idx: number) => {
    const Icon = item.kind === 'command' ? item.command.icon : resultIcon(item.result.badge);
    return (
      <button
        key={item.key}
        type="button"
        role="option"
        aria-selected={idx === active}
        data-active={idx === active}
        onClick={() => run(item)}
        onMouseMove={() => setHighlight(idx)}
        className={cn(
          'flex w-full items-start gap-3 rounded-control px-3 py-2 text-left text-sm text-foreground',
          idx === active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
        )}
      >
        <Icon size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        {item.kind === 'command' ? (
          <span className="truncate">{item.command.title}</span>
        ) : (
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{item.result.title}</span>
              <span className="shrink-0 text-caption text-muted">{item.result.badge}</span>
            </span>
            <span className="mt-0.5 block truncate text-caption text-muted">{item.result.subtitle}</span>
          </span>
        )}
      </button>
    );
  };

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[var(--z-overlay)] flex items-start justify-center overflow-y-auto bg-surface-inverse/45 px-4 pb-4 pt-[10vh]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div role="dialog" aria-modal="true" aria-label="Suche und Befehle" className="w-full max-w-xl rounded-modal bg-surface shadow-2xl">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <Search size={16} className="shrink-0 text-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              autoFocus
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onClose();
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setHighlight(Math.max(0, Math.min(items.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
                } else if (event.key === 'Enter' && items[active]) {
                  event.preventDefault();
                  run(items[active]);
                }
              }}
              placeholder="Befehl, Seite, Rechnung oder Kunde"
              aria-label="Suche und Befehle"
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-list"
              className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted focus-visible:outline-none"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} id="command-palette-list" role="listbox" aria-label="Treffer" className="max-h-[50vh] overflow-y-auto p-2">
            {matchingCommands.length > 0 && (
              <div role="group" aria-label="Befehle">
                <p className="px-3 pb-1 pt-1 text-caption font-medium text-muted">Befehle</p>
                {matchingCommands.map((command, idx) => row({ kind: 'command', key: command.key, command }, idx))}
              </div>
            )}
            {query.length === 1 && <p className="px-3 py-3 text-caption text-muted">Ab 2 Zeichen wird auch in Rechnungen, Kunden und Artikeln gesucht.</p>}
            {query.length >= 2 && (
              <div role="group" aria-label="Treffer" className={matchingCommands.length > 0 ? 'mt-1 border-t border-border-subtle pt-1' : undefined}>
                <p className="px-3 pb-1 pt-2 text-caption font-medium text-muted">Treffer</p>
                {loading ? (
                  <p className="px-3 py-3 text-caption text-muted">Suche läuft …</p>
                ) : dataResults.length === 0 ? (
                  <p className="px-3 py-3 text-caption text-muted">Keine Treffer in Rechnungen, Kunden und Artikeln.</p>
                ) : (
                  dataResults.map((result, i) => row({ kind: 'result', key: result.key, result }, matchingCommands.length + i))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
};
