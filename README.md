# AthenIQ Evo

The AthenIQ estate, integrated: **Open edX** delivers the courseware, **OpenMAIC**
runs in-class AI instruction, **Signara** signs and issues certificates and
degrees, and the **AthenIQ console** is the records and awards service behind
it: degree plans, the learner portal API and Signara awards. **AthenIQ
Institute** — the public university site, admissions, student accounts, the
course catalog and the registrar — is `apps/institution`, on
`atheniq.institute` and `registrar.atheniq.institute`. It is the staff console:
a course is added, edited, generated and removed there, and nowhere else. This repository is the seam between them — one
service, one contract and one set of patches — so a learner is one person, a
course is one course and a completion becomes a credential exactly once.

```
                       ┌──────────────────────────────┐
   registrar / student │  atheniq-console (Next.js)   │  records + awards
                       │  degrees · awards · portal   │  academic record
                       └───────────┬──────────────────┘
                                   │ service token
                        ┌──────────▼───────────┐
                        │   atheniq-bridge     │  identity, launch, ledger
                        │  apps/bridge         │  completion fan-out
                        └──┬────────┬────────┬─┘
        signed classroom   │        │        │  service token
        token (JWT, HS256) │        │        └──────────────┐
                  ┌────────▼──────┐ │                       │
                  │   OpenMAIC    │ │ REST                  ▼
                  │ AI classroom  │ │            ┌────────────────────┐
                  └───────┬───────┘ │            │ atheniq-console    │
                          │         │            │ /api/internal/…    │
            HMAC completion│        │            └─────────┬──────────┘
                          └────────►│                      │ X-API-Key
                                    ▼                      ▼
                        ┌───────────────────┐   ┌────────────────────┐
                        │ Open edX LMS      │   │ Signara            │
                        │ completion+grade  │   │ documents, signing │
                        └───────────────────┘   │ certificates       │
                                                └────────────────────┘
```

## The four flows

| Flow | Who starts it | What happens |
| --- | --- | --- |
| **Launch** | A learner presses *AI classroom* in the portal | The console asks the bridge to sign them in; the bridge mints a 15-minute token pinned to that learner and course; the console sets it as an HttpOnly cookie and redirects to OpenMAIC, which resolves the *same* owner id the rest of the estate uses. |
| **Generate** | The institution console, for a course | The bridge calls OpenMAIC's classroom generator with that token, gets a stage back, and records the classroom so a later completion can be tied to it. |
| **Complete** | The classroom | OpenMAIC reports to the bridge with an HMAC-signed body. The bridge mines the learner and course from its own ledger (never the body), then writes the LMS completion, the grade override, closes the enrollment in the console, and awards a certificate when the console says the learner is eligible. |
| **Award** | The console, or the bridge | The console renders the PDF and runs Signara's upload → signing request → typed signature flow. The bridge never re-implements eligibility or signing; it asks. |

A completion is idempotent by `classroomId:learnerId`. Pressing *Finish module*
twice, or a retry after a dropped response, returns the first result rather than
a second certificate. `POST /v1/completions?retry=1` re-runs only the steps that
did not finish — the fix for "the LMS token was missing".

**One staff console.** `registrar.atheniq.institute` is the institution console,
and it is the only place a course is added, edited, generated or removed. The
Next.js console keeps awards, degree plans and the service routes the bridge
calls; its `/courses` and `/generate` pages answer `308` to
`INSTITUTION_CONSOLE_URL` instead of offering a second catalog, and its sidebar
links there. Two consoles editing one catalog is two answers to "what is this
course".

## Quick start

```bash
bash scripts/bootstrap.sh     # fetch the four upstreams at the pinned commits, apply patches
cp .env.example .env          # then fill in the secrets (see below)
npm install
npm run check                 # typecheck + the integration suites
npm run up                    # bridge + AI classroom + console + institution, CSP-checked
```

`npm run up` is `docker compose up -d --wait` followed by the classroom's frame
policy check, and it exits non-zero when the image Compose pulled does not allow
this estate's `OPENMAIC_FRAME_ANCESTORS`. A mismatched classroom serves a blank
iframe in the registrar and nothing else complains, so the start command is the
place to refuse it. `bash scripts/up.sh --no-deps` re-runs just the check.

Then open `http://atheniq.localhost:8080` for the public site and
`http://registrar.localhost:8080` for the registrar. Both are the one
`institution` service, routed by hostname.

`npm run check` is the honest gate: a Compose guard, `tsc` over the bridge and
the institution, 29 bridge tests that start the real HTTP server against fake
OpenMAIC, LMS, console and OmniRoute, and 45 institution tests covering the
application → admission → account → registration lifecycle, the course catalog
(create, edit, publish, remove, LMS sync, AI draft fallback), the Stalwart JMAP
calls and the startup preflight against a fake server.

