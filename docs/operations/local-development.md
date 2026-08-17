# Local development

## Prerequisites

| Tool    | Version         | Notes                                                 |
| ------- | --------------- | ----------------------------------------------------- |
| Node.js | 24+             | `.nvmrc` pins 24, CI uses 24, the images ship 24      |
| pnpm    | 11+             | `corepack enable pnpm`                                |
| Docker  | with Compose v2 | For MongoDB. Optional if you already run one locally. |

## First run

```bash
corepack enable pnpm       # if pnpm is not already on PATH
pnpm install
cp .env.example .env       # defaults work as-is for local development
pnpm docker:up             # starts MongoDB on 127.0.0.1:27017
pnpm dev                   # web on :3000, api on :3001
```

Check it came up:

```bash
curl -s http://localhost:3001/api/health/ready | jq
open http://localhost:3000        # the workspace
open http://localhost:3001/api/docs   # OpenAPI UI
```

The workspace header shows an API status badge. If it reads "API unreachable",
the web app is up but cannot reach the API — check `NEXT_PUBLIC_API_BASE_URL`.

## Everyday commands

| Command                                          | Does                                              |
| ------------------------------------------------ | ------------------------------------------------- |
| `pnpm dev`                                       | Both apps in watch mode                           |
| `pnpm --filter @wdrg/api dev`                    | API only                                          |
| `pnpm --filter @wdrg/web dev`                    | Web only                                          |
| `pnpm test`                                      | Unit + component tests. No infrastructure needed. |
| `pnpm test:e2e`                                  | API integration tests. **Requires MongoDB.**      |
| `pnpm test:browser`                              | Browser E2E. **Requires MongoDB + Chromium.**     |
| `node test/fixtures/generate-fixtures.mjs`       | Rebuilds the binary test fixtures (from apps/api) |
| `pnpm lint` / `pnpm lint:fix`                    | ESLint, zero warnings tolerated                   |
| `pnpm typecheck`                                 | `tsc --noEmit` across every package               |
| `pnpm format` / `pnpm format:check`              | Prettier                                          |
| `pnpm build`                                     | Production builds                                 |
| `pnpm verify`                                    | Every gate, in CI order                           |
| `pnpm docker:up` / `docker:down` / `docker:logs` | Local MongoDB                                     |

Run `pnpm verify` before pushing. It covers formatting, lint, typecheck, unit
tests and the production build. The two suites that need infrastructure —
`pnpm test:e2e` and `pnpm test:browser` — are deliberately separate, and CI runs
all of them.

### Text recognition (OCR)

Requirement images and scanned PDFs are read with Tesseract, which is a system
package rather than an npm dependency:

```bash
sudo apt-get install tesseract-ocr tesseract-ocr-eng   # Debian / Ubuntu
brew install tesseract                                  # macOS
```

Without it, image sources fail with a clear message rather than returning empty
content. To run deliberately without OCR, set `OCR_ENABLED=false` — image
uploads are then refused, and everything else works.

Extra languages need their own trained data (`tesseract-ocr-deu`, …) and go in
`OCR_LANGUAGES` as `eng+deu`.

### Legacy .doc and .xls

Off by default. Enabling it needs headless LibreOffice:

```bash
sudo apt-get install libreoffice-writer libreoffice-calc
export LEGACY_CONVERSION_ENABLED=true
```

While it is off, `.doc` and `.xls` uploads are refused with a message asking for
`.docx` or `.xlsx`. See [ADR-0015](../adr/0015-legacy-file-strategy.md).

### Uploaded files

Stored under `UPLOAD_STORAGE_ROOT` (`./storage/uploads` by default), which is
gitignored and never web-served. Removing that directory is safe — the source
records remain, and their extraction is already in MongoDB — but the original
files are then gone and cannot be downloaded again.

### Browser end-to-end tests

One-time setup, then a run:

```bash
pnpm --filter @wdrg/e2e exec playwright install --with-deps chromium
pnpm build

# Point the suite at your MongoDB. Default is 27017; the docker-compose stack
# uses whatever MONGODB_HOST_PORT you set.
export MONGODB_HOST_PORT=27017
pnpm test:browser
```

Playwright starts the API, a second API in production mode (for the `Secure`
cookie assertion) and a production build of the web application on ports
3210–3212, then shuts them all down. It uses its own databases
(`wdrg_e2e_browser*`) and its own Next.js build directory (`.next-e2e`), so it
touches neither your development data nor your development build.

When something fails, everything you need is under `apps/e2e/.artifacts/`:
captured server logs, a trace, a screenshot, a video and an HTML report. Open the
report with:

