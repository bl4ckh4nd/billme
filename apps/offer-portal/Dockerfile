FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts
RUN pnpm -C apps/offer-portal build
WORKDIR /app/apps/offer-portal
RUN mkdir -p /app/data /app/storage
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:3001/health'); if(!r.ok) process.exit(1)"
CMD ["node", "--import", "tsx", "dist/node.js"]