### One Compose rule

Compose expands `${VAR}` in `docker-compose.yml` and in `environment:`, but **not
in a file passed via `env_file:`** — it copies those verbatim. A derived value in
`env_file` therefore reaches the container as the literal text `${VAR}`, and the
symptom appears far from the cause ("every classroom token is invalid").

So: `env_file` holds literal files only (`.env`), derived values live in
`environment:`, and Open edX's settings are YAML that is **mounted**. `npm run
check:compose` fails the build if that ever stops being true; it was written
against the first draft of this file and catches it.

Fill in `.env` before starting anything with real traffic:

| Variable | What it is |
| --- | --- |
| `BRIDGE_JWT_SECRET` | HS256 key for classroom tokens. 32+ chars, generated (`openssl rand -hex 32`). The same value goes to OpenMAIC as `ATHENIQ_BRIDGE_JWT_SECRET`. |
| `BRIDGE_SERVICE_TOKEN` / `CONSOLE_SERVICE_TOKEN` | The console ↔ bridge service token. One value, both variables. |
| `BRIDGE_HOOK_SECRET` | HMAC key for completion callbacks. Same value in OpenMAIC as `ATHENIQ_BRIDGE_HOOK_SECRET`. |
| `OMNIROUTE_API_KEY` | The one model-gateway key for the whole estate. Never in client code. |
| `LMS_API_TOKEN` | An Open edX token with course-author rights, created by `deploy/openedx/provision-bridge.sh`. |
| `SIGNARA_API_KEY` | The console's Signara key (document and signature scopes). |
| `OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY` | The estate's model gateway. The institution's course studio writes drafts with it, server-side; without a key the deterministic curriculum rules write the draft and say so. |
| `LMS_PUBLIC_URL` | The LMS whose public catalog the console syncs against (`https://atheniq.courses`). Read-only. |
| `OPENMAIC_PUBLIC_URL` | The browser-reachable OpenMAIC origin for the embedded classroom preview. Empty means the console explains that embedding is not configured. |
| `INSTITUTION_CONSOLE_URL` | Where the Next.js console sends course authoring: the institution console, `https://registrar.atheniq.institute`. Also the sidebar's *Course catalog* link. Inlined into the console's middleware at build time, so Compose passes it as a build argument. |

The bridge **refuses to start** without strong `BRIDGE_JWT_SECRET`,
`BRIDGE_SERVICE_TOKEN` and `BRIDGE_HOOK_SECRET`, and refuses a corrupt ledger.
Starting with an empty signing key would mint classroom tokens anyone can forge.

## What is in here

```
apps/bridge/            the integration service — no runtime dependencies
  src/app.ts            six routes over node:http
  src/flow.ts           launch and completion orchestration
  src/auth.ts           classroom tokens (HS256) and hook signatures (HMAC)
  src/ledger.ts         the AI-instruction ledger, atomic JSON, one writer
  src/clients/          Open edX · OpenMAIC · console · OmniRoute
  test/                 end-to-end over real HTTP, plus token rules
apps/institution/       the university — public site, portal, console
  src/content.ts        programs, terms, faculty, admissions copy (the seed)
  src/catalog.ts        the course catalog: CRUD, atomic JSON, LMS sync state
  src/ai.ts             course generation (OmniRoute, or the curriculum rules)
  src/sync.ts           reads the LMS public catalog
  src/classroom.ts      starts and signs into OpenMAIC's classroom
  src/registry.ts       apply → admit → issue account → register
  src/store.ts          the institution registry (atomic JSON, one writer)
  src/server.ts         one process, two hostnames, no framework
  src/views/            public · portal · registrar · courses
  public/               one stylesheet, one small script, no build step
packages/contracts/     the wire contract, copied verbatim by both patches
patches/
  openmaic/             identity method, completion route, reporter component
  atheniq-console/      award service, internal API, launch route, portal button
deploy/
  openmaic/             OmniRoute model config
  openedx/              LMS settings (YAML, mounted) and the service-user script
scripts/bootstrap.sh    fetch pinned upstreams, apply patches, check they still apply
upstream.lock.json      the four repositories and the exact commits
docs/                   architecture, contract, runbook, institution, cutover
```

`upstream/` is fetched, never committed: Open edX alone is far too large to
vendor. `upstream.lock.json` pins what the patches were generated against, and
`scripts/bootstrap.sh --check` tells you when an upstream has moved.

## What changed upstream

