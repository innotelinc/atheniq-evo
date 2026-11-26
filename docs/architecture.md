# Architecture

## Why a bridge and not four pairwise integrations

Four systems, four possible pairwise integrations, each with its own idea of who
a learner is and what "completed" means. A bridge is one place where those
answers are decided:

- **One identity.** A learner id (`lrn_…`), a staff id (`stf_…`) and a course key
  are the vocabulary. OpenMAIC stores `atheniq:<id>` as its owner, the LMS knows
  the username, the console owns the record. Nothing needs a mapping table
  because nothing invents a second id.
- **One completion.** The LMS records courseware progress; Signara records
  signatures. Neither can answer "what did this classroom observe, did the grade
  reach the book of record, and was a certificate awarded from it". The bridge's
  ledger can, and that is what makes the fan-out idempotent.
- **One place to change a decision.** Which model, which usage id, which
  eligibility rule, whether to auto-award: each is one configuration value or one
  function, not a convention repeated in four codebases.

## Ownership: who is authoritative for what

| Fact | Owner | Everyone else |
| --- | --- | --- |
| A person applied, was admitted, and their student number | Institution registry (`apps/institution`) | the console receives the `lrn_…` id; the bridge never sees a password |
| A student's portal account and `@atheniq.institute` address | Institution registry | the mail provider activates the mailbox; nothing else reads the password |
| A person exists, their name and email | Console | receives an id and display data |
| The Institute's course catalog, course authoring and AI generation | Institution console (`apps/institution`: `catalog.ts`, `ai.ts`) — one writer | public site, portal and LMS sync read it; the Next.js console `308`s `/courses` and `/generate` there |
| Course price and degree plans | Console (records) | LMS receives an OLX package; it no longer authors the catalog |
| Registration for a term course | Institution registry, then the LMS | the registrar reconciles; classroom launch stays with the console's portal route |
| Courseware, progress, gradebook | Open edX LMS | bridge writes completion + optional grade |
| In-class instruction, what the classroom observed | OpenMAIC → bridge ledger | console records the resulting completion |
| Eligibility for a credential | Console (`lib/eligibility.ts`) | bridge asks, never decides |
| Signature, signed PDF, revocation | Signara | console holds the award record and verify id |
| Model access | OmniRoute | both apps call it with the estate's key |

The rule behind the table: **the system that owns a fact is the only one that may
decide it.** The bridge orchestrates and remembers; it does not overrule.

The institution is the staff console. `registrar.atheniq.institute` serves it,
and it owns the facts only it can own — an application, an admission, a student
number, an address, and the catalog a student registers from — and reads the
bridge for academic facts. Its registrar has four sections (overview,
admissions, students, courses) rather than the console's course pages. The
Next.js console is the records and awards service beside it: no registrar host,
no course authoring, and `/courses` and `/generate` answer `308` to the
institution (`INSTITUTION_CONSOLE_URL`). The catalog the institution writes is
the same record the portal registers against and the LMS sync reports on.
`docs/institution.md` describes the lifecycle, the two hostnames, the catalog and
the production hardening order.

## Flow 1 — launch

```
learner        console                    bridge                   OpenMAIC
  │  click       │                          │                        │
  │─────────────►│ GET /api/classrooms/launch?enrollmentId=…
  │              │ verify portal cookie     │                        │
  │              │ verify access≠pending    │                        │
  │              │──── POST /v1/sso/classroom (service token) ───────►│
  │              │                          │ find or reserve a       │
  │              │                          │ classroom for (learner, │
  │              │                          │ course); mint HS256 JWT │
  │              │◄──── { token, url } ─────│                        │
  │              │ Set-Cookie atheniq_classroom (HttpOnly, parent domain)
  │◄── 303 ──────│                          │                        │
  │────────────────────── navigate with cookie ─────────────────────►│
  │              │                          │   host method verifies │
  │              │                          │   sub/course/exp/aud   │
  │              │                          │   → owner `atheniq:lrn_…`
```

Re-entering the same course returns the *same* classroom, so a learner does not
accumulate two libraries of duplicate work for one course.

