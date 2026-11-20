# Runbook

## First bring-up, in order

The order matters: each step proves one credential before the next depends on it.

1. **Fetch and patch.**
   ```bash
   bash scripts/bootstrap.sh          # clones upstream/ at the pinned commits, applies patches
   bash scripts/bootstrap.sh --check  # later: confirm the upstreams have not moved
   ```
2. **Secrets.** `cp .env.example .env`, then generate, not invent:
   ```bash
   openssl rand -hex 32   # BRIDGE_JWT_SECRET  (also ATHENIQ_BRIDGE_JWT_SECRET)
   openssl rand -hex 24   # BRIDGE_SERVICE_TOKEN (also CONSOLE_SERVICE_TOKEN)
   openssl rand -hex 24   # BRIDGE_HOOK_SECRET (also ATHENIQ_BRIDGE_HOOK_SECRET)
   ```
   The same value must be in both variables of each pair; they are two names for
   one secret on either side of a boundary.
3. **OmniRoute.** `OMNIROUTE_API_KEY` is the estate's single model key. Prove it
   before starting anything else:
   ```bash
   node apps/bridge/src/main.ts &   # after the three secrets are set
   curl -s localhost:8787/health | jq '.checks[] | select(.name=="omniroute")'
   curl -s -H "authorization: Bearer $BRIDGE_SERVICE_TOKEN" localhost:8787/v1/gateway/models
   ```
4. **Open edX.** In the LMS container:
   ```bash
   ./deploy/openedx/provision-bridge.sh --course course-v1:Org+Course+Run
   ```
   Create an OAuth2 application with the client-credentials grant, exchange it for
   a token, and put it in `LMS_API_TOKEN`. Set `LMS_GRADE_USAGE_ID` to the
   sequential the AI classroom's score belongs to.
5. **Signara.** Put the console's key in `SIGNARA_API_KEY`. The console's
   *Health* page probes it and reports a rejected key as rejected, not as
   "unavailable".
6. **Start.** `docker compose up -d`. Then check `curl -s localhost:8787/health`:
every check should be `ok`; `not_configured` means a variable is missing, and
`failed` names the host and status.
7. **Prove the secrets arrived expanded, not literal.** `env_file` is copied
   verbatim, so a `${…}` left in one shows up inside the container as text.
   ```bash
   docker compose exec openmaic printenv | grep ATHENIQ_BRIDGE
   # ATHENIQ_BRIDGE_JWT_SECRET=<64 hex chars>   ← good
   # ATHENIQ_BRIDGE_JWT_SECRET=${BRIDGE_JWT_SECRET}   ← the bug this guards
   docker compose config | grep -A3 ATHENIQ_BRIDGE_JWT_SECRET
   ```
   Both lines must match the value in `.env`. `npm run check:compose` catches the
   static case before it ever reaches a container.
8. **Prove the loop** with a throwaway course and learner: press *AI classroom*
   in the portal, finish the module, then open the candidate's record in the
   console. You should see the completion, the enrollment closed, and — if the
   course is in the catalog and the certificate was requested — an award with a
   verify id.

## Local preview without Docker

The Compose stack is the deployment. This is the **development** path: the same
four processes, run directly, for a machine with no container runtime. It will
not reproduce image builds or the Compose network — it reproduces the
behavior, which is what a preview is for.

| Process | Port | What it is |
| --- | --- | --- |
| institution | 8080 | public site + student portal, registrar at `registrar.localhost:8080` |
| bridge | 8787 | identity, launch, completion fan-out |
| OpenMAIC | 3000 | AI classroom (needs Postgres) |
| Postgres | 55432 | OpenMAIC's database, portable build |
| console | 3100 | academic record and awards (optional for this preview) |

### 1. Fetch and patch the upstreams

```bash
bash scripts/bootstrap.sh          # clones the four pinned repositories
npm install                        # bridge + institution workspaces
```

`upstream/OpenMAIC` and `upstream/atheniq-console` are the two that need a
build. The institution service has no dependencies and no build step.

### 2. Secrets in `.env`

```bash
cp .env.example .env
openssl rand -hex 32   # BRIDGE_JWT_SECRET (same value as ATHENIQ_BRIDGE_JWT_SECRET)
openssl rand -hex 24   # BRIDGE_SERVICE_TOKEN (same value as CONSOLE_SERVICE_TOKEN)
openssl rand -hex 24   # BRIDGE_HOOK_SECRET (same value as ATHENIQ_BRIDGE_HOOK_SECRET)
openssl rand -hex 32   # SESSION_SECRET (institution session cookies)
```