| Repo | Change | Why |
| --- | --- | --- |
| **OpenMAIC** | `lib/server/identity/host/atheniq-classroom.ts` verifies the bridge's cookie with Web Crypto and answers an owner principal; registered from `instrumentation.ts` only when `ATHENIQ_BRIDGE_JWT_SECRET` is set. | The classroom must know the learner the console knows. A host identity method is OpenMAIC's own documented extension point, so no route is forked. With the secret unset, a standalone OpenMAIC is unchanged. |
| **OpenMAIC** | `app/api/atheniq/completion` reports a finished classroom with an HMAC-signed callback; `components/atheniq/atheniq-completion-reporter.tsx` is the one control it renders. | Completion has to leave the classroom and reach the record of record. Identity and course come from the signed token, so a browser cannot claim another learner's completion. |
| **atheniq-console** | `lib/award.ts` extracts the award logic that was the body of `POST /api/credentials`; both the registrar UI and the new service route use it. | One implementation of eligibility, evidence hashing and the Signara flow — the thing least affordable to have two of. |
| **atheniq-console** | `app/api/internal/atheniq` (service-token), `app/api/classrooms/launch` (portal → bridge → cookie → redirect), and an *AI classroom* button in the portal. | The console is the only thing a learner signs into; it should be the only thing they press. |
| **atheniq-console** | `middleware.ts` answers `308` for `/courses` and `/generate` to the institution console, translated to its paths (`/generate` → `/courses/generate`); `components/Nav.tsx` links there instead of listing them; `app/page.tsx`'s course CTAs — new course, generate, a course's editor — point there directly and take no hop; `next.config.mjs` and the `Dockerfile` carry `INSTITUTION_CONSOLE_URL`, which Next inlines at build time. | Course authoring has one owner. The console keeps awards and degree plans, not a second catalog. |
| **Open edX** | No source patch. `deploy/openedx/` adds the settings the estate needs (`WRITABLE_GRADEBOOK`, completion tracking, trusted origins) and a script that creates the bridge's service user. | The LMS already exposes the two endpoints the bridge writes to. Forking Django views would be a maintenance cost with no benefit. |
| **Signara** | No source patch. The console already speaks its document + signature + certificate API; `deploy/signara/` adds the estate's API settings. | Signing is Signara's job, and the console is the issuer of record. |

## Verification

Run: `npm run check`.

- **29 bridge tests pass**, over real HTTP, against fake upstreams: launch,
  generation, full completion fan-out, replay, signed-callback refusal,
  stale-signature refusal, course/learner mismatch, unknown classroom, per-step
  retry, credential idempotency, gateway model list, and the token rules
  (expiry, audience, issuer, tampering, algorithm, weak signature).
- **45 institution tests pass**: curriculum integrity, application validation,
  admission issuing one account and a unique `@atheniq.institute` address,
  mailbox activation, Stalwart account creation and password updates, the
  startup preflight (unreachable URL, rejected key, missing domain), the
  provider configuration guard, temporary-password sign-in and forced change,
  seat accounting, full-studio refusal, waitlist refusal, salted password hashes,
  session role/tamper rules, and the catalog: unique codes, the runtime key,
  draft-versus-published registration, an edit reaching credits, a removal guard,
  sync drift in both directions, LMS read failures, and AI generation against a
  fake gateway and the rules fallback.
- **`tsc --noEmit` is clean** for the bridge and the institution.
- **All three patches apply cleanly** to the pinned upstream commits
  (`git apply --check`).
- **The patched console builds**: `next build` exits 0, `/api/classrooms/launch`
  and `/api/internal/atheniq` are in the route table, and the authoring pages
  answer `308` to `INSTITUTION_CONSOLE_URL` while `/api/courses` still answers
  `200`. Run with `INSTITUTION_CONSOLE_URL=https://institution.example.test`, the
  answers were `/courses` → `/courses` (query kept), `/courses/new` →
  `/courses/new`, `/courses/AI101` → `/courses`, `/generate` →
  `/courses/generate`, `/generate/sess_1` → `/courses`: the institution's paths,
  not this app's. The value is inlined by the build, so that run needed the
  variable at `next build`, which is why the `Dockerfile` takes it as an
  argument.
