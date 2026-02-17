import { ZodFirstPartyTypeKind } from 'zod';
import type { ZodTypeAny } from 'zod';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from './contract';

export type IpcInvoke = <K extends IpcRouteKey>(key: K, args: IpcArgs<K>) => Promise<IpcResult<K>>;

type RouteGroup<K extends string> = K extends `${infer G}:${string}` ? G : never;
type RouteMethod<K extends string> = K extends `${string}:${infer M}` ? M : never;

type Groups = RouteGroup<IpcRouteKey>;
type MethodsForGroup<G extends string> = RouteMethod<Extract<IpcRouteKey, `${G}:${string}`>>;
type KeyFor<G extends string, M extends string> = Extract<IpcRouteKey, `${G}:${M}`>;

type MethodFn<K extends IpcRouteKey> = IpcArgs<K> extends undefined
  ? () => Promise<IpcResult<K>>
  : (args: IpcArgs<K>) => Promise<IpcResult<K>>;

export type BillmeApi = {
  [G in Groups]: {
    [M in MethodsForGroup<G>]: MethodFn<KeyFor<G, M>>;
  };
};

const hasUndefinedArgs = (schema: ZodTypeAny): boolean => {
  return schema._def.typeName === ZodFirstPartyTypeKind.ZodUndefined;
};

export const createBillmeApi = (invoke: IpcInvoke): BillmeApi => {
  const api: Record<string, Record<string, unknown>> = {};

  for (const key of Object.keys(ipcRoutes) as IpcRouteKey[]) {
    const [group, method] = key.split(':') as [string, string];
    api[group] ??= {};

    const route = ipcRoutes[key];
    if (hasUndefinedArgs(route.args)) {
      api[group]![method] = () => invoke(key, undefined as IpcArgs<typeof key>);
    } else {
      api[group]![method] = (args: unknown) => invoke(key, args as IpcArgs<typeof key>);
    }
  }

  return api as unknown as BillmeApi;
};
