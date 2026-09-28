import React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Bell, CheckCheck, Plus, X, type LucideIcon } from 'lucide-react';
import { BillmeLogo, Button, IconButton, Kbd, KontorIcon, Portal, cn, popoverExitClass, useAnchoredPosition, useExitTransition, useThemePreference, type ThemePreference } from '@billme/ui';
import { useSettingsQuery } from '../../hooks/useSettings';
import { useNotificationsStore, type AppNotification } from '@billme/desktop-core/state/notificationsStore';
import { CommandPalette, isMacPlatform, type ShellCommand } from './CommandPalette';

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

export type ShellNavGroup = 'Arbeit' | 'Verkauf' | 'Abschluss';

export interface ShellNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: ShellNavGroup;
  /** Route path. `search` narrows it to one area of a tabbed route, e.g. `{ view: 'opos' }`. */
  to: string;
  search?: Record<string, string>;
  /** Further path prefixes that belong to this entry (sub-pages, editors, legacy paths). */
  also?: string[];
  /** Open work in this area, shown as a pill in the full rail. */
  count?: number;
  /** Context line next to the header title, from 1100px on. */
  subtitle?: string;
  /** Palette command that opens this entry, e.g. "Nächsten Umsatz buchen". */
  action?: string;
}

export interface DashboardLayoutProps {
  children: React.ReactNode;
  isEditorActive: boolean;
  /**
   * Rail entries. Lite derives them from the runtime config (the web shell hides
   * sections), Pro adds its accounting areas, so the product supplies them.
   */
  navItems: readonly ShellNavItem[];
  /** Product titlebar, rendered above the shell. */
  titlebar: React.ReactNode;
}

const GROUPS: ShellNavGroup[] = ['Arbeit', 'Verkauf', 'Abschluss'];

const pathMatches = (pathname: string, prefix: string) =>
  prefix === '/' ? pathname === '/' : pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Picks the one active entry: path match, then the entry whose search fits the URL, else the first path match. */
const findActive = (items: readonly ShellNavItem[], pathname: string, search: Record<string, unknown>): string | null => {
  const onPath = items.filter((item) => [item.to, ...(item.also ?? [])].some((prefix) => pathMatches(pathname, prefix)));
  const exact = onPath.find((item) => item.search && Object.entries(item.search).every(([key, value]) => search[key] === value));
  return (exact ?? onPath.find((item) => !item.search || !Object.keys(item.search).some((key) => key in search)) ?? onPath[0])?.id ?? null;
};

const LEGAL_FORM: Record<string, string> = { sole_proprietor: 'Einzelunternehmen', gmbh: 'GmbH', ug: 'UG', gbr: 'GbR', ek: 'e. K.' };

const readRailPreference = (): 'full' | 'mini' => {
  try {
    return globalThis.localStorage?.getItem('billme.rail') === 'mini' ? 'mini' : 'full';
  } catch {
    return 'full';
  }
};

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: 'system', label: 'System', icon: KontorIcon.system },
  { value: 'light', label: 'Hell', icon: KontorIcon.sun },
  { value: 'dark', label: 'Dunkel', icon: KontorIcon.moon },
];

/** Master-data creation per area: offered in the palette and as that page's topbar action. */
const CREATE_ACTIONS: Array<{ key: string; title: string; to: string; search: Record<string, string>; keywords: string[] }> = [
  { key: 'client', title: 'Neuer Kunde', to: '/clients', search: { create: 'client' }, keywords: ['kunde', 'kontakt'] },
  { key: 'project', title: 'Neues Projekt', to: '/projects', search: { create: 'project' }, keywords: ['projekt'] },
  { key: 'article', title: 'Neue Leistung', to: '/articles', search: { create: 'article' }, keywords: ['leistung', 'artikel', 'produkt'] },
];