The token is 15 minutes and audience-pinned. It is a cookie rather than a header
because a redirect cannot carry an `Authorization` header, and it is HttpOnly so
no page script can exfiltrate it. OpenMAIC verifies it with Web Crypto — twenty
lines, no JWT dependency in an app that does not otherwise need one.

## Flow 2 — generate

The institution console (or a registrar action) posts a requirement to the bridge. The bridge
mints a token for a classroom id it has already chosen, calls OpenMAIC's
`POST /api/generate-classroom`, and records the job id and stage. Generation then
runs inside the OpenMAIC process and survives the browser leaving the page.

If OpenMAIC refuses, the bridge answers 502 and records nothing: no half-created
classroom for a completion to attach to.

## Flow 3 — complete

```
OpenMAIC                      bridge                         LMS / console / Signara
   │ POST /v1/completions        │
   │ x-atheniq-timestamp         │
   │ x-atheniq-signature         │ verify HMAC over `timestamp.body`
   │ { score, outcomes }         │ (5-minute window, so a replay expires)
   │────────────────────────────►│
   │                             │ learner+course from the LEDGER, not the body
   │                             │ reserve idempotency key  ──── durable
   │                             │ 1 completion-batch ─────────► LMS
   │                             │ 2 gradebook bulk-update ────► LMS (needs user id)
   │                             │ 3 close enrollment ─────────► console
   │                             │◄── eligible: [course, track, program]
   │                             │ 4 issue credential ─────────► console → Signara
   │◄── steps[], credential ─────│
```

Four properties this ordering buys:

1. **The body cannot lie about who finished what.** `classroomId`, `courseKey`
   and `learnerId` are read from the ledger entry the launch created, and a
   mismatch is a 409. A browser editing JSON cannot move a completion to another
   learner or course.
2. **A duplicate cannot award twice.** The key is reserved in one serialized
   write *before* any network call, so two concurrent callbacks cannot both see
   "not yet processed".
3. **Eligibility is not re-derived.** The console answers with what the
   completion made possible; the bridge awards exactly that.
4. **Partial failure is visible and repairable.** Each step reports
   `ok | skipped | failed | not_configured` with an HTTP status and a sentence.
   `?retry=1` re-runs only the unfinished steps. A scheduled sweep also retries
   every partial record with exponential backoff; `GET /v1/completions/needs-retry`
   lists the backlog, and a record that stays partial past the alert window
   raises one alert and fails the `completion-retries` health check.

## Failure semantics

| Failure | Behavior | Why |
| --- | --- | --- |
| OpenMAIC unreachable at launch | 502, no classroom recorded | nothing to complete later |
| LMS unreachable | completion stored `partial`, steps say `failed` | the observation is not lost; retry writes it |
| Console unreachable | `partial`, no credential | awarding without a closed enrollment awards hope |
| Signara key missing | console returns `queued_local`; step reported `ok` with reason | the award exists and can be re-submitted |
| Callback signature stale/forged | 401, nothing recorded | a captured callback expires in five minutes |
| Second identical callback | `replay: true`, stored result, no upstream calls | idempotency is the whole point |

## Security notes

- **Two trust domains, two secrets.** The classroom token secret signs identity;
  the hook secret signs callbacks. Neither can do the other's job.
- **Service tokens are server-side only.** The bridge never sends its token to a
  browser; the console only sets the short-lived classroom cookie.
- **A grade is never guessed.** The gradebook API needs a numeric user id that
  Open edX does not expose; the bridge reads a supplied map and otherwise reports
  `not_configured`.
- **Secrets never enter the ledger, the logs or a response.** `describeConfig`
  prints hosts and booleans, never a key; the ledger records facts, not tokens.
- **The ledger is written 0600, atomically** (temp file + rename), one writer at a
  time, and a corrupt file stops the process instead of starting empty and
  re-awarding everything.

## Scaling shape

One bridge per estate, in front of one LMS. The parts that would change for a
fleet, in order: `lib/ledger.ts` (JSON → Postgres, same interface), then the
in-process `queue` (→ a real job runner) for the fan-out. Neither change touches a
route.