For a local preview also set, in `.env`:

```dotenv
INSTITUTION_SEED_DEMO=true     # one demo applicant, one demo student
COOKIE_SECURE=false            # the preview is http, so a Secure cookie is never stored
REGISTRAR_PASSWORD=atheniq-registrar
```

`.env` is gitignored and mode 600. Nothing in it is a real credential until you
put one there.

### 3. Postgres for OpenMAIC

Any local Postgres works. The one used here is a portable build in a gitignored
directory, so nothing is installed system-wide:

```bash
mkdir -p .local/dev-postgres && cd .local/dev-postgres
npm init -y
npm i --no-save embedded-postgres@18.7.0-beta.19
```

`start.mjs`:

```js
import EmbeddedPostgres from "embedded-postgres";

const pg = new EmbeddedPostgres({
  databaseDir: "./pgdata",
  user: "openmaic",
  password: "openmaic",
  port: 55432,
  persistent: true,
  // Windows initdb defaults to WIN1252, which cannot store the multilingual
  // content a classroom generates. Re-initialise with these flags if you see
  // encoding errors; delete ./pgdata first.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

await pg.initialise();
await pg.start();
await pg.createDatabase("openmaic");
console.log("postgres on 127.0.0.1:55432");
```

```bash
node start.mjs      # leave running
```

**Gotcha:** `initdb` only runs on an empty directory. If the cluster was created
before you added the encoding flags, stop it, delete `pgdata/`, and start again.
A cluster created as WIN1252 cannot be fixed by a connection string.

### 4. OpenMAIC

Install once, with a global pnpm: its `postinstall` shells out to `pnpm run
build:packages`, and a local-only pnpm is not on `PATH` during install.

```bash
npm i -g pnpm@10.28.0
cd upstream/OpenMAIC
pnpm install --frozen-lockfile
```

`.env.local` (gitignored) — OpenMAIC reads this, not the estate's `.env`:

```dotenv
DATABASE_URL=postgres://openmaic:openmaic@127.0.0.1:55432/openmaic
ATHENIQ_BRIDGE_JWT_SECRET=<same as BRIDGE_JWT_SECRET>
ATHENIQ_BRIDGE_URL=http://127.0.0.1:8787
ATHENIQ_BRIDGE_HOOK_SECRET=<same as BRIDGE_HOOK_SECRET>
OMNIROUTE_BASE_URL=https://gateway.innotel.us/v1
OMNIROUTE_API_KEY=<the estate key>
```

Typecheck and build with a larger heap. The TypeScript project is big enough to
run the default heap out of memory; this is not an optional nicety.

```bash
NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit -p tsconfig.json
NODE_OPTIONS=--max-old-space-size=6144 pnpm build     # ~15 minutes on a laptop
```

Run the production build, not `pnpm dev`: the preview then exercises the same
compiled routes the container will.

```bash
PORT=3000 HOSTNAME=127.0.0.1 pnpm start
```

The `ACCESS_CODE` warning at boot is expected. Access is gated by the signed
classroom cookie from the bridge, not by OpenMAIC's own access code.

### 5. Bridge

```bash
PORT=8787 node --env-file=.env apps/bridge/src/main.ts
```

**Gotcha:** some shells export `PORT=0`. Node's `--env-file` never overrides a
variable that already exists in the environment, so an exported `PORT=0` wins
over `.env` and the bridge asks the OS for an ephemeral port. Pass `PORT=8787`
explicitly every time (the same applies to the institution and OpenMAIC). Prove
where it actually listens:

```bash
curl -s http://127.0.0.1:8787/health | jq '{contractVersion, checks}'
```

### 6. Institution site and registrar

```bash
PORT=8080 \
SESSION_SECRET=<32+ chars> \
REGISTRAR_PASSWORD=atheniq-registrar \
INSTITUTION_SEED_DEMO=true \
COOKIE_SECURE=false \
node --env-file=.env apps/institution/src/main.ts
```

`INSTITUTION_ORIGIN` defaults to `http://localhost:8080` and `REGISTRAR_ORIGIN`
to `http://registrar.localhost:8080`. Both are served by this one process; the
surface is chosen from the `Host` header.

- Public site: <http://atheniq.localhost:8080> (or `http://127.0.0.1:8080`)
- Registrar: <http://registrar.localhost:8080>