- **The embedded classroom authenticates**: a bridge-minted token in
  `atheniq_classroom` is accepted by the real OpenMAIC host method (`bridged:
  true` with the registrar identity, course key and classroom id), a tampered
  token is refused with `INVALID_CREDENTIAL`, and the classroom page embeds the
  host in an iframe. Verified locally over a same-site pair; the public hosts
  need the deploy described in `docs/institution.md`. The build also has to
  admit the registrar as an ancestor: built with
  `ALLOWED_FRAME_ANCESTORS=https://registrar.atheniq.institute`, the classroom
  answers `frame-ancestors 'self' https://registrar.atheniq.institute` with no
  `X-Frame-Options`, renders inside the registrar's iframe with `bridged: true`
  and the `atheniq_classroom` cookie on `.atheniq.institute`, and Chromium
  refuses it when framed by a host the policy does not name. That run mapped the
  public names to the local stack, so it proves the image and the frame, not the
  edge in front of them. That image is now built in CI, not by hand: the
  `openmaic image` workflow fetches OpenMAIC at the pinned commit, builds it with
  the frame origin it reads back from `docker compose config` — the value Compose
  ships, so CI cannot drift from the estate (with `OPENMAIC_FRAME_ANCESTORS`
  unset, `ALLOWED_FRAME_ANCESTORS` resolves to
  `https://registrar.atheniq.institute`) — and asserts the header on the running
  container. It
  answered `200` with `Content-Security-Policy: frame-ancestors 'self'
  https://registrar.atheniq.institute` and no `X-Frame-Options`. It publishes
  that image to GHCR and to the public Docker Hub repository
  `docker.io/innotel/atheniq-evo-openmaic` (`latest` and `sha-<commit>`), so a
  workstation pulls it without a GitHub package scope. `docker compose up` uses
  that image rather than compiling: the service names it by **digest** in
  `OPENMAIC_IMAGE`, so a plain `up` is a pull plus a start, and a   `pull` cannot
  quietly move to a build nobody proved — deploying a new one means moving that
  pin to the digest the workflow prints. `npm run check:openmaic-csp` then asks
  the running container what policy it actually ships and fails, naming the two
  origins, when it disagrees with `OPENMAIC_FRAME_ANCESTORS`; without that
  comparison the symptom is only a blank iframe in the registrar. That check is
  not a habit to remember: `npm run up` runs it as the `csp-check` Compose
  service after the stack is healthy and exits non-zero when it disagrees. The same build
  never finished on this workstation — the Docker engine died during `next build`
  on a 3.9 GB VM, which `docs/cutover.md` records.
- **Live gateway**: the bridge's `/health` against the real OmniRoute answered
  `ok` with the model catalog, so the configured key and base URL work.

Not verified here, and worth doing on a real deployment: the **two public
hostnames** — the classroom was proven over the local same-site pair, against the
patched OpenMAIC build, but `registrar.atheniq.institute` and
`classroom.atheniq.institute` are not published (`docs/cutover.md` is the ordered
run) — and live calls to Open edX's completion
and gradebook APIs and to Signara — those were exercised against fakes only. The LMS
client's request shapes follow the published API (completion-batch takes a
`blocks` map; the gradebook write is `bulk-update` and needs a numeric user id,
which Open edX does not expose over REST — hence `LMS_USER_MAP_PATH`). Treat the
first live run as the contract test for those two, and see `docs/runbook.md`.

## Limits, stated plainly

- **The bridge's ledger is the source of truth for AI instruction**, in one JSON
  file with serialized atomic writes. That is right for one bridge per estate; a
  fleet needs the Postgres implementation of `lib/ledger.ts`, which is why the
  interface is narrow.
- **Grades need a user-id map.** Without `LMS_USER_MAP_PATH` the bridge writes
  completions but reports `not_configured` for the grade, rather than guessing an
  id. A grade written to the wrong learner is worse than an unwritten one.
- **Signara key absent** means awards are held as `queued_local` by the console —
  the design the console already documents. Nothing is lost; re-submitting picks
  up where it stopped.
- **No self-service account.** Anyone can apply on the public site, but an
  application creates no account. Admission is the only act that mints a student
  number, a portal account and a `@MAIL_DOMAIN` address. The temporary password is
  shown once.
- **Mail is wired to Stalwart when configured.** `MAIL_PROVIDER=local` reserves
  the address only. With `MAIL_PROVIDER=stalwart`, admission creates the mailbox
  through Stalwart's JMAP management API, and a portal password change or a
  registrar reset updates it. Startup queries the configured domain first, so a
  bad URL, a rejected key or a missing `MAIL_DOMAIN` stops the service with
  `mail preflight failed: …` instead of surfacing on the first admission. If
  provisioning still fails, the address stays `reserved` and the roster lists it
  with a per-student **Retry mailbox** action; the dashboard shows how many
  addresses are waiting, so local mode and an outage are visible rather than
  silent.
- **The institution registry and catalog are one JSON file each, one writer.**
  Right for one institute on one process; `docs/institution.md` names the
  migration path and the production hardening order.
- **The institution console edits the catalog; the LMS import is separate.** The
  sync reads `atheniq.courses`' public catalog and reports which courses are
  live and which drift. Writing an OLX package into the LMS is the Next.js
  console's publish pipeline, not this one — the institution says so on the
  course record rather than implying a course was pushed when it was not.
