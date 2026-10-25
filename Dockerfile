# OpenCord server image
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/client packages/client
# Server deps, plus the client's build tooling for the web app (no Electron binary needed).
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --workspace @opencord/server --workspace @opencord/client --include-workspace-root=false
RUN cd packages/server && node build.mjs
RUN cd packages/client && npx electron-vite build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production OPENCORD_CONFIG=/data/config.toml
COPY --from=build /src/packages/server/dist/opencord-server.mjs ./
COPY --from=build /src/packages/client/out/renderer ./web
COPY --from=build /src/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /src/node_modules/bindings ./node_modules/bindings
COPY --from=build /src/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=build /src/node_modules/@node-rs ./node_modules/@node-rs
COPY --from=build /src/node_modules/mediasoup ./node_modules/mediasoup
COPY --from=build /src/node_modules/debug ./node_modules/debug
COPY --from=build /src/node_modules/ms ./node_modules/ms
COPY --from=build /src/node_modules/flatbuffers ./node_modules/flatbuffers
COPY --from=build /src/node_modules/h264-profile-level-id ./node_modules/h264-profile-level-id
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# HTTP/gateway port, plus the SFU (mediasoup) UDP/TCP media port range (see [sfu] in config.toml).
EXPOSE 8443 40000-49999/udp 40000-49999/tcp
ENTRYPOINT ["node", "/app/opencord-server.mjs"]
CMD ["start"]
