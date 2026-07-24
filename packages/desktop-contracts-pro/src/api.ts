import {
  createContractApi,
  type ContractApi,
  type ContractInvoke,
} from '@billme/desktop-contracts/api-factory';
import { ipcRoutes } from './contract';

export type IpcInvoke = ContractInvoke<typeof ipcRoutes>;
export type BillmeApi = ContractApi<typeof ipcRoutes>;

export const createBillmeApi = (invoke: IpcInvoke): BillmeApi =>
  createContractApi(ipcRoutes, invoke);
