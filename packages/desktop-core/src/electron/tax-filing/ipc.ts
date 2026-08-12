import type { IpcMain } from 'electron';
import { taxFilingRoutes } from '@billme/desktop-contracts/taxFiling';
import { TaxFilingAdapter } from './adapter';

export { taxFilingRoutes };
export type TaxFilingRouteKey = keyof typeof taxFilingRoutes;
export type TaxFilingArgs<K extends TaxFilingRouteKey> = import('zod').infer<(typeof taxFilingRoutes)[K]['args']>;
export type TaxFilingResult<K extends TaxFilingRouteKey> = import('zod').infer<(typeof taxFilingRoutes)[K]['result']>;
export type TaxFilingInvoke = <K extends TaxFilingRouteKey>(key: K, args: TaxFilingArgs<K>) => Promise<TaxFilingResult<K>>;
export type TaxFilingApi = {
  status: () => Promise<TaxFilingResult<'taxFiling:getStatus'>>;
  records: () => Promise<TaxFilingResult<'taxFiling:listRecords'>>;
  installCertificate: (args: TaxFilingArgs<'taxFiling:installCertificate'>) => Promise<TaxFilingResult<'taxFiling:installCertificate'>>;
  removeCertificate: (args: TaxFilingArgs<'taxFiling:removeCertificate'>) => Promise<boolean>;
  validate: (args: TaxFilingArgs<'taxFiling:validate'>) => Promise<TaxFilingResult<'taxFiling:validate'>>;
  export: (args: TaxFilingArgs<'taxFiling:export'>) => Promise<TaxFilingResult<'taxFiling:export'>>;
  submit: (args: TaxFilingArgs<'taxFiling:submit'>) => Promise<TaxFilingResult<'taxFiling:submit'>>;
};

export const createTaxFilingApi = (invoke: TaxFilingInvoke): TaxFilingApi => ({
  status: () => invoke('taxFiling:getStatus', undefined),
  records: () => invoke('taxFiling:listRecords', undefined),
  installCertificate: (args) => invoke('taxFiling:installCertificate', args),
  removeCertificate: (args) => invoke('taxFiling:removeCertificate', args),
  validate: (args) => invoke('taxFiling:validate', args),
  export: (args) => invoke('taxFiling:export', args),
  submit: (args) => invoke('taxFiling:submit', args),
});

export const registerTaxFilingIpcHandlers = (
  ipcMain: IpcMain,
  options: { getUserDataPath: () => string; resourcesPath?: string; binaryPath?: string; adapter?: TaxFilingAdapter },
): TaxFilingAdapter => {
  const adapter = options.adapter ?? new TaxFilingAdapter({ userDataPath: options.getUserDataPath(), resourcesPath: options.resourcesPath, binaryPath: options.binaryPath });
  const register = <K extends TaxFilingRouteKey>(key: K, fn: (args: TaxFilingArgs<K>) => Promise<unknown> | unknown) => {
    const route = taxFilingRoutes[key];
    ipcMain.handle(route.channel, async (_event, raw) => route.result.parse(await fn(route.args.parse(raw) as TaxFilingArgs<K>)));
  };
  register('taxFiling:getStatus', async () => ({ provider: await adapter.providerStatus(), certificates: await adapter.certificates() }));
  register('taxFiling:listRecords', async () => adapter.records());
  register('taxFiling:installCertificate', (args) => adapter.installCertificate(args));
  register('taxFiling:removeCertificate', (args) => adapter.removeCertificate(args.id));
  register('taxFiling:validate', (args) => adapter.validate(args.record));
  register('taxFiling:export', (args) => adapter.export(args.record));
  register('taxFiling:submit', (args) => adapter.submit(args.record));
  return adapter;
};
