# `@wdrg/e2e` — browser end-to-end suite

Playwright, driving the real Next.js and NestJS applications against an isolated
MongoDB. Nothing here is mocked.

## Why it is a separate package

Playwright pulls in a ~120 MB browser download and its own runner. Keeping it out
of `@wdrg/web` means the unit suite, the lint job and every other CI job install
none of that. It also gives the browser tests their own `tsconfig`, their own
lint scope and their own build of the web application.

## What Playwright starts

Three processes, all managed by `playwright.config.ts` and all shut down when the
run ends:

| Process                            | Port | Purpose                                                                                                                                                     |
| ---------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS API (`NODE_ENV=test`)       | 3211 | The API under test, from `apps/api/dist`.                                                                                                                   |
| NestJS API (`NODE_ENV=production`) | 3212 | Never loaded in a browser. It exists so the `Secure` cookie flag — which is on only in production — can be asserted against a server that actually sets it. |
| Next.js (`next start`)             | 3210 | A production build, from `.next-e2e`.                                                                                                                       |

The web application needs its own build because `NEXT_PUBLIC_*` values are
inlined at build time and this suite serves it against a different API origin.
That build writes to `.next-e2e` (via `NEXT_DIST_DIR`) so the ordinary
development build in `.next` is never overwritten.

Server output is piped through `tee` into `.artifacts/*.log`. That is not for
convenience: the suite asserts that a recovery secret never appears in an
application log, which requires the log to be readable from inside a test.

## Databases

`wdrg_e2e_browser` and `wdrg_e2e_browser_production`, distinct from the API
integration suite's `wdrg_e2e`. Global setup empties both collections rather than
dropping the databases — dropping would take the indexes with it, and the API
creates those once at startup.

Data is cleared on the way _in_, so a failed run leaves its database to inspect.

## Running it

Needs MongoDB. Point the suite at it with `MONGODB_HOST_PORT` (default `27017`):

```bash
pnpm install
pnpm --filter @wdrg/e2e exec playwright install --with-deps chromium   # once
pnpm build                                                             # apps + packages

export MONGODB_HOST_PORT=27117    # whatever your local MongoDB is on
pnpm --filter @wdrg/e2e test:e2e
```

`test:e2e` truncates the captured logs, builds the web application, then runs
Playwright. The log truncation cannot live in `globalSetup`, because Playwright
starts the web servers before that hook runs and would erase the run's own
startup output.

Useful during development:

```bash
pnpm --filter @wdrg/e2e test:e2e:ui                      # the Playwright UI
pnpm --filter @wdrg/e2e exec playwright test -g "cookie" # one scenario
pnpm --filter @wdrg/e2e exec playwright show-report .artifacts/report
```

## What each spec covers

| Spec                    | Covers                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journey.spec.ts`       | The full lifecycle: create, verify the identifier is not an ObjectId, confirm the secret is confined to the fragment, configure all five sections, refresh, recover in a clean browser, end the session, recover again, delete with the wrong and then the right confirmation, and confirm neither the session nor the link works afterwards. Plus expiry, aged with a database fixture. |
| `cookies.spec.ts`       | `HttpOnly`, `SameSite`, `Secure` in production, scope, clearance on session end and on deletion, and that a cookie-less context reaches nothing.                                                                                                                                                                                                                                         |
| `responsive.spec.ts`    | The workflow at 390×844, 768×1024 and 1440×900: no horizontal overflow, everything inside the viewport, nothing covered, focus indicators visible, the dialog inside the screen.                                                                                                                                                                                                         |
| `accessibility.spec.ts` | axe at WCAG 2.2 AA over creation, the workspace, the recovery flow and the delete dialog, at desktop and mobile.                                                                                                                                                                                                                                                                         |

## Conventions

- **Locators are roles and accessible names.** A selector only a test can follow
  keeps passing after the UI becomes unusable, which is the opposite of the point.
- **The API is never mocked.** A suite that stubs the server can only prove the
  client is self-consistent.
- **Serial, one worker.** Several assertions concern process-wide state — the
  application log, a context's cookies — which concurrency would make depend on
  whatever another test happened to be doing.
- **Fixed test data.** "The recovered project matches what was saved" is a
  comparison against a literal, not against whatever the test produced earlier.
