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
7. **Prove the loop** with a throwaway course and learner: press *AI classroom*
   in the portal, finish the module, then open the candidate's record in the
   console. You should see the completion, the enrollment closed, and — if the
   course is in the catalog and the certificate was requested — an award with a
   verify id.

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
