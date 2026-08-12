import { z } from 'zod';

export const taxFilingKindSchema = z.enum(['euer', 'e_bilanz', 'unternehmensregister']);
export const taxFilingRecordSchema = z.object({
  id: z.string().min(1),
  kind: taxFilingKindSchema,
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['frozen', 'approved', 'queued']),
});
export const taxFilingSnapshotSchema = z.object({
  id: z.string().min(1),
  kind: taxFilingKindSchema,
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  payload: z.record(z.unknown()),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['frozen', 'approved', 'queued']),
});
const operationInput = z.object({ record: taxFilingRecordSchema });
const provider = z.object({
  available: z.boolean(),
  provider: z.literal('eric').nullable(),
  version: z.string().optional(),
  binaryPath: z.string().optional(),
  errorCode: z.enum(['PROVIDER_UNAVAILABLE', 'PROVIDER_INVALID']).optional(),
});
const issue = z.object({ code: z.string(), message: z.string(), field: z.string().optional() });
const operationResult = (operation: 'validate' | 'export' | 'submit') => z.object({
  operation: z.literal(operation),
  status: z.enum(['validated', 'exported', 'submitted', 'failed']),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputPath: z.string().optional(),
  issues: z.array(issue),
});

export const taxFilingRoutes = {
  'taxFiling:getStatus': {
    channel: 'taxFiling:getStatus', args: z.undefined(),
    result: z.object({ provider, certificates: z.array(z.object({ id: z.string(), fingerprint: z.string(), expiresAt: z.string(), subject: z.string().optional() })) }),
  },
  'taxFiling:listRecords': {
    channel: 'taxFiling:listRecords', args: z.undefined(),
    result: z.array(taxFilingRecordSchema),
  },
  'taxFiling:installCertificate': {
    channel: 'taxFiling:installCertificate', args: z.object({ id: z.string().min(1), pem: z.string().min(1), password: z.string().optional(), expiresAt: z.string().datetime(), subject: z.string().optional() }),
    result: z.object({ id: z.string(), fingerprint: z.string(), expiresAt: z.string(), subject: z.string().optional() }),
  },
  'taxFiling:removeCertificate': { channel: 'taxFiling:removeCertificate', args: z.object({ id: z.string().min(1) }), result: z.boolean() },
  'taxFiling:validate': { channel: 'taxFiling:validate', args: operationInput, result: operationResult('validate') },
  'taxFiling:export': { channel: 'taxFiling:export', args: operationInput, result: operationResult('export') },
  'taxFiling:submit': { channel: 'taxFiling:submit', args: operationInput, result: operationResult('submit') },
} as const;
