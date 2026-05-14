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

FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=80
ENV NGINX_ENVSUBST_FILTER=^PORT$
EXPOSE 80
