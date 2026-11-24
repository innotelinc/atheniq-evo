# The institution

AthenIQ Institute is the university the rest of this estate serves. This document
describes the institution surfaces added in `apps/institution`, how they relate
to the console, the bridge and the LMS, and what a real institution still needs
before it should put its name on a degree.

The short version: **one service, two hostnames.**

| Host | Surface | Who it is for |
| --- | --- | --- |
| `atheniq.institute` | public site, admissions, student portal | prospective students, applicants, enrolled students |
| `registrar.atheniq.institute` | console: applications, account issuance, roster, course catalog | the registrar and admissions staff |

**One console.** This is the staff console, and it owns the catalog. The Next.js
console in `upstream/atheniq-console` keeps awards, degree plans and the service
routes the bridge calls, but it takes no registrar host and no longer authors
courses: its `/courses` and `/generate` pages answer `308` here
(`INSTITUTION_CONSOLE_URL`). Adding a second catalog editor was two answers to
"what is this course", and the institution's answer is the one the portal
registers against. One migration dependency comes with the cutover: the console's
mobile app (`upstream/atheniq-console/mobile`) defaults to
`https://registrar.atheniq.institute` for its API and privacy URL. Point
`EXPO_PUBLIC_API_BASE` and `privacyPolicyUrl` at the console's own host (or at
this service, once it serves those routes) before the registrar host moves.

## Who owns what

The estate already has one rule: the system that owns a fact is the only one
that may decide it. The institution extends the table rather than replacing it.

| Fact | Owner | Everyone else |
| --- | --- | --- |
| A person applied | Institution registry | admissions staff read it; nobody else |
| A person is admitted, and their student number | Institution registrar | the console receives the learner id `lrn_…` |
| A student's portal account and password | Institution registry | the bridge never sees a password |
| An `@atheniq.institute` address | Institution registry (reserved) → mail provider (delivered) | the portal displays its state |
| The Institute's course catalog and teaching schedule | Institution console (`src/catalog.ts`, `src/ai.ts`) | the public site, the portal and the LMS sync read it; the LMS serves the courseware; the Next.js console redirects its course pages here |
| Registration for a term course | Institution registry | the LMS enrollment is the next sync |
| Courseware, progress, gradebook | Open edX LMS | bridge writes completion and optional grade |
| What an AI classroom observed | Bridge ledger | portal and console read it |
| Eligibility for an award | Console (`lib/eligibility.ts`) | the bridge asks; the institution does not decide |
| Signature and verification | Signara | the console holds the award; the registrar links to it |

The student id issued here is `lrn_…` and is the **same id** the bridge mints
classroom tokens for and the console records. There is no mapping table: one
person, one id, from application to award.

## The student lifecycle

```
apply ─────────► application (status: submitted)
                    │
                    │ registrar reads, interviews, decides
                    ▼
admit ─────────► one write creates:
                    · student number   ATH-2027-0001
                    · student id       lrn_…
                    · portal account   scrypt password, forced change
                    · mailbox          first.last@atheniq.institute (reserved)
                    │
                    ▼
activate ──────► student signs in with the temporary password,
                    sets their own, reaches the portal
                    │
                    ▼
register ──────► seat held (seats are real; a full studio is full)
                    │
                    ▼
learn ─────────► AI classroom (bridge token, console launch)
                    │
                    ▼
complete ──────► completion fan-out → LMS, console, Signara
                    │
                    ▼
award ─────────► signed credential with a verify id, verifiable by anyone
```

Admission is the only place a password is minted, and the plaintext is returned
**once**, to the registrar, on the confirmation page. It is stored only as a
scrypt hash. If that page is lost, the registrar issues a reset; nobody can
recover the password, including the Institute.

## The course catalog

Courses are data, not code. The institution console's **Courses** section is the one writer of
`$INSTITUTION_DATA_DIR/catalog.json`, and every surface reads it: the public
program pages and the academic schedule, the student's registration page, the
registrar's roster, and the LMS sync.

- **Add, edit, remove.** A course record is the catalog entry, the registration
  rules and the LMS runtime key in one. The code (`AI101`) and term (`2027A`)
  produce `course-v1:AthenIQ+AI101+2027A`. A code is not editable: removing and
  re-adding is the honest way to change one, because enrollment and classroom
  records name it.
