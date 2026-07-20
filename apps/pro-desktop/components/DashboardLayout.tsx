import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Briefcase, Bell, FileText, Package, Search, Settings, Users, X, CheckCheck } from 'lucide-react';
import { ipc } from '../ipc/client';
import { Titlebar } from './Titlebar';
import billmeFullLogo from '../assets/billme-full-logo.svg';
import { useNotificationsStore, type AppNotification } from '../state/notificationsStore';

type HeaderSearchResult = {
  key: string;
  title: string;
  subtitle: string;
  badge: 'Rechnung' | 'Angebot' | 'Kunde' | 'Projekt' | 'Artikel';
  to: string;
  score: number;
};

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

interface DashboardLayoutProps {
  children: React.ReactNode;
  activePage: string;
  onNavigate: (page: string) => void;
  isEditorActive: boolean;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children, activePage, onNavigate, isEditorActive }) => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchHighlightIndex, setSearchHighlightIndex] = React.useState(-1);
  const searchContainerRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const { notifications, addNotification, markAllRead, clearAll } = useNotificationsStore();
  const unreadCount = notifications.filter((n) => !n.read).length;
  const [notifPanelOpen, setNotifPanelOpen] = React.useState(false);
  const notifPanelRef = React.useRef<HTMLDivElement | null>(null);

  // Subscribe to push notifications from the main process
  React.useEffect(() => {
    window.billmeWindow?.onNotification((payload) => {
      addNotification({
        type: payload.type as AppNotification['type'],
        title: payload.title,
        message: payload.message,
      });
    });
    return () => {
      window.billmeWindow?.offNotification();
    };
  }, [addNotification]);

  // Close notification panel on outside click
  React.useEffect(() => {
    if (!notifPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (notifPanelRef.current && !notifPanelRef.current.contains(e.target as Node)) {
        setNotifPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
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
        ipc.projects.list({ includeArchived: true }),
        ipc.articles.list(),
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
          to: `/documents?kind=invoice&id=${encodeURIComponent(inv.id)}`,
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
          to: `/documents?kind=offer&id=${encodeURIComponent(offer.id)}`,
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
          to: `/clients?id=${encodeURIComponent(client.id)}`,
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
          to: `/articles?query=${encodeURIComponent(article.sku || article.title)}`,
          score,
        });
      }

      results.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title, 'de-DE'));
      return results.slice(0, 12);
    },
  });

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!searchContainerRef.current) return;
      if (searchContainerRef.current.contains(event.target as Node)) return;
      setSearchOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const openSearchResult = (result: HeaderSearchResult) => {
    setSearchOpen(false);
    setSearchTerm('');
    setSearchHighlightIndex(-1);
    navigate({ to: result.to });
  };

  // Simplified menu items for top nav (text only typically looks cleaner in top bars)
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'clients', label: 'Kunden' },
    { id: 'projects', label: 'Projekte' },
    { id: 'documents', label: 'Dokumente' },
    { id: 'finance', label: 'Finanzen' },
    { id: 'articles', label: 'Artikel' },
  ];

  return (
    <div className="flex flex-col h-screen w-screen bg-canvas font-sans text-foreground overflow-hidden">
      <Titlebar />

      {isEditorActive ? (
        <div className="flex-1 w-full bg-canvas overflow-auto">{children}</div>
      ) : (
        <>
          {/* Top Navigation Bar */}
          <header className="h-[88px] bg-surface border-b border-border-subtle px-8 flex items-center justify-between shrink-0 z-40 no-print">
            {/* Left: Logo */}
            <div className="flex items-center gap-3 w-64">
              <img
                src={billmeFullLogo}
                alt="Billme"
                className="h-8 w-auto object-contain"
                draggable={false}
              />
            </div>

            {/* Center: Navigation Pills */}
            <nav className="hidden md:flex items-center gap-1 bg-surface-muted p-1.5 rounded-full border border-border">
              {menuItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onNavigate(item.id)}
                  className={`px-6 py-2.5 rounded-full text-sm font-bold transition-colors duration-200 ease-out ${
                    activePage === item.id
                      ? 'bg-foreground text-white shadow-md'
                      : 'text-muted hover:bg-surface hover:text-foreground hover:shadow-sm'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            {/* Right: Actions */}
            <div className="flex items-center gap-2 w-64 justify-end">
                <div ref={searchContainerRef} className="relative hidden lg:block">
                    <div className="flex items-center h-11 px-3 bg-surface border border-border rounded-xl shadow-sm transition-shadow duration-200 ease-out focus-within:shadow-md gap-2">
                        <Search size={16} className="text-muted shrink-0" />
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
                            className="bg-transparent border-none outline-none text-sm font-medium w-44 focus:w-56 transition-[width] duration-200 ease-out placeholder:text-muted flex-1"
                        />
                        {!searchTerm && (
                          <kbd className="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold text-muted bg-surface-muted border border-border shrink-0">⌘K</kbd>
                        )}
                    </div>

                    {searchOpen && (
                      <div className="absolute top-full right-0 mt-2 w-[26rem] max-h-[24rem] overflow-auto rounded-xl border border-border bg-surface shadow-xl p-2 z-50">
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
                                  className={`w-full text-left rounded-lg border px-3 py-2 transition-colors duration-150 ease-out ${isHighlighted ? 'border-border bg-surface-muted' : 'border-transparent hover:border-border hover:bg-surface-muted'}`}
                                >
                                  <div className="flex items-start gap-3">
                                    <span className="mt-0.5 w-6 h-6 rounded-md bg-canvas text-muted flex items-center justify-center">
                                      <Icon size={13} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-bold text-foreground truncate">{result.title}</p>
                                        <span className="px-1.5 py-0.5 rounded bg-canvas text-muted text-[10px] font-bold uppercase tracking-wide">
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
                    )}
                </div>

                <div className="flex items-center gap-1 p-1 bg-surface-muted border border-border rounded-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                    <button
                        onClick={() => onNavigate('settings')}
                        className="group w-9 h-9 bg-surface border border-border hover:border-foreground/20 rounded-lg flex items-center justify-center text-muted hover:text-foreground transition-colors duration-200 ease-out shadow-sm"
                        title="Einstellungen"
                        aria-label="Einstellungen"
                    >
                        <Settings size={16} className="transition-transform duration-200 ease-out group-hover:rotate-45" />
                    </button>

                    <div ref={notifPanelRef} className="relative">
                      <button
                        onClick={() => {
                          setNotifPanelOpen((v) => !v);
                          if (!notifPanelOpen && unreadCount > 0) markAllRead();
                        }}
                        className="group relative w-9 h-9 bg-surface border border-border hover:border-foreground/20 rounded-lg flex items-center justify-center text-muted hover:text-foreground transition-colors duration-200 ease-out shadow-sm"
                        title="Benachrichtigungen"
                        aria-label="Benachrichtigungen"
                      >
                        <Bell size={16} />
                        {unreadCount > 0 && (
                          <span className="absolute -top-1 -right-1 w-4 h-4 bg-error text-white text-[9px] font-black rounded-full flex items-center justify-center leading-none">
                            {unreadCount > 9 ? '9+' : unreadCount}
                          </span>
                        )}
                      </button>

                      {notifPanelOpen && (
                        <div className="absolute right-0 top-full mt-2 w-80 max-h-96 overflow-auto rounded-xl border border-border bg-surface shadow-xl z-50">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
                            <span className="text-sm font-bold text-foreground">Benachrichtigungen</span>
                            <div className="flex items-center gap-2">
                              {notifications.length > 0 && (
                                <>
                                  <button
                                    onClick={markAllRead}
                                    className="text-[10px] font-bold text-muted hover:text-foreground flex items-center gap-1 transition-colors duration-150 ease-out"
                                    title="Alle als gelesen markieren"
                                  >
                                    <CheckCheck size={12} /> Alle gelesen
                                  </button>
                                  <button
                                    onClick={clearAll}
                                    className="text-[10px] font-bold text-muted hover:text-foreground transition-colors duration-150 ease-out"
                                    title="Alle löschen"
                                  >
                                    <X size={12} />
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
                                  className={`px-4 py-3 ${n.read ? 'opacity-60' : 'bg-info-bg/50'}`}
                                >
                                  <div className="flex items-start gap-2">
                                    {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-info mt-1.5 shrink-0" />}
                                    <div className="min-w-0 flex-1" style={n.read ? { marginLeft: '14px' } : {}}>
                                      <p className="text-xs font-bold text-foreground">{n.title}</p>
                                      <p className="text-xs text-muted mt-0.5">{n.message}</p>
                                      <p className="text-[10px] text-muted mt-1">
                                        {new Date(n.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                </div>
            </div>
          </header>

          {/* Main Content Area */}
          <main className="flex-1 overflow-auto p-4 md:p-8 scrollbar-hide">
             <div className="max-w-[1800px] mx-auto h-full animate-enter">
                {children}
             </div>
          </main>
        </>
      )}
    </div>
  );
};
