# Root-level Dockerfile so hosts that look for ./Dockerfile (e.g. Render defaults) work without extra settings.
# Same build as milcsoguard/Dockerfile, with paths relative to the repository root.
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY milcsoguard/web/package.json milcsoguard/web/package-lock.json milcsoguard/web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY milcsoguard/web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /src/backend
COPY milcsoguard/backend/package.json milcsoguard/backend/package-lock.json milcsoguard/backend/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY milcsoguard/backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=api /src/backend/node_modules ./node_modules
COPY --from=api /src/backend/dist ./dist
COPY --from=api /src/backend/migrations ./migrations
COPY --from=api /src/backend/package.json ./package.json
COPY --from=web /src/web/dist ./web
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
