# Patches

Small, reviewable deltas on the upstream repositories — not forks. Each series is
generated against the commit in `upstream.lock.json` and applied by
`scripts/bootstrap.sh`.

```bash
bash scripts/bootstrap.sh --check   # do they still apply to the pinned commits?
```

## openmaic/0001-atheniq-classroom-integration.patch

| File | Change |
| --- | --- |
| `lib/server/identity/host/atheniq-classroom.ts` | **new** — verifies the bridge's `atheniq_classroom` cookie (HS256 via Web Crypto) and answers an owner principal `atheniq:<sub>`, with publish rights only for staff roles. |
| `instrumentation.ts` | registers that method, and only when `ATHENIQ_BRIDGE_JWT_SECRET` is set. |
| `app/api/atheniq/classroom/route.ts` | **new** — the binding the UI may know: bridged?, course, learner. No token leaves the server. |
| `app/api/atheniq/completion/route.ts` | **new** — HMAC-signed completion callback; identity and course come from the token, never the body. |
| `components/atheniq/atheniq-completion-reporter.tsx` | **new** — the one control rendered, only when bridged. |
| `app/classroom/[id]/page.tsx` | mounts the reporter beside the classroom. |

Uses OpenMAIC's documented host identity extension point (`OwnerAuthMethod`) and
its documented host-code directory, so no core identity file is modified and the
boundary test that guards those headers still holds: the cookie is read only
inside `lib/server/identity/host/`.

## atheniq-console/0001-atheniq-bridge-integration.patch

| File | Change |
| --- | --- |
| `lib/award.ts` | **new** — the award logic extracted from `POST /api/credentials`, shared by the registrar UI and the service route. |
| `app/api/credentials/route.ts` | POST delegates to `lib/award.ts`; identical validation order and responses. |
| `lib/bridge.ts` | **new** — server-side bridge client (launch ticket). |
| `app/api/internal/atheniq/route.ts` | **new** — service-authenticated `complete-enrollment` and `issue-credential`. |
| `app/api/classrooms/launch/route.ts` | **new** — portal session + access check → bridge ticket → HttpOnly cookie → redirect. |
| `app/portal/page.tsx` | adds *AI classroom* beside *Open course* when a bridge is configured. |

## Regenerating after an upstream bump

```bash
cd upstream/OpenMAIC && git checkout <new commit> && git apply ../../patches/openmaic/*.patch
# fix conflicts, then:
git add -A && git diff --cached --binary > ../../patches/openmaic/0001-atheniq-classroom-integration.patch
git reset
```

Update `upstream.lock.json` in the same commit. A patch that no longer applies is
a signal to read the upstream change, not to force it.
