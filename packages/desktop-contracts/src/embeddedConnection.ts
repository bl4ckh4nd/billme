import { z } from 'zod';

/** Private Electron-only handshake; deliberately not part of BillmeApi/ipcRoutes. */
export const embeddedConnectionSchema = z
  .object({
    baseUrl: z.string().url(),
    token: z.string().min(1),
  })
  .strict();

export const embeddedConnectionResultSchema = embeddedConnectionSchema.nullable();

export type EmbeddedConnection = z.output<typeof embeddedConnectionSchema>;
export type EmbeddedConnectionResult = z.output<typeof embeddedConnectionResultSchema>;

export const EMBEDDED_CONNECTION_CHANNEL = 'embedded:connection';
