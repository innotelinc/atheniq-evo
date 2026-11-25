# Deploying the institution on Coolify

This resource deploys the institution service: the public site and student portal
at `atheniq.innotel.site`, and the institution's registrar panel at
`registrar.innotel.site` — applications, admission, account issuance and the
student roster — from one container and one registry volume.

`registrar.innotel.site` is **not** the AthenIQ console. Course authoring lives
in this service's `/courses` section, and the console on port 3100
(`upstream/atheniq-console`) is the records and awards service — degree plans and
Signara credentials, with its course pages redirected here. It is not in this Compose file and is not published by this
resource. That is why `CONSOLE_BASE_URL` stays empty: with no public console URL
the portal hides its console link instead of pointing it at a host that does not
answer. To publish the console later, give it its own hostname (for example
`console.innotel.site`) and deploy it as a second Coolify resource.

## Before deploying

- The repository must be pushed to the Git remote Coolify can read.
- DNS for `atheniq.innotel.site` and `registrar.innotel.site` must point at the
  Coolify server (A/AAAA, or CNAME to its hostname).
- The Stalwart domain must already exist, the API key must grant `Inherit`
  permissions (Stalwart refuses account writes from a narrowed key), and
  `https://mail.innotel.us/jmap/` must answer. The service checks URL, key and
  domain at startup, so a wrong value fails the deploy before it serves a page.

## 0. Put the API token in a file

The deploy is driven from this repository, so the token lives in a gitignored
file rather than in a shell history or a chat message:

```bash
cp deploy/coolify/.env.coolify.example .env.coolify
```

In Coolify: **Keys & Tokens → API tokens → Create New Token**, name it
`atheniq-deploy`, give it the `write` permission (the default `read` cannot
deploy), and copy the value once — the UI never shows it again. Put it in
`COOLIFY_TOKEN` and the instance URL in `COOLIFY_BASE_URL` (`https://…` or
`http://host:8000`, without `/api/v1`). Leave `COOLIFY_SERVER_UUID` empty on a
single-server instance.

```bash
git check-ignore -v .env.coolify   # must match .gitignore's `.env.*`
```

That check is worth running before pasting the token: `.env.coolify` is ignored,
while `deploy/coolify/.env.coolify.example` is committed. Nothing in this
repository prints either value.

## 0b. Or let the script do steps 1–4

`scripts/coolify-deploy.mjs` drives the API with the token from §0. It never
prints a secret value: dry runs show `"<64 chars>"` where a secret would be.

```bash
node scripts/coolify-deploy.mjs --init      # write .env.coolify with generated secrets
node scripts/coolify-deploy.mjs --dry-run   # print every request, send none
node scripts/coolify-deploy.mjs             # project, resource, env, domains, deploy
```

What it does, in order: health-check the panel; resolve the server record named
by `COOLIFY_SERVER`; create the `atheniq` project if absent; create the Docker
Compose resource from `/docker-compose.coolify.yml` on `main` (or reuse it); set
`SESSION_SECRET`, the registrar credentials, the real URL pair, `TRUST_PROXY` and
`COOKIE_SECURE`; put both hostnames on the `institution` service through
`docker_compose_domains`; then `POST /deploy`. Re-running it is safe — an
existing project, resource and matching env var are left alone.

`COOLIFY_SERVER` defaults to **`i2-local`**: `i3-local` is the intended
destination, but i3's Docker 29 session dies at `exporting layers`
(`deploy/signara/README.md`), so the build runs on i2 (42 GB free, Docker
29.10.0) and Coolify's proxy config still routes the hostnames to the container.

## 1. Create the resource

1. In Coolify, open the project **atheniq** (create it if it does not exist).
2. **New Resource → Docker Compose**.
3. Choose the `atheniq-evo` repository and branch `main`.
4. Set the Compose file to `/docker-compose.coolify.yml`.
5. Save, then review the rendered Compose content.

The build context is `./apps/institution`; there is no separate image registry
step. Coolify builds the image from the repository on each deploy.

## 2. Set the environment

Set these in the resource's **Environment Variables** before the first deploy.
Mark the secrets as secrets in Coolify.

| Variable | Value | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | 32+ random characters | Signs portal and registrar cookies. Required. |
| `REGISTRAR_EMAIL` | `registrar@atheniq.institute` | Bootstrap registrar sign-in. |
| `REGISTRAR_PASSWORD_HASH` | `scrypt$…` | Preferred. Generate it with the command below. |
| `REGISTRAR_PASSWORD` | a 12+ character password | Alternative to the hash; remove after first boot. |
| `MAIL_PROVIDER` | `stalwart` | `local` reserves addresses without creating mailboxes. |
| `MAIL_DOMAIN` | `atheniq.institute` | Must exist in Stalwart; checked at startup. Use `innotel.us` if that is the mail domain. |
| `STALWART_URL` | `https://mail.innotel.us` | Stalwart JMAP base URL; checked at startup. |
| `STALWART_TOKEN` | `API_…` | Secret. Required with `MAIL_PROVIDER=stalwart`; checked at startup. |
| `STALWART_QUOTA_BYTES` | `0` or a byte count | `0` means no per-mailbox quota. |
| `CONSOLE_BASE_URL` | leave empty | The console is not published by this resource. |
| `CREDENTIAL_VERIFY_URL` | empty or the Signara verify URL | Optional. |

Generate the registrar hash locally, in the repository root:

```bash
node --input-type=module -e \
  "import { hashPassword } from './apps/institution/src/auth.ts'; console.log(hashPassword(process.argv[1]))" \
  'choose-a-long-password'
```