```bash
pnpm --filter @wdrg/e2e exec playwright show-report .artifacts/report
```

The browser download is an explicit step because pnpm blocks dependency lifecycle
scripts by policy — see `pnpm-workspace.yaml`. Installing dependencies will not
silently fetch 120 MB of browser.

Optional: `pnpm turbo telemetry disable` — Turborepo collects anonymous usage
telemetry by default. CI sets `TURBO_TELEMETRY_DISABLED=1`.

## Environment variables

Every variable is documented in `.env.example` with a safe default. They are
validated at startup: a missing or malformed value fails the process immediately
and lists **every** problem, so one restart fixes the whole deployment.

```
Invalid environment configuration (2 problems):
  - MONGODB_URI: Must start with mongodb:// or mongodb+srv://
  - API_PORT: Too big: expected number to be <=65535

See .env.example for the full list of supported variables.
```

`.env` is git-ignored. Never commit real credentials; `.env.example` must stay
free of secrets.

## Troubleshooting

**`pnpm install` reports ignored build scripts.**
pnpm blocks dependency lifecycle scripts by default. Approved packages are listed
in `pnpm-workspace.yaml` under `allowBuilds`. If a new dependency legitimately
needs one, add it there with a comment explaining why — do not blanket-allow.

**A document refuses to approve and the blocker mentions coverage or assumptions.**
Working as designed, and the message says what to do. The three most common:

- _"N approved items have no acceptance criterion"_ — write one for each, or record
  that it is deliberately not covered and why. A gap has to be a decision.
- _"N suggested assumptions are waiting for a decision"_ — confirm the ones you stand
  behind and reject the rest. A suggestion never becomes an assumption on its own.
- _"This document describes something as included that the approved scope excludes"_ —
  the brief says something is out of scope while the estimate priced it. Decide which
  is right upstream; a commercial document must not claim both.

**A Statement of Work says "the duration set out in the approved estimate" instead of
a number of weeks.**
No team has been supplied, so Phase 6 produced hours and no schedule. The document is
stating the strongest thing the evidence supports. Supply a team through
`PUT /projects/current/estimation/team` and regenerate; there is no interface for it
yet.

**An Assumptions document is empty.**
Also working as designed. Nothing becomes an assumption unless somebody put it there —
see [ADR-0036](../adr/0036-assumption-provenance.md). Ask for candidates if you want
suggestions to work from.

**API exits at startup with "Invalid environment configuration".**
Working as designed. Fix the listed variables. `cp .env.example .env` gives a
working local set.

**Readiness returns 503 with `mongodb: down`.**
MongoDB is not reachable. `pnpm docker:up`, then
`docker compose -f infrastructure/docker/docker-compose.yml ps` to confirm it is
healthy. Command buffering is deliberately off, so an unreachable database fails
fast instead of queueing requests.

**Port 27017 already in use.**
Another MongoDB is running. Set a different host port instead of stopping it —
the container port stays 27017, so only your `.env` changes:

```bash
MONGODB_HOST_PORT=27117
MONGODB_URI=mongodb://localhost:27117/wdrg
```

`infrastructure/scripts/compose.sh` validates the value (numeric, 1024-65535)
before starting anything, so a typo fails with a clear message instead of a
confusing bind error.

To run a throwaway stack alongside your working one, also set
`COMPOSE_PROJECT_NAME` — containers and the data volume are namespaced by it, so
`docker compose down --volumes` on the throwaway stack cannot delete your data:

```bash
MONGODB_HOST_PORT=27117 COMPOSE_PROJECT_NAME=wdrg-scratch pnpm docker:up
```

**Docker fails with `docker-credential-desktop: executable file not found`.**
A stale credential helper in `~/.docker/config.json`. Either remove the
`credsStore` entry, or run the command with an isolated config:
`DOCKER_CONFIG=$(mktemp -d) pnpm docker:up`.

**Web shows "API unreachable" but the API is up.**
CORS or base URL. `CORS_ALLOWED_ORIGINS` must include the web origin, and
`NEXT_PUBLIC_API_BASE_URL` must point at the API. `NEXT_PUBLIC_*` values are
inlined at build time — restart `pnpm dev` after changing them.

**Types from a shared package look stale.**
`packages/contracts`, `config` and `testing` compile to `dist/`. Run
`pnpm build --filter='./packages/*'`, or use `pnpm dev`, which builds
dependencies first.

**Turbo returns a cached result you did not expect.**
`pnpm build --force` bypasses the cache; `pnpm clean` clears build output.

## Inspecting the database

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile tools up -d
open http://localhost:8081     # mongo-express
```

Bound to localhost only, and off unless the `tools` profile is requested.
