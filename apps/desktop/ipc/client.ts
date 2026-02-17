import type { BillmeApi } from './api';
import { mockBackendApi } from './mockBackend';

const getExternalApi = (): BillmeApi | undefined => {
  return (globalThis as any).billmeApi as BillmeApi | undefined;
};

export const ipc: BillmeApi = getExternalApi() ?? mockBackendApi;