The service refuses to start in production if `SESSION_SECRET` is missing or
short, if both registrar credentials are empty, if `COOKIE_SECURE=false`, or if
the Stalwart preflight fails. That is deliberate: a half-configured deployment
should fail at startup, not after an admission.

## 3. Assign both domains

Open the resource's **Domains** tab and add two domains to the `institution`
service. Use protocol HTTPS and internal port `8080` for each:

```
atheniq.innotel.site       -> 8080
registrar.innotel.site     -> 8080
```

Coolify routes by hostname to the same container. The service reads
`X-Forwarded-Host` because `TRUST_PROXY=true`; without that, every request would
look like the internal container host and the registrar would never appear.

Both names reach the same container, but they do not serve the same pages:
`registrar.innotel.site` answers with the registrar sign-in and, once signed in,
the registrar panel. It never serves the public site, and the public host never
serves the panel.

Do not add a public `ports:` mapping for 8080. Coolify's proxy is the only
ingress, and the container should not be reachable directly. Do not point any
domain at port 3100 from this resource; there is no service listening there.

## 4. Deploy and verify

1. Deploy. The Dockerfile healthcheck calls `/health` every 15 seconds.
2. Check the deployment logs for the preflight, then the listener:

   ```
   atheniq-institution: mail preflight ok (atheniq.institute at https://mail.innotel.us)
   atheniq-institution: listening on 0.0.0.0:8080
   ```

   No preflight line with `MAIL_PROVIDER=local` is expected; that is the
   reserve-only mode.
3. Verify externally:

```bash
curl -fsS https://atheniq.innotel.site/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://atheniq.innotel.site/
curl -fsS -o /dev/null -w '%{http_code}\n' https://registrar.innotel.site/
```

Sign in at `https://registrar.innotel.site/signin` with `REGISTRAR_EMAIL` and the
password or hash you set.

4. Submit one test application, admit it, and confirm the confirmation says the
mailbox is active. If it says the mailbox is still reserved, read the container
logs for `mailbox provisioning failed`, fix the Stalwart token or domain, then
use **Reset access** on the student record to retry.

## When the mail preflight fails

The process exits with status 78 and prints one line naming the setting, so the
failure is in the deployment log rather than in a student's admission:

```
atheniq-institution: mail preflight failed: <reason>
```

| Reason | What it means | Fix |
| --- | --- | --- |
| `Stalwart is unreachable at https://…` | DNS, TLS or the host is down | Correct `STALWART_URL`, or bring Stalwart up |
| `Stalwart refused the API key (401)` | The bearer token is wrong or expired | Put a new key with `Inherit` permissions in `STALWART_TOKEN` |
| `Stalwart refused the API key (403)` | The key exists but may not query domains | Grant `sysDomainQuery` to the key's account |
| `Stalwart has no domain atheniq.institute` | `MAIL_DOMAIN` is not a domain in Stalwart | Create the domain in Stalwart, or set `MAIL_DOMAIN` to one that exists |

With `restart: unless-stopped` Coolify restarts the container until the check
passes, so the log shows the same reason each time. A passing preflight does not
prove delivery; the admitted mailbox in step 4 is the real test.

## Stalwart checklist

- Domain `MAIL_DOMAIN` exists under **Management → Domains**.
- The API key's account holds the three `sys*` permissions above.
- MX, SPF, DKIM and DMARC are published for the mail domain.
- `https://mail.innotel.us/jmap/` answers; the key is sent as
  `Authorization: Bearer …`.
- A test sign-in to the mailbox works with the student's temporary password.

## How this resource is actually deployed

Deployed 25 Nov 2026 from `scripts/coolify-deploy.mjs` against the panel at
`http://192.168.1.85:8000`:

- **Server** `i2-local` (`192.168.1.52`); resource `xw65pbpnsz7vlw2uhf0hbnpv`
  in project `AthenIQ`, environment `production`.
- **Build** happens on i2 from the private GitHub App; the image tag is the
  commit, so the running container always names its source commit.
- **The edge still terminates TLS.** The NPM edge (`192.168.1.71`) answers for
  both hostnames with its `*.innotel.site` certificate and proxy host **412**
  forwards to `https://192.168.1.52:443` with `proxy_ssl_verify off`. It has to
  be HTTPS: the panel's Traefik answers port 80 with a redirect to 443.
- **The proxy on i2 belongs to the panel.** `/data/coolify/proxy/docker-compose.yml`
  is written from the saved configuration in the panel (Server → Proxy), and
  starting, stopping or editing the proxy there is what restarts `coolify-proxy`.
  Its configuration here differs from the panel default in two ways, both stored
  in the panel: the `8080:8080` port mapping is dropped, because `oauth2-proxy`
  already owns host port 8080 on i2, and no ACME resolver is defined, because
  TLS for these names ends at the edge. Traefik therefore logs
  `Router uses a nonexistent certificate resolver` for routers labelled with
  `letsencrypt`; the routes still serve.
- **`/data` is chowned for you.** The compose file's one-shot `data-init` service
  runs `chown -R 1000:1000 /data` before `institution` starts, so a fresh volume
  no longer needs a manual `chown` on the host: that was the only reason the
  first deployment had to be corrected by hand.
- **The deploy token used for this run was revoked** once the deployment
  finished. Create a fresh token in §0 before running the script again; a
  revoked token answers `401` and the script stops at its health check.

Check it from outside:

```bash
curl -fsS https://atheniq.innotel.site/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://registrar.innotel.site/
```

The registrar sign-in, an admission and the resulting mailbox have not been
exercised yet; those are steps 4 of §4, and they need the registrar password or
hash that is set in the resource's environment.
