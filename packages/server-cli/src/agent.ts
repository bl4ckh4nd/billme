import { randomUUID } from 'node:crypto';
import {
  agentInvocationSchema,
  agentResultSchema,
  assertAgentInvocationAllowed,
  getAgentActionCatalog,
  parseAgentArgs,
  parseAgentResult,
  type AgentAction,
  type AgentInvocation,
  type AgentProduct,
  type AgentTarget,
} from '@billme/agent-control';
import { readLocalAgentEndpoint } from '@billme/agent-control/bridge';
import { createBillmeServerClient, type BillmeServerClient } from './client.js';

export type AgentClient = {
  listActions: () => AgentAction[];
  invoke: (input: AgentInvocation & { target: AgentTarget; endpointPath?: string }) => Promise<unknown>;
};

const asRecord = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent action input must be a JSON object.');
  }
  return value as Record<string, any>;
};

const invokeServerAction = async (
  client: BillmeServerClient,
  product: AgentProduct,
  invocation: AgentInvocation,
  token: string | null,
): Promise<unknown> => {
  const args = invocation.args === undefined ? {} : asRecord(invocation.args);
  const reason = invocation.reason ?? 'Agent action';
  const tokenArgs = { product, token };

  switch (invocation.action) {
    case 'clients:list': return client.listClients(tokenArgs);
    case 'clients:get': return client.getClient(String(args.id), tokenArgs);
    case 'clients:upsert': return client.upsertClient({ reason, client: args.client, ...tokenArgs });
    case 'clients:delete': return client.deleteClient({ id: String(args.id), reason, ...tokenArgs });
    case 'invoices:list': return client.listInvoices(tokenArgs);
    case 'invoices:get': return client.getInvoice(String(args.id), tokenArgs);
    case 'invoices:upsert': return client.upsertInvoice({ reason, invoice: args.invoice, ...tokenArgs });
    case 'invoices:delete': return client.deleteInvoice({ id: String(args.id), reason, ...tokenArgs });
    case 'offers:list': return client.listOffers(tokenArgs);
    case 'offers:get': return client.getOffer(String(args.id), tokenArgs);
    case 'offers:upsert': return client.upsertOffer({ reason, offer: args.offer, ...tokenArgs });
    case 'offers:delete': return client.deleteOffer({ id: String(args.id), reason, ...tokenArgs });
    case 'recurring:list': return client.listRecurringProfiles(tokenArgs);
    case 'recurring:get': return client.getRecurringProfile(String(args.id), tokenArgs);
    case 'recurring:upsert': return client.upsertRecurringProfile({ reason, profile: args.profile, ...tokenArgs });
    case 'recurring:delete': return client.deleteRecurringProfile({ id: String(args.id), reason, ...tokenArgs });
    case 'settings:get': return client.getSettings(tokenArgs);
    case 'settings:set': return client.setSettings({ settings: args.settings, ...tokenArgs });
    case 'numbers:reserve': return client.reserveNumber({ kind: args.kind, ...tokenArgs });
    case 'numbers:release': return client.releaseNumber({ reservationId: String(args.reservationId), ...tokenArgs });
    case 'numbers:finalize': return client.finalizeNumber({ reservationId: String(args.reservationId), documentId: String(args.documentId), ...tokenArgs });
    case 'templates:list': return client.listTemplates({ kind: args.kind, token: tokenArgs.token });
    case 'templates:active': return client.getActiveTemplate({ kind: args.kind, token: tokenArgs.token });
    case 'templates:upsert': return client.upsertTemplate({ template: args.template, token: tokenArgs.token });
    case 'templates:setActive': return client.setActiveTemplate({ kind: args.kind, templateId: args.templateId, token: tokenArgs.token });
    case 'articles:list': return client.listArticles({ token: tokenArgs.token });
    case 'articles:upsert': return client.upsertArticle({ article: args.article, token: tokenArgs.token });
    case 'accounts:list': return client.listAccounts({ token: tokenArgs.token });
    case 'accounts:upsert': return client.upsertAccount({ account: args.account, token: tokenArgs.token });
    case 'pro:listWorkflowEntries': return client.listWorkflowEntries({ token: tokenArgs.token });
    case 'pro:upsertWorkflowEntry': return client.upsertWorkflowEntry({
      transactionId: String(args.transactionId),
      transactionJson: String(args.transactionJson),
      draftJson: String(args.draftJson),
      token: tokenArgs.token,
    });
    case 'pro:listLedgerAccounts': return client.listLedgerAccounts({ ...args, token: tokenArgs.token });
    case 'pro:getLedgerStats': return client.getLedgerStats({ token: tokenArgs.token });
    case 'pro:listTaxCases': return client.listTaxCases({ ...args, token: tokenArgs.token });
    case 'pro:listTaxCaseAccountMappings': return client.listTaxCaseAccountMappings({ ...args, token: tokenArgs.token });
    case 'pro:upsertTaxCaseAccountMapping': return client.upsertTaxCaseAccountMapping({
      id: args.id,
      chart: args.chart,
      taxCaseKey: args.taxCaseKey,
      role: args.role,
      accountNumber: args.accountNumber,
      datevBuKey: args.datevBuKey,
      validFrom: args.validFrom,
      validTo: args.validTo,
      token: tokenArgs.token,
    });
    case 'pro:listAccountSuggestionRules': return client.listAccountSuggestionRules({ ...args, token: tokenArgs.token });
    case 'pro:upsertAccountSuggestionRule': return client.upsertAccountSuggestionRule({
      id: args.id,
      chart: args.chart,
      priority: args.priority,
      field: args.field,
      operator: args.operator,
      value: args.value,
      targetAccountNumber: args.targetAccountNumber,
      flowType: args.flowType,
      active: args.active,
      token: tokenArgs.token,
    });
    case 'pro:deleteAccountSuggestionRule': return client.deleteAccountSuggestionRule({ id: String(args.id), token: tokenArgs.token });
    default:
      throw new Error(`Server target does not support agent action: ${product}:${invocation.action}`);
  }
};

