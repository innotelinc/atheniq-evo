# Signara — signing and verification

Signara signs and issues the Institute's awards. The console is the issuer of
record: it renders the certificate PDF, uploads it, requests the signature and
stores the verify id. The institution site never talks to Signara directly — it
links a visitor to the console's public verification page.

```
console ──X-API-Key──► Signara API   /documents/upload → /signatures/requests → /signatures/requests/{id}
                                            │
institution /verify ──link──► console /verify[/{verifyId}] ──► credential + Signara signature
```

## Where it runs

Signara is **its own stack**, not part of this repository's Compose file: it
needs PostgreSQL, Redis, an S3-compatible store, Meilisearch and an OIDC
provider, and its upstream ships the Compose files for exactly that. Run it on
the Docker host that already carries the estate's data services.

| Piece | Container port | Public host (estate default) |
| --- | --- | --- |
| web | 3000 | `app.signara.innotel.us` |
| api | 8000 | `api.signara.innotel.us` |
| authentik (only without `AUTHENTIK_MODE=remote`) | 9000 / 9443 | `auth.signara.innotel.us` |
| object store (onyx) | — | `storage.signara.innotel.us` |

The estate's identity provider is the existing Authentik at
`auth.cerulean.innotel.us`, so the local one stays off; `AUTH_URL` in the
template points there.

Both web and api must be reachable at the hostnames compiled into the web app
(`NEXT_PUBLIC_API_URL`). Publish them through the edge (Cerulean / NPM) with
TLS; the Compose file binds them to loopback on purpose.

## Secrets

The estate's values live in Cerulean Vault at `cerulean/signara` (KV v2):
`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`MEILISEARCH_API_KEY`, `OIDC_CLIENT_SECRET`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `CRYPTO_MASTER_KEY`.

Signara does **not** resolve `vault://` references at runtime — upstream's
`docs/stack.md` is explicit that a reference reaches the container as a literal
string. `scripts/vault-migrate.py` pushes plaintext *into* Vault; nothing pulls
it back out. So read the values out on the host when writing `.env`:

```bash
vault kv get -field=POSTGRES_PASSWORD cerulean/signara
```

Keep `.env` at mode 0600 on the host and out of version control. The token
Cerulean mints for this path is scoped to `cerulean/signara` alone.

## Bring it up

```bash
cd /srv            # any directory on the Docker host
git clone https://github.com/innotelinc/signara.git
cd signara
git checkout dbc7d260deef74dc2cbe6ef30ba90ee4fde576f2   # the revision this estate was set up from
cp /path/to/atheniq-evo/deploy/signara/estate.env .env   # then resolve every __SET_FROM_VAULT__
chmod 600 .env
./setup.sh --production
```

`setup.sh --production` generates any missing secret, starts Postgres/Redis/
storage/Meilisearch, builds api+web, runs migrations and starts the stack. Set
`AUTHENTIK_MODE=remote` (the template already does) to use the estate's
existing Authentik instead of Signara's local copy. On a host without build
tooling, add `--use-images` to pull the published images.

Prerequisites the template cannot create for you: an Authentik OIDC application
`signara` at `auth.cerulean.innotel.us` with the redirect in
`OIDC_REDIRECT_URI`, and the `signara-admins` group that `IDP_ADMIN_GROUP`
names.

Verify before touching the console:

```bash
curl -fsS http://127.0.0.1:8000/ready            # API (liveness is /health)
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
curl -fsS https://api.signara.innotel.us/ready   # through the edge
```

## API key for the console

Awards are submitted with an API key, not a user session. Signara accepts it as
`X-API-Key: sgn_…` and creates keys with `POST /api/v1/api-keys`.

