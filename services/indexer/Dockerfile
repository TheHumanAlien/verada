# Build context: repository root (the indexer consumes the workspace SDK).
#   docker build -f services/indexer/Dockerfile .
FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.0.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/endaoment-client/package.json packages/endaoment-client/package.json
COPY packages/cause-catalog/package.json packages/cause-catalog/package.json
COPY services/indexer/package.json services/indexer/package.json
RUN pnpm install --prod --frozen-lockfile --filter @verada/indexer...

FROM node:22-slim AS runtime
ENV NODE_ENV=production PONDER_TELEMETRY_DISABLED=true PORT=42069 DATABASE_SCHEMA=verada
WORKDIR /app
RUN chown node:node /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=deps --chown=node:node /app/packages/endaoment-client/node_modules ./packages/endaoment-client/node_modules
COPY --from=deps --chown=node:node /app/packages/cause-catalog/node_modules ./packages/cause-catalog/node_modules
COPY --from=deps --chown=node:node /app/services/indexer/node_modules ./services/indexer/node_modules
COPY --chown=node:node packages/sdk/package.json ./packages/sdk/package.json
COPY --chown=node:node packages/sdk/src ./packages/sdk/src
COPY --chown=node:node packages/endaoment-client/package.json ./packages/endaoment-client/package.json
COPY --chown=node:node packages/endaoment-client/src ./packages/endaoment-client/src
COPY --chown=node:node packages/cause-catalog/package.json ./packages/cause-catalog/package.json
COPY --chown=node:node packages/cause-catalog/src ./packages/cause-catalog/src
WORKDIR /app/services/indexer
COPY --chown=node:node services/indexer/package.json services/indexer/ponder.config.ts services/indexer/ponder.schema.ts services/indexer/ponder-env.d.ts ./
COPY --chown=node:node services/indexer/src ./src
USER node
EXPOSE 42069
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||42069)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/ponder", "start"]
