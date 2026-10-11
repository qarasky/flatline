# Flatline public status site (Next.js).
#
# Server rendering reads FLATLINE_URL at request time, so the backend can
# move without rebuilding. NEXT_PUBLIC_FLATLINE_URL is different: Next
# inlines it into the browser bundle at build time (the unlock form posts
# cross-origin to the backend), so bake it via --build-arg when the public
# backend origin is not the default below.
ARG NEXT_PUBLIC_FLATLINE_URL=http://127.0.0.1:3001

FROM node:26-trixie-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
COPY apps/status-site/package.json apps/status-site/package.json
COPY apps/status-site/package-lock.json apps/status-site/package-lock.json
COPY apps/status-site/next.config.mjs apps/status-site/next.config.mjs
COPY apps/status-site/tsconfig.json apps/status-site/tsconfig.json
COPY apps/status-site/app apps/status-site/app
COPY apps/status-site/public apps/status-site/public

WORKDIR /app/apps/status-site
RUN npm ci --no-audit --no-fund

ARG NEXT_PUBLIC_FLATLINE_URL
ENV NEXT_PUBLIC_FLATLINE_URL=${NEXT_PUBLIC_FLATLINE_URL}
RUN npm run build

FROM node:26-trixie-slim AS runtime
WORKDIR /app/apps/status-site
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY apps/status-site/package.json ./package.json
COPY apps/status-site/package-lock.json ./package-lock.json
COPY packages/shared/package.json ../../packages/shared/package.json
COPY packages/shared/src ../../packages/shared/src
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/apps/status-site/.next ./.next
COPY --from=build /app/apps/status-site/public ./public
COPY --from=build /app/apps/status-site/next.config.mjs ./next.config.mjs

# Server-side requests default to the compose service name; override per
# deploy. The browser side was baked with NEXT_PUBLIC_FLATLINE_URL.
ENV FLATLINE_URL=http://flatline:3001
ENV PORT=3002
EXPOSE 3002
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3002/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npx", "next", "start", "--hostname", "0.0.0.0", "--port", "3002"]
