import {
  createBillmeApi as createLiteBillmeApi,
  type BillmeApi as LiteBillmeApi,
} from '@billme/desktop-contracts/api';
import {
  createBillmeApi as createProBillmeApi,
  type BillmeApi as ProBillmeApi,
} from '@billme/desktop-contracts-pro/api';
import {
  createLiteMockInvoke,
  createProMockInvoke,
} from '@billme/desktop-services/mockEngine';

export type RendererProduct = 'lite' | 'pro';

type RendererApi = LiteBillmeApi | ProBillmeApi;

let fallbackProduct: RendererProduct = 'lite';
let liteFallback: LiteBillmeApi | undefined;
let proFallback: ProBillmeApi | undefined;

const getExternalApi = (): RendererApi | undefined =>
  (globalThis as { billmeApi?: RendererApi }).billmeApi;

const getFallbackApi = (product: RendererProduct): RendererApi => {
  if (product === 'pro') {
    proFallback ??= createProBillmeApi(createProMockInvoke());
    return proFallback;
  }
  liteFallback ??= createLiteBillmeApi(createLiteMockInvoke());
  return liteFallback;
};

export function getRendererApi(product: 'lite'): LiteBillmeApi;
export function getRendererApi(product: 'pro'): ProBillmeApi;
export function getRendererApi(product?: RendererProduct): RendererApi;
export function getRendererApi(product?: RendererProduct): RendererApi {
  if (product) {
    fallbackProduct = product;
  }
  return getExternalApi() ?? getFallbackApi(product ?? fallbackProduct);
}

export const ipc = new Proxy({} as LiteBillmeApi, {
  get: (_target, property) =>
    Reflect.get(getRendererApi(), property),
});
