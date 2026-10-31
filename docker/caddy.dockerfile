# Flatline's Caddy: the stock image with docker/Caddyfile baked in, so the
# compose files work from any directory and a source-tree swap on the host
# cannot leave a running container on a stale bind mount.
#
#   docker build -f docker/caddy.dockerfile -t artchsh/flatline-caddy:office-live .
FROM caddy:2.11-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
