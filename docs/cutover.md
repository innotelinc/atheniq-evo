# Cutover: `registrar.atheniq.institute` and `classroom.atheniq.institute`

This is the change that puts the institution on the registrar hostname, gives
OpenMAIC a hostname the registrar may frame, and moves the Next.js console off
that hostname. Every command below is written to be run once you hold DNS and
edge access. **None of it has been run against the public hosts** — the iframe
was proven locally over a same-site pair, and that proof is repeated here for the
real names.

## What is true today

Checked from outside; none of it is a plan, it is the starting state.

| Name | Resolves to | Answers today |
| --- | --- | --- |
| `registrar.atheniq.institute` | `73.68.203.71` (edge) | the Next.js console on `192.168.1.17:3100`, behind Authentik forward auth |
| `classroom.atheniq.institute` | `73.68.203.71` | nothing: the TLS handshake fails with `alert 112` (`unrecognized name`) — no vhost, no certificate |
| `bridge.atheniq.institute` | does not exist | — and it must stay that way; the bridge is internal |
| `console.atheniq.institute` | does not exist | — the console's new home |
| `class.atheniq.courses` | a different install | OpenMAIC behind Authentik. A different registrable domain, so a registrar cookie cannot reach it |

The target:

| Name | Edge → origin | Serves |
| --- | --- | --- |
| `registrar.atheniq.institute` | i3 `192.168.1.53:8081` | the institution (container port 8080) |
| `classroom.atheniq.institute` | i3 `192.168.1.53:3001` | OpenMAIC (container port 3000) |
| `console.atheniq.institute` | wherever the console runs today (`192.168.1.17:3100`, or i3 `:3100`) | the Next.js console: awards, degree plans, mobile API |

Host ports `8081` and `3001` rather than `8080` and `3000` because i3 already
answers on 8080 and Signara's web container binds loopback `:3000` on that host.
Check before you start, and change the numbers below if yours differ:

```bash
ss -ltnp | grep -E ':(8080|8081|3000|3001|3100) '
```

## Why the order matters

The console's new middleware sends `/courses` and `/generate` to
`INSTITUTION_CONSOLE_URL`, whose default is `https://registrar.atheniq.institute`.
If that middleware is live while the registrar host still points at the console,
`/courses` redirects to itself and never resolves. So the institution must
answer at the registrar host **before** the console image carrying patch
`0002-institution-owns-the-course-catalog` is deployed there. Steps 1–4 are in
that order; the console is step 5.

## 0. Prerequisites, off the edge

**Move the mobile app first.** `upstream/atheniq-console/mobile` defaults to
`https://registrar.atheniq.institute` for `EXPO_PUBLIC_API_BASE` and its
`privacyPolicyUrl`. Point both at `https://console.atheniq.institute` and publish
an app build before the registrar host moves, or the installed app starts
answering from the institution, which serves none of its routes.

**Ports.** In `.env` on i3:

```dotenv
INSTITUTION_PORT=8081
OPENMAIC_PORT=3001
CONSOLE_PORT=3100
```

**The institution's own values.** These are the production values for the three
`.atheniq.institute` names; `deploy/coolify/README.md`'s `innotel.site` pair is a
different deployment and is not this one.

```dotenv
INSTITUTION_ORIGIN="https://atheniq.institute"
REGISTRAR_ORIGIN="https://registrar.atheniq.institute"
SESSION_SECRET=<openssl rand -hex 32>
REGISTRAR_EMAIL="registrar@atheniq.institute"
REGISTRAR_PASSWORD_HASH='scrypt$…'        # preferred; REGISTRAR_PASSWORD only until it exists
COOKIE_SECURE=true
INSTITUTION_SEED_DEMO=false
MAIL_DOMAIN="atheniq.institute"
# The embedded classroom.
OPENMAIC_PUBLIC_URL="https://classroom.atheniq.institute"
CLASSROOM_COOKIE_DOMAIN=".atheniq.institute"   # arrives as ATHENIQ_CLASSROOM_COOKIE_DOMAIN
OPENMAIC_FRAME_ANCESTORS="https://registrar.atheniq.institute"   # OpenMAIC build arg
# The catalog's one owner, and the links that point at the records console.
INSTITUTION_CONSOLE_URL="https://registrar.atheniq.institute"
CONSOLE_BASE_URL="https://console.atheniq.institute"
CREDENTIAL_VERIFY_URL="https://console.atheniq.institute/verify"
```

