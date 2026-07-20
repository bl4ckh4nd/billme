import { z } from 'zod';
import {
  ipcRoutes as liteRoutes,
  type IpcRouteKey as LiteIpcRouteKey,
} from '@billme/desktop-contracts/contract';
import {
  ipcRoutes as proRoutes,
  type IpcRouteKey as ProIpcRouteKey,
} from '@billme/desktop-contracts-pro/contract';

export const agentProductSchema = z.enum(['lite', 'pro']);
export type AgentProduct = z.infer<typeof agentProductSchema>;

export const agentTargetSchema = z.enum(['server', 'desktop']);
export type AgentTarget = z.infer<typeof agentTargetSchema>;

export const agentActionKeySchema = z.string().trim().min(1).max(120);

export const agentInvocationSchema = z.object({
  action: agentActionKeySchema,
  args: z.unknown().optional(),
  reason: z.string().trim().min(1).optional(),
  confirm: z.boolean().optional().default(false),
});

export type AgentInvocation = z.infer<typeof agentInvocationSchema>;

export const agentActionSchema = z.object({
  action: agentActionKeySchema,
  product: agentProductSchema,
  targets: z.array(agentTargetSchema).min(1),
  requiresReason: z.boolean(),
  requiresConfirmation: z.boolean(),
  serverStatus: z.enum(['supported', 'unsupported']),
});

export type AgentAction = z.infer<typeof agentActionSchema>;

export const agentResultSchema = z.object({
  requestId: z.string().min(1),
  action: agentActionKeySchema,
  status: z.enum(['completed', 'queued']),
  data: z.unknown(),
  operationId: z.string().min(1).optional(),
});

export type AgentResult = z.infer<typeof agentResultSchema>;

