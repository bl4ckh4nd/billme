import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Briefcase, Bell, FileText, Package, Search, Settings, Users } from 'lucide-react';
import { ipc } from '../ipc/client';
import { Titlebar } from './Titlebar';
import billmeFullLogo from '../assets/billme-full-logo.svg';

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
  const searchContainerRef = React.useRef<HTMLDivElement | null>(null);

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
    <div className="flex flex-col h-screen w-screen bg-[#f3f4f6] font-sans text-slate-800 overflow-hidden">
      <Titlebar />

      {isEditorActive ? (
        <div className="flex-1 w-full bg-[#f3f4f6] overflow-auto">{children}</div>
      ) : (
        <>
          {/* Top Navigation Bar */}
          <header className="h-[88px] bg-white border-b border-gray-100 px-8 flex items-center justify-between shrink-0 z-40 no-print">
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
            <nav className="hidden md:flex items-center gap-1 bg-gray-100/80 p-1.5 rounded-full border border-gray-200">
              {menuItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onNavigate(item.id)}
                  className={`px-6 py-2.5 rounded-full text-sm font-bold transition-all duration-300 ${
                    activePage === item.id
                      ? 'bg-black text-white shadow-md'
                      : 'text-gray-500 hover:bg-white hover:text-black hover:shadow-sm'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            {/* Right: Actions */}
            <div className="flex items-center gap-2 w-64 justify-end">
                <div ref={searchContainerRef} className="relative hidden lg:block">
                    <div className="flex items-center h-11 px-3 bg-gradient-to-b from-white to-gray-50 border border-gray-200 rounded-2xl shadow-sm transition-all focus-within:shadow-md focus-within:border-gray-300">
                        <Search size={16} className="text-gray-400 mr-2" />
                        <input
                            type="text"
                            value={searchTerm}
                            onFocus={() => setSearchOpen(true)}
                            onChange={(e) => {
                              setSearchTerm(e.target.value);
                              setSearchOpen(true);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                setSearchOpen(false);
                                return;
                              }
                              if (e.key === 'Enter' && searchResults[0]) {
                                e.preventDefault();
                                openSearchResult(searchResults[0]);
                              }
                            }}
                            placeholder="Suchen..."
                            className="bg-transparent border-none outline-none text-sm font-medium w-20 focus:w-28 transition-all placeholder-gray-400"
                        />
                    </div>

                    {searchOpen && (
                      <div className="absolute top-full right-0 mt-2 w-[26rem] max-h-[24rem] overflow-auto rounded-2xl border border-gray-200 bg-white shadow-xl p-2 z-50">
                        {normalizedSearch.length < 2 && (
                          <div className="px-3 py-4 text-xs font-medium text-gray-500">
                            Mindestens 2 Zeichen eingeben.
                          </div>
                        )}

                        {normalizedSearch.length >= 2 && searchLoading && (
                          <div className="px-3 py-4 text-xs font-medium text-gray-500">
                            Suche läuft...
                          </div>
                        )}

                        {normalizedSearch.length >= 2 && !searchLoading && searchResults.length === 0 && (
                          <div className="px-3 py-4 text-xs font-medium text-gray-500">
                            Keine Treffer gefunden.
                          </div>
                        )}

                        {normalizedSearch.length >= 2 && !searchLoading && searchResults.length > 0 && (
                          <div className="space-y-1">
                            {searchResults.map((result) => {
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
                                  onClick={() => openSearchResult(result)}
                                  className="w-full text-left rounded-xl border border-transparent hover:border-gray-200 hover:bg-gray-50 px-3 py-2 transition-colors"
                                >
                                  <div className="flex items-start gap-3">
                                    <span className="mt-0.5 w-6 h-6 rounded-md bg-gray-100 text-gray-600 flex items-center justify-center">
                                      <Icon size={13} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-bold text-gray-900 truncate">{result.title}</p>
                                        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] font-bold uppercase tracking-wide">
                                          {result.badge}
                                        </span>
                                      </div>
                                      <p className="text-xs text-gray-500 truncate mt-0.5">{result.subtitle}</p>
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

                <div className="flex items-center gap-1 p-1 bg-gray-100/90 border border-gray-200 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                    <button
                        onClick={() => onNavigate('settings')}
                        className="group w-9 h-9 bg-white border border-gray-200 hover:border-gray-300 rounded-xl flex items-center justify-center text-gray-500 hover:text-black transition-all duration-200 shadow-sm hover:-translate-y-0.5 hover:shadow-md"
                        title="Einstellungen"
                        aria-label="Einstellungen"
                    >
                        <Settings size={16} className="transition-transform duration-300 group-hover:rotate-45" />
                    </button>

                    <button
                        onClick={() => onNavigate('settings')}
                        className="group relative w-9 h-9 bg-white border border-gray-200 hover:border-gray-300 rounded-xl flex items-center justify-center text-gray-500 hover:text-black transition-all duration-200 shadow-sm hover:-translate-y-0.5 hover:shadow-md"
                        title="Benachrichtigungen"
                        aria-label="Benachrichtigungen"
                    >
                        <Bell size={16} className="transition-transform duration-300 group-hover:-rotate-6" />
                        <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-error rounded-full ring-2 ring-white"></span>
                    </button>
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
