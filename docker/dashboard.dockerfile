# Flatline operator dashboard (Vite + React, static build behind nginx).
#
# The backend URL is baked by Vite at build time, which is wrong for a
# published image: the URL is only known where the container runs. So the
# build stamps a __FLATLINE_URL__ placeholder into the bundle and the
# entrypoint replaces it with $FLATLINE_URL on every start. Rebuild only when
# the app changes, reconfigure with an env var.
ARG FLATLINE_URL_PLACEHOLDER=__FLATLINE_URL__

FROM node:26-trixie-slim AS build
WORKDIR /app

# The dashboard depends on the shared package via `file:`, so both must be
# present before install.
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/dashboard/package-lock.json apps/dashboard/package-lock.json
COPY apps/dashboard/index.html apps/dashboard/index.html
COPY apps/dashboard/vite.config.ts apps/dashboard/vite.config.ts
COPY apps/dashboard/tsconfig.json apps/dashboard/tsconfig.json
COPY apps/dashboard/src apps/dashboard/src
COPY apps/dashboard/public apps/dashboard/public

WORKDIR /app/apps/dashboard
RUN npm ci --no-audit --no-fund

ARG FLATLINE_URL_PLACEHOLDER
RUN VITE_FLATLINE_URL=${FLATLINE_URL_PLACEHOLDER} npm run build

FROM nginx:1.27-alpine AS runtime

COPY docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
COPY docker/dashboard-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
