# Builds the web dashboard and the API into one image. The API serves the dashboard (same origin).
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /src/backend
COPY backend/package.json backend/package-lock.json backend/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
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
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
