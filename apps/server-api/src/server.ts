import { z } from 'zod';
import { buildServerApi } from '@billme/server-runtime';

const envSchema = z.object({
  PORT: z.coerce.number().default(3100),
  HOST: z.string().default('127.0.0.1'),
});

const env = envSchema.parse(process.env);

const app = await buildServerApi();

await app.listen({
  port: env.PORT,
  host: env.HOST,
});
