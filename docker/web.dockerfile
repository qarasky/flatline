# Flatline's web app: the Next.js standalone server (operator UI, Superboard,
# status pages). Built from the repository root, because the app imports
# packages/shared:
#
#   docker build -f docker/web.dockerfile \
#       --build-arg FLATLINE_BUILD_ID=$(git rev-parse --short HEAD) \
#       -t artchsh/flatline-web:office-live .
#
# FLATLINE_BUILD_ID is the build id open tabs compare against `/build` to
# notice a deploy; without it the build time is used.

FROM node:26-trixie-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm --prefix apps/web ci --no-audit --no-fund
COPY apps/web apps/web
# The /api and /agent rewrites in next.config.ts are baked at build time;
# behind Caddy they are never reached, but they should point at the backend.
ARG API_URL=http://flatline:3001
ARG FLATLINE_BUILD_ID=
ENV API_URL=${API_URL} FLATLINE_BUILD_ID=${FLATLINE_BUILD_ID}
RUN npm --prefix apps/web run build

FROM node:26-trixie-slim AS release
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    API_URL=http://flatline:3001
# The standalone output traces from the repository root, so the server sits
# at apps/web/server.js. Files stay root-owned: read-only for the app user.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/build').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
