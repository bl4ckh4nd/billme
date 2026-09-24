import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, Briefcase, Bell, FileText, Package, Plus, Search, Settings, Users, X, CheckCheck, type LucideIcon } from 'lucide-react';
import { IconButton, Kbd, Portal, cn, popoverExitClass, useExitTransition } from '@billme/ui';
import { ipc } from '@billme/desktop-renderer/runtime-api';
import { useNotificationsStore, type AppNotification } from '@billme/desktop-core/state/notificationsStore';
import { useAnchoredPosition } from './useAnchoredPosition';

type HeaderSearchResult = {
  key: string;
  title: string;
  subtitle: string;
  badge: 'Rechnung' | 'Angebot' | 'Kunde' | 'Projekt' | 'Artikel';
  to: string;
  search?: Record<string, string>;
  score: number;
};

/** A palette entry: create something or jump to a page. */
type ShellCommand = {
  key: string;
  title: string;
  icon: LucideIcon;
  keywords: string[];
  run: () => void;
};

type PaletteItem =
  | { kind: 'command'; key: string; command: ShellCommand }
  | { kind: 'result'; key: string; result: HeaderSearchResult };

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

const normalize = (value: string): string => value.trim().toLocaleLowerCase('de-DE');

/**
 * Desktop notification bridge exposed by the Electron preload
 * (`@billme/desktop-core/electron/preload`). Absent in the browser shells, so it
 * is read through a typed accessor rather than the `window.billmeWindow`
 * augmentation, which only the Electron app tsconfigs declare.
 */
type DesktopBridge = {
  onNotification: (callback: (payload: { type: string; title: string; message: string }) => void) => void;
  offNotification: () => void;
};

const isDesktopBridge = (value: unknown): value is DesktopBridge =>
  typeof value === 'object' &&
  value !== null &&
  'onNotification' in value &&
  typeof value.onNotification === 'function' &&
  'offNotification' in value &&
  typeof value.offNotification === 'function';

const getDesktopBridge = (): DesktopBridge | undefined => {
  const bridge: unknown = Reflect.get(globalThis, 'billmeWindow');
  return isDesktopBridge(bridge) ? bridge : undefined;
};

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

export interface ShellNavItem {
  id: string;
  label: string;
}