- **A removal is refused while enrollments exist.** Archive the course instead;
  a delete that orphans a student's record is worse than a catalog that keeps a
  retired course.
- **Draft versus published.** Only a published course is listed for students and
  open for registration. A draft is a registrar's working record.
- **The seed is `content.ts`.** A new data directory materialises the published
  curriculum on first boot, so the public site never points at an empty catalog.
  After that the file is the source of truth.

### Generated with AI

`/courses/generate` turns a sentence into a complete draft: title, summary,
description, outcomes, prerequisites, audience, 3–6 modules with typed lessons
and minutes, an assessment per module, and a grading mix that must sum to 100%.
Two engines, one contract:

- **The model gateway** — `OMNIROUTE_BASE_URL`, `OMNIROUTE_MODEL`,
  `OMNIROUTE_API_KEY` (server-side only, never in a view or the browser). The
  reply is coerced back into the draft schema, so a malformed answer cannot
  reach the catalog.
- **The curriculum rules** — deterministic and dependency-free, used when no key
  is configured or the gateway fails. The preview says which engine wrote the
draft.

Nothing is saved until a registrar accepts the draft. Acceptance writes a normal
course record with `source: "ai"`, so it is edited and published exactly like a
hand-authored one.

### In sync with atheniq.courses

`POST /courses/sync` reads the LMS public catalog
(`GET /api/courses/v1/courses/`, no token) and matches by course code. The
console then shows, per course, whether the LMS serves it, and separately lists
courses the LMS serves that the catalog does not hold, with an **Import** action
that creates a local draft. A failed check records the reason and keeps the last
good picture; it never blanks the page.

The sync is read-only. Pushing a generated OLX package into the LMS belongs to
the Next.js console's publish pipeline (it still builds and pushes the OLX
bundle); this service reports the drift rather than pretending a course was
pushed.

### The embedded classroom

A course's **AI classroom** page starts (once) and embeds an OpenMAIC classroom
for that course, signed with a 15-minute instructor token issued by the bridge.
It needs `ATHENIQ_BRIDGE_URL`, `ATHENIQ_BRIDGE_SERVICE_TOKEN` and
`OPENMAIC_PUBLIC_URL`; without them the page says embedding is not configured.
For the iframe to carry the HttpOnly `atheniq_classroom` cookie, the console and
OpenMAIC must be same-site: set `ATHENIQ_CLASSROOM_COOKIE_DOMAIN` to the shared
parent domain in production (or run both on the same host in development). The
page's CSP allows exactly that one frame origin.

On the real hosts that pair is:

| Role | Host | Serves |
| --- | --- | --- |
| Console | `registrar.atheniq.institute` | this service, port 8080 |
| Classroom | `classroom.atheniq.institute` | OpenMAIC, reached by the browser |
| Bridge | internal (`http://bridge:8787`) | never published; the console calls it server-side |

`classroom.atheniq.institute` is under the same registrable domain as the
registrar, which is why the cookie works there: set
`ATHENIQ_CLASSROOM_COOKIE_DOMAIN=.atheniq.institute`, `COOKIE_SECURE=true` and
`OPENMAIC_PUBLIC_URL=https://classroom.atheniq.institute` on the institution, and
the same `BRIDGE_JWT_SECRET` as `ATHENIQ_BRIDGE_JWT_SECRET` on OpenMAIC. The
classroom host in use today, `class.atheniq.courses`, is a different registrable
domain and sits behind Authentik; a cookie set by the registrar cannot reach it,
so it cannot serve this embed.

Proof, in order: sign in at the registrar, open a course's **AI classroom**,
press **Start classroom** (the bridge creates it), then **Sign in to classroom**.
`docs/cutover.md` has the same proof as commands for both real hosts.
The response sets `atheniq_classroom` with `Domain=.atheniq.institute; Secure;
HttpOnly; SameSite=Lax`, and the iframe at `classroom.atheniq.institute` renders
the room as the registrar's identity instead of asking for a sign-in. Until the
generator has named a stage, the page embeds the classroom host itself — the same
signed-in owner's library — so the cookie is exercised before a stage exists. A sign-in
wall inside the frame means the cookie did not cross: compare the two hostnames,
the cookie's `Domain`, and that both are HTTPS.

## Accounts and the `@MAIL_DOMAIN` address

