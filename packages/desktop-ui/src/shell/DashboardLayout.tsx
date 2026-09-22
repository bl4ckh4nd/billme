import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Briefcase, Bell, FileText, Package, Search, Settings, Users, X, CheckCheck } from 'lucide-react';
import { Portal } from '@billme/ui';
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

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (searchContainerRef.current?.contains(target) || searchPanelRef.current?.contains(target)) return;
      setSearchOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const openSearchResult = (result: HeaderSearchResult) => {
    setSearchOpen(false);
    setSearchTerm('');
    setSearchHighlightIndex(-1);
    navigate({ to: result.to, search: result.search });
  };


  return (
    <div className="flex flex-col h-screen w-screen bg-surface-sunken text-foreground font-sans overflow-hidden">
      {titlebar}

      {isEditorActive ? (
        <div className="flex-1 w-full bg-surface-sunken overflow-auto">{children}</div>
      ) : (
        <>
          {/* Top Navigation Bar */}
          <header className="h-[88px] bg-surface border-b border-border px-6 flex items-center gap-4 shrink-0 z-[var(--z-dropdown)] no-print">
            {/* Left: Logo */}
            <div className="flex items-center gap-3 w-40 shrink-0">
              <img
                src={logoUrl}
                alt="Billme"
                className="h-8 w-auto object-contain"
                draggable={false}
              />
            </div>

            {/* Center: navigation pills. The wrapper is the only flexible cell in
                the row and the nav scrolls inside it, so the search field can never
                cover a destination at narrow widths. */}
            <div className="flex min-w-0 flex-1 justify-center">
              <nav className="hidden xl:flex max-w-full items-center gap-1 overflow-x-auto scrollbar-hide bg-surface-muted p-1.5 rounded-full border border-border">
                {navItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    className={`shrink-0 whitespace-nowrap px-4 py-2.5 rounded-full text-sm font-bold motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                      activePage === item.id
                        ? 'bg-dark-base text-background'
                        : 'text-muted hover:bg-surface hover:text-foreground'
                    }`}
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
                    <label className="flex items-center h-11 px-3 bg-surface-muted border border-control-border rounded-xl motion-safe:transition-colors motion-reduce:transition-none focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring gap-2">
                        <Search size={16} className="text-muted shrink-0" aria-hidden="true" />
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
                                setSearchHighlightIndex((i) => Math.min(i + 1, searchResults.length - 1));
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
                                  ? searchResults[searchHighlightIndex]
                                  : searchResults[0];
                                if (target) openSearchResult(target);
                              }
                            }}
                            placeholder="Suchen..."
                            aria-label="Globale Suche"
                            className="bg-transparent border-none focus-visible:outline-none text-sm font-medium w-40 focus:w-52 motion-safe:transition-[width] motion-reduce:transition-none placeholder:text-muted flex-1 h-full"
                        />
                        {!searchTerm && (
                          <kbd className="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-bold text-muted bg-surface border border-border shrink-0">⌘K</kbd>
                        )}
                    </label>

                    {searchOpen && (
                      <Portal>
                      <div
                        ref={searchPanelRef}
                        style={{ position: 'fixed', top: searchPanelPos.top, right: searchPanelPos.right }}
                        className="ui-enter-popover w-[26rem] max-h-[24rem] overflow-auto rounded-xl bg-surface shadow-2xl p-2 z-[var(--z-dropdown)]"
                      >
                        {normalizedSearch.length < 2 && (
                          <div className="px-3 py-4 text-xs font-medium text-muted">
                            Mindestens 2 Zeichen eingeben.
                          </div>
                        )}

                        {normalizedSearch.length >= 2 && searchLoading && (
                          <div className="px-3 py-4 text-xs font-medium text-muted">
                            Suche läuft...
                          </div>
                        )}

                        {normalizedSearch.length >= 2 && !searchLoading && searchResults.length === 0 && (
                          <div className="px-3 py-4 text-xs font-medium text-muted">
                            Keine Treffer gefunden.
                          </div>
                        )}

                        {normalizedSearch.length >= 2 && !searchLoading && searchResults.length > 0 && (
                          <div className="space-y-1">
                            {searchResults.map((result, idx) => {
                              const Icon =
                                result.badge === 'Kunde'
                                  ? Users
                                  : result.badge === 'Projekt'
                                    ? Briefcase
                                    : result.badge === 'Artikel'
                                      ? Package
                                      : FileText;
                              const isHighlighted = idx === searchHighlightIndex;

                              return (
                                <button
                                  key={result.key}
                                  type="button"
                                  onClick={() => openSearchResult(result)}
                                  onMouseEnter={() => setSearchHighlightIndex(idx)}
                                  className={`w-full text-left rounded-md border px-3 py-2 motion-safe:transition-colors motion-reduce:transition-none ${isHighlighted ? 'border-border bg-surface-muted' : 'border-transparent hover:border-border hover:bg-surface-muted'}`}
                                >
                                  <div className="flex items-start gap-3">
                                    <span className="mt-0.5 w-6 h-6 rounded-sm bg-surface-muted text-muted flex items-center justify-center">
                                      <Icon size={13} aria-hidden="true" />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-bold text-foreground truncate">{result.title}</p>
                                        <span className="px-1.5 py-0.5 rounded-sm bg-surface-muted text-muted text-xs font-bold uppercase tracking-wide">
                                          {result.badge}
                                        </span>
                                      </div>
                                      <p className="text-xs text-muted truncate mt-0.5">{result.subtitle}</p>
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      </Portal>
                    )}
                </div>

                <div className="flex items-center gap-1 p-1 bg-surface-muted border border-border rounded-xl">
                    <button
                        type="button"
                        onClick={() => onNavigate('settings')}
                        className="w-9 h-9 bg-surface border border-control-border hover:bg-surface-muted rounded-md flex items-center justify-center text-muted hover:text-foreground motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        title="Einstellungen"
                        aria-label="Einstellungen"
                    >
                        <Settings size={16} aria-hidden="true" />
                    </button>

                    <div ref={notifPanelRef} className="relative">
                      <button
                        type="button"
                        aria-expanded={notifPanelOpen}
                        onClick={() => {
                          setNotifPanelOpen((v) => !v);
                          if (!notifPanelOpen && unreadCount > 0) markAllRead();
                        }}
                        className="ui-press relative w-9 h-9 bg-surface border border-control-border hover:bg-surface-muted rounded-md flex items-center justify-center text-muted hover:text-foreground motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        title="Benachrichtigungen"
                        aria-label="Benachrichtigungen"
                      >
                        <Bell size={16} aria-hidden="true" />
                        {unreadCount > 0 && (
                          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 bg-error-text text-background text-xs font-bold rounded-full flex items-center justify-center leading-none tabular-nums">
                            {unreadCount > 9 ? '9+' : unreadCount}
                          </span>
                        )}
                      </button>

                      {notifPanelOpen && (
                        <Portal>
                        <div
                          ref={notifDropdownRef}
                          style={{ position: 'fixed', top: notifPanelPos.top, right: notifPanelPos.right }}
                          className="ui-enter-popover w-80 max-h-96 overflow-auto rounded-xl bg-surface shadow-2xl z-[var(--z-dropdown)]"
                        >
                          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                            <span className="text-sm font-bold text-foreground">Benachrichtigungen</span>
                            <div className="flex items-center gap-2">
                              {notifications.length > 0 && (
                                <>
                                  <button
                                    type="button"
                                    onClick={markAllRead}
                                    className="text-xs font-bold text-muted hover:text-foreground flex items-center gap-1 motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
                                    title="Alle als gelesen markieren"
                                  >
                                    <CheckCheck size={12} aria-hidden="true" /> Alle gelesen
                                  </button>
                                  <button
                                    type="button"
                                    onClick={clearAll}
                                    aria-label="Alle Benachrichtigungen löschen"
                                    className="text-xs font-bold text-muted hover:text-foreground motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
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
                                      <p className={`text-xs font-bold ${n.read ? 'text-muted' : 'text-foreground'}`}>{n.title}</p>
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
            className="flex xl:hidden items-center gap-1 overflow-x-auto scrollbar-hide bg-surface border-b border-border px-4 py-2 shrink-0 no-print"
          >
            {navItems.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                  activePage === item.id
                    ? 'bg-dark-base text-background'
                    : 'text-muted hover:bg-surface-muted hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Main Content Area */}
          <main className="flex-1 overflow-auto p-4 md:p-8 scrollbar-hide">
             <div className="max-w-[1800px] mx-auto h-full">
                {children}
             </div>
          </main>
        </>
      )}
    </div>
  );
};
