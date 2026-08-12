export type BillmeNavigationPage = 'dashboard' | 'clients' | 'projects' | 'documents' | 'finance' | 'articles' | 'tax-filing';

export type BillmeRuntimeConfig = {
  shell?: 'desktop' | 'web';
  product?: 'lite' | 'pro';
  navigation?: BillmeNavigationPage[];
  onLogout?: () => void;
};

const DEFAULT_RUNTIME: BillmeRuntimeConfig = {
  shell: 'desktop',
};

export const getBillmeRuntimeConfig = (): BillmeRuntimeConfig => {
  const runtime = (globalThis as { billmeRuntime?: BillmeRuntimeConfig }).billmeRuntime;
  if (!runtime) {
    return DEFAULT_RUNTIME;
  }
  return {
    ...DEFAULT_RUNTIME,
    ...runtime,
  };
};
