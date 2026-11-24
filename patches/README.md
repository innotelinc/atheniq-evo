# Patches

Small, reviewable deltas on the upstream repositories — not forks. Each series is
generated against the commit in `upstream.lock.json` and applied by
`scripts/bootstrap.sh`.

```bash
bash scripts/bootstrap.sh --check   # do they still apply to the pinned commits?
```

## openmaic/0001-atheniq-classroom-integration.patch

| File | Change |
| --- | --- |
| `lib/server/identity/host/atheniq-classroom.ts` | **new** — verifies the bridge's `atheniq_classroom` cookie (HS256 via Web Crypto) and answers an owner principal `atheniq:<sub>`, with publish rights only for staff roles. |
| `instrumentation.ts` | registers that method, and only when `ATHENIQ_BRIDGE_JWT_SECRET` is set. |
| `app/api/atheniq/classroom/route.ts` | **new** — the binding the UI may know: bridged?, course, learner. No token leaves the server. |
| `app/api/atheniq/completion/route.ts` | **new** — HMAC-signed completion callback; identity and course come from the token, never the body. |
| `components/atheniq/atheniq-completion-reporter.tsx` | **new** — the one control rendered, only when bridged. |
| `app/classroom/[id]/page.tsx` | mounts the reporter beside the classroom. |

Uses OpenMAIC's documented host identity extension point (`OwnerAuthMethod`) and
its documented host-code directory, so no core identity file is modified and the
boundary test that guards those headers still holds: the cookie is read only
inside `lib/server/identity/host/`.

## atheniq-console/0001-atheniq-bridge-integration.patch

| File | Change |
| --- | --- |
| `lib/award.ts` | **new** — the award logic extracted from `POST /api/credentials`, shared by the registrar UI and the service route. |
| `app/api/credentials/route.ts` | POST delegates to `lib/award.ts`; identical validation order and responses. |
| `lib/bridge.ts` | **new** — server-side bridge client (launch ticket). |
| `app/api/internal/atheniq/route.ts` | **new** — service-authenticated `complete-enrollment` and `issue-credential`. |
| `app/api/classrooms/launch/route.ts` | **new** — portal session + access check → bridge ticket → HttpOnly cookie → redirect. |
| `app/portal/page.tsx` | adds *AI classroom* beside *Open course* when a bridge is configured. |

## atheniq-console/0002-institution-owns-the-course-catalog.patch

| File | Change |
| --- | --- |
| `README.md` | says what the app now is — records and awards — and that adding, editing, generating and removing a course belongs to the institution console at the registrar host. |
| `middleware.ts` | `/courses` and `/generate` answer `308` to `INSTITUTION_CONSOLE_URL` (default `https://registrar.atheniq.institute`), translated to the institution's paths: `/generate` → `/courses/generate`, a generation session or a course id → `/courses`, `/courses/{new,generate,sync,import}` unchanged. `/api/*` and the public site are untouched, so awards, the mobile API and the generated website keep working. |
| `components/Nav.tsx` | the Teach group is removed; a *Course catalog* link (`${INSTITUTION_CONSOLE_URL}/courses`) replaces it. |
| `app/layout.tsx` | passes that link from the environment, says *Records console* rather than *Registrar console*, and describes the app as awards rather than course authoring. |
| `next.config.mjs` | exposes `INSTITUTION_CONSOLE_URL` through `env`, because Next inlines `process.env` for the middleware at build time and the edge runtime sees nothing else. |
| `Dockerfile` | takes `INSTITUTION_CONSOLE_URL` as a build argument for the same reason: the value is baked into the middleware, so a runtime-only variable would be ignored. `docker-compose.yml` passes it as `build.args`. |

One catalog, one writer: the institution console authors courses, and this app
keeps awards, degree plans and the service routes the bridge calls.

Two things to know before deploying it. **The redirect target is baked at build
time** — changing `INSTITUTION_CONSOLE_URL` means rebuilding the image, not
restarting the container. And **the institution must answer at
`registrar.atheniq.institute` before this patch goes live there**: the default
target is that host, so a console serving `/courses` on it would redirect to
itself forever. `docs/cutover.md` is the ordered version of that.

## Verified against the pinned commit

```bash
cd upstream/OpenMAIC
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec tsc --noEmit -p tsconfig.json
pnpm build
```

Both pass at the pinned commit: `tsc` exits 0 and `next build` emits
`/classroom/[id]`, `/api/atheniq/classroom` and `/api/atheniq/completion`. Two
gotchas worth knowing before running them:

- `tsc` needs the larger heap. The default 2 GB aborts with "Ineffective
  mark-compacts near heap limit" on this monorepo.
- The install's own `postinstall` shells out to `pnpm run build:packages`, so
  `pnpm` must be on PATH; a corepack shim or a global install is enough.

## Regenerating after an upstream bump

```bash
cd upstream/OpenMAIC && git checkout <new commit> && git apply ../../patches/openmaic/*.patch
# fix conflicts, then regenerate from the touched paths only:
git add -- instrumentation.ts 'app/classroom/[id]/page.tsx' \
  lib/server/identity/host/atheniq-classroom.ts app/api/atheniq components/atheniq
git diff --cached --binary -- instrumentation.ts 'app/classroom/[id]/page.tsx' \
  lib/server/identity/host/atheniq-classroom.ts app/api/atheniq components/atheniq \
  > ../../patches/openmaic/0001-atheniq-classroom-integration.patch
git reset
```

Name the paths rather than using `git add -A`: `node_modules/` and
`public/vendor/standalone-player/` are untracked in that checkout, and staging
them takes minutes and produces a patch no one can review.

Update `upstream.lock.json` in the same commit. A patch that no longer applies is
a signal to read the upstream change, not to force it.