const SETTINGS_SUBTITLE = 'Firma, Buchführung und Nummernkreise';

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children, isEditorActive, navItems, titlebar }) => {
  const navigate = useNavigate();
  const location = useRouterState({ select: (s) => s.location });
  const activeId = findActive(navItems, location.pathname, (location.search ?? {}) as Record<string, unknown>);
  const settingsActive = pathMatches(location.pathname, '/settings');
  const activeItem = navItems.find((item) => item.id === activeId);
  const canCreateInvoice = navItems.some((item) => item.to === '/documents');
  const subtitle = activeItem ? activeItem.subtitle : settingsActive ? SETTINGS_SUBTITLE : undefined;
  const { data: settings } = useSettingsQuery();
  const profile = settings?.businessReportingProfile;
  const [theme, setTheme] = useThemePreference();
  const currentTheme = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0];

  const [rail, setRail] = React.useState<'full' | 'mini'>(readRailPreference);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const go = React.useCallback(
    (item: Pick<ShellNavItem, 'to' | 'search'>) => {
      setDrawerOpen(false);
      void navigate({ to: item.to, search: item.search ?? {} });
    },
    [navigate],
  );

  const toggleRail = () => {
    const next = rail === 'full' ? 'mini' : 'full';
    setRail(next);
    try {
      globalThis.localStorage?.setItem('billme.rail', next);
    } catch {
      // Collapsing still works for this session without storage.
    }
  };

  const { notifications, addNotification, markAllRead, clearAll } = useNotificationsStore();
  const unreadCount = notifications.filter((n) => !n.read).length;
  const [notifPanelOpen, setNotifPanelOpen] = React.useState(false);
  const notifPanelRef = React.useRef<HTMLDivElement | null>(null);
  const notifDropdownRef = React.useRef<HTMLDivElement | null>(null);
  const notifPanelPos = useAnchoredPosition(notifPanelRef, notifDropdownRef, notifPanelOpen, { align: 'end', offset: 8 });
  const notifPanel = useExitTransition(notifPanelOpen);

  // Subscribe to push notifications from the desktop main process.
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

  // The document editors bind Ctrl/⌘K to their own actions dialog.
  React.useEffect(() => {
    if (isEditorActive) return undefined;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isEditorActive]);

  React.useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [drawerOpen]);

  const commands = React.useMemo<ShellCommand[]>(() => {
    const has = (to: string) => navItems.some((item) => item.to === to);
    const create = (key: string, title: string, to: string, search: Record<string, string>, keywords: string[]): ShellCommand => ({
      key: `create:${key}`,
      title,
      icon: Plus,
      keywords: ['neu', 'anlegen', 'erstellen', ...keywords],
      run: () => void navigate({ to, search }),
    });
    const list: ShellCommand[] = [];
    if (has('/documents')) {
      list.push(create('invoice', 'Rechnung schreiben', '/documents', { create: 'invoice' }, ['neue rechnung', 'rechnung', 'dokument', 'schreiben']));
      list.push(create('offer', 'Neues Angebot', '/documents', { kind: 'offer', create: 'offer' }, ['angebot', 'dokument']));
    }
    for (const entry of CREATE_ACTIONS) {
      if (has(entry.to)) list.push(create(entry.key, entry.title, entry.to, entry.search, entry.keywords));
    }
    for (const item of navItems) {
      if (item.action) list.push({ key: `action:${item.id}`, title: item.action, icon: item.icon, keywords: [item.label.toLowerCase()], run: () => go(item) });
    }
    for (const item of navItems) {
      list.push({ key: `go:${item.id}`, title: `Gehe zu ${item.label}`, icon: item.icon, keywords: ['öffnen', 'seite', item.label.toLowerCase(), `${item.label.toLowerCase()} öffnen`, item.group.toLowerCase()], run: () => go(item) });
    }
    list.push({ key: 'go:settings', title: 'Gehe zu Einstellungen', icon: KontorIcon.settings, keywords: ['öffnen', 'seite', 'einstellungen', 'einstellungen öffnen'], run: () => go({ to: '/settings' }) });
    for (const option of THEME_OPTIONS) {
      list.push({ key: `theme:${option.value}`, title: `Darstellung: ${option.label}`, icon: option.icon, keywords: ['theme', 'dunkel', 'hell', 'modus', 'farbschema'], run: () => setTheme(option.value) });
    }
    return list;
  }, [go, navItems, navigate, setTheme]);

  const mini = rail === 'mini';

  const railContent = (compact: boolean) => (
    <>
      <div className="flex flex-col gap-2.5 px-3 pb-2.5 pt-3.5">
        <div className={cn('flex h-7 items-center px-1', compact && 'justify-center')}>
          {/* Collapsed: crop the wordmark's viewBox to the mark. */}
          <BillmeLogo className="h-6 w-auto text-foreground" {...(compact ? { viewBox: '300 505 265 375' } : {})} />
        </div>
        {!compact && settings && (
          <div className="rounded-card border border-border bg-surface-sunken px-2.5 py-2" aria-label="Unternehmen">
            <div className="truncate text-label font-semibold text-foreground">{settings.company.name || 'Unternehmen'}</div>
            <div className="text-[0.6875rem] leading-4 text-muted">
              {[
                profile && LEGAL_FORM[profile.legalForm],
                profile && (profile.profitDetermination === 'eur' ? 'EÜR' : 'Doppelte Buchführung'),
                profile?.chart,
              ]
                .filter(Boolean)
                .join(' · ') || 'Buchführung noch nicht eingerichtet'}
            </div>
          </div>
        )}
      </div>
      <nav aria-label="Hauptnavigation" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {GROUPS.map((group) => {
          const items = navItems.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mt-3.5 first:mt-0.5">
              <p className={cn('px-2 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.04em] text-muted', compact && 'sr-only')}>{group}</p>
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === activeId;
                  const count = item.count || undefined;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => go(item)}
                        aria-current={active ? 'page' : undefined}
                        title={compact ? item.label : undefined}
                        aria-label={compact ? item.label : undefined}
                        aria-describedby={count ? `nav-count-${item.id}` : undefined}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-control px-2 py-[7px] text-left text-label motion-safe:transition-colors motion-reduce:transition-none',
                          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                          compact && 'justify-center px-0',
                          active ? 'bg-selected text-selected-foreground' : 'text-muted hover:bg-surface-sunken hover:text-foreground',
                        )}
                      >
                        <Icon size={16} aria-hidden="true" className="shrink-0" />
                        {!compact && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                        {!compact && count && (
                          <span
                            aria-hidden="true"
                            className={cn(
                              'shrink-0 rounded-full border px-[5px] font-mono text-[0.6875rem] leading-4 tabular-nums',
                              active ? 'border-transparent bg-selected-foreground/15 text-selected-foreground' : 'border-border bg-surface-sunken text-muted',
                            )}
                          >
                            {count}
                          </span>
                        )}
                      </button>
                      {count && <span id={`nav-count-${item.id}`} className="sr-only">{count} offen</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="flex flex-col gap-1 border-t border-border p-2">
        <button
          type="button"
          onClick={() => go({ to: '/settings' })}
          aria-current={settingsActive ? 'page' : undefined}
          title={compact ? 'Einstellungen' : undefined}
          aria-label={compact ? 'Einstellungen' : undefined}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-control px-2 py-[7px] text-left text-label focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
            compact && 'justify-center px-0',
            settingsActive ? 'bg-selected text-selected-foreground' : 'text-muted hover:bg-surface-sunken hover:text-foreground',
          )}
        >
          <KontorIcon.settings size={16} aria-hidden="true" className="shrink-0" />
          {!compact && <span className="flex-1">Einstellungen</span>}
        </button>
        {compact ? (
          <IconButton
            aria-label={`Darstellung: ${currentTheme.label}. Wechseln`}
            title={`Darstellung: ${currentTheme.label}`}
            onClick={() => setTheme(THEME_OPTIONS[(THEME_OPTIONS.indexOf(currentTheme) + 1) % THEME_OPTIONS.length].value)}
            className="self-center"
          >
            <currentTheme.icon size={16} aria-hidden="true" />
          </IconButton>
        ) : (
          <div role="radiogroup" aria-label="Darstellung" className="flex rounded-control bg-surface-sunken p-0.5">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                aria-label={`Darstellung ${label}`}
                title={label}
                onClick={() => setTheme(value)}
                className={cn(
                  'flex h-7 flex-1 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-focus-ring',
                  theme === value ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground',
                )}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-surface-sunken font-sans text-foreground">
      {titlebar}

      {isEditorActive ? (
        <div className="w-full flex-1 overflow-auto bg-surface-sunken">{children}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside
            aria-label="Bereiche"
            className={cn(
              'hidden min-h-0 shrink-0 flex-col border-r border-border bg-surface no-print min-[900px]:flex',
              mini ? 'w-16' : 'w-[236px]',
            )}
          >
            {railContent(mini)}
          </aside>

          {drawerOpen && (
            <Portal>
              <div className="fixed inset-0 z-[var(--z-overlay)] min-[900px]:hidden">
                <div className="absolute inset-0 bg-surface-inverse/45" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
                <aside aria-label="Bereiche" className="ui-enter-panel absolute inset-y-0 left-0 flex w-[min(280px,86vw)] flex-col bg-surface shadow-2xl">
                  {railContent(false)}
                </aside>
              </div>
            </Portal>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="z-[var(--z-dropdown)] flex h-14 shrink-0 items-center gap-2 px-3 no-print md:px-4">
              <IconButton
                className="min-[900px]:hidden"
                aria-label="Bereiche öffnen"
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen(true)}
              >
                <KontorIcon.menu size={16} aria-hidden="true" />
              </IconButton>
              <IconButton
                className="hidden min-[900px]:inline-flex"
                aria-label={mini ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
                aria-pressed={mini}
                onClick={toggleRail}
              >
                <KontorIcon.panel size={16} aria-hidden="true" />
              </IconButton>

              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <p className="min-w-0 shrink truncate text-label text-muted" data-shell-area>
                  {activeItem ? (
                    <>
                      <span className="max-sm:hidden">{activeItem.group} / </span>
                      <span className="font-semibold text-foreground">{activeItem.label}</span>
                    </>
                  ) : settingsActive ? (
                    <span className="font-semibold text-foreground">Einstellungen</span>
                  ) : null}
                </p>
                {subtitle && (
                  <span className="hidden min-w-0 truncate text-caption text-muted min-[1100px]:inline" data-shell-subtitle>
                    {subtitle}
                  </span>
                )}
              </div>

              {/* Pages carry their own create action in the page header; the topbar only offers the invoice. */}
              {canCreateInvoice && !pathMatches(location.pathname, '/documents') && (
                <Button size="sm" onClick={() => go({ to: '/documents', search: { create: 'invoice' } })} className="max-sm:hidden">
                  <Plus size={14} aria-hidden="true" />
                  Neue Rechnung
                </Button>
              )}

              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-keyshortcuts={isMacPlatform() ? 'Meta+K' : 'Control+K'}
                className="flex h-9 max-w-80 flex-1 items-center gap-2 rounded-control border border-control-border bg-surface px-2.5 text-left text-sm text-muted hover:border-control-border-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring max-sm:max-w-9 max-sm:flex-none max-sm:justify-center max-sm:px-0"
              >
                <KontorIcon.search size={14} className="shrink-0" aria-hidden="true" />
                <span className="flex-1 truncate max-sm:sr-only">Suchen oder Befehl …</span>
                <Kbd className="shrink-0 max-sm:hidden">{isMacPlatform() ? '⌘K' : 'Strg K'}</Kbd>
              </button>

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
                    <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error-text px-1 text-caption font-semibold leading-none text-background ring-2 ring-surface-sunken tabular-nums">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </IconButton>

                {notifPanel.mounted && (
                  <Portal>
                    <div
                      ref={notifDropdownRef}
                      style={notifPanelPos.style}
                      className={cn(
                        'ui-enter-popover z-[var(--z-dropdown)] max-h-96 w-80 overflow-auto rounded-panel bg-surface shadow-md',
                        notifPanel.closing && popoverExitClass,
                      )}
                    >
                      <div className="flex items-center justify-between border-b border-border px-4 py-3">
                        <span className="text-sm font-semibold text-foreground">Benachrichtigungen</span>
                        <div className="flex items-center gap-2">
                          {notifications.length > 0 && (
                            <>
                              <button
                                type="button"
                                onClick={markAllRead}
                                className="flex items-center gap-1 rounded-sm text-xs font-semibold text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-colors motion-reduce:transition-none"
                                title="Alle als gelesen markieren"
                              >
                                <CheckCheck size={12} aria-hidden="true" /> Alle gelesen
                              </button>
                              <button
                                type="button"
                                onClick={clearAll}
                                aria-label="Alle Benachrichtigungen löschen"
                                className="rounded-sm text-xs font-semibold text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-safe:transition-colors motion-reduce:transition-none"
                                title="Alle löschen"
                              >
                                <X size={12} aria-hidden="true" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {notifications.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-muted">Keine Benachrichtigungen</div>
                      ) : (
                        <div className="divide-y divide-border-subtle">
                          {notifications.map((n) => (
                            <div key={n.id} className={`px-4 py-3 ${n.read ? 'bg-surface' : 'bg-surface-muted'}`}>
                              <div className="flex items-start gap-2">
                                {!n.read && (
                                  <>
                                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-info-text" aria-hidden="true" />
                                    <span className="sr-only">Ungelesen</span>
                                  </>
                                )}
                                <div className="min-w-0 flex-1">
                                  <p className={`text-xs font-semibold ${n.read ? 'text-muted' : 'text-foreground'}`}>{n.title}</p>
                                  <p className={`mt-0.5 text-xs ${n.read ? 'text-muted' : 'text-foreground'}`}>{n.message}</p>
                                  <p className="mt-1 text-xs text-muted tabular-nums">
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
            </header>

            {/* A tight gutter lets each page's raised surface read as one inset
                panel on the ground, framed by the rail and the header. */}
            <main className="scrollbar-hide flex-1 overflow-auto px-2 pb-2 md:px-3 md:pb-3">
              <div className="mx-auto h-full max-w-[1800px]">{children}</div>
            </main>
          </div>
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        includeProjects={navItems.some((item) => item.to === '/projects')}
        includeArticles={navItems.some((item) => item.to === '/articles')}
      />
    </div>
  );
};

