FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable
RUN apk add --no-cache chromium poppler-utils tesseract-ocr tesseract-ocr-data-deu tesseract-ocr-data-eng

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts
RUN pnpm -C apps/server-worker build

WORKDIR /app/apps/server-worker

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node --input-type=module -e "if (!process.env.DATABASE_URL) process.exit(0); const { Client } = await import('pg'); const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); await client.query('select 1'); await client.end();"

CMD ["node", "--import", "tsx", "dist/worker.js"]
