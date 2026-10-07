export type Route = { app: 'api' | 'portal'; method: string; path: string };

/** Fastify prints a tree; `commonPrefix: false` keeps whole segments, children are indented by four columns. */
export const fastifyRoutes = (tree: string): Route[] => {
  const stack: string[] = [];
  const routes: Route[] = [];
  for (const line of tree.split('\n')) {
    const match = line.match(/^([│ ]*)(?:├── |└── )(\S+)(?: \(([^)]+)\))?/);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    stack.length = depth;
    stack[depth] = match[2]!;
    for (const method of match[3]?.split(', ') ?? []) {
      if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ app: 'api', method, path: stack.join('') });
    }
  }
  return routes;
};

/** `:id|:invoiceId` is one Fastify node for two parameter names. */
export const routeMatcher = (path: string): RegExp =>
  new RegExp(`^${path.replace(/:[A-Za-z]+(\|:[A-Za-z]+)+/g, ':p').replace(/:[A-Za-z]+/g, '[^/]+').replace(/\*/g, '.*')}$`);

/** A requestable path for a route pattern: every parameter becomes `x`. */
export const concretePath = (path: string): string => path.replace(/:[A-Za-z]+(\|:[A-Za-z]+)*/g, 'x');
