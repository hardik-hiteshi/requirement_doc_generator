# Releases

What a version number means here, what gets published, and the checklist that a test
enforces so nobody has to remember it.

## One version, four places

The version lives in `package.json` at the workspace root, in `apps/api/package.json`, in
`apps/web/package.json`, and as `API_SERVICE_VERSION` in `apps/api/src/app.constants.ts`.
All four must agree.

The constant exists rather than a read of `package.json` so the compiled bundle has no
filesystem dependency at runtime. The cost of that choice is drift: a release bumps the
manifest, nobody edits the constant, and every health payload and operator status view
then reports a version that has not existed for months — which is exactly when somebody is
asking "what is actually deployed".

`apps/api/src/app.constants.spec.ts` fails when they disagree. The constant's own comment
says it is "bumped as part of the release checklist"; that spec _is_ the checklist, in a
form that fails.

## Cutting a release

```bash
# 1. Bump all four by hand — three manifests and the constant. Then let the spec
#    tell you which one you missed.
pnpm --filter @wdrg/api test src/app.constants.spec.ts

# 2. The full gate.
pnpm verify            # format, lint, typecheck, unit tests, build
pnpm test:e2e          # API integration
pnpm test:browser      # browser end-to-end

# 3. Commit, push, and let hosted CI run every job — including the images job,
#    which builds both images, runs them, smoke tests them, scans them and
#    rehearses a restore.

# 4. Merge to main. The images job publishes from main and only from main.

# 5. Tag the merge commit.
git tag -a v0.2.0 -m 'Release 0.2.0'
git push origin v0.2.0
```

Tag only after main's CI is green on the merge commit. A tag that points at a commit whose
CI failed is worse than no tag: it is a claim.

## Phase tags and version tags

This repository carries both, and they answer different questions.

- **`phase-N-<name>`** — a development milestone, applied after main's CI is green for
  that phase's merge. It records that a body of work landed and was verified. These are
  the tags this repository has today.
- **`vX.Y.Z`** — a release. Same version as the four places above, and the only kind of tag
  that means "this is deployable".

A phase tag is not a release. Phase 14 is the phase that makes the application
deployable; it does not by itself declare version 1.0.

## What CI publishes

The `images` job in `.github/workflows/ci.yml` builds both images on **every** run —
including pull requests, because a Dockerfile that stopped building should fail the PR that
broke it rather than the merge. It publishes only from `main`.

Publishing happens after, and only after, every verification step in that job:

1. Both images build.
2. `verify-image.sh` inspects each artefact: non-root, `node` as PID 1 with no entrypoint
   wrapper, a healthcheck, no `.env`, no keys, no `.git`, no TypeScript sources, no package
   manager, no credential-shaped build-time variable, and — for the API — Tesseract, the
   compiled entry point, and workspace dependencies that resolved to real files rather than
   symlinks into a build stage that no longer exists.
3. Both images are started against a real MongoDB and a real ClamAV.
4. `smoke-test.sh` drives the running deployment: 51 checks, including a full
   authenticated project flow and the operator surface being absent when unconfigured.
5. A second API instance, configured with a token, has its operator boundary checked.
6. `restore-rehearsal.sh` destroys data in a throwaway database and recovers it.
7. Trivy scans both images.

The push is a `docker tag` and `docker push` of the images that were just verified, not a
second build. That distinction is the whole reason the job is shaped this way: a
build-and-push in one step publishes an artefact nothing has run.

### Registry and credentials

`ghcr.io/<owner>/wdrg-api` and `ghcr.io/<owner>/wdrg-web`, authenticated with the
`GITHUB_TOKEN` that GitHub issues to the job and rotates itself. There is **no registry
credential in this repository's secrets** — nothing to leak, nothing to rotate, and the
`packages: write` permission is scoped to the one job that needs it.

### Tags on a published image

| Tag         | Moves | Deploy from it                                             |
| ----------- | ----- | ---------------------------------------------------------- |
| `sha-<12>`  | Never | **Yes.** The only tag that identifies one build for ever   |
| `<version>` | Yes   | No — it points at whatever shipped last under that version |
| `main`      | Yes   | No — useful for "the current tip", not for a deployment    |

A deployment pinned to `main` silently changes underneath itself on the next merge. Pin to
`sha-`.

### The web image, and why it is not generically deployable

`NEXT_PUBLIC_API_BASE_URL` is inlined into the client bundle at build time, so a published
`wdrg-web` image only works for a deployment whose API is at the origin it was built with.
CI uses the repository variable `WEB_API_BASE_URL`, defaulting to a localhost origin —
which makes the published image useful for local evaluation and nothing else.

Set that variable to your own API origin, or build the web image yourself; it is one
command, and [deployment.md](deployment.md#the-web-image-is-built-for-one-api-origin) has
it. The `wdrg-api` image carries no such assumption.

## Node version

`engines.node` is `>=24.0.0`, `.nvmrc` says `24`, CI runs 24, and both images are built
`FROM node:24-bookworm-slim` pinned by digest. Those four are the same number on purpose:
a deployment must not run a major version nothing was tested on.

The base is pinned by **digest** because the tag moves. A tag rebuild six months from now
would silently take a different base, which is how a reproducible build stops being one —
and how a vulnerability audit that passed on Tuesday describes a different image by Friday.
Updating it is a deliberate edit to both Dockerfiles, and the scan in CI is what tells you
whether it was worth making.

## Vulnerability policy for the images

The scan gates on **fixable** HIGH and CRITICAL findings, and prints everything including
unfixed. The reasoning matches the dependency audit: an unfixed advisory in the Debian base
has no action attached to it — there is no patched version to move to — so gating on it
would make the pipeline permanently red and teach everyone to ignore it.

This is not a loophole; it is what made the images better. The first scan reported seven
fixable HIGH/CRITICAL findings, every one of them in a library bundled inside the base
image's own npm rather than in anything this application depends on. Deleting the package
manager from the runtime stage — which the application never needs — took that to zero.

If a fixable finding ever appears in an application dependency, the fix is a `pnpm`
override with a comment saying why, in the same style as the existing entries in
`pnpm-workspace.yaml`. Not an ignore file.

## Related

- [Deployment](deployment.md)
- [Backup and restore](backup-and-restore.md)
- [Schema changes](schema-changes.md) — the other thing a release can break