1. Sign in to the Signara app with Authentik as an organisation admin.
2. Create an API key (`POST /api/v1/api-keys`, or the app's API-key screen) with
   the document, signature and certificate permissions for the Institute's
   organisation.
3. Put it in the console's **Integrations** page as `SIGNARA_API_KEY`, with
   `SIGNARA_API_URL` set to the **API** host (`https://api.signara.innotel.us`,
   no path). The console's Health page probes
   `GET /api/v1/signatures/requests?limit=1` and reports a rejected key as
   rejected rather than unavailable.

Until a key is present the console still records the award, as
`queued_local`; set the key and re-submit the award from the console.

## Verification

- **Console** (public): `https://<console host>/verify` — a visitor enters the
  `ATH-XXXXXXXX` identifier; `/verify/{id}` renders the result. This page reads
  the credential register, so it works with or without Signara being reachable.
- **Signara API** (machine): `POST /api/v1/certificates/verify` with the
  `X-API-Key`, a `certificateId` or `certificatePem`, and optionally
  `signatureValue` + `signedHash`. It returns the verification report with the
  identity assurance level.
- **Institution site**: set `CREDENTIAL_VERIFY_URL` to the console's verify page
  (`https://<console host>/verify`). The `/verify` page shows the "Open
  verification" button only when that is set; empty means "not connected in this
  environment", which is the correct default for a preview.

## Current state

Signara exists as a **Coolify resource** in this estate and has not yet served a
request successfully. What is set up (instance `deploy.innotel.us`, project
**AthenIQ**):

| Setting | Value |
| --- | --- |
| Resource | `signara` (`4vzo0yw5ipz3m8cx9fuptr4d`), type **Docker Compose** |
| Destination | `i3-local` = `192.168.1.53` |
| Source | `github.com/innotelinc/signara`, branch `main` |
| Compose file | `/docker-compose.prod.yml` |
| Exposed port | `80` (from `ports_exposes`); no domain or host mapping yet |
| Profiles | `authentik` off (`AUTHENTIK_MODE=remote`), `legacy-storage` off |

The earlier copy on `i2-local` (`192.168.1.52`) has been deleted, along with its
host-port mapping of web `13000` → 3000 and api `18000` → 8000. Coolify 4.7.6
cannot move an application between servers — there is no `migrate` route and
`PATCH` rejects `destination_uuid` — so the i3 copy was recreated like-for-like
through the API rather than moved. `8000` is not usable on the i2 box anyway:
it belongs to that host's own Coolify stack, and a container that binds it fails
with `port already allocated`.

On i3 the Environment variables page held **346 rows for 162 distinct names, and
the rows were duplicated**. Rows 1–174 carry the whole `estate.env` followed by the
keys compose interpolates; rows 175–346 then repeat rows 1–172 exactly. Twelve
keys repeat even inside the first block — `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `NODE_ENV` three times, `DATABASE_URL` twice, plus the six
`AUTHENTIK_*` / `AUTHENTIK_POSTGRESQL__*` pairs — so **184 of the 346 rows are
redundant**. That row order puts `NODE_ENV` in the table six times and
`POSTGRES_USER` four.

The two kinds of duplicate do not behave alike. The twelve in-block repeats agree
copy for copy: `NODE_ENV`'s three copies, `DATABASE_URL`'s two, the
`AUTHENTIK_*` pairs and `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` all
carry identical values. The repeated second block is **empty**: in every row read
from 175 to 200 the value was blank, including `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`, `SIGNARA_S3_ACCESS_KEY` /
`_SECRET_KEY`, `MEILISEARCH_API_KEY`, `OIDC_JWKS_URL` and `AUTHENTIK_SECRET_KEY`,
while the same names in the first block carry the real ones. Rows 1–100 and
201–346 were not read — the page stopped answering at 100 rows per page (504 from
openresty) — so the blanks are confirmed for the head of the repeat block, not
for all of it. That page size was a per-page-load setting, so it is not a stored
state to undo; the table comes back at its default. Since then the whole instance
is down rather than slow: `/`, `/login` and `/api/health` all return `502 Bad
Gateway` from openresty (checked 21 Nov, repeatedly over several minutes), which
is Coolify's own container refusing the proxy, not this application. Until that
instance answers, the remaining rows cannot be read at all.

That application was later deleted from the project, and on 22 Nov it was
recreated from the same source as `4vzo0yw5ipz3m8cx9fuptr4d` (Docker Compose,
branch `main`, `/docker-compose.prod.yml`, ports `80`, i3-local). Its fresh table
reads **180 rows** at the default 10 per page, before any deployment — so the
doubling arrives with a redeploy, not at creation. Those rows are not the estate's
values, though: all ten rows on page one carry the same 15-character placeholder,
so the real secrets still have to be written before a deploy means anything.
The first manual deployment of that resource (`sdhnh1vxccpy1iywwputlapx`, commit
`6555303`, i3-local) ran 16:00:04–17:01:24 on 22 Nov and ended **Failed** after
`01h 01m 21s`. The source build (`frontend`, `api`, `backup`) held `Pulling &
building required images.` from 16:00:20 until 16:52:34, and that step prints
nothing while it runs, so the long silence was a slow build rather than a stall.
From 16:58:20 it removed the old containers and created and started the new set,
then died at 17:01:15 on the same bind mount as before — `error mounting
".../infra/monitoring/alertmanager/alertmanager.yml" ... not a directory` —
because `infra/` had still never been copied into this app's directory on i3
(steps 1–3 below). The resource then reported `Degraded`.

That blocker is gone. A second manual deployment (`rf9khpe366fd6yxkcxiamszg`, the
same commit, 00:02:32–00:42:46 on 23 Nov, `40m 23s`) ended **Failed** with **no
mount error in any of its 109 log lines**: every container in the set —
`alertmanager`, `migrate`, `backup` and `dns-probe` among them — was created and
started, so `infra/` is in place on i3 now. It stopped one step later, on
`dependency failed to start: container meilisearch-…-20261123T050243 is
unhealthy`, and that container's own log gives the reason: `The master key must
be at least 16 bytes in a production environment. The provided key is only 9
bytes.` `MEILISEARCH_API_KEY` had no value in Coolify, so the compose default
`${MEILISEARCH_API_KEY:-change-me}` — nine bytes — reached `MEILI_MASTER_KEY`,
and Meilisearch refuses to serve in `MEILI_ENV=production` with a key that
short: it restarted, its healthcheck never passed, and `up -d` aborted on the
dependency. The row now holds `PLACEHOLDER-NOT-A-REAL-MEILI-KEY` (32 bytes), so
the container starts; the real Vault key still has to replace it. The
`smtp_password` the api mounts is likewise a 36-byte placeholder, not the real
SMTP submission password.

A third manual deployment (`l5awslraqhukesufwb5ap3r6`, started 01:59:55 on
23 Nov) ran with that row in place. Its log reached `Pulling & building required
images.` at 02:00:19 and the images were still building when the Coolify session
watching it was lost around 02:50. What it produced is up regardless:
`https://api.signara.innotel.us/ready` answers
`{"status":"ok","info":{"postgres":{"status":"up"}}}`, `/health` names
`signara-api`, and the console signed in at `app.signara.innotel.us` calls
`GET https://api.signara.innotel.us/api/v1/auth/me` and
`/api/v1/documents?limit=8`, getting `200` after `204` preflights. The api starts
only when `migrate` has completed and `postgres`, `redis` and `meilisearch` are
healthy, so this run cleared the Meilisearch blocker above. Coolify's own verdict
on the run is still unread — see the forward-auth note below.

One path is easy to mistake for a broken route: `https://api.signara.innotel.us/`
and `/api/health` return the API's own
`{"statusCode":404,"error":"NOT_FOUND","message":["Cannot GET /"]}` in JSON, not
the edge's HTML 404. The paths that answer are `/ready`, `/health` and
`/api/v1/…`; `api.signara.innotel.us` is also the host the OIDC callback
(`/api/v1/auth/callback`) and the compiled web bundle both point at.

Reading the deployment itself once the session came back failed on access, not on
the stack. Coolify sits behind Authentik forward auth, and on 23 Nov every request
to `deploy.innotel.us` — the deployment page and the terminal WebSocket alike —
is sent to
`auth.innotel.us/if/flow/default-provider-authorization-implicit-consent/` and
then returns to the Authentik user portal without a proxy session, with that
portal signed in; `/outpost.goauthentik.io/start?rd=…` behaves the same. Until
that SSO is repaired, the deployment log, the container state and the
server-terminal route below are all closed, so this file records the stack's
behaviour from outside rather than Coolify's status for the run.

After that failed deployment the environment-variable table still reads **`1–10
of 180`**, the same 180 rows it had before the deploy: read while it ran and again
once it ended `Failed`. The doubling to 346 did not come back on the recreated
resource.

Those rows are Coolify's parse of the compose file — every `${VAR}` it
interpolates plus each service's literal `environment:` keys — and the first 174
rows are the estate's `estate.env` ahead of that same parse. They are not a
one-time import either: each save/redeploy re-derives them, which is how the table
went from 180 rows to 346 after the failed deployment of `6555303`, so re-check
the count after every redeploy instead of assuming it is fixed. It is not every
redeploy on its own that doubles the table, though: the failed deployment of that
same commit on the recreated resource left the count at 180. The app's own
settings are rows this time: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`CRYPTO_MASTER_KEY`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ISSUER_URL`,
`OIDC_AUTHORIZATION_URL`, `OIDC_REDIRECT_URI`, `IDP_ADMIN_GROUP`, `AUTH_URL`,
`APP_URL`, `CORS_ORIGINS`, `REDIS_HOST`, `REDIS_PORT` and `POSTGRES_PORT` all sit
in the first block, so the earlier "missing keys" problem is gone. Compose hands
the api `env_file: .env`, which Coolify writes from this table, so what is left
to fear is the blank copies winning over the real ones.

Two deployments ran on the now-deleted i2 copy. The first finished
`exited:unhealthy` because Coolify had imported the repository's `.env.example`
twice, so every key existed in duplicate and `POSTGRES_PASSWORD` could resolve
to `change-me-postgres` in one container and the generated value in another. All
116 duplicate rows were then deleted and the clean set written. Both attempts
are recorded as **Failed** in that copy's history, and its compose containers
sat in a restart loop until the app was deleted.

The i3 copy did have a container set, but never a healthy one: its deployments on
`i3-local` ran 17m 20s (Failed), 37m 46s (Cancelled) and 25m 44s (Failed), the
last one on `6555303`, and the two failures end on a bind mount (below). That
copy's environment page listed the 346 duplicated rows described above, all marked
"Used by Compose", and the containers Coolify did start sat in `Restarting`. It is
the deleted application, not the resource recreated on 22 Nov, whose table holds
180 rows with a failed deployment behind it.

## Remaining blockers

1. **No object store.** ONYX at `192.168.1.71:2090` refuses connections, and
   MinIO in this stack is profile-gated on purpose (its images are no longer
   pullable). Documents cannot be written until ONYX is back or a bucket is
   pointed at via `SIGNARA_S3_ENDPOINT` / `SIGNARA_S3_*`.
2. **The `signara-admins` group, and the API key that needs it.** The OIDC
   application now exists: `application/o/signara/.well-known/openid-configuration`
   at `auth.cerulean.innotel.us` answers `200` with issuer
   `…/application/o/signara/`, the web bundle signs in as client `signara-web`
   with callback `https://api.signara.innotel.us/api/v1/auth/callback`, and on
   23 Nov a user reached the console's dashboard through it. Not verified here:
   the `signara-admins` grant and the service API key minted from it, so
   `SIGNARA_API_KEY` is still unwritten in `deploy/signara/estate.env`.
3. **Both public routes exist.** `app.` and `api.signara.innotel.us` resolve to
   `73.68.203.71` and both answer through the edge: the web app renders, and the
   api answers `/ready`, `/health` and `/api/v1/…` (401 without a bearer token)
   with CORS allowing `https://app.signara.innotel.us`. Do not "fix" this by
   pointing an edge host at `192.168.1.53:8000`: the compose default and
   `estate.env` publish the api on the i3 host's **loopback**
   (`API_BIND_ADDRESS=127.0.0.1`), so such a host would answer 502.
4. **The compose file's file bind mounts cannot resolve under Coolify.**
   `docker-compose.prod.yml` mounts eight files by relative path (seven configs
   plus the SMTP password); Coolify rewrites them under
   `/data/coolify/applications/<uuid>/` but does not copy the repository's
   `infra/` tree there, so Docker creates an empty *directory* for each file
   source and `up -d` dies on `not a directory`. It ended every i3 deployment before 23 Nov;
   `infra/` is now in place on the host, so the mounts no longer fail — see **Why
   the i3 deployment failed** below. `postgres — Error dependency postgres failed to start` in the
   same log is that abort cascading, not a database problem.
5. **The environment rows are doubled, and the second copy is blank where it was
   read.** 346 rows for 162 names: rows 175–346 repeat rows 1–172, and the 26
   rows read there (175–200) carried no value at all, so whichever copy the
   generated `.env` keeps may be the empty one. Rows 201–346 were never read.
   Duplicates are what broke i2, and blanks would break this the same way. That
   was the deleted application; the resource recreated on 22 Nov holds 180 rows,
   and a failed deployment of the same commit left that count at 180. Fix it
   as **step 0** below.

Fix order: dedupe the environment rows (step 0) → repair the bind mounts
(steps 1–3) → redeploy → bring ONYX back → add the user to `signara-admins` →
create the API key and set `SIGNARA_API_URL` (already `https://api.signara.innotel.us`),
`SIGNARA_API_KEY` and `CREDENTIAL_VERIFY_URL`.

## Why the i3 deployment failed (and the commands that fix it)

Not the runner. The same instance reported a `chatterbox` deployment successful
at 04:52 that morning, and signara's own build ran 17 minutes on `i3-local`: it
pulled `innotelinc/signara@6555303`, built both images, and created the volumes
and containers. It then died on one class of problem:

```
Error response from daemon: failed to create task for container: ...
error mounting "/data/coolify/applications/pf1lmgigerzrt8hqrasm2khj/infra/monitoring/alertmanager/alertmanager.yml"
to rootfs at "/etc/alertmanager/alertmanager.yml": not a directory:
Are you trying to mount a directory onto a file (or vice-versa)?
```

`docker-compose.prod.yml` bind-mounts its config files by relative path — eight
file mounts: `./infra/monitoring/alertmanager/{alertmanager.yml,entrypoint.sh,email.tmpl}`,
`./infra/monitoring/prometheus/{prometheus.yml,rules.yml}`,
`./infra/monitoring/dns_probe.py`, `./infra/backup/backup_metrics.py` and
`./infra/secrets/smtp_password` (mounted by both api and alertmanager). `./infra/backup`
is also mounted, but as a directory, so an empty one would start the backup
container and fail at its entrypoint rather than at the mount. Coolify rewrites the
relative paths to absolute ones under `/data/coolify/applications/<uuid>/` but
does not copy the repository's `infra/` tree there. Docker creates an empty
**directory** for each missing file source, and mounting a directory onto a file
fails. Only the first failure reaches the log, and the same condition applies to
the other seven, so repairing `alertmanager.yml` alone would just move the error
to the next file.

These run on **`192.168.1.53`** (the i3 deploy host), as root. None of them has
been run, so each *proves* line describes what success looks like, not captured
output. SSH to i3 from this workstation is refused, so the root path in is
Coolify's own server terminal — **Servers → i3-local → Terminal**
(`/server/adc5d2b4-b58a-4334-a8e7-30504d915622/terminal`) — which opens
`root@i3:~#` through the SSH key Coolify already holds for i3, when its forward
auth is working (see the forward-auth failure recorded above).

`deploy/signara/fix-infra-mounts.sh` is the one-shot, idempotent version of steps
1–3: copy it to the host, run it as root, and check its three `OK n/3` lines the
way the *Proves it* lines below say to. It refuses to copy a `--source` tree that
is not the pinned `6555303` commit unless you also pass `--allow-other-commit`,
and its `OK 1/3` line names the commit it actually copied. It also refuses an
application directory outside `/data/coolify/applications/`: retarget it with
`SIGNARA_APP_DIR`, and add `SIGNARA_ALLOW_OTHER_APP_DIR=1` only for a path that
really is that app's. The manual commands stay as the fallback for when the
script cannot run; change both together.

### 0. Make the environment rows unique and complete

Do this before the redeploy, or the stack comes up with the i2 failure all over
again: the same key in two rows with different values.

Every row count in this step describes the application that was deleted. The
resource that replaced it holds 180 rows, not 346, and its page one carried one
repeated 15-character placeholder rather than the estate's values, so there is no
second block to delete there; what is left is writing the real values into those
rows and de-duplicating any key that still repeats.

The page holds 346 rows for 162 distinct names. Rows 1–174 are the complete
`estate.env` plus the compose keys; rows 175–346 repeat rows 1–172. The 26 rows
of that second block that could be read (175–200) were all blank; rows 1–100 and
201–346 were never read, so emptiness is confirmed only to row 200, not for the
whole block. Twelve keys also repeat inside the first block: `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `NODE_ENV` (three times), `DATABASE_URL`
(twice) and the six `AUTHENTIK_*` / `AUTHENTIK_POSTGRESQL__*` pairs.

Delete the second block's rows first, but look at each value as you go: the 26
rows read there (175–200) are blank and say nothing the first block does not, and
rows 201–346 have the same repeated names but were not opened. Then, for each
secret that still repeats, keep the row whose value the stack must use and delete
the other:

```text
POSTGRES_PASSWORD    compare with  vault kv get -field=POSTGRES_PASSWORD cerulean/signara
REDIS_PASSWORD       compare with  vault kv get -field=REDIS_PASSWORD cerulean/signara
SIGNARA_S3_ACCESS_KEY compare with vault kv get -field=S3_ACCESS_KEY cerulean/signara
SIGNARA_S3_SECRET_KEY compare with vault kv get -field=S3_SECRET_KEY cerulean/signara
MEILISEARCH_API_KEY  compare with  vault kv get -field=MEILISEARCH_API_KEY cerulean/signara
```

Reveal values with the page's **Hide all values** toggle. The rows are separate
records, so deleting one leaves the other: **184 go, 162 stay**. The table is
derived from the compose file, and a redeploy re-creates the variables Coolify
computes from it, so re-check the row count after each redeploy and dedupe again
if it climbs back toward 346.

The settings compose never references are already rows this time, so check their
values against the template rather than adding them:

```text
JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, CRYPTO_MASTER_KEY,
OIDC_CLIENT_ID=signara-web, OIDC_CLIENT_SECRET, OIDC_ISSUER_URL,
OIDC_AUTHORIZATION_URL, OIDC_REDIRECT_URI, IDP_ADMIN_GROUP=signara-admins,
AUTH_URL, APP_URL, CORS_ORIGINS, REDIS_HOST, REDIS_PORT, POSTGRES_PORT
```

URLs and names are in `deploy/signara/estate.env`; secrets are in Cerulean
Vault. Nothing here was done from this workstation — the page was only read,
with no shell and no API token.

*Proves it:* searching the page for `NODE_ENV` returns one row, `POSTGRES_USER`
one, `JWT_ACCESS_SECRET` one, and no row has an empty value.

### 1. Show the directories that should be files

```bash
APP=/data/coolify/applications/4vzo0yw5ipz3m8cx9fuptr4d
find "$APP/infra" -maxdepth 4
find "$APP/infra" -type d \( -name '*.yml' -o -name '*.sh' -o -name '*.py' -o -name '*.tmpl' \) -print
```

*Proves it:* the second command prints every mount source. Each path it prints is
a directory that has to be a file — that list is the bug, stated in one line.

### 2. Put the real files there

```bash
rm -rf "$APP/infra"      # only the empty directories Docker created
rm -rf /tmp/signara-src
git clone https://github.com/innotelinc/signara.git /tmp/signara-src   # add a token if the repo is private
git -C /tmp/signara-src checkout 6555303fce6932bb2118905321b933321a7b369c
cp -a /tmp/signara-src/infra "$APP/infra"
find "$APP/infra" -type d \( -name '*.yml' -o -name '*.sh' -o -name '*.py' -o -name '*.tmpl' \) -print
ls -l "$APP/infra/monitoring/alertmanager/"
```

*Proves it:* the `find` prints nothing, and the `ls` shows `alertmanager.yml`,
`entrypoint.sh` and `email.tmpl` as `-rw-r--r--` instead of `d`. A redeploy should
not undo this — Coolify rewrites the compose file, not the tree beside it — so it
holds until the relative mounts are removed from the compose file upstream.

### 3. Write the SMTP password file by hand

`./infra/secrets/smtp_password` is mounted twice (alertmanager and the api) and is
not committed: at this revision `infra/secrets/` holds only `README.md`. The
clone therefore leaves the path missing, and a missing bind source becomes a
directory exactly like the others, so this step is not optional. Write it
without leaving it in shell history:

```bash
read -rs SMTP && printf '%s' "$SMTP" > "$APP/infra/secrets/smtp_password" && unset SMTP
chmod 0444 "$APP/infra/secrets/smtp_password"
ls -l "$APP/infra/secrets/smtp_password"; wc -c < "$APP/infra/secrets/smtp_password"
```

*Proves it:* mode `-r--r--r--` and a non-zero byte count. The mode is not this
runbook's idea: the compose file's comment on that mount says both consumers are
unprivileged (alertmanager as `nobody`, the api as `signara`) and were refused
the file at 0600, which read as an empty password rather than a permission error.
That rationale is upstream's, quoted here rather than reproduced on i3.

### 4. Redeploy, then prove the stack came up

Press **Redeploy** on the app. The log must end at `Deployment successful` with no
`not a directory` anywhere. Then:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -Ei '4vzo0yw5ipz3m8cx9fuptr4d|signara'
PG=$(docker ps --format '{{.Names}}' | grep -Ei 'postgres.*(4vzo0yw5ipz3m8cx9fuptr4d|signara)' | head -1)
docker exec "$PG" pg_isready
curl -fsS http://127.0.0.1:8000/health; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

*Proves it:* every container is `Up` rather than `Restarting`, Postgres answers
`accepting connections`, and api and web answer on the host's loopback — the
compose file binds `${API_BIND_PORT:-8000}` and `${WEB_BIND_PORT:-3000}` on
`127.0.0.1` by default. If 8000 is refused because something else on i3 already holds it,
set `API_BIND_PORT` for this app; do not move Coolify's own ports.

### 5. What that does not fix

With the stack up, it is still LAN-only and still cannot sign anyone in: the
public hosts, ONYX and the Authentik application are the blockers above, not
deployment problems. A running stack with the placeholder `.env` from the current
environment is enough to reach `/ready`, not enough to issue an award.

## Checks that matter

- `curl -fsS https://api.signara.innotel.us/ready` through the edge, not just on
  loopback.
- Console Health: Signara `ok`, not `failed`.
- One award end to end: submit → `signed` with a verify id → open
  `/verify/{verifyId}` while signed out.
- Revoke that award in the console; `/verify/{verifyId}` must say revoked.
