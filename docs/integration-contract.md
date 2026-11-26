# The integration contract

Everything that crosses a boundary is defined in `packages/contracts/src/index.ts`.
Both patches copy the shapes they need; `CONTRACT_VERSION` is on every classroom
token and every health response, so a rolling deploy can refuse a token minted by
an older major rather than misreading it.

## Endpoints

Base URL: `BRIDGE_ORIGIN` (default `http://localhost:8787`).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Contract version, a probe of LMS, OpenMAIC, console and OmniRoute, and the completion retry backlog. `degraded` is not `failed`: an unconfigured dev box should not page anyone. A partial completion past its alert window is `failed`. |
| GET | `/v1/gateway/models` | service | The models OmniRoute offers, so a bad key is distinguishable from a bad model name. |
| POST | `/v1/sso/classroom` | service | Mint a classroom token for a learner + course. Idempotent per pair: re-entry returns the same classroom. |
| POST | `/v1/classrooms` | service | Start a classroom in OpenMAIC and record it. 201 with job id, launch URL and token. |
| POST | `/v1/completions` | hook signature **or** service | Accept one completion and fan it out. `?retry=1` re-runs only unfinished steps; a scheduled sweep also retries partial records automatically. |
| GET | `/v1/completions/needs-retry` | service | Partial completions waiting for delivery: age, attempt count, next attempt, last error and whether the record is stale. |
| POST | `/v1/credentials` | service | Ask the console for one credential (registrar action or backfill). Idempotent by `idempotencyKey`. |
| GET | `/v1/learners/{id}/transcript` | service | The AI-instruction record for one learner, newest first. |
| GET | `/v1/classrooms/{id}` | service | One classroom record. |

Auth errors are `401` with `{ok:false,error:{code,message}}`; validation errors
are `400`; a completion that does not match its classroom is `409`; an upstream
refusal is `502`.

### Service auth

`Authorization: Bearer <BRIDGE_SERVICE_TOKEN>`, compared in constant time. The
console uses the same value as `CONSOLE_SERVICE_TOKEN` on its own side.

### Hook auth

```
x-atheniq-timestamp: 1795200000
x-atheniq-signature: hex( HMAC-SHA256( BRIDGE_HOOK_SECRET, `${timestamp}.${rawBody}` ) )
```

Refused when either header is missing, the timestamp is not numeric, the clock
skew exceeds **300 seconds**, or the digest differs. The body is verified
verbatim, so re-serialising it invalidates the signature.

## The classroom token

HS256, 15 minutes (`BRIDGE_TOKEN_TTL_SECONDS`), `aud: "atheniq-classroom"`,
`iss: "https://bridge.atheniq.institute"`.

| Claim | Meaning |
| --- | --- |
| `sub` | AthenIQ person id (`lrn_…`, `stf_…`). The only identity OpenMAIC stores. |
| `role` | `learner`, `instructor`, `registrar` or `service`; decides publish rights. |
| `org` | Institution / white-label tenant. |
| `courseKey` | The course this classroom serves. A completion naming another course is refused. |
| `classroomId` | The bridge's record, known before the classroom exists. |
| `lmsUsername` | Optional; lets grading and completion skip a lookup. |
| `ver` | Contract version. |
| `name`, `email` | Display data. May change; `sub` may not. |

OpenMAIC maps `sub` to owner `atheniq:<sub>`. Changing that scheme later would
orphan every course already stored under it — pick it once.

## Completion payloads

Request (OpenMAIC → bridge):

```json
{
  "classroomId": "cls_…",
  "courseKey": "course-v1:InnotelLabs+CS101+2026F",
  "learnerId": "lrn_…",
  "score": 8,
  "maxScore": 10,
  "outcomes": [{ "id": "search-invariant", "label": "Explains the loop invariant", "mastery": 0.9 }],
  "issueCredential": true,
  "idempotencyKey": "classroom:cls_…"
}
```

`learnerId`, `courseKey` and `classroomId` must match the launch; the bridge reads
them from its ledger and answers `409` on any mismatch.

Response:

```json
{
  "completionId": "cmp_…",
  "replay": false,
  "accepted": true,
  "grade": { "earned": 8, "possible": 10, "percent": 80 },
  "steps": [
    { "step": "lms-completion", "status": "ok", "detail": "…", "http": 200 },
    { "step": "lms-grade", "status": "ok", "detail": "…", "http": 202 },
    { "step": "console-completion", "status": "ok", "detail": "…", "eligible": ["course-v1:…"] },
    { "step": "credential", "status": "ok", "detail": "Award ATH-… recorded (issued)." }
  ],
  "credential": { "credentialId": "cred_…", "verifyId": "ATH-…", "status": "issued" }
}
```

## What each side reads

### OpenMAIC (patched)

| Variable | Read by |
| --- | --- |
| `ATHENIQ_BRIDGE_JWT_SECRET` | the host identity method; absent → OpenMAIC keeps its own identity mode |
| `ATHENIQ_BRIDGE_URL` | the completion route |
| `ATHENIQ_BRIDGE_HOOK_SECRET` | the completion route |

OpenMAIC never holds a service token, so a compromised classroom cannot create
classrooms or award credentials — only report a completion for the classroom its
token names.

### Console (patched)

| Variable | Read by |
| --- | --- |
| `ATHENIQ_BRIDGE_URL` | the portal button and `/api/classrooms/launch` |
| `ATHENIQ_BRIDGE_SERVICE_TOKEN` | launch calls **and** verifying `/api/internal/atheniq` |
| `ATHENIQ_CLASSROOM_COOKIE_DOMAIN` | the cookie's `Domain`, so OpenMAIC's host can read it |

When `ATHENIQ_BRIDGE_SERVICE_TOKEN` is unset, `/api/internal/atheniq` answers
`503` rather than becoming an unauthenticated award endpoint.

### Bridge

| Variable | Purpose |
| --- | --- |
| `BRIDGE_JWT_SECRET` | classroom tokens (32+ chars, required) |
| `BRIDGE_SERVICE_TOKEN` | service calls in (required) |
| `BRIDGE_HOOK_SECRET` | callbacks in (required) |
| `OPENMAIC_BASE_URL` | generation |
| `LMS_BASE_URL`, `LMS_API_TOKEN` | completion and grade |
| `LMS_GRADE_USAGE_ID` | the graded block; empty = completions only |
| `LMS_USER_MAP_PATH`, `LMS_USERNAME_MAP_PATH` | learner → numeric LMS user id, for grade overrides |
| `CONSOLE_BASE_URL`, `CONSOLE_SERVICE_TOKEN` | closing enrollments, issuing awards |
| `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_MODEL` | the gateway probe |
| `BRIDGE_DATA_DIR` | where the ledger lives |

## Ledger

`$BRIDGE_DATA_DIR/atheniq-ledger.json`, mode 0600, written atomically.

| Collection | Holds |
| --- | --- |
| `classrooms` | id, course, learner, job id, requirement, who created it |
| `completions` | idempotency key, grade, outcomes, per-step results, credential, status |
| `credentials` | award id, verify id, status, subject |
| `events` | an append-only trail (`classroom.created`, `completion.received`, `credential.issued`, …) |

It records facts, never tokens or keys. `status` is `complete` when no step is
`failed` or `not_configured`, and `partial` otherwise — which is exactly the set a
retry will pick up.
