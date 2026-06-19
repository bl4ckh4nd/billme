export type ServerRouteProduct = 'lite' | 'pro';

export const SERVER_API_BASE = '/api/v1';

export const serverRoute = (...parts: string[]): string => {
  const path = parts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return path ? `/${path}` : '/';
};

export const serverProductPrefix = (product: ServerRouteProduct): string =>
  serverRoute(SERVER_API_BASE, product);

export const serverProductRoute = (product: ServerRouteProduct, path: string): string =>
  serverRoute(serverProductPrefix(product), path);

export const serverRoutes = {
  health: '/health',
  meta: {
    capabilities: serverRoute(SERVER_API_BASE, 'meta/capabilities'),
  },
  auth: {
    bootstrapStatus: serverRoute(SERVER_API_BASE, 'auth/bootstrap/status'),
    bootstrap: serverRoute(SERVER_API_BASE, 'auth/bootstrap'),
    login: serverRoute(SERVER_API_BASE, 'auth/login'),
    me: serverRoute(SERVER_API_BASE, 'auth/me'),
  },
  product: (product: ServerRouteProduct) => ({
    prefix: serverProductPrefix(product),
    auth: {
      bootstrapStatus: serverProductRoute(product, 'auth/bootstrap/status'),
      bootstrap: serverProductRoute(product, 'auth/bootstrap'),
      login: serverProductRoute(product, 'auth/login'),
      me: serverProductRoute(product, 'auth/me'),
    },
    numbers: {
      reserve: serverProductRoute(product, 'numbers/reserve'),
      release: serverProductRoute(product, 'numbers/release'),
      finalize: serverProductRoute(product, 'numbers/finalize'),
    },
    billing: {
      clients: serverProductRoute(product, 'clients'),
      invoices: serverProductRoute(product, 'invoices'),
      offers: serverProductRoute(product, 'offers'),
      recurring: serverProductRoute(product, 'recurring'),
      settings: serverProductRoute(product, 'settings'),
    },
    templates: {
      list: serverProductRoute(product, 'templates'),
      active: serverProductRoute(product, 'templates/active'),
      activeByKind: (kind: string) => serverProductRoute(product, `templates/active/${encodeURIComponent(kind)}`),
    },
  }),
  pro: {
    articles: serverProductRoute('pro', 'articles'),
    accounts: serverProductRoute('pro', 'accounts'),
    templates: {
      list: serverProductRoute('pro', 'templates'),
      active: serverProductRoute('pro', 'templates/active'),
      activeByKind: (kind: string) => serverProductRoute('pro', `templates/active/${encodeURIComponent(kind)}`),
    },
  },
} as const;
