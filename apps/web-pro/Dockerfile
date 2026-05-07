FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts
RUN pnpm -C apps/web-pro build

FROM nginx:1.27-alpine

COPY docker/nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY docker/runtime-config.js.template /usr/share/nginx/html/runtime-config.js.template
COPY docker/nginx-runtime-config.sh /docker-entrypoint.d/99-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/99-runtime-config.sh
COPY --from=build /app/apps/web-pro/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O- http://127.0.0.1:8080/health >/dev/null || exit 1