export interface DashboardLayoutProps {
  children: React.ReactNode;
  activePage: string;
  onNavigate: (page: string) => void;
  isEditorActive: boolean;
  /**
   * Top navigation entries. Lite derives them from the runtime config (the web
   * shell hides sections), Pro uses a fixed list, so the product supplies them.
   */
  navItems: readonly ShellNavItem[];
  /** Product logo shown in the header. */
  logoUrl: string;
  /** Product titlebar, rendered above the shell. */
  titlebar: React.ReactNode;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  children,
  activePage,
  onNavigate,
  isEditorActive,
  navItems,
  logoUrl,
  titlebar,
}) => {
  const navigate = useNavigate();
  const includeProjectsInSearch = navItems.some((item) => item.id === 'projects');
  const includeArticlesInSearch = navItems.some((item) => item.id === 'articles');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchHighlightIndex, setSearchHighlightIndex] = React.useState(-1);
  const searchContainerRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const searchPanelRef = React.useRef<HTMLDivElement | null>(null);
  const searchPanelPos = useAnchoredPosition(searchContainerRef, searchOpen);

  const { notifications, addNotification, markAllRead, clearAll } = useNotificationsStore();
  const unreadCount = notifications.filter((n) => !n.read).length;
  const [notifPanelOpen, setNotifPanelOpen] = React.useState(false);
  const notifPanelRef = React.useRef<HTMLDivElement | null>(null);
  const notifDropdownRef = React.useRef<HTMLDivElement | null>(null);
  const notifPanelPos = useAnchoredPosition(notifPanelRef, notifPanelOpen);
  const notifPanel = useExitTransition(notifPanelOpen);

  // Subscribe to push notifications from the desktop main process. The bridge
  // is absent in the browser shells, so it is read through a typed accessor
  // instead of the Electron `window` augmentation, which the browser tsconfig
  // does not include.
  React.useEffect(() => {
    getDesktopBridge()?.onNotification((payload) => {
      addNotification({
        type: payload.type as AppNotification['type'],
        title: payload.title,
        message: payload.message,
      });
    });
    return () => {
      getDesktopBridge()?.offNotification();
    };
  }, [addNotification]);

  // Close notification panel on outside click or Escape
  React.useEffect(() => {
    if (!notifPanelOpen) return;
    const pointerHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (notifPanelRef.current?.contains(target) || notifDropdownRef.current?.contains(target)) return;
      setNotifPanelOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotifPanelOpen(false);
    };
    document.addEventListener('mousedown', pointerHandler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', pointerHandler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [notifPanelOpen]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const normalizedSearch = normalize(searchTerm);

  // ⌘K is a command palette as well as the data search: with an empty field it
  // lists what can be created and every destination; typing filters both.
  const commands = React.useMemo<ShellCommand[]>(() => {
    const has = (id: string) => navItems.some((item) => item.id === id);
    const create = (key: string, title: string, to: string, search: Record<string, string>, keywords: string[]): ShellCommand => ({
      key: `create:${key}`,
      title,
      icon: Plus,
      keywords: ['neu', 'anlegen', 'erstellen', ...keywords],
      run: () => void navigate({ to, search }),
    });
    const list: ShellCommand[] = [];
    if (has('documents')) {
      list.push(create('invoice', 'Neue Rechnung', '/documents', { create: 'invoice' }, ['rechnung', 'dokument']));
      list.push(create('offer', 'Neues Angebot', '/documents', { kind: 'offer', create: 'offer' }, ['angebot', 'dokument']));
    }
    if (has('clients')) list.push(create('client', 'Neuer Kunde', '/clients', { create: 'client' }, ['kunde', 'kontakt']));
    if (has('projects')) list.push(create('project', 'Neues Projekt', '/projects', { create: 'project' }, ['projekt']));
    if (has('articles')) list.push(create('article', 'Neuer Artikel', '/articles', { create: 'article' }, ['artikel', 'leistung', 'produkt']));
    for (const item of navItems) {
      list.push({ key: `go:${item.id}`, title: `${item.label} öffnen`, icon: ArrowRight, keywords: ['gehe', 'öffnen', 'seite'], run: () => onNavigate(item.id) });
    }
    list.push({ key: 'go:settings', title: 'Einstellungen öffnen', icon: Settings, keywords: ['gehe', 'öffnen', 'seite', 'einstellungen'], run: () => onNavigate('settings') });
    return list;
  }, [navItems, navigate, onNavigate]);

  const matchingCommands = React.useMemo(() => {
    if (!normalizedSearch) return commands;
    return commands
      .map((command) => ({ command, score: getScore(normalizedSearch, [command.title, ...command.keywords]) }))
      .filter((entry): entry is { command: ShellCommand; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 6)
      .map((entry) => entry.command);
  }, [commands, normalizedSearch]);

  const { data: searchResults = [], isFetching: searchLoading } = useQuery({
    queryKey: ['header-search', normalizedSearch],
    enabled: !isEditorActive && normalizedSearch.length >= 2,
    staleTime: 15_000,
    queryFn: async () => {
      const [invoices, offers, clients, projects, articles] = await Promise.all([
        ipc.invoices.list(),
        ipc.offers.list(),
        ipc.clients.list(),
        includeProjectsInSearch ? ipc.projects.list({ includeArchived: true }) : Promise.resolve([]),
        includeArticlesInSearch ? ipc.articles.list() : Promise.resolve([]),
      ]);

      const results: HeaderSearchResult[] = [];

      for (const inv of invoices) {
        const score = getScore(normalizedSearch, [inv.number, inv.client, inv.clientEmail, inv.clientNumber]);
        if (score === null) continue;
        results.push({
          key: `invoice:${inv.id}`,
          title: inv.number,
          subtitle: inv.client || 'Ohne Kunde',
          badge: 'Rechnung',
          to: '/documents',
          search: { kind: 'invoice', id: inv.id },
          score,
        });
      }

      for (const offer of offers) {
        const score = getScore(normalizedSearch, [offer.number, offer.client, offer.clientEmail, offer.clientNumber]);
        if (score === null) continue;
        results.push({
          key: `offer:${offer.id}`,
          title: offer.number,
          subtitle: offer.client || 'Ohne Kunde',
          badge: 'Angebot',
          to: '/documents',
          search: { kind: 'offer', id: offer.id },
          score,
        });
      }

      for (const client of clients) {
        const score = getScore(normalizedSearch, [client.company, client.customerNumber, client.contactPerson, client.email]);
        if (score === null) continue;
        results.push({
          key: `client:${client.id}`,
          title: client.company,
          subtitle: client.customerNumber || client.contactPerson || client.email || '',
          badge: 'Kunde',
          to: '/clients',
          search: { id: client.id },
          score,
        });
      }

      for (const project of projects) {
        const score = getScore(normalizedSearch, [project.code, project.name, project.description]);
        if (score === null) continue;
        results.push({
          key: `project:${project.id}`,
          title: project.name,
          subtitle: project.code || 'Projekt',
          badge: 'Projekt',
          to: `/projects/${encodeURIComponent(project.id)}`,
          score,
        });
      }

      for (const article of articles) {
        const score = getScore(normalizedSearch, [article.title, article.sku, article.category, article.description]);
        if (score === null) continue;
        results.push({
          key: `article:${article.id}`,
          title: article.title,
          subtitle: article.sku || article.category || 'Artikel',
          badge: 'Artikel',
          to: '/articles',
          search: { query: article.sku || article.title },
          score,
        });
      }

      results.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title, 'de-DE'));
      return results.slice(0, 12);
    },
  });

  const dataResults = normalizedSearch.length >= 2 && !searchLoading ? searchResults : [];
  const paletteItems: PaletteItem[] = [
    ...matchingCommands.map((command) => ({ kind: 'command' as const, key: command.key, command })),
    ...dataResults.map((result) => ({ kind: 'result' as const, key: result.key, result })),
  ];

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (searchContainerRef.current?.contains(target) || searchPanelRef.current?.contains(target)) return;
      setSearchOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const runPaletteItem = (item: PaletteItem) => {
    setSearchOpen(false);
    setSearchTerm('');
    setSearchHighlightIndex(-1);
    searchInputRef.current?.blur();
    if (item.kind === 'command') item.command.run();
    else navigate({ to: item.result.to, search: item.result.search });
  };


  return (
    <div className="flex flex-col h-screen w-screen bg-surface-sunken text-foreground font-sans overflow-hidden">
      {titlebar}

      {isEditorActive ? (
        <div className="flex-1 w-full bg-surface-sunken overflow-auto">{children}</div>
      ) : (
        <>
          {/* Top Navigation Bar */}
          {/* Chrome sits on the sunken ground with no border; the page surface
              below is the raised plane, so the header recedes. */}
          <header className="h-14 bg-surface-sunken px-4 md:px-5 flex items-center gap-4 shrink-0 z-[var(--z-dropdown)] no-print">
            {/* Left: Logo */}
            <div className="flex items-center gap-3 w-40 shrink-0">
              <img
                src={logoUrl}
                alt="Billme"
                className="h-6 w-auto object-contain"
                draggable={false}
              />
            </div>

            {/* Center: navigation pills. The wrapper is the only flexible cell in
                the row and the nav scrolls inside it, so the search field can never
                cover a destination at narrow widths. */}
            <div className="flex min-w-0 flex-1 justify-center">
              <nav aria-label="Hauptnavigation" className="hidden xl:flex max-w-full items-center gap-0.5 overflow-x-auto scrollbar-hide bg-ink-100 p-0.5 rounded-control">
                {navItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    aria-current={activePage === item.id ? 'page' : undefined}
                    className={cn(
                      'shrink-0 whitespace-nowrap h-8 px-3 rounded-sm text-label transition-[color,background-color,box-shadow] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                      activePage === item.id
                        ? 'bg-surface text-foreground shadow-sm'
                        : 'text-muted hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-2 shrink-0 justify-end">
                <div ref={searchContainerRef} className="relative hidden lg:block">
                    {/* The wrapper is the label so a click anywhere on the 44px field focuses the
                        input; the input itself also fills the height to keep its own hit area >=24px. */}
                    <label className="flex items-center h-9 px-2.5 bg-surface border border-control-border hover:border-ink-500 rounded-control transition-colors motion-reduce:transition-none focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring gap-2">
                        <Search size={14} className="text-muted shrink-0" aria-hidden="true" />
                        <input
                            ref={searchInputRef}
                            type="text"
                            value={searchTerm}
                            onFocus={() => setSearchOpen(true)}
                            onChange={(e) => {
                              setSearchTerm(e.target.value);
                              setSearchOpen(true);
                              setSearchHighlightIndex(-1);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                setSearchOpen(false);
                                setSearchHighlightIndex(-1);
                                return;
                              }
                              if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                setSearchHighlightIndex((i) => Math.min(i + 1, paletteItems.length - 1));
                                return;
                              }
                              if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                setSearchHighlightIndex((i) => Math.max(i - 1, 0));
                                return;
                              }
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const target = searchHighlightIndex >= 0
                                  ? paletteItems[searchHighlightIndex]
                                  : paletteItems[0];
                                if (target) runPaletteItem(target);
                              }
                            }}
                            placeholder="Suchen oder Befehl …"
                            aria-label="Suche und Befehle"
                            className="bg-transparent border-none focus-visible:outline-none text-sm w-52 placeholder:text-muted flex-1 h-full"
                        />
                        {!searchTerm && (
                          <Kbd className="hidden lg:inline-flex shrink-0">{isMacPlatform() ? '⌘K' : 'Strg K'}</Kbd>
                        )}
                    </label>

                    {/* The palette is a frequent interaction, so it opens and closes without motion (DESIGN.md Motion). */}
                    {searchOpen && (
                      <Portal>
                      <div
                        ref={searchPanelRef}
                        style={{ position: 'fixed', top: searchPanelPos.top, right: searchPanelPos.right }}
                        className={cn(
                          'w-[26rem] max-h-[24rem] overflow-auto rounded-panel bg-surface shadow-md p-2 z-[var(--z-dropdown)]',
                        )}
                      >
                        {matchingCommands.length > 0 && (
                          <div role="group" aria-label="Befehle">
                            <p className="px-3 pb-1 pt-2 text-caption font-medium text-muted">Befehle</p>
                            {matchingCommands.map((command, idx) => {
                              const Icon = command.icon;
                              return (
                                <button
                                  key={command.key}
                                  type="button"
                                  onClick={() => runPaletteItem({ kind: 'command', key: command.key, command })}
                                  onMouseEnter={() => setSearchHighlightIndex(idx)}
                                  className={cn(
                                    'flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-sm text-foreground motion-safe:transition-colors motion-reduce:transition-none',
                                    idx === searchHighlightIndex ? 'bg-surface-muted' : 'hover:bg-surface-muted',
                                  )}
                                >
                                  <Icon size={16} className="shrink-0 text-muted" aria-hidden="true" />
                                  <span className="truncate">{command.title}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {normalizedSearch.length === 1 && (
                          <p className="px-3 py-3 text-caption text-muted">Ab 2 Zeichen wird auch in Rechnungen, Kunden und Artikeln gesucht.</p>
                        )}

                        {normalizedSearch.length >= 2 && (
                          <div role="group" aria-label="Treffer" className={matchingCommands.length > 0 ? 'mt-1 border-t border-border-subtle pt-1' : undefined}>
                            <p className="px-3 pb-1 pt-2 text-caption font-medium text-muted">Treffer</p>
                            {searchLoading ? (
                              <p className="px-3 py-3 text-caption text-muted">Suche läuft …</p>
                            ) : searchResults.length === 0 ? (
                              <p className="px-3 py-3 text-caption text-muted">Keine Treffer in Rechnungen, Kunden und Artikeln.</p>
                            ) : searchResults.map((result, resultIdx) => {
                              const idx = matchingCommands.length + resultIdx;
                              const Icon =
                                result.badge === 'Kunde'
                                  ? Users
                                  : result.badge === 'Projekt'
                                    ? Briefcase
                                    : result.badge === 'Artikel'
                                      ? Package
                                      : FileText;
                              return (
                                <button
                                  key={result.key}
                                  type="button"
                                  onClick={() => runPaletteItem({ kind: 'result', key: result.key, result })}
                                  onMouseEnter={() => setSearchHighlightIndex(idx)}
                                  className={cn(
                                    'flex w-full items-start gap-3 rounded-control px-3 py-2 text-left motion-safe:transition-colors motion-reduce:transition-none',
                                    idx === searchHighlightIndex ? 'bg-surface-muted' : 'hover:bg-surface-muted',
                                  )}
                                >
                                  <Icon size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                      <span className="truncate text-sm font-medium text-foreground">{result.title}</span>
                                      <span className="shrink-0 text-caption text-muted">{result.badge}</span>
                                    </span>
                                    <span className="mt-0.5 block truncate text-caption text-muted">{result.subtitle}</span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      </Portal>
                    )}
                </div>

                <div className="flex items-center gap-0.5">
                    <IconButton
                        onClick={() => onNavigate('settings')}
                        aria-label="Einstellungen"
                        aria-current={activePage === 'settings' ? 'page' : undefined}
                        className={activePage === 'settings' ? 'bg-surface text-foreground shadow-sm' : undefined}
                    >
                        <Settings size={16} aria-hidden="true" />
                    </IconButton>

                    <div ref={notifPanelRef} className="relative">
                      <IconButton
                        aria-expanded={notifPanelOpen}
                        onClick={() => {
                          setNotifPanelOpen((v) => !v);
                          if (!notifPanelOpen && unreadCount > 0) markAllRead();
                        }}
                        aria-label="Benachrichtigungen"
                      >
                        <Bell size={16} aria-hidden="true" />
                        {unreadCount > 0 && (
                          <span className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 bg-error-text text-background text-caption font-semibold rounded-full ring-2 ring-surface-sunken flex items-center justify-center leading-none tabular-nums">
                            {unreadCount > 9 ? '9+' : unreadCount}
                          </span>
                        )}
                      </IconButton>

                      {notifPanel.mounted && (
                        <Portal>
                        <div
                          ref={notifDropdownRef}
                          style={{ position: 'fixed', top: notifPanelPos.top, right: notifPanelPos.right }}
                          className={cn(
                            'ui-enter-popover [--origin:top_right] w-80 max-h-96 overflow-auto rounded-panel bg-surface shadow-md z-[var(--z-dropdown)]',
                            notifPanel.closing && popoverExitClass,
                          )}
                        >
                          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                            <span className="text-sm font-semibold text-foreground">Benachrichtigungen</span>
                            <div className="flex items-center gap-2">
                              {notifications.length > 0 && (
                                <>
                                  <button
                                    type="button"
                                    onClick={markAllRead}
                                    className="text-xs font-semibold text-muted hover:text-foreground flex items-center gap-1 motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
                                    title="Alle als gelesen markieren"
                                  >
                                    <CheckCheck size={12} aria-hidden="true" /> Alle gelesen
                                  </button>
                                  <button
                                    type="button"
                                    onClick={clearAll}
                                    aria-label="Alle Benachrichtigungen löschen"
                                    className="text-xs font-semibold text-muted hover:text-foreground motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
                                    title="Alle löschen"
                                  >
                                    <X size={12} aria-hidden="true" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                          {notifications.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-muted">
                              Keine Benachrichtigungen
                            </div>
                          ) : (
                            <div className="divide-y divide-border-subtle">
                              {notifications.map((n) => (
                                <div
                                  key={n.id}
                                  className={`px-4 py-3 ${n.read ? 'bg-surface' : 'bg-surface-muted'}`}
                                >
                                  <div className="flex items-start gap-2">
                                    {!n.read && (
                                      <>
                                        <span className="w-1.5 h-1.5 rounded-full bg-info-text mt-1.5 shrink-0" aria-hidden="true" />
                                        <span className="sr-only">Ungelesen</span>
                                      </>
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <p className={`text-xs font-semibold ${n.read ? 'text-muted' : 'text-foreground'}`}>{n.title}</p>
                                      <p className={`text-xs mt-0.5 ${n.read ? 'text-muted' : 'text-foreground'}`}>{n.message}</p>
                                      <p className="text-xs text-muted mt-1 tabular-nums">
                                        {new Date(n.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        </Portal>
                      )}
                    </div>
                </div>
            </div>
          </header>

          {/* Below xl the pill nav cannot hold every destination, so the same items
              render as a scrollable strip on their own row. No hamburger and no
              extra state: every destination stays reachable at any width. */}
          <nav
            aria-label="Hauptnavigation"
            className="flex xl:hidden items-center gap-0.5 overflow-x-auto scrollbar-hide bg-surface-sunken px-4 pb-2 shrink-0 no-print"
          >
            {navItems.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={activePage === item.id ? 'page' : undefined}
                className={cn(
                  'shrink-0 whitespace-nowrap h-8 px-3 rounded-sm text-label transition-[color,background-color,box-shadow] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                  activePage === item.id
                    ? 'bg-surface text-foreground shadow-sm'
                    : 'text-muted hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Main Content Area */}
          {/* A tight gutter lets each page's raised surface read as one inset
              panel on the ground, framed by the chrome. */}
          <main className="flex-1 overflow-auto px-2 pb-2 md:px-3 md:pb-3 scrollbar-hide">
             <div className="max-w-[1800px] mx-auto h-full">
                {children}
             </div>
          </main>
        </>
      )}
    </div>
  );
};