Modern browsers resolve `*.localhost` to loopback. If yours does not, add
`127.0.0.1 atheniq.localhost registrar.localhost` to your hosts file, or use
curl with an explicit host:

```bash
curl -s -H 'Host: registrar.localhost' http://127.0.0.1:8080/signin | grep -o '<title>[^<]*'
```

Preview credentials when `INSTITUTION_SEED_DEMO=true`:

| Surface | Email | Password |
| --- | --- | --- |
| Student portal | `nadia.rahman@atheniq.institute` | `atheniq-demo` |
| Registrar | `registrar@atheniq.institute` | `REGISTRAR_PASSWORD` |

### 7. Console (optional)

The AthenIQ console is a separate Next.js app, not the institution's registrar
page. If `upstream/atheniq-console` is missing, `bash scripts/bootstrap.sh`
fetches the pinned upstreams. It needs its own dependencies and first boot:

```bash
cd upstream/atheniq-console
npm install
set -a; . ../../.env; set +a
AUTH_PASSWORD=atheniq-registrar \
AUTH_EMAIL=registrar@atheniq.institute \
AUTH_NAME=Registrar \
AUTH_REQUIRE_2FA=off \
ATHENIQ_BRIDGE_SERVICE_TOKEN="$BRIDGE_SERVICE_TOKEN" \
CONSOLE_ORIGIN=http://localhost:3100 \
npm run dev
```

It answers at `http://localhost:3100/login`. The first boot seeds
`upstream/atheniq-console/data/store.json`; sign in with `AUTH_EMAIL` and
`AUTH_PASSWORD`. `AUTH_REQUIRE_2FA=on` is the production default; the local
example turns it off so the first sign-in does not need an authenticator.

The institution portal's "Console" link appears only when `CONSOLE_BASE_URL` is
set, and it must be a URL the browser can reach — `http://localhost:3100`
locally, a public console hostname in production. Do not give it the Compose
service name `http://console:3100`; that only resolves inside the Compose
network.

### 8. Smoke test, in one pass

```bash
for path in / /academics /academics/msc-machine-intelligence /admissions \
            /admissions/apply /about /verify /portal /health; do
  printf '%-42s %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080$path")"
done

# The registrar is the same process on a different Host.
for path in / /applications /students; do
  printf 'registrar %-30s %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' \
    -H 'Host: registrar.localhost' "http://127.0.0.1:8080$path")"
done
```

`/` and `/signin` render the registrar sign-in page; other unauthenticated
registrar paths answer `303` to `/signin`. A `500` means a view or the registry
failed — read the process output, not the HTML.

### Stopping the preview

Stop each process by the PID you started, never by name:

```bash
kill <pid>              # the recorded PID
pkill -P <pid>          # its children, if it spawned any
```

A pattern kill (`pkill -f`, `pgrep -f | xargs kill`) can match the agent's own
command line. Do not use one.

### What differs from Compose

- No image build, so a missing `Dockerfile` dependency appears here as "works on
  my machine" and only in CI or a real host as a build failure.
- Services reach each other on `127.0.0.1`, not the Compose service names. The
  bridge's `OPENMAIC_BASE_URL` and the institution's `ATHENIQ_BRIDGE_URL` must be
  loopback URLs locally and `http://openmaic:3000` / `http://bridge:8787` in
  Compose.
- The classroom launch cookie needs a shared parent domain in production
  (`CLASSROOM_COOKIE_DOMAIN=.atheniq.institute`). Locally, `localhost` is the
  shared parent; do not set the domain.
- The registrar and public site share one registry file. If they show different
  data, they are reading different `INSTITUTION_DATA_DIR`s.

### The CI version of the Compose check

`.github/workflows/ci.yml` runs three jobs:

1. **typecheck and tests** — `npm ci && npm run check` (static Compose guard,
   `tsc` for the bridge and the institution, 51 tests).
2. **compose interpolation** — on a Docker runner, generates a literal `.env`,
   runs `docker compose config` for the default and both opt-in profiles, then
   asserts that Compose's *resolved* model contains the `.env` values rather
   than `${…}`. That is the check the static guard cannot make: Compose itself
   performs the substitution.
3. **institution image and health** — builds `apps/institution`, starts the
   container with a generated session secret, waits for `/health`, and fetches
   `/`. This is the only check that runs the production image.

Reproduce it on a machine with Docker:

