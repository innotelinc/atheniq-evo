# AthenIQ Evo

The AthenIQ estate, integrated: **Open edX** delivers the courseware, **OpenMAIC**
runs in-class AI instruction, **Signara** signs and issues certificates and
degrees, and the **AthenIQ console** is the management console and student
portal. **AthenIQ Institute** — the public university site, admissions, student
accounts and the registrar — is `apps/institution`, on `atheniq.institute` and
`registrar.atheniq.institute`. This repository is the seam between them — one
service, one contract and one set of patches — so a learner is one person, a
course is one course and a completion becomes a credential exactly once.

```
                       ┌──────────────────────────────┐
   registrar / student │  atheniq-console (Next.js)   │  console + portal
                       │  courses · degrees · awards  │  academic record
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
| **Generate** | The console, for a course | The bridge calls OpenMAIC's classroom generator with that token, gets a stage back, and records the classroom so a later completion can be tied to it. |
| **Complete** | The classroom | OpenMAIC reports to the bridge with an HMAC-signed body. The bridge mines the learner and course from its own ledger (never the body), then writes the LMS completion, the grade override, closes the enrollment in the console, and awards a certificate when the console says the learner is eligible. |
| **Award** | The console, or the bridge | The console renders the PDF and runs Signara's upload → signing request → typed signature flow. The bridge never re-implements eligibility or signing; it asks. |

A completion is idempotent by `classroomId:learnerId`. Pressing *Finish module*
twice, or a retry after a dropped response, returns the first result rather than
a second certificate. `POST /v1/completions?retry=1` re-runs only the steps that
did not finish — the fix for "the LMS token was missing".

## Quick start

```bash
bash scripts/bootstrap.sh     # fetch the four upstreams at the pinned commits, apply patches
cp .env.example .env          # then fill in the secrets (see below)
npm install
npm run check                 # typecheck + the integration suites
docker compose up -d          # bridge + AI classroom + console + institution
```

Then open `http://atheniq.localhost:8080` for the public site and
`http://registrar.localhost:8080` for the registrar. Both are the one
`institution` service, routed by hostname.

`npm run check` is the honest gate: a Compose guard, `tsc` over the bridge and
the institution, 29 bridge tests that start the real HTTP server against fake
OpenMAIC, LMS, console and OmniRoute, and 26 institution tests covering the
application → admission → account → registration lifecycle and the Stalwart
JMAP calls and startup preflight against a fake server.

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
apps/institution/       the university — public site, portal, registrar
  src/content.ts        programs, courses, terms, faculty, admissions copy
  src/registry.ts       apply → admit → issue account → register
  src/store.ts          the institution registry (atomic JSON, one writer)
  src/server.ts         one process, two hostnames, no framework
  src/views/            public · portal · registrar
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
docs/                   architecture, contract, runbook, institution
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
| **Open edX** | No source patch. `deploy/openedx/` adds the settings the estate needs (`WRITABLE_GRADEBOOK`, completion tracking, trusted origins) and a script that creates the bridge's service user. | The LMS already exposes the two endpoints the bridge writes to. Forking Django views would be a maintenance cost with no benefit. |
| **Signara** | No source patch. The console already speaks its document + signature + certificate API; `deploy/signara/` adds the estate's API settings. | Signing is Signara's job, and the console is the issuer of record. |

## Verification

Run: `npm run check`.

- **29 bridge tests pass**, over real HTTP, against fake upstreams: launch,
  generation, full completion fan-out, replay, signed-callback refusal,
  stale-signature refusal, course/learner mismatch, unknown classroom, per-step
  retry, credential idempotency, gateway model list, and the token rules
  (expiry, audience, issuer, tampering, algorithm, weak signature).
- **26 institution tests pass**: curriculum integrity, application validation,
  admission issuing one account and a unique `@atheniq.institute` address,
  mailbox activation, Stalwart account creation and password updates, the
  startup preflight (unreachable URL, rejected key, missing domain), the
  provider configuration guard, temporary-password sign-in and forced change,
  seat accounting, full-studio refusal, waitlist refusal, salted password hashes,
  and session role/tamper rules.
- **`tsc --noEmit` is clean** for the bridge and the institution.
- **Both patches apply cleanly** to pristine clones of the pinned upstream
  commits (`git apply --check`).
- **The patched console builds**: `next build` exits 0, and
  `/api/classrooms/launch` and `/api/internal/atheniq` appear in the route table.
- **Live gateway**: the bridge's `/health` against the real OmniRoute answered
  `ok` with the model catalog, so the configured key and base URL work.

Not verified here, and worth doing on a real deployment: a **build of OpenMAIC**
with its patch (its pnpm tree is large), and live calls to Open edX's completion
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
  provisioning still fails, the address stays `reserved` and the registrar's
  access reset retries it.
- **The institution registry is one JSON file, one writer.** Right for one
  institute on one process; `docs/institution.md` names the migration path and
  the production hardening order.
