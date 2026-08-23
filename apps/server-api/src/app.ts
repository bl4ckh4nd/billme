// Compatibility seam for existing server-api callers. The implementation lives
// in @billme/server-runtime so the hosted server composes the shared Fastify module.
export {
  buildServerApi,
  requireMutationSession,
  requirePool,
  requireSession,
} from '@billme/server-runtime';
