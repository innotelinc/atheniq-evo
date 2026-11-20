# Deploying the institution on Coolify

This resource deploys the institution service: the public site at
`atheniq.innotel.site` and the registrar panel at `registrar.innotel.site`, from
one container and one registry volume.

The AthenIQ console on port 3100 is a **separate Next.js app** (`upstream/atheniq-console`).
It is not in this Compose file, because both hostnames above are already assigned
to the institution service. If the console should be public as well, give it its
own hostname (for example `console.innotel.site`) and deploy its Dockerfile as a
second Coolify resource. Leaving `CONSOLE_BASE_URL` empty hides the portal's
console link.

## Before deploying

- The repository must be pushed to the Git remote Coolify can read.
- DNS for `atheniq.innotel.site` and `registrar.innotel.site` must point at the
  Coolify server (A/AAAA, or CNAME to its hostname).
- The Stalwart domain must already exist, and its API key must have
  `sysDomainQuery`, `sysAccountCreate` and `sysAccountUpdate`.

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
| `MAIL_DOMAIN` | `atheniq.institute` | Must exist in Stalwart. Use `innotel.us` if that is the mail domain. |
| `STALWART_URL` | `https://mail.innotel.us` | Stalwart JMAP base URL. |
| `STALWART_TOKEN` | `API_…` | Stalwart API key. Secret. |
| `STALWART_QUOTA_BYTES` | `0` or a byte count | `0` means no per-mailbox quota. |
| `CONSOLE_BASE_URL` | empty or a public console URL | Browser link; never `http://console:3100`. |
| `CREDENTIAL_VERIFY_URL` | empty or the Signara verify URL | Optional. |

Generate the registrar hash locally, in the repository root:

```bash
node --input-type=module -e \
  "import { hashPassword } from './apps/institution/src/auth.ts'; console.log(hashPassword(process.argv[1]))" \
  'choose-a-long-password'
```

The service refuses to start in production if `SESSION_SECRET` is missing or
short, if both registrar credentials are empty, or if `MAIL_PROVIDER=stalwart`
is set without `STALWART_URL` and `STALWART_TOKEN`. That is deliberate: a
half-configured mail deployment should fail at startup, not after an admission.

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

Do not add a public `ports:` mapping for 8080. Coolify's proxy is the only
ingress, and the container should not be reachable directly.

## 4. Deploy and verify

1. Deploy. The Dockerfile healthcheck calls `/health` every 15 seconds.
2. Check the deployment logs for:
   `atheniq-institution: listening on 0.0.0.0:8080`, followed by the public and
   registrar origins.
3. Verify externally:

```bash
curl -fsS https://atheniq.innotel.site/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://atheniq.innotel.site/
curl -fsS -o /dev/null -w '%{http_code}\n' https://registrar.innotel.site/
```

The registrar hostname serves the registrar sign-in page; it does not serve the
public site. Sign in with `REGISTRAR_EMAIL` and the password or hash you set.

4. Submit one test application, admit it, and confirm the confirmation says the
mailbox is active. If it says the mailbox is still reserved, read the container
logs for `mailbox provisioning failed`, fix the Stalwart token or domain, then
use **Reset access** on the student record to retry.

## Stalwart checklist

- Domain `MAIL_DOMAIN` exists under **Management → Domains**.
- The API key's account holds the three `sys*` permissions above.
- MX, SPF, DKIM and DMARC are published for the mail domain.
- `https://mail.innotel.us/jmap/` answers; the key is sent as
  `Authorization: Bearer …`.
- A test sign-in to the mailbox works with the student's temporary password.

## What was not done here

No Coolify API token, server URL or Docker daemon was available in this
workspace, so the resource was **not** created or deployed. These files are the
deployable definition; steps 1–4 are the remaining actions on the Coolify host.
