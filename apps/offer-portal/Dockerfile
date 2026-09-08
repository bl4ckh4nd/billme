FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN apk add --no-cache --virtual .better-sqlite3-build-deps python3 make g++ \
  && pnpm install --frozen-lockfile --prod=false --ignore-scripts \
  && cd apps/offer-portal \
  && SQLITE_PACKAGE_DIR="$(dirname "$(readlink -f node_modules/better-sqlite3/package.json)")" \
  && npm --prefix "$SQLITE_PACKAGE_DIR" run build-release \
  && node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); const row = db.prepare('select 1 as ok').get(); if (row.ok !== 1) process.exit(1); db.close();" \
  && cd /app \
  && apk del .better-sqlite3-build-deps
RUN pnpm -C apps/offer-portal build
WORKDIR /app/apps/offer-portal
RUN mkdir -p /app/data /app/storage
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:3001/health'); if(!r.ok) process.exit(1)"
CMD ["node", "--import", "tsx", "dist/node.js"]