`TRUST_PROXY` is deliberately absent: the edge must preserve `Host`, and the
institution chooses its surface from it. Set `TRUST_PROXY=true` only if the proxy
in front rewrites `Host` and sets `X-Forwarded-Host` itself.

The three secrets are generated, not chosen (`openssl rand -hex 32`, `-hex 24`,
`-hex 24`), and each pair holds one value on both sides of its boundary:
`BRIDGE_JWT_SECRET` = `ATHENIQ_BRIDGE_JWT_SECRET`,
`BRIDGE_SERVICE_TOKEN` = `ATHENIQ_BRIDGE_SERVICE_TOKEN` and
`CONSOLE_SERVICE_TOKEN`, `BRIDGE_HOOK_SECRET` = `ATHENIQ_BRIDGE_HOOK_SECRET`.

**Two values are baked into images at build time.** OpenMAIC's CSP
(`ALLOWED_FRAME_ANCESTORS`) and the console's redirect target
(`INSTITUTION_CONSOLE_URL`) are read by `next build`, not at runtime. A restart
will not change either; `docker compose build openmaic console` will.

## 1. Bring the stack up, before any edge change

```bash
cd /srv/atheniq-evo            # wherever the repository lives on i3
bash scripts/bootstrap.sh      # fetches upstream/ at the pinned commits and patches it
docker compose build           # OpenMAIC's build takes ~15 minutes and needs the heap
docker compose up -d
docker compose ps
```

The OpenMAIC build wants a few gigabytes of headroom: it compiles with
`NODE_OPTIONS=--max-old-space-size=3072`. On an 8 GB Windows workstation whose
Docker VM had 3.9 GB, `pnpm install` finished in 41 minutes and the engine then
died during `next build` (`failed to receive status: rpc error: code =
Unavailable ... EOF`), so raise Docker's memory well above that heap (6 GB is a
workable floor) or build on i3 as above.

It does not have to be built on either. The `openmaic image` workflow fetches
OpenMAIC at the pinned commit (`scripts/bootstrap.sh --only OpenMAIC`), builds it
with the registrar origin, asserts the `frame-ancestors` line on the running
container, and publishes `ghcr.io/innotelinc/atheniq-evo-openmaic` as `latest` and
`sha-<commit>`. A workstation can then pull that image instead of compiling, or
load the run's artifact (`gh run download <run> --name openmaic-image`, then
`docker load`).

Prove each surface by hostname against loopback — this is the check that matters
before a proxy can confuse you:

```bash
curl -fsS http://127.0.0.1:8081/health
curl -s -o /dev/null -w 'registrar /   %{http_code}\n' -H 'Host: registrar.atheniq.institute' http://127.0.0.1:8081/
curl -s -o /dev/null -w 'registrar /courses %{http_code} -> %{redirect_url}\n' -H 'Host: registrar.atheniq.institute' http://127.0.0.1:8081/courses
curl -s -o /dev/null -w 'openmaic  /   %{http_code}\n' http://127.0.0.1:3001/
curl -sI http://127.0.0.1:3001/ | grep -iE 'content-security-policy|x-frame-options'
```

*Proves it:* `/health` answers `ok`, an unauthenticated registrar path answers
`303` to `/signin` (not the public site), `/courses` answers `200` once signed in
and `303` when not — never `404` — and OpenMAIC's CSP line reads
`frame-ancestors 'self' https://registrar.atheniq.institute` with no
`X-Frame-Options` beside it. If `X-Frame-Options: SAMEORIGIN` is still there, the
image was built without `OPENMAIC_FRAME_ANCESTORS` and the frame will be blocked
no matter how right the cookie is.

That composition is already exercised locally, with the two public names mapped
to a local stack: the image built with the argument above served this exact
line, the registrar's iframe rendered its classroom with `bridged: true` and
the `.atheniq.institute` cookie, and Chromium refused the same frame from a host
the policy does not name. What this step adds is the edge in front of it.

## 2. DNS

Two records in Technitium, zone `atheniq.institute`, TTL 300 (the registrar and
classroom already point at the edge; only `console` is new):

| Name | Type | Value |
| --- | --- | --- |
| `console` | A | `73.68.203.71` |
| `classroom` | A | `73.68.203.71` (exists — confirm it is unchanged) |
| `registrar` | A | `73.68.203.71` (exists — unchanged) |

```bash
for h in registrar classroom console; do printf '%-10s %s\n' "$h" "$(dig +short "$h.atheniq.institute" @192.168.1.71)"; done
```

