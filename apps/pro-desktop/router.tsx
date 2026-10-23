import React from 'react';
import {
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
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
import { ClientsView } from '@billme/desktop-renderer/components/ClientsView';
import { ArticlesView } from '@billme/desktop-renderer/components/ArticlesView';
import { SettingsView, type SettingsExtraSection } from '@billme/desktop-renderer/components/SettingsView';
import { ArrowRightLeft, ListChecks } from 'lucide-react';
import { ProTransferSettings } from './components/ProTransferSettings';
import { ProBookingRulesSettings } from './components/ProBookingRulesSettings';
import { RecurringView } from '@billme/desktop-renderer/components/RecurringView';
import { ProjectsView } from '@billme/desktop-renderer/components/ProjectsView';
import { ProjectDetailView } from '@billme/desktop-renderer/components/ProjectDetailView';
import { EurView } from '@billme/desktop-renderer/components/EurView';
import { TaxFilingCenter } from '@billme/desktop-renderer/components/TaxFilingCenter';
import { DashboardLayout } from './components/DashboardLayout';
import { AccountsView } from './components/AccountsView';
import { OnboardingWizard } from './components/OnboardingWizard';
import { ProAccountingPage } from './components/ProAccountingPage';

const AccountsPage: React.FC = () => <AccountsView />;
const EurPage: React.FC = () => <EurView />;
const ClientsPage: React.FC = () => <ClientsView />;
const ProjectsPage: React.FC = () => <ProjectsView />;
const ArticlesPage: React.FC = () => <ArticlesView />;
const PRO_SETTINGS: SettingsExtraSection[] = [
  { group: 'Buchhaltung', id: 'rules', label: 'Buchungsregeln', icon: ListChecks, desc: 'Regeln, Overrides & Probelauf', render: () => <ProBookingRulesSettings /> },
  { group: 'Buchhaltung', id: 'transfers', label: 'Umbuchungen', icon: ArrowRightLeft, desc: 'Geldtransit & Erkennung', render: () => <ProTransferSettings /> },
];
const SettingsPage: React.FC = () => <SettingsView extraSections={PRO_SETTINGS} />;
const RecurringPage: React.FC = () => <RecurringView />;
const TaxFilingPage: React.FC = () => <TaxFilingCenter />;

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
  return <ProAccountingPage view={view ?? 'inbox'} onViewChange={(next) => void navigate({ to: '/accounting', search: { view: next } })} />;
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
  component: ProjectDetailView,
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