const invokeDesktopAction = async (
  product: AgentProduct,
  invocation: AgentInvocation,
  endpointPath: string,
): Promise<unknown> => {
  const endpoint = await readLocalAgentEndpoint(endpointPath);
  if (endpoint.product !== product) {
    throw new Error(`Local endpoint is for ${endpoint.product}, not ${product}.`);
  }
  const response = await fetch(`${endpoint.baseUrl}/actions/${encodeURIComponent(invocation.action)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      args: invocation.args,
      reason: invocation.reason,
      confirm: invocation.confirm,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String(payload.message)
      : `Local agent request failed with status ${response.status}`;
    throw new Error(message);
  }
  const result = agentResultSchema.parse(payload);
  return {
    ...result,
    data: parseAgentResult(product, invocation.action, result.data),
  };
};

export const createAgentClient = (options: {
  product: AgentProduct;
  target: AgentTarget;
  server?: {
    baseUrl: string;
    token?: string | null;
    fetchImplementation?: typeof fetch;
  };
}): AgentClient => {
  const serverClient = options.server
    ? createBillmeServerClient({
        baseUrl: options.server.baseUrl,
        product: options.product,
        token: options.server.token,
        fetchImplementation: options.server.fetchImplementation,
      })
    : null;

  return {
    listActions: () => getAgentActionCatalog(options.product).filter((action) => action.targets.includes(options.target)),
    async invoke(input) {
      const invocation = agentInvocationSchema.parse(input);
      assertAgentInvocationAllowed(options.product, invocation.action, invocation);
      const parsedArgs = parseAgentArgs(options.product, invocation.action, invocation.args, invocation.reason);
      const normalized = { ...invocation, args: parsedArgs, action: invocation.action };

      if (options.target === 'desktop') {
        if (!input.endpointPath) {
          throw new Error('Local desktop actions require --endpoint or BILLME_DESKTOP_ENDPOINT.');
        }
        return invokeDesktopAction(options.product, normalized, input.endpointPath);
      }
      if (!serverClient) {
        throw new Error('Server actions require --base-url and a bearer token.');
      }
      const data = await invokeServerAction(serverClient, options.product, normalized, options.server?.token ?? null);
      return agentResultSchema.parse({
        requestId: randomUUID(),
        action: invocation.action,
        status: 'completed',
        data: parseAgentResult(options.product, invocation.action, data),
      });
    },
  };
};