The bridge gets no record. It is reached as `http://bridge:8787` inside the
Compose network and `127.0.0.1:8787` on the host.

## 3. The edge

Two layers answer for `atheniq.institute` today — an openresty front and an NPM
instance on `192.168.1.71` — and the TLS error on `classroom` shows which one
decides: `alert 112` is a name with no certificate. Add the two names **where
`registrar` is defined now**, and if openresty fronts NPM, add them in both, or
the outer layer will answer with the same `unrecognized name`.

For each name:

- **Forward** to i3's LAN address, port `8081` (institution) or `3001` (OpenMAIC).
  Not `localhost`, not the container name.
- **Preserve `Host`** — `proxy_set_header Host $host`. The institution refuses to
  guess its surface from anything else.
- **TLS**: a certificate covering the name. Let's Encrypt HTTP-01 needs port 80 of
  the name to reach the ACME client; if openresty holds 80, use DNS-01 against
  Technitium, or reuse the existing certificate if it covers the name.
- **No Authentik forward auth on `registrar`.** The institution has its own
  sign-in, and its POSTs check `Origin` against `Host`. An outpost in front means
  two logins and a session the institution never issued. If you want forward auth
  for the console, put it on `console.atheniq.institute` only.
- **Websockets and long responses** on `classroom`: OpenMAIC streams generation
  output, so leave `proxy_buffering off`, raise the read timeout to 300s, and
  allow a 200 MB body (its own `proxyClientMaxBodySize` is 200 MB).

NPM's *Advanced* tab is nginx, so the equivalent there is:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_buffering off;
proxy_read_timeout 300s;
client_max_body_size 200m;
```

The Caddy form, if the estate moves to it, is in `docs/institution.md`.

```bash
for h in atheniq.institute registrar.atheniq.institute classroom.atheniq.institute console.atheniq.institute; do
  printf '%-30s ' "$h"
  echo | openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null || echo 'NO CERTIFICATE'
done
```

*Proves it:* each name returns a certificate whose `CN`/`SAN` covers that exact
name — the failure on `classroom` is exactly the absence of this line — and
`atheniq.institute` still renders the public site.

## 4. Prove both hosts from outside, with no console involved

```bash
curl -fsS https://registrar.atheniq.institute/health
curl -s -o /dev/null -w 'registrar /        %{http_code}\n' https://registrar.atheniq.institute/
curl -s -o /dev/null -w 'registrar /signin  %{http_code}\n' https://registrar.atheniq.institute/signin
curl -s -o /dev/null -w 'classroom /        %{http_code}\n' https://classroom.atheniq.institute/
curl -sI https://classroom.atheniq.institute/ | grep -i 'content-security-policy'
```

*Proves it:* `/health` is `200`, `/` is `303` to `/signin` (a signed-out
registrar), `/signin` renders the institution's own form — not Authentik — and
the classroom host answers with its CSP named above. A `502` here is the edge
pointing at the wrong i3 port; a `404` on `/signin` is the edge pointing at
something that is not the institution.

## 5. Now the console

Only now is it safe to run an image with patch 0002 on any host whose `/courses`
would land back on itself.

```bash
INSTITUTION_CONSOLE_URL=https://registrar.atheniq.institute \
  docker compose build console
docker compose up -d console
```

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://console.atheniq.institute/courses
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://console.atheniq.institute/generate
curl -s -o /dev/null -w '%{http_code}\n' https://console.atheniq.institute/api/courses
```

*Proves it:*

```
308 https://registrar.atheniq.institute/courses
308 https://registrar.atheniq.institute/courses/generate
200
```

`/generate` landing on `/generate` instead of `/courses/generate` means the image
predates the path translation. A second `308` when you follow the first one means
the registrar host is still the console: stop, the loop is live.

## 6. The classroom proof, on the real hosts

**In a browser, signed in as the registrar.** This is the proof the whole cutover
exists for:

1. Sign in at `https://registrar.atheniq.institute/signin` with
   `REGISTRAR_EMAIL` and the password or hash you set.
2. **Courses** → open a course → **AI classroom** (or create one, then open it).
3. Press **Start classroom** (the bridge creates it) and then **Sign in to
   classroom**.
4. DevTools → Application → Cookies: `atheniq_classroom` on `Domain=.atheniq.institute`,
   `Secure`, `HttpOnly`, `SameSite=Lax`, ~15 minutes of life.
5. Network, filtered to the frame: `https://classroom.atheniq.institute/api/atheniq/classroom`
   answers `{"bridged":true,…}` with the registrar's identity, and the frame
   renders the room instead of asking for a sign-in.

