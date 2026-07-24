import { ZodFirstPartyTypeKind, type ZodTypeAny, z } from 'zod';

export type ContractRouteMap = Record<
  string,
  { args: ZodTypeAny; result: ZodTypeAny }
>;

type RouteKey<TRoutes extends ContractRouteMap> = keyof TRoutes & string;
type RouteArgs<
  TRoutes extends ContractRouteMap,
  K extends RouteKey<TRoutes>,
> = z.infer<TRoutes[K]['args']>;
type RouteResult<
  TRoutes extends ContractRouteMap,
  K extends RouteKey<TRoutes>,
> = z.infer<TRoutes[K]['result']>;
type RouteGroup<K extends string> = K extends `${infer G}:${string}` ? G : never;
type RouteMethod<K extends string> = K extends `${string}:${infer M}` ? M : never;
type Groups<TRoutes extends ContractRouteMap> = RouteGroup<RouteKey<TRoutes>>;
type MethodsForGroup<
  TRoutes extends ContractRouteMap,
  G extends string,
> = RouteMethod<Extract<RouteKey<TRoutes>, `${G}:${string}`>>;
type KeyFor<
  TRoutes extends ContractRouteMap,
  G extends string,
  M extends string,
> = Extract<RouteKey<TRoutes>, `${G}:${M}`>;
type MethodFn<
  TRoutes extends ContractRouteMap,
  K extends RouteKey<TRoutes>,
> = RouteArgs<TRoutes, K> extends undefined
  ? () => Promise<RouteResult<TRoutes, K>>
  : (args: RouteArgs<TRoutes, K>) => Promise<RouteResult<TRoutes, K>>;

export type ContractInvoke<TRoutes extends ContractRouteMap> = <
  K extends RouteKey<TRoutes>,
>(
  key: K,
  args: RouteArgs<TRoutes, K>,
) => Promise<RouteResult<TRoutes, K>>;

export type ContractApi<TRoutes extends ContractRouteMap> = {
  [G in Groups<TRoutes>]: {
    [M in MethodsForGroup<TRoutes, G>]: MethodFn<
      TRoutes,
      KeyFor<TRoutes, G, M>
    >;
  };
};

const hasUndefinedArgs = (schema: ZodTypeAny): boolean =>
  schema._def.typeName === ZodFirstPartyTypeKind.ZodUndefined;

export const createContractApi = <TRoutes extends ContractRouteMap>(
  routes: TRoutes,
  invoke: ContractInvoke<TRoutes>,
): ContractApi<TRoutes> => {
  const api: Record<string, Record<string, unknown>> = {};

  for (const key of Object.keys(routes) as RouteKey<TRoutes>[]) {
    const [group, method] = key.split(':') as [string, string];
    api[group] ??= {};
    const route = routes[key];
    api[group]![method] = hasUndefinedArgs(route.args)
      ? () => invoke(key, undefined as RouteArgs<TRoutes, typeof key>)
      : (args: RouteArgs<TRoutes, typeof key>) => invoke(key, args);
  }

  return api as ContractApi<TRoutes>;
};
