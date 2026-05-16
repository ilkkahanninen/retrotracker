# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS build
WORKDIR /app
# .dockerignore strips .git, so scripts/version.sh can't compute the
# version inside the container. CI computes it on the host and passes
# it through here; vite.config.ts reads APP_VERSION from env and falls
# back to "dev" only if neither this arg nor the script is available.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production image is Node serving both the SPA and the optional /api
# backend. The backend is gated by RETROTRACKER_BACKEND at runtime —
# when unset (default), only static files are served, so the CI-built
# image stays inert for the public deploy.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package.json ./package.json
# Install only runtime deps (hono) — esbuild marked them external in the
# bundle, so node needs them present in node_modules at start.
COPY --from=build /app/package-lock.json ./package-lock.json
RUN npm ci --omit=dev && npm cache clean --force
ENV PORT=80
EXPOSE 80
CMD ["node", "dist-server/index.mjs"]
