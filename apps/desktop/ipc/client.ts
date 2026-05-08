import type { BillmeApi } from './api';
import { mockBackendApi } from './mockBackend';

const getExternalApi = (): BillmeApi | undefined => {
  return (globalThis as any).billmeApi as BillmeApi | undefined;
};

const resolveApi = (): BillmeApi => getExternalApi() ?? mockBackendApi;

export const ipc: BillmeApi = new Proxy({} as BillmeApi, {
  get(_target, prop) {
    const api = resolveApi();
    const value = api[prop as keyof BillmeApi];
    return typeof value === 'function' ? value.bind(api) : value;
  },
}) as BillmeApi;
