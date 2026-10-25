import React from 'react';
import {
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useNavigate,
  useRouterState,
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
import { DashboardLayout } from './components/DashboardLayout';
import { OnboardingWizard } from './components/OnboardingWizard';

// Views outside the dashboard load on first visit, so the start bundle stays small.
const AccountsPage = lazyRouteComponent(() => import('./components/AccountsView'), 'AccountsView');
const EurPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/EurView'), 'EurView');
const ClientsPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ClientsView'), 'ClientsView');
const ProjectsPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ProjectsView'), 'ProjectsView');
const ProjectDetailPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ProjectDetailView'), 'ProjectDetailView');
const ArticlesPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/ArticlesView'), 'ArticlesView');
const SettingsPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/SettingsView'), 'SettingsView');
const RecurringPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/RecurringView'), 'RecurringView');
const TaxFilingPage = lazyRouteComponent(() => import('@billme/desktop-renderer/components/TaxFilingCenter'), 'TaxFilingCenter');
const ProAccountingPage = React.lazy(() => import('./components/ProAccountingPage').then((module) => ({ default: module.ProAccountingPage })));

const RootLayout: React.FC = () => <AppRootLayout Layout={DashboardLayout} Onboarding={OnboardingWizard} />;

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: AccountsPage,
});

const financeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/finance',
  // The old finance hub only linked to Konten and Buchhaltung; its SKR re-import now lives on /accounts.
  beforeLoad: () => {
    throw redirect({ to: '/accounts', replace: true });
  },
});

const AccountingPage: React.FC = () => {
  const view = useRouterState({ select: (state) => (state.location.search as { view?: unknown }).view });
  const navigate = useNavigate();
  return (
    <React.Suspense fallback={null}>
      <ProAccountingPage view={view ?? 'inbox'} onViewChange={(next) => void navigate({ to: '/accounting', search: { view: next } })} onOpenTaxFiling={() => void navigate({ to: '/tax-filing' })} />
    </React.Suspense>
  );
};

const accountingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounting',
  component: AccountingPage,
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
  component: DocumentEditorPage,
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

const taxFilingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tax-filing',
  component: TaxFilingPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  accountsRoute,
  financeRoute,
  accountingRoute,
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
  taxFilingRoute,
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
