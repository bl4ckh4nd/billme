import type { BillmeApi as LiteBillmeApi } from '@billme/desktop-contracts/api';
import type { BillmeApi as ProBillmeApi } from '@billme/desktop-contracts-pro/api';
import type { VatValidationResult, WorkspaceSummary } from '@billme/server-core';

export type RendererProduct = 'lite' | 'pro';

export type VatValidationClient = (args: {
  countryCode: string;
  vatNumber: string;
}) => Promise<VatValidationResult>;

/** The signed-in person's workspaces; only a hosted server has more than one. */
export type RendererWorkspaces = {
  currentTenantId: string;
  currentUserId: string;
  list: WorkspaceSummary[];
  /** Web app per product, to open a workspace of the other product. */
  appUrls: Partial<Record<RendererProduct, string>>;
  setupTokenRequired: boolean;
  switchTo: (tenantId: string) => Promise<void>;
  create: (input: { name: string; product: RendererProduct; setupToken?: string }) => Promise<void>;
};

export type RendererRuntime = {
  product?: RendererProduct;
  shell?: 'desktop' | 'web';
  validateVatId?: VatValidationClient;
  onLogout?: () => void;
  workspaces?: RendererWorkspaces;
};

type RendererApi = LiteBillmeApi | ProBillmeApi;

let fallbackProduct: RendererProduct = 'lite';

const getExternalApi = (): RendererApi | undefined =>
  (globalThis as { billmeApi?: RendererApi }).billmeApi;

export const getRendererRuntime = (): RendererRuntime =>
  (globalThis as { billmeRuntime?: RendererRuntime }).billmeRuntime ?? {};

/**
 * Mirrors the server's mutation rule (owner, admin and accountant change data;
 * sales and viewer only read). The desktop has no workspaces and always may.
 */
export const canMutate = (): boolean => {
  const workspaces = getRendererRuntime().workspaces;
  const role = workspaces?.list.find((workspace) => workspace.tenantId === workspaces.currentTenantId)?.role;
  return !role || role === 'owner' || role === 'admin' || role === 'accountant';
};

/** Tooltip and hint for actions a read-only role cannot use. */
export const READ_ONLY_HINT = 'Nur Lesezugriff: Du kannst ansehen, aber nichts ändern.';

export const getRendererProduct = (): RendererProduct =>
  (globalThis as { billmeRuntime?: RendererRuntime }).billmeRuntime?.product ?? fallbackProduct;

export function getRendererApi(product: 'lite'): LiteBillmeApi;
export function getRendererApi(product: 'pro'): ProBillmeApi;
export function getRendererApi(product?: RendererProduct): RendererApi;
export function getRendererApi(product?: RendererProduct): RendererApi {
  if (product) {
    fallbackProduct = product;
  }
  const api = getExternalApi();
  if (!api) {
    throw new Error('billmeApi is not installed: expected the Electron preload, a browser shell adapter, or installDevMockApi in dev.');
  }
  return api;
}

export const ipc = new Proxy({} as LiteBillmeApi, {
  get: (_target, property) =>
    Reflect.get(getRendererApi(), property),
});

export function createRendererApiProxy(product: 'lite'): LiteBillmeApi;
export function createRendererApiProxy(product: 'pro'): ProBillmeApi;
export function createRendererApiProxy(product: RendererProduct): RendererApi {
  return new Proxy({} as RendererApi, {
    get: (_target, property) => Reflect.get(getRendererApi(product), property),
  });
}
