# The web application, as a deployable image.
#
# Same shape as the API image and the same reasoning: multi-stage, base pinned by digest,
# non-root at runtime, no toolchain in the shipped layer.
#
# ## The build-time argument that catches people
#
# `NEXT_PUBLIC_API_BASE_URL` is **inlined into the client bundle at build time**. It is
# not read from the environment when the container starts, so an image built for one
# deployment cannot be pointed at another API by setting a variable — the browser would
# keep calling the old host. That is a property of how Next.js handles `NEXT_PUBLIC_*`,
# not a choice made here, and it is the single most likely way a deployment of this image
# goes wrong.
#
# So it is an explicit `ARG` with no default. A build that forgets it produces a bundle
# calling a relative path, which fails in a way nobody diagnoses quickly; failing the
# build instead is cheaper. `docs/operations/deployment.md` states the consequence: one
# image per API origin.

# ---------------------------------------------------------------- dependencies
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS deps

WORKDIR /repo

RUN corepack enable pnpm

# Every workspace project's manifest — see the note in api.Dockerfile: a missing one
# reads to `--frozen-lockfile` as a project that was removed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/e2e/package.json apps/e2e/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/testing/package.json packages/testing/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json packages/ui/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------- build
FROM deps AS build

WORKDIR /repo

ARG NEXT_PUBLIC_API_BASE_URL
RUN test -n "$NEXT_PUBLIC_API_BASE_URL" || \
    (echo "NEXT_PUBLIC_API_BASE_URL must be supplied: it is inlined into the client bundle." && exit 1)

ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_TELEMETRY_DISABLED=1

COPY turbo.json ./
COPY packages packages
COPY apps/web apps/web

RUN pnpm --filter @wdrg/config build && \
    pnpm --filter @wdrg/contracts build && \
    pnpm --filter @wdrg/web build

# -------------------------------------------------------------------- runtime
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The package manager, removed — see the same step in api.Dockerfile for why. The
# standalone server installs nothing; the only thing npm could do in this image is fetch
# and run code that was not in the build.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*

WORKDIR /app

# Next's standalone output: the server, its traced dependencies and nothing else. Copied
# with explicit ownership so a non-root process can read it and cannot write to it.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

# No `public` copy: this application has no `apps/web/public` directory. Every asset it
# serves is imported through the bundler, so there is nothing to copy — and a COPY of a
# path that does not exist fails the build rather than being skipped.

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The base image's entrypoint wrapper is discarded — see the note in api.Dockerfile.
ENTRYPOINT []

# The standalone server, at the path the monorepo layout puts it.
CMD ["node", "apps/web/server.js"]
