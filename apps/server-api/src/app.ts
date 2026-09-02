// Compatibility seam for existing server-api callers. The implementation lives
// in @billme/server-runtime so Electron and the hosted server can compose the
// same Fastify module without an app-to-app dependency.
export {
  buildServerApi,
  requireDatabase,
  requireMutationSession,
  requirePool,
  requireSession,
} from '@billme/server-runtime';
export type {
  BuildServerApiOptions,
  EmbeddedLocalAuthOptions,
} from '@billme/server-runtime';