**From the host, without a browser.** Mint a token through the bridge inside the
network — the token is a credential, so only its length and prefix are printed —
then ask the public classroom host what it thinks of it:

```bash
COURSE_KEY=course-v1:AthenIQ+AI101+2027A     # a course the catalog holds

TK=$(docker compose exec -T -e COURSE_KEY="$COURSE_KEY" institution node --input-type=module -e '
  const r = await fetch("http://bridge:8787/v1/sso/classroom", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.ATHENIQ_BRIDGE_SERVICE_TOKEN}`,
    },
    body: JSON.stringify({
      learnerId: "stf_registrar",
      name: "Registrar preview",
      email: process.env.REGISTRAR_EMAIL,
      courseKey: process.env.COURSE_KEY,
      role: "instructor",
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.token) { console.error(r.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  process.stdout.write(body.token);
' )
printf 'token: %s chars, prefix %s\n' "${#TK}" "${TK:0:8}"

curl -s -H "Cookie: atheniq_classroom=$TK" \
  https://classroom.atheniq.institute/api/atheniq/classroom; echo
curl -s -H "Cookie: atheniq_classroom=${TK%?}x" \
  https://classroom.atheniq.institute/api/atheniq/classroom; echo
```

*Proves it:* the first call answers `{"bridged":true,"courseKey":"course-v1:…",
"classroomId":"cls_…","learner":{"role":"instructor"}}`; the tampered token does
**not** answer `bridged:true`. The `-e` form passes the course into the container's environment
without putting it in the compose file or the container's configuration.

If the browser and the curl disagree, the browser is sending a different cookie
than you think: compare the cookie's `Domain` with the frame's origin, and check
that both are `https`.

| Symptom on the real hosts | Cause | Check |
| --- | --- | --- |
| The frame is blank, console shows `Refused to frame` | OpenMAIC's CSP does not name the registrar | the `frame-ancestors` line above; rebuild with `OPENMAIC_FRAME_ANCESTORS` |
| The frame renders OpenMAIC's sign-in wall | the cookie did not cross | `Domain=.atheniq.institute`, `Secure`, both HTTPS, same registrable domain |
| `/api/atheniq/classroom` answers `{"bridged":false}` | no cookie reached OpenMAIC | the DevTools cookie list, then the curl above |
| `INVALID_CREDENTIAL` | the two JWT secrets differ | `BRIDGE_JWT_SECRET` on the bridge vs `ATHENIQ_BRIDGE_JWT_SECRET` on OpenMAIC |
| The room loads and then drops to sign-in after ~15 minutes | the classroom cookie's life is 900 seconds by design | re-enter from the course page; that mints a new one |
| `POST /v1/classrooms` answers `502` | the bridge cannot reach OpenMAIC | `docker compose exec institution curl -s http://bridge:8787/health` |

## 7. After the proof

- The institution is now the only staff console, and `registrar` is its host.
- The console keeps awards, degree plans and the mobile API on
  `console.atheniq.institute`; its `/courses` and `/generate` are one hop away.
- `atheniq.courses` and `class.atheniq.courses` are untouched: the LMS and the
  other OpenMAIC install have their own hosts and their own Authentik
  applications. Nothing in this cutover changes them.

## Rolling back

The edge is the switch, and the old console is still running:

1. Point `registrar.atheniq.institute` back at `192.168.1.17:3100` and re-add its
   Authentik forward auth if you removed it. The institution keeps answering on
   its i3 port; only the public name moves.
2. `classroom.atheniq.institute` can be left published — it harms nothing while
   the registrar does not frame it — or its vhost removed.
3. The console's `/courses` will still `308` to the institution. That is a working
   redirect while the institution is up, not a loop: the loop only exists when the
   registrar host points at the console. If you need the old catalog pages back,
   redeploy the console image built before patch 0002.

Nothing in this cutover migrates data. `institution-data` is a fresh volume: the
catalog it serves after step 1 is the seed in `content.ts` until a registrar edits
it, so take the chance to confirm the seed is what you want on the record.

## What this does not cover

- The bridge, the LMS and Signara keep their own deployment stories
  (`docs/runbook.md`, `deploy/signara/README.md`). Only the registrar and
  classroom names move here.
- No student-facing host changes. `atheniq.institute` and the portal are already
  served by this service.
- The mobile app build described in step 0 is a prerequisite, not part of this
  runbook: an app release cannot be rolled back by an edge change.
