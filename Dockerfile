# OpenCord server image (linux/amd64 and linux/arm64).
#   docker compose up -d                      (see docker-compose.yml)
#   docker build -t opencord-server .

# 1. Bundle the server and build the web app.
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/client packages/client
# The client's build tooling is only needed for the web app; skip the Electron binary.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --workspace @opencord/server --workspace @opencord/client --include-workspace-root=false
RUN cd packages/server && node build.mjs
RUN cd packages/client && npx electron-vite build

# 2. Install only the native runtime dependencies, for the image's own architecture.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv make g++ && rm -rf /var/lib/apt/lists/*
COPY packages/server/package.json /tmp/server-package.json
RUN node -e " \
  const p = require('/tmp/server-package.json'); \
  const pick = ['better-sqlite3', '@node-rs/argon2', 'mediasoup']; \
  const deps = Object.fromEntries(pick.map((k) => [k, p.dependencies[k]])); \
  require('fs').writeFileSync('package.json', JSON.stringify({ name: 'opencord-server', private: true, type: 'module', dependencies: deps }));" \
  && npm install --omit=dev --no-audit --no-fund --loglevel=error

# 3. Runtime.
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/jas0xA/opencord" \
      org.opencontainers.image.description="OpenCord server: self-hosted chat with a web app and the global OpenCord network" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /app
# OPENCORD_DOCKER makes the Server Admin page show Docker update steps.
# The media port range is kept small so it's practical to publish (match it in docker-compose.yml).
ENV NODE_ENV=production \
    OPENCORD_CONFIG=/data/config.toml \
    OPENCORD_DOCKER=1 \
    OPENCORD_RTC_MIN_PORT=40000 \
    OPENCORD_RTC_MAX_PORT=40100 \
    OPENCORD_HTTP_PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /src/packages/server/dist/opencord-server.mjs ./
COPY --from=build /src/packages/client/out/renderer ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# HTTP(S)/gateway/web app; 8080 answers certificate checks and redirects to HTTPS when
# OPENCORD_TLS_AUTO is on (map host port 80 to it); plus the SFU media ports.
EXPOSE 8443 8080 40000-40100/udp 40000-40100/tcp
# Plain HTTP, or HTTPS with automatic certificates (issued for the public address, not 127.0.0.1).
# The start period covers getting the first certificate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "const t = /^(1|true|yes|on)$/i.test(process.env.OPENCORD_TLS_AUTO || ''); require(t ? 'https' : 'http').get({ host: '127.0.0.1', port: process.env.OPENCORD_PORT || 8443, path: '/api/v1/instance', rejectUnauthorized: false, timeout: 4000 }, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
ENTRYPOINT ["node", "/app/opencord-server.mjs"]
CMD ["start"]
