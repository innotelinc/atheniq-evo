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
request successfully. What is set up (instance `deploy.innotel.us`, server
`i2-local` = `192.168.1.52`, project **AthenIQ**):

| Setting | Value |
| --- | --- |
| Resource | `signara`, type **Docker Compose** |
| Source | `github.com/innotelinc/signara`, branch `main`, public repo |
| Compose file | `/docker-compose.prod.yml` |
| Host ports | web `13000` → 3000, api `18000` → 8000 |
| Profiles | `authentik` off (`AUTHENTIK_MODE=remote`), `legacy-storage` off |

`8000` is not usable on that host: it belongs to Coolify itself, and a stack
that binds it fails with `port already allocated`. The 18xxx/13xxx pair is why
the published ports differ from upstream's defaults.

Forty environment variables are stored in Coolify, with every secret generated
there and never written to this repository: `POSTGRES_PASSWORD`,
`REDIS_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`CRYPTO_MASTER_KEY`, `MEILISEARCH_API_KEY`, the two `SIGNARA_S3_*` keys.
`DATABASE_URL` and `REDIS_URL` are derived from those parts, and the OIDC values
point at `https://auth.cerulean.innotel.us/application/o/signara/`.

Two deployments have run:

1. `co6a9fkpcqt55qmblcbakofw` — finished `exited:unhealthy`. Coolify had imported
   the repository's `.env.example` twice, so every key existed in duplicate and
   `POSTGRES_PASSWORD` could resolve to `change-me-postgres` in one container and
   the generated value in another.
2. `p6bnmblziyzwx49ob6lyelur` — queued after all 116 duplicate rows were deleted
   and the clean set written. **Its result was never observed**: Coolify stopped
   answering at that point and has not been reachable since.

## Remaining blockers

1. **No object store.** ONYX at `192.168.1.71:2090` refuses connections, and
   MinIO in this stack is profile-gated on purpose (its images are no longer
   pullable). Documents cannot be written until ONYX is back or a bucket is
   pointed at via `SIGNARA_S3_ENDPOINT` / `SIGNARA_S3_*`.
2. **No OIDC application.** Nothing in the estate yet provides
   `application/o/signara/` at `auth.cerulean.innotel.us` or the `signara-admins`
   group. Without it nobody can sign in, and an API key cannot be minted, so the
   console stays on `queued_local`.
3. **No public route.** `api.` and `app.signara.innotel.us` both resolve to
   `73.68.203.71` and terminate on the `.71` edge, which has no `api.` vhost.
   The Coolify stack listens on `192.168.1.52:13000` and `:18000`, reachable on
   the LAN only.
4. **Coolify itself is down.** `deploy.innotel.us` accepts TCP on 443 and then
   hangs while the rest of the edge serves normally (workforce, mail), so the
   pending deployment above is not cancelled and the API tokens created during
   setup are not yet revoked. Restart the Coolify container on `.52` first.

Fix order: restart Coolify and cancel the pending deployment → revoke the
setup tokens (`atheniq-deploy`, `atheniq-signara`, `atheniq-root` in Keys &
Tokens) → bring ONYX back → create the Authentik application and group → add an
`api.signara.innotel.us` vhost pointing at `192.168.1.52:18000` → create the API
key and set `SIGNARA_API_URL`, `SIGNARA_API_KEY` and `CREDENTIAL_VERIFY_URL`.

## Checks that matter

- `curl -fsS https://api.signara.innotel.us/ready` through the edge, not just on
  loopback.
- Console Health: Signara `ok`, not `failed`.
- One award end to end: submit → `signed` with a verify id → open
  `/verify/{verifyId}` while signed out.
- Revoke that award in the console; `/verify/{verifyId}` must say revoked.
