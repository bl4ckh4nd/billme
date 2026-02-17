import { createApp } from './app';
import { createMemoryOfferStore, createMemoryPdfStore } from './storage/memory';
import { createWorkerD1OfferStore, createWorkerR2PdfStore, type WorkerEnv } from './storage/workerD1';

type Env = WorkerEnv & {
  PUBLISH_API_KEY?: string;
  PUBLIC_BASE_URL?: string;
  REQUIRE_PUBLISH_API_KEY?: string;
};

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    const store = env.DB ? createWorkerD1OfferStore(env.DB) : createMemoryOfferStore();
    const pdf = env.PDF_BUCKET ? createWorkerR2PdfStore(env.PDF_BUCKET) : createMemoryPdfStore();
    const app = createApp({
      store,
      pdf,
      config: {
        publishApiKey: env.PUBLISH_API_KEY,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        requirePublishApiKey:
          typeof env.REQUIRE_PUBLISH_API_KEY === 'string'
            ? ['1', 'true', 'yes', 'on'].includes(env.REQUIRE_PUBLISH_API_KEY.toLowerCase())
            : false,
      },
    });
    return app.fetch(request, env, ctx);
  },
};