```bash
docker compose config --quiet
docker compose config | grep -A2 ATHENIQ_BRIDGE_JWT_SECRET
```

The static guard remains the only check that can see inside an `env_file`,
because `docker compose config` does not print `env_file` contents. The two
checks are complementary, and both are required.

## Deploy order for a change

The three patched services and the bridge form a chain of trust:

1. **Bridge** first. It accepts the old token version (same `CONTRACT_VERSION`)
   and old callbacks, so nothing breaks while it rolls.
2. **OpenMAIC**, then **console**, then the edge config.
3. If `CONTRACT_VERSION` changes, deploy the bridge last instead: the bridge bumps
   its version, and tokens minted by the old console are refused by the new
   OpenMAIC until the console catches up. A 15-minute token lifetime bounds that
   window; during a release, expect re-launches rather than errors.

## Rotating a secret

| Secret | Steps |
| --- | --- |
| `BRIDGE_JWT_SECRET` | Change on bridge and OpenMAIC together. Outstanding classroom cookies stop working; a learner re-enters from the portal. No data is affected because the owner id is derived from `sub`, not the key. |
| `BRIDGE_HOOK_SECRET` | Change on bridge and OpenMAIC together. A callback in flight is refused and retried by the classroom; the completion is idempotent, so nothing is duplicated. |
| `BRIDGE_SERVICE_TOKEN` | Change on bridge and console together. Launches fail closed while they differ (503/401), never silently. |
| `OMNIROUTE_API_KEY` | The bridge reads it; both apps read it from the same `.env`. Rotate in OmniRoute, then restart the classroom and console. |
| `SIGNARA_API_KEY` | Use the console's *Health* page rotation (it mints a replacement and proves it before replacing), or paste a new key in Integrations. |

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| *AI classroom* button missing in the portal | `ATHENIQ_BRIDGE_URL` unset on the console | the button is hidden rather than broken; set it and restart |
| 303 back to the portal with a note | payment outstanding, no enrollment, or the bridge refused | the note is the bridge's own message |
| Classroom opens but shows an empty library | the cookie did not reach OpenMAIC's host | `ATHENIQ_CLASSROOM_COOKIE_DOMAIN` must be the shared parent domain, and the session must be HTTPS in production (`Secure`) |
| 401 from `/api/atheniq/completion` | token expired (15 min) or the two JWT secrets differ | re-enter from the portal; compare `BRIDGE_JWT_SECRET` with `ATHENIQ_BRIDGE_JWT_SECRET` |
| Completion `partial`, `lms-grade: not_configured` | no numeric user id, or no `LMS_GRADE_USAGE_ID` | add the learner to `LMS_USER_MAP_PATH`; set the usage id; then `POST /v1/completions?retry=1` with the same body |
| Completion `partial`, `console-completion: failed` | console was down, or the service tokens differ | the step's `detail` carries the console's sentence; fix, then retry |
| Award `queued_local` | no Signara key | set `SIGNARA_API_KEY`, then re-submit the award in the console |
| `409 UNKNOWN_CLASSROOM` | a completion for a classroom this bridge never launched (a wiped ledger, or a second bridge) | completions must come from the launch that created them; check `BRIDGE_DATA_DIR` is the durable volume |
| Ledger parse error at boot | the file is corrupt | the process refuses to start rather than re-awarding; restore the file or the volume |

## Backfill and repair

The ledger is a plain JSON file and every completion is replayable.

```bash
# Everything a learner has done in AI classrooms
curl -s -H "authorization: Bearer $BRIDGE_SERVICE_TOKEN" \
  localhost:8787/v1/learners/lrn_…/transcript | jq

# A stuck completion: same body, retry flag
curl -s -X POST localhost:8787/v1/completions?retry=1 \
  -H "x-atheniq-timestamp: $(date +%s)" \
  -H "x-atheniq-signature: $(…)":      # sign with BRIDGE_HOOK_SECRET
```

A registrar can also award by hand in the console — `override: true` is recorded
on the award, so an override is never invisible.

## What to watch

- `/health` — `ok: false` means an upstream is failing, not that the bridge is
  down (the bridge answering at all is the liveness signal).
- `completion.fanned-out` events with `partial` — the queue of things a human
  should look at.
- `credential.issued` with a status other than `issued` — an award waiting on
  Signara.
- The ledger's growth: `completions` is capped at 50,000, `events` at 5,000. Their
  size is the signal to move to the Postgres implementation.
