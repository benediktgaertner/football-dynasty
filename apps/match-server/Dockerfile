# Build-Kontext ist das Repo-Wurzelverzeichnis:
#   docker build -f apps/match-server/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/match-server/package.json apps/match-server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @fd/shared --workspace @fd/engine --workspace @fd/match-server --include-workspace-root
COPY packages/shared packages/shared
COPY packages/engine packages/engine
COPY apps/match-server apps/match-server
RUN npm run build -w @fd/shared && npm run build -w @fd/engine && npm run build -w @fd/match-server \
 && npm prune --omit=dev --workspace @fd/shared --workspace @fd/engine --workspace @fd/match-server

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/shared/package.json packages/shared/package.json
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/engine/package.json packages/engine/package.json
COPY --from=build /repo/packages/engine/dist packages/engine/dist
COPY --from=build /repo/apps/match-server/package.json apps/match-server/package.json
COPY --from=build /repo/apps/match-server/dist apps/match-server/dist
USER node
EXPOSE 2567
CMD ["node", "apps/match-server/dist/index.js"]
