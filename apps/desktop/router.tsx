import React from 'react';
import {
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import {
  AppRootLayout,
  DashboardPage,
  DocumentEditorPage,
  DocumentsPage,
  NotFoundPage,
  TemplateEditorPage,
  TemplatesPage,
} from '@billme/desktop-renderer/components/AppPages';
import { LiteReportsView } from '@billme/desktop-renderer/ui';
import { DashboardLayout } from './components/DashboardLayout';
import { OnboardingWizard } from './components/OnboardingWizard';

// Views outside the dashboard load on first visit, so the start bundle stays small.
// LiteReportsView stays static: the `ui` barrel is already part of the start bundle.
const StatisticsPage: React.FC = () => <LiteReportsView />;
const AccountsPage = lazyRouteComponent(() => import('./components/AccountsView'), 'AccountsView');
const EurPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/EurView'), 'EurView');
const ClientsPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ClientsView'), 'ClientsView');
const ProjectsPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ProjectsView'), 'ProjectsView');
const ProjectDetailPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ProjectDetailView'), 'ProjectDetailView');
const ArticlesPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ArticlesView'), 'ArticlesView');
const SettingsPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/SettingsView'), 'SettingsView');
const RecurringPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/RecurringView'), 'RecurringView');

const RootLayout: React.FC = () => <AppRootLayout Layout={DashboardLayout} Onboarding={OnboardingWizard} />;

const REASON_SUGGESTIONS = ['Tippfehler korrigiert', 'Adresse aktualisiert', 'Betrag angepasst', 'Kundendaten geändert', 'Sonstiges'];

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const statisticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/statistics',
  component: StatisticsPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: AccountsPage,
});

const financeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/finance',
  // The old finance hub is gone; old `/finance?tab=` links land on the page that now hosts that tab.
  beforeLoad: ({ location }) => {
    const tab = (location.search as { tab?: unknown }).tab;
    throw redirect({ to: tab === 'accounts' ? '/accounts' : tab === 'eur' ? '/eur' : '/statistics', replace: true });
  },
});

const eurRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/eur',
  component: EurPage,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates',
  component: TemplatesPage,
});

const templateEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates/$id',
  component: () => {
    const { id } = templateEditorRoute.useParams();
    return <TemplateEditorPage templateId={id} />;
  },
});

const documentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/documents',
  component: DocumentsPage,
});

const documentsEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/documents/edit',
  component: () => <DocumentEditorPage reasonSuggestions={REASON_SUGGESTIONS} />,
});

const recurringRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/recurring',
  component: RecurringPage,
});

const clientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clients',
  component: ClientsPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
});

const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectDetailPage,
});

const articlesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/articles',
  component: ArticlesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  statisticsRoute,
  accountsRoute,
  financeRoute,
  eurRoute,
  templatesRoute,
  templateEditorRoute,
  documentsRoute,
  documentsEditRoute,
  recurringRoute,
  clientsRoute,
  projectsRoute,
  projectDetailRoute,
  articlesRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultNotFoundComponent: NotFoundPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export const AppRouterProvider: React.FC = () => <RouterProvider router={router} />;
