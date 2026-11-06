# The mesh hub as an OCI image (M4.6). Several replicas run on one Postgres; one replica can also run
# on a SQLite file in a volume. Build: docker build -t mesh-hub .
#
# Configuration (see docs/guide/operations.md and src/hub/config.ts):
#   MESH_HUB_CONFIG  path of mesh-hub.yaml (default /etc/mesh/mesh-hub.yaml; mount it there)
#   MESH_HUB_DB      postgres://… URL, or a SQLite file such as /data/mesh-hub.db (overrides db:)
#   MESH_HUB_URL     the public URL people and OIDC redirects use (overrides url:)
#   MESH_HUB_LISTEN  host:port to listen on (default here 0.0.0.0:7700)
#   plus the variable each OIDC provider names in client_secret_env.

ARG NODE_IMAGE=node:24-slim
ARG PNPM_VERSION=12.16.1

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /src
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    MESH_HUB_CONFIG=/etc/mesh/mesh-hub.yaml \
    MESH_HUB_LISTEN=0.0.0.0:7700
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json LICENSE.md NOTICE ./
# /data holds the SQLite file when there is no Postgres (one replica only).
RUN mkdir -p /data /etc/mesh && chown 1000:1000 /data
# The image's "node" user, by number so Kubernetes can check runAsNonRoot.
USER 1000:1000
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.MESH_HUB_LISTEN.split(':').pop()+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/main.mjs"]
CMD ["hub"]