Rules the registry enforces:

- **One address per student.** `first.last@atheniq.institute`, ASCII-folded and
  lower-cased; a collision becomes `first.last2@`, then `3`, and so on.
- **The address is permanent.** It is not derived from the program or the
  intake, so a student who changes program keeps it.
- **The mailbox starts `reserved`, then becomes `active`.** `MAIL_PROVIDER=local`
  reserves the address in the registry only. With `MAIL_PROVIDER=stalwart`,
  admission creates the account at the provider in the same request, and a
  failure leaves the address reserved rather than blocking the portal account.
- **The account is issued, not self-service.** An application creates no account.
  Acceptance creates one. There is no public sign-up form that can mint a student
  id, and no route that lets a browser choose its own student number.

### Connecting Stalwart

The Institute uses Stalwart at `mail.innotel.us`. The registry remains the
source of truth for who exists; Stalwart is the delivery system.

1. **Create the domain in Stalwart** under Management → Domains. It must equal
   `MAIL_DOMAIN` (`atheniq.institute` by default). If the Stalwart domain is
   `innotel.us`, set `MAIL_DOMAIN=innotel.us` so issued addresses and accounts
   agree; the service refuses to provision an address outside that domain.
2. **Create an API key** under Account › Credentials › API Keys and put it in
   `STALWART_TOKEN`. Give it `Inherit` permissions. Stalwart refuses an account
   change when the caller does not hold every permission of the target account,
   so a key narrowed to the `sys*` names alone cannot create a normal user: it
   answers `not authorized to grant permissions: jmapQuotaGet …`. The key is a
   bearer credential and must stay out of the browser and version control.
3. **Set** `MAIL_PROVIDER=stalwart` and `STALWART_URL=https://mail.innotel.us`.
   `STALWART_QUOTA_BYTES` is optional (`0` means no per-mailbox quota).
4. **Publish** MX, SPF, DKIM and DMARC for the mail domain. Stalwart's domain
   page generates the records when DNS management is manual.
5. **Test** one admission. The registrar's confirmation should say the mailbox is
   active, and the student's temporary password should open both the portal and
   the mailbox. Changing the portal password or resetting access updates the
   Stalwart credential as well.

**When the mail server authenticates through a directory.** Stalwart can run on
an internal directory or on an external one (OIDC, LDAP, SQL). With an external
directory — the usual setup when single sign-on already exists — the server
refuses any password on an account (`Cannot set credentials for accounts in an
external directory`), and on the open-source edition that applies to every
domain, whatever a domain's own `directoryId` says. The service detects this on
the first admission: it creates the mailbox without a credential, and the
student signs in to mail through the directory rather than with the temporary
password. The registrar's confirmation says so. Portal passwords and mail
passwords are then separate systems, which is the point of SSO.

At startup the service runs one `x:Domain/query` for `MAIL_DOMAIN`. That single
call proves all three settings: the URL answers, the key is accepted, and the
domain exists. If any of them is wrong the service exits with
`mail preflight failed: <reason>` and a line naming the setting to fix, rather
than starting and failing during an admission. A passing preflight does not
prove delivery — the admitted mailbox is still the real test.

If Stalwart goes down after startup the admission still succeeds and the address
stays `reserved`. Fix the provider settings, then use **Reset access** on the
student record; that issues a new temporary password and retries the mailbox. The
registrar console and portal both show the status, so a mixed migration is
visible per student.

Stalwart's management API is JMAP at `/jmap/`, not a REST endpoint. The calls are
in `apps/institution/src/mail.ts`; the account and domain objects are documented
at `stalw.art/docs/ref/object/account` and `.../domain`.

## Data and its limits

The registry is one JSON file, `$INSTITUTION_DATA_DIR/registry.json`, written
atomically with mode 0600. That is honest for one institution on one process and
wrong for a university with concurrent registrars:

- **Single writer.** Writes are synchronous, so two processes pointed at the same
  file will not serialise. Run exactly one institution container.
- **No query surface.** Reports are computed in memory. A few thousand students
  is fine; a hundred thousand is not.
- **No audit log.** The file records decisions (`decidedAt`, `decisionNote`,
  `temporaryPasswordIssuedAt`) but not who made them. Registrar accounts and an
  append-only audit trail are the first production hardening item.

