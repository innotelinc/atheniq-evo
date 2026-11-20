# The institution

AthenIQ Institute is the university the rest of this estate serves. This document
describes the institution surfaces added in `apps/institution`, how they relate
to the console, the bridge and the LMS, and what a real institution still needs
before it should put its name on a degree.

The short version: **one service, two hostnames.**

| Host | Surface | Who it is for |
| --- | --- | --- |
| `atheniq.institute` | public site, admissions, student portal | prospective students, applicants, enrolled students |
| `registrar.atheniq.institute` | applications, account issuance, roster | the registrar and admissions staff |

## Who owns what

The estate already has one rule: the system that owns a fact is the only one
that may decide it. The institution extends the table rather than replacing it.

| Fact | Owner | Everyone else |
| --- | --- | --- |
| A person applied | Institution registry | admissions staff read it; nobody else |
| A person is admitted, and their student number | Institution registrar | the console receives the learner id `lrn_…` |
| A student's portal account and password | Institution registry | the bridge never sees a password |
| An `@atheniq.institute` address | Institution registry (reserved) → mail provider (delivered) | the portal displays its state |
| Course catalog and teaching schedule | `content.ts` (this repo) → console catalog | the LMS receives an OLX package |
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

## Accounts and the `@atheniq.institute` address

Rules the registry enforces:

- **One address per student.** `first.last@atheniq.institute`, ASCII-folded and
  lower-cased; a collision becomes `first.last2@`, then `3`, and so on.
- **The address is permanent.** It is not derived from the program or the
  intake, so a student who changes program keeps it.
- **The mailbox starts `reserved`.** The record exists in the Institute
  directory; delivery is a provider operation. `MAIL_PROVIDER=local` means "this
  deployment has not connected a provider yet", and the portal and registrar say
  so rather than implying mail is flowing.
- **The account is issued, not self-service.** An application creates no account.
  Acceptance creates one. There is no public sign-up form that can mint a student
  id, and no route that lets a browser choose its own student number.

### Connecting a mail provider

The service catalog used for this build returned **no provider that supplies
mailbox hosting plus a provisioning API**, so nothing was invented. The
integration point is deliberately small:

1. Choose a provider that supports custom-domain mailboxes and an admin API for
   create / suspend / alias. For an institution, evaluate **Google Workspace for
   Education** and **Microsoft 365 Education** first; **Migadu** and **Zoho Mail**
   are lower-cost options worth pricing against real seat counts.
2. Verify: API access on the plan you are buying, alias and group support,
   retention and eDiscovery, SSO with your identity provider, and whether
   suspended students keep their mail.
3. Set `MAIL_PROVIDER` to the provider's name. The registry already records the
   provider on each mailbox, so a mixed migration is visible per student.
4. Publish `SPF`, `DKIM` and `DMARC` for `atheniq.institute`. A student address
   that lands in spam is worse than no address, and DMARC is now table stakes
   for an institution sending admissions mail.
5. Add the provider's sync to the registrar: `reserved → active` on success,
   `disabled` on suspension. The status field exists; the API call does not yet.

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
```

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
`SESSION_SECRET`, no registrar credential, or `COOKIE_SECURE=false`. A service
that starts insecurely is worse than one that explains why it will not start.

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
- **A CMS.** Programs and courses live in `content.ts` and change by pull
  request, which is deliberate while the catalog is small.
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

## Content is not configuration

Programs, courses, terms, faculty and the admissions calendar live in
`apps/institution/src/content.ts`. A change to what the Institute teaches is a
reviewed pull request, not a database edit. When the catalog outgrows that —
more than a few dozen courses, or multiple faculties editing concurrently — move
it to a CMS or the console's catalog, and keep the same shapes.