export const agentErrorSchema = z.object({
  requestId: z.string().min(1).optional(),
  action: agentActionKeySchema.optional(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export type AgentError = z.infer<typeof agentErrorSchema>;

const excludedActions = new Set([
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:isMaximized',
  'shell:openPath',
  'shell:openExportsDir',
  'shell:openExternal',
  'dialog:pickCsv',
  'secrets:get',
  'secrets:set',
  'secrets:delete',
  'secrets:has',
  'updater:getStatus',
  'updater:downloadUpdate',
  'updater:quitAndInstall',
]);

const readOnlyActions = new Set([
  'invoices:list',
  'invoices:get',
  'offers:list',
  'offers:get',
  'clients:list',
  'clients:get',
  'projects:list',
  'projects:get',
  'articles:list',
  'accounts:list',
  'recurring:list',
  'recurring:get',
  'settings:get',
  'templates:list',
  'templates:active',
  'audit:verify',
  'audit:exportCsv',
  'pdf:export',
  'portal:health',
  'transactions:list',
  'dunning:getInvoiceStatus',
  'finance:listImportBatches',
  'finance:getImportBatchDetails',
  'finance:importPreview',
  'pro:listLedgerAccounts',
  'pro:listTaxCases',
  'pro:listTaxCaseAccountMappings',
  'pro:getLedgerStats',
  'pro:listBankTransactions',
  'pro:listAccountSuggestionRules',
  'pro:getDraftByTransactionId',
  'pro:listJournalEntries',
  'pro:getLedgerBalances',
  'pro:getSusaReport',
  'pro:getGuvReport',
  'pro:getBilanzReport',
  'pro:listDatevExports',
  'pro:getAccountingHealth',
  'pro:validateTaxCompliance',
  'pro:getVatSummary',
  'pro:listWorkflowEntries',
  'eur:getReport',
  'eur:listItems',
  'eur:listRules',
]);

const confirmationActions = new Set([
  'invoices:delete',
  'offers:delete',
  'clients:delete',
  'projects:archive',
  'articles:delete',
  'accounts:delete',
  'recurring:delete',
  'templates:delete',
  'numbers:release',
  'db:restore',
  'portal:publishOffer',
  'portal:publishInvoice',
  'portal:rotateCustomerAccessLink',
  'email:send',
  'transactions:link',
  'transactions:unlink',
  'dunning:manualRun',
  'recurring:manualRun',
  'finance:importCommit',
  'finance:rollbackImportBatch',
  'pro:importSkr',
  'pro:upsertTaxCaseAccountMapping',
  'pro:upsertAccountSuggestionRule',
  'pro:deleteAccountSuggestionRule',
  'pro:dispatchDraftAction',
  'pro:postDraft',
  'pro:reverseJournalEntry',
  'pro:exportDatevBuchungsstapel',
  'pro:upsertWorkflowEntry',
  'tax:auditExportPackage',
  'eur:upsertClassification',
  'eur:upsertRule',
  'eur:deleteRule',
]);

const serverSupportedActions = new Set([
  'clients:list',
  'clients:get',
  'clients:upsert',
  'clients:delete',
  'invoices:list',
  'invoices:get',
  'invoices:upsert',
  'invoices:delete',
  'offers:list',
  'offers:get',
  'offers:upsert',
  'offers:delete',
  'recurring:list',
  'recurring:get',
  'recurring:upsert',
  'recurring:delete',
  'settings:get',
  'settings:set',
  'numbers:reserve',
  'numbers:release',
  'numbers:finalize',
  'templates:list',
  'templates:active',
  'templates:upsert',
  'templates:setActive',
  'articles:list',
  'articles:upsert',
  'accounts:list',
  'accounts:upsert',
  'pro:listWorkflowEntries',
  'pro:upsertWorkflowEntry',
  'pro:listLedgerAccounts',
  'pro:getLedgerStats',
  'pro:listTaxCases',
  'pro:listTaxCaseAccountMappings',
  'pro:upsertTaxCaseAccountMapping',
  'pro:listAccountSuggestionRules',
  'pro:upsertAccountSuggestionRule',
  'pro:deleteAccountSuggestionRule',
]);

const serverProOnlyActions = new Set([
  'articles:list',
  'articles:upsert',
  'accounts:list',
  'accounts:upsert',
  'pro:listWorkflowEntries',
  'pro:upsertWorkflowEntry',
  'pro:listLedgerAccounts',
  'pro:getLedgerStats',
  'pro:listTaxCases',
  'pro:listTaxCaseAccountMappings',
  'pro:upsertTaxCaseAccountMapping',
  'pro:listAccountSuggestionRules',
  'pro:upsertAccountSuggestionRule',
  'pro:deleteAccountSuggestionRule',
]);

const reasonPayloadActions = new Set([
  'invoices:upsert',
  'offers:upsert',
  'projects:upsert',
]);

type RouteMap = Record<string, { args: z.ZodTypeAny; result: z.ZodTypeAny }>;

const getRoutes = (product: AgentProduct): RouteMap => product === 'pro' ? proRoutes : liteRoutes;

export const isAgentAction = (product: AgentProduct, action: string): boolean => {
  const routes = getRoutes(product);
  return action in routes && !excludedActions.has(action);
};

export const parseAgentArgs = (product: AgentProduct, action: string, args: unknown, reason?: string): unknown => {
  const routes = getRoutes(product);
  const route = routes[action];
  if (!route || !isAgentAction(product, action)) {
    throw new Error(`Unsupported agent action: ${product}:${action}`);
  }
  const normalizedArgs = reasonPayloadActions.has(action)
    && args && typeof args === 'object' && !Array.isArray(args)
    ? { ...(args as Record<string, unknown>), reason }
    : args;
  return route.args.parse(normalizedArgs);
};

export const parseAgentResult = (product: AgentProduct, action: string, result: unknown): unknown => {
  const routes = getRoutes(product);
  const route = routes[action];
  if (!route || !isAgentAction(product, action)) {
    throw new Error(`Unsupported agent action: ${product}:${action}`);
  }
  return route.result.parse(result);
};

export const getAgentActionCatalog = (product: AgentProduct): AgentAction[] => {
  const routes = getRoutes(product);
  return Object.keys(routes)
    .filter((action) => !excludedActions.has(action))
    .sort()
    .map((action) => {
      const serverSupported = serverSupportedActions.has(action)
        && (!serverProOnlyActions.has(action) || product === 'pro');
      return agentActionSchema.parse({
        action,
        product,
        targets: serverSupported ? ['server', 'desktop'] : ['desktop'],
        requiresReason: !readOnlyActions.has(action),
        requiresConfirmation: confirmationActions.has(action),
        serverStatus: serverSupported ? 'supported' : 'unsupported',
      });
    });
};

export const assertAgentInvocationAllowed = (
  product: AgentProduct,
  action: string,
  invocation: Pick<AgentInvocation, 'reason' | 'confirm'>,
): void => {
  const metadata = getAgentActionCatalog(product).find((entry) => entry.action === action);
  if (!metadata) {
    throw new Error(`Unsupported agent action: ${product}:${action}`);
  }
  if (metadata.requiresReason && !invocation.reason?.trim()) {
    throw new Error(`Agent action ${action} requires --reason.`);
  }
  if (metadata.requiresConfirmation && invocation.confirm !== true) {
    throw new Error(`Agent action ${action} requires --confirm.`);
  }
};

export type LiteRouteKey = LiteIpcRouteKey;
export type ProRouteKey = ProIpcRouteKey;