The migration path is a relational store behind the same `Registry` methods
(`createApplication`, `decide`, `register`, `changePassword`, `resetAccess`,
`summary`). No route needs to change; see "Recommendations" for the order.

```json
{
  "version": 1,
  "applications": [{ "id": "app_…", "status": "admitted", "studentId": "lrn_…" }],
  "students": [{
    "id": "lrn_…",
    "number": "ATH-2027-0001",
    "schoolEmail": "nadia.rahman@atheniq.institute",
    "passwordHash": "scrypt$16384$8$1$…",
    "mustChangePassword": false,
    "mailbox": { "address": "nadia.rahman@atheniq.institute", "status": "reserved", "provider": "local" }
  }],
  "enrollments": [{ "studentId": "lrn_…", "courseCode": "AI201", "status": "registered" }],
  "counters": { "student": 1 }
}
```

## Deployment and the edge

The Compose service is `institution` (port 8080, volume `institution-data`). The
edge must:

- terminate TLS for both names,
- **preserve `Host`** (the service routes on it), and
- forward to the same upstream for both.

Caddy:

```caddyfile
www.atheniq.institute {
  redir https://atheniq.institute{uri} permanent
}

atheniq.institute {
  reverse_proxy institution:8080
}

registrar.atheniq.institute {
  reverse_proxy institution:8080
}

classroom.atheniq.institute {
  reverse_proxy openmaic:3000
}
```

`classroom` must be same-site with `registrar` for the embedded classroom (see
above); the bridge stays internal and needs no hostname. The Next.js console
(`upstream/atheniq-console`) is the records and awards service and takes no
registrar host; if its own UI needs one, give it a separate name such as
`console.atheniq.institute`.

OpenMAIC also refuses framing it was not built to allow: without
`ALLOWED_FRAME_ANCESTORS=https://registrar.atheniq.institute` its build-time CSP
says `frame-ancestors 'self'` and sends `X-Frame-Options: SAMEORIGIN`, so the
registrar's iframe is blocked however correct the cookie is. Compose passes
`OPENMAIC_FRAME_ANCESTORS` as that build argument, and a restart does not change
it — the image has to be rebuilt.

The ordered version of this cutover — the DNS records, the two vhosts, the ports
the edge forwards to, and how each step is proven — is `docs/cutover.md`.

If another proxy sits in front, it must pass `Host` through, not rewrite it to
the container name. Only set `TRUST_PROXY=true` when `X-Forwarded-Host` is set by
a proxy you control; otherwise a client can choose its own surface.

Production checklist for the container:

```dotenv
INSTITUTION_ORIGIN=https://atheniq.institute
REGISTRAR_ORIGIN=https://registrar.atheniq.institute
SESSION_SECRET=<32+ random chars>
REGISTRAR_PASSWORD_HASH=<scrypt$…>     # preferred over REGISTRAR_PASSWORD
COOKIE_SECURE=true
INSTITUTION_SEED_DEMO=false
MAIL_DOMAIN=atheniq.institute
```

The service refuses to start in production with an unset or short
`SESSION_SECRET`, no registrar credential, `COOKIE_SECURE=false`, or a failing
Stalwart preflight (unreachable `STALWART_URL`, rejected `STALWART_TOKEN`, or a
`MAIL_DOMAIN` that Stalwart does not serve). A service that starts misconfigured
is worse than one that explains why it will not start.

**Backups.** `institution-data` is the whole institution record. Back it up on a
schedule, restore it into a scratch container monthly, and keep the copy off the
host. A JSON registry with no restore rehearsal is not a backup.

## Security posture

| Control | Implementation |
| --- | --- |
| Passwords | scrypt (N=16384, r=8, p=1), 16-byte salt per password, constant-time compare |
| Sessions | HMAC-SHA256 signed cookie, HttpOnly, SameSite=Lax, Secure in production, 8-hour expiry |
| Surface separation | different cookie names and signed roles; a student token is refused as staff |
| CSRF | `Origin` must match `Host` on every POST; `Sec-Fetch-Site: cross-site` is refused by the browser/edge policy |
| Output | every visitor-supplied value is escaped at interpolation |
| CSP | `default-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'` |
| Sign-in abuse | per-process attempt limiter (8 per 10 minutes per IP + account) |
| Personal data | portal and registrar send `noindex, nofollow`; only the public site is indexable |
| Seed data | only with `INSTITUTION_SEED_DEMO=true`; a visible ribbon says the records are demonstrations |

