# The API, as a deployable image.
#
# Multi-stage, so the shipped layer holds compiled output, production dependencies and
# the one native binary the application actually shells out to — not the toolchain that
# produced it. A build image is roughly a gigabyte of compilers; a runtime image that
# includes them is a gigabyte of attack surface doing nothing.
#
# ## The base is pinned by digest
#
# `node:24-bookworm-slim` moves. A tag rebuild six months from now would silently take a
# different base, which is how a reproducible build stops being one — and how a
# vulnerability audit that passed on Tuesday describes a different image by Friday. The
# tag is kept alongside the digest for readability; the digest is what is resolved.
#
# ## Why Tesseract is here and LibreOffice is not
#
# OCR is not optional: scanned uploads run through the Tesseract binary, and an image
# without it degrades extraction silently rather than failing loudly. `.doc`/`.xls`
# conversion goes through LibreOffice, which is off by default and adds several hundred
# megabytes — so it is absent, and `docs/operations/deployment.md` says what to do if a
# deployment needs it. Shipping half a gigabyte for a disabled feature is the wrong
# default; hiding that the choice was made would be worse.

# ---------------------------------------------------------------- dependencies
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS deps

WORKDIR /repo

RUN corepack enable pnpm

# Manifests only, so this layer is cached until a dependency actually changes rather
# than on every source edit.
#
# Every workspace project, not just the ones this image needs: `--frozen-lockfile`
# compares the lockfile against the projects it can see, and a workspace member whose
# manifest is absent reads as one that was removed. Copying a subset makes the install
# fail — or, worse, resolve differently from the lockfile CI verified.
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

# The shared TypeScript configuration is a workspace package rather than a root
# `tsconfig.base.json`, so it arrives with `packages`.
COPY turbo.json ./
COPY packages packages
COPY apps/api apps/api

# The contracts package is a real build dependency of the API, not a path alias.
RUN pnpm --filter @wdrg/config build && \
    pnpm --filter @wdrg/contracts build && \
    pnpm --filter @wdrg/api build

# Production dependencies only, resolved into the layer that ships.
#
# `--legacy` because this workspace links workspace packages rather than injecting
# them (`nodeLinker: isolated`, no `inject-workspace-packages`), and pnpm 10 onwards
# refuses a non-injected deploy without it. The alternative — turning injection on
# repository-wide — would change how every developer's install materialises workspace
# dependencies in order to satisfy one build step, so the flag stays here instead.
#
# Only `node_modules` is taken from the result. The compiled output is copied straight
# from this stage below, because `deploy` selects a project's own files by packing
# rules and `dist/` is git-ignored — which would silently ship an image with no
# application in it.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm --filter @wdrg/api --prod --legacy deploy /runtime

# -------------------------------------------------------------------- runtime
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

# Tesseract, and nothing else. `--no-install-recommends` because the recommended set
# pulls in a documentation and font tree this image has no use for.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng && \
    rm -rf /var/lib/apt/lists/*

# npm and corepack, removed.
#
# The application starts with `node dist/main.js` and installs nothing at runtime, so a
# package manager in the shipped image is capability without purpose — and it is not
# free. A vulnerability scan of this image reported seven fixable HIGH/CRITICAL
# advisories, every one of them in a library bundled inside the base image's own npm
# (tar, undici, ip-address, brace-expansion) rather than in anything this application
# depends on. Deleting the package manager removes all seven, and removes the ability to
# fetch and execute new code inside a production container along with them.
#
# Kept in the build stages, obviously: that is where the install happens.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=3001

WORKDIR /app

# `node` exists in the base image with uid 1000 and owns nothing outside its home, which
# is what we want: the process cannot modify its own code. The storage root is created
# separately and owned by it, because the filesystem adapter writes there.
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json

RUN mkdir -p /var/lib/wdrg/uploads && chown -R node:node /var/lib/wdrg

ENV UPLOAD_STORAGE_ROOT=/var/lib/wdrg/uploads

USER node

EXPOSE 3001

# Readiness, not liveness: an orchestrator asking "may I send traffic" wants to know
# MongoDB answers and the scanner is reachable, which is exactly what this reports.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The base image's `docker-entrypoint.sh` is discarded. It ends in `exec "$@"`, so it
# does not actually get in the way of signal delivery — but it decides whether to prefix
# the command with `node` based on what it finds on PATH, and a start command that
# depends on that is a start command nobody can read off the Dockerfile.
ENTRYPOINT []

# Directly, with no shell and no init wrapper: Node is PID 1 and receives SIGTERM itself,
# which is what `app.enableShutdownHooks()` needs in order to finish in-flight work and
# stop the extraction and retention workers cleanly.
CMD ["node", "dist/main.js"]
