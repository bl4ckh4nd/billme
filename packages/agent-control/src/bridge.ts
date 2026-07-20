import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentInvocationSchema,
  agentResultSchema,
  assertAgentInvocationAllowed,
  getAgentActionCatalog,
  parseAgentArgs,
  parseAgentResult,
  type AgentInvocation,
  type AgentProduct,
} from './index.js';

type LocalAgentInvoker = (invocation: AgentInvocation & { requestId: string }) => Promise<unknown>;

export type LocalAgentBridge = {
  endpointPath: string;
  stop: () => Promise<void>;
};

type LocalAgentEndpoint = {
  baseUrl: string;
  token: string;
  product: AgentProduct;
};

const writeJson = (response: ServerResponse, status: number, payload: unknown): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) {
      throw new Error('Request body exceeds 2 MiB.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const bearerToken = (request: IncomingMessage): string | null => {
  const value = request.headers.authorization;
  const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return match?.[1] ?? null;
};

const routeAction = (pathname: string): string | null => {
  const prefix = '/actions/';
  if (!pathname.startsWith(prefix)) return null;
  const action = decodeURIComponent(pathname.slice(prefix.length));
  return action || null;
};

export const startLocalAgentBridge = async (options: {
  userDataPath: string;
  product: AgentProduct;
  invoke: LocalAgentInvoker;
}): Promise<LocalAgentBridge> => {
  const token = randomBytes(32).toString('base64url');
  const endpointPath = join(options.userDataPath, 'billme-agent-control.json');
  await mkdir(options.userDataPath, { recursive: true });

  const server: Server = createServer(async (request, response) => {
    try {
      if (bearerToken(request) !== token) {
        writeJson(response, 401, { code: 'unauthorized', message: 'Invalid local agent token.' });
        return;
      }

      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && pathname === '/actions') {
        writeJson(response, 200, getAgentActionCatalog(options.product));
        return;
      }

      if (request.method !== 'POST') {
        writeJson(response, 405, { code: 'method_not_allowed', message: 'Use GET /actions or POST /actions/:action.' });
        return;
      }

      const action = routeAction(pathname);
      if (!action) {
        writeJson(response, 404, { code: 'not_found', message: 'Unknown local agent route.' });
        return;
      }

      const parsed = agentInvocationSchema.parse({
        ...(await readBody(request) as Record<string, unknown>),
        action,
      });
      assertAgentInvocationAllowed(options.product, action, parsed);
      const parsedArgs = parseAgentArgs(options.product, action, parsed.args, parsed.reason);
      const requestId = randomUUID();
      const result = parseAgentResult(
        options.product,
        action,
        await options.invoke({ ...parsed, args: parsedArgs, requestId }),
      );
      writeJson(response, 200, agentResultSchema.parse({
        requestId,
        action,
        status: 'completed',
        data: result,
      }));
    } catch (error) {
      writeJson(response, 400, {
        code: 'invalid_agent_request',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Local agent bridge did not receive a TCP address.');
  }

  const endpoint: LocalAgentEndpoint = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    product: options.product,
  };
  await writeFile(endpointPath, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 0o600 });
  await chmod(endpointPath, 0o600).catch(() => undefined);

  return {
    endpointPath,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const current = await readFile(endpointPath, 'utf8').catch(() => null);
      if (current && current.includes(token)) {
        await unlink(endpointPath).catch(() => undefined);
      }
    },
  };
};

export const readLocalAgentEndpoint = async (endpointPath: string): Promise<{
  baseUrl: string;
  token: string;
  product: AgentProduct;
}> => {
  const raw = JSON.parse(await readFile(endpointPath, 'utf8')) as LocalAgentEndpoint;
  return raw;
};