Not yet present, and required before real student data: registrar accounts with
roles (admissions / registrar / exams), an audit log of every decision and reset,
MFA for staff, and a documented retention schedule.

## What is deliberately not built

- **Payments.** The application is free; fees are invoiced by the registrar. No
  card data touches this service. The catalog lookup for a payments provider
  returned nothing suitable, so no provider was integrated.
- **SSO.** Students sign in with an Institute password. The right end state is
  OIDC against the same identity provider as mail and the console, with
  `atheniq.institute` as the issuer.
- **LMS enrollment sync.** A registration holds a seat in the registry. Pushing
  it to Open edX's enrollment API is the next integration; until then the
  registrar reconciles before teaching begins.
- **Document upload and interview scheduling.** Admissions is a form, a
  conversation and a decision. Files and calendars are provider-shaped problems.
- **A CMS for programs.** Programs, terms and faculty still live in
  `content.ts` and change by pull request. Courses do not: they are catalog
  records the console edits, described above.
- **Accreditation.** The public site says plainly that the Institute is new and
  does not yet hold accreditation. Do not replace that sentence with a logo.

## Recommendations, in order

### First, before recruiting students

1. **Registrar roles and an audit log.** Replace the single bootstrap account
   with named staff accounts, roles, and an append-only event log. Every
   admission, reset and status change is attributable.
2. **Mail provider and deliverability.** Pick one, wire create/suspend, publish
   SPF/DKIM/DMARC, and test admissions mail against Gmail and Outlook.
3. **Privacy notice, terms and accessibility statement.** The application form
   collects personal data; the notice must say what is kept, why, where, for how
   long, and how to ask for it back or have it removed. Target WCAG 2.2 AA and
   say which standard you are testing against.
4. **Backups and restore rehearsal.** Automate, encrypt, and actually restore.
5. **Rate limiting and a WAF at the edge.** The in-process limiter is a floor,
   not a substitute for edge protection on sign-in and application endpoints.

### Then, to run a cohort

6. **SSO for students and staff.** OIDC, then use it for mail and the console.
   Force MFA for staff.
7. **LMS enrollment sync.** On registration, call the LMS enrollment API and
   store the result per enrollment (`synced | failed | not_connected`). Make the
   registrar's reconcile view show only failures.
8. **Payments.** Evaluate an education-aware provider (Flywire, Stripe
   Invoicing, Adyen) for tuition, installments, refunds and scholarship
   reconciliation. Keep card data entirely with the provider; the registry stores
   only an invoice reference and status.
9. **Admissions at scale.** Interview scheduling, document upload with virus
   scanning and retention, decision templates, and a waitlist that is visible to
   applicants rather than an email inbox.
10. **A real SIS boundary.** Move the registry to Postgres, add an audit table,
    and expose a read API for the console. Keep the `Registry` interface so the
    routes do not move.

### Then, to be a university rather than a school

11. **Student identity and exams.** A verifiable student credential (photo ID or
    a signed digital card), proctoring policy, and an academic integrity process
    that names who decides.
12. **Calendar and mail integration.** Term dates as ICS, course schedules in the
    student's calendar, and transactional mail for registration and results.
13. **Library, careers and alumni.** These are services with their own vendors.
    Add them as links and entitlements, not as bespoke code in this repository.
14. **Accessibility and content operations.** A CMS for program pages, an
    editorial owner for every public claim, and a quarterly link and content
    audit. The public site is a regulated surface once it recruits.
15. **Analytics with consent.** Funnel from application to enrollment, completion
    by program, and award verification counts. No third-party tag without a
    consent decision.

## Content is not configuration — except courses

Programs, terms, faculty and the admissions calendar live in
`apps/institution/src/content.ts`, and a change to them is a reviewed pull
request. Courses moved: their record is `catalog.json`, written by the institution
console, because a registrar adding a section or correcting credits is an operational
act, not a code change. `content.ts` keeps the seed curriculum and the program
plans. If programs outgrow the file for the same reasons, move them behind the
same pattern — an atomic store with one writer and a validation layer — rather
than editing a TypeScript file between terms.
