# Build context: repository root (the publisher consumes the workspace SDK and Arkiv registry).
#   docker build -f services/publisher/Dockerfile .
FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.0.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/arkiv-registry/package.json packages/arkiv-registry/package.json
COPY services/publisher/package.json services/publisher/package.json
RUN pnpm install --prod --frozen-lockfile --filter @verada/publisher...

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=42070
WORKDIR /app
RUN chown node:node /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=deps --chown=node:node /app/packages/arkiv-registry/node_modules ./packages/arkiv-registry/node_modules
COPY --from=deps --chown=node:node /app/services/publisher/node_modules ./services/publisher/node_modules
COPY --chown=node:node packages/sdk/package.json ./packages/sdk/package.json
COPY --chown=node:node packages/sdk/src ./packages/sdk/src
COPY --chown=node:node packages/arkiv-registry/package.json ./packages/arkiv-registry/package.json
COPY --chown=node:node packages/arkiv-registry/src ./packages/arkiv-registry/src
WORKDIR /app/services/publisher
COPY --chown=node:node services/publisher/package.json services/publisher/tsconfig.json ./
COPY --chown=node:node services/publisher/src ./src
COPY --chown=node:node tsconfig.base.json /app/tsconfig.base.json
USER node
EXPOSE 42070
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||42070)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
