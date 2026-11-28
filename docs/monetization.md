# AthenIQ Plus — the free app and its subscription

The mobile app is free, and stays useful for free. **AthenIQ Plus** is the
optional subscription that pays for the parts a phone can do that a notebook
cannot. This document is the operator's view: what is sold, where entitlement
lives, what must be configured, and what has and has not been proven.

## What is free and what is Plus

| | Free | Plus |
| --- | --- | --- |
| Browse the catalog | yes | yes |
| Enroll in a free course, read every lesson | yes | yes |
| Progress, credits, certificates | yes | yes |
| Courses kept offline | 1 | unlimited |
| AI study coach | — | yes |
| Study analytics | — | yes |
| Priority registrar review | — | yes (members are sorted first in the award queue) |

Priced courses are unchanged: a course with a one-off price still goes through
the registrar's transfer confirmation. Plus is not a way around a course fee.

Prices: **$9.99/month** or **$79.99/year**, sold through StoreKit and Play
Billing as auto-renewable subscriptions in one group. The product ids are
`institute.atheniq.plus.monthly` and `institute.atheniq.plus.yearly`.

## Where entitlement lives

```
phone ──purchase──► StoreKit / Play Billing ──► RevenueCat ──webhook──► console
  │                                                  ▲                    │
  └──── POST /api/mobile/v1/premium/sync ────────────┘      memberships[] ┘
                                                                  │
              coach, analytics, /offline read it on every call ◄───┘
```

- **The phone never sends a plan.** `POST /api/mobile/v1/premium/sync` asks
  RevenueCat, with a secret key that stays on the server, what this learner
  owns. Only an entitlement named `plus` becomes a membership row
  (`lib/premium.ts`).
- **Every gated route checks the row again.** `POST /api/mobile/v1/coach`,
  `GET /api/mobile/v1/analytics` and the offline quota in
  `GET /api/mobile/v1/offline` all call `isPlus` on the server. A modified
  client gets a `402` with `upgrade: "plus"`, not a free lesson.
- **Renewals arrive without the app.** `POST /api/internal/revenuecat/webhook`
  records renewals, expirations, pauses, cancellations and refunds. A
  cancellation keeps access until the paid period ends; a refund ends it at
  once.
- **A registrar can grant Plus** by writing a membership row with
  `store: "granted"` and `expiresAt: null`; a store lookup cannot revoke a
  grant.
- **Priority review is the queue order, not a shortcut.** Both the console's
  Credential center and the app's registrar queue call `plusFirst`
  (`lib/premium.ts`), which puts active and granted members ahead of everyone
  else while keeping each group in arrival order; the console table marks those
  rows `Plus`. A lapsed or refunded row has no priority. The award itself still
  needs the same evidence, the same registrar and the same signature.

## Edge bypass: the paths that carry no session

The console host sits behind Authentik forward auth, so a request without a
browser session is redirected to the identity provider before it reaches the
app. Two callers can never have one, and both of their paths must be exempted
**on the host the caller uses**:

| Path pattern | Caller | Without the exemption |
| --- | --- | --- |
| `^/api/internal/revenuecat/webhook$` | RevenueCat's servers | Renewals, expiries, cancellations and refunds never arrive; entitlement then changes only when the app calls `premium/sync`. |
| `^/api/mobile/` | the app, for every request it makes | **The app does not work at all.** Sign-in, catalog, lessons, progress, certificates, the coach and the premium routes all live under this prefix, so every call is answered with Authentik's sign-in page and no learner gets past the first screen. |

That host is the one in the app's `EXPO_PUBLIC_API_BASE` and in the webhook URL:
today `registrar.atheniq.institute`, from cutover step 0
`console.atheniq.institute`. If both hosts answer for the console, add both
lines to both.

Measured on 27 Nov 2026 against `https://registrar.atheniq.institute`:
`/privacy` and `/api/health/digest` answer `200`, and **every other path is
`302` to the IdP's `/application/o/authorize/`** (client `classroom`) —
including `/api/mobile/v1`, the app's reachability check, and
`/api/internal/revenuecat/webhook`. The redirect carries the requested path in
its `state`, so the app is not asking for a page that does not exist: the gate
is in front of the API. `console.atheniq.institute` does not resolve yet.

Fix it at the edge: add both patterns to whatever list already exempts
`/api/health/digest` (Authentik proxy provider → *Unauthenticated paths*, or the
equivalent NPM `auth_request` bypass):

```
^/api/internal/revenuecat/webhook$
^/api/mobile/
```

Both are matched against the request path; `/api/mobile/` keeps its trailing
slash so it covers every route under `/api/mobile/v1/` and nothing else. No code
change goes with it — the console middleware already lists both in
`PUBLIC_PATHS` (`middleware.ts`) — and the bypass only removes the browser login
that neither caller can perform:

- The webhook still compares `Authorization: Bearer $REVENUECAT_WEBHOOK_TOKEN`
  in constant time, and answers `503` when the token is unset.
- Every `/api/mobile/` route that touches a learner checks the learner's bearer
  token (`lib/mobile-auth.ts`) and answers its own `401`; `/api/mobile/v1` is the
  one anonymous route, and it returns the catalog count.

### Probe it, and let it name the gate

`npm run probe:edge` requests the paths that must reach the console and reports
which gate answered — `app`, `authentik`, `edge` (the proxy's own error page),
`console-middleware`, or `none` for DNS/TLS — with the evidence and the fix for
that gate. `--path` adds one. A `GET` writes nothing.

With no `--base` it asks the host the app is actually built for —
`EXPO_PUBLIC_API_BASE` from the environment, or else the default compiled into
`upstream/atheniq-console/mobile/lib/api.ts` — and prints which source it used.
The probe carries no host of its own, so after the cutover it follows the app
rather than checking yesterday's name. `--base` names a host by hand and warns
when it differs from the app's; when neither source is available the probe stops
with exit `2` instead of guessing a host.

```bash
npm run probe:edge
npm run probe:edge -- --base https://console.atheniq.institute
```

Measured on 28 Nov 2026, before the exemption:

```
  /api/health/digest                 200  app                 ok
  /api/mobile/v1                     302  authentik           GATED
  /api/mobile/v1/auth/login          302  authentik           GATED
  /api/mobile/v1/me                  302  authentik           GATED
  /api/internal/revenuecat/webhook   302  authentik           GATED
  /api/credentials                   302  authentik           ok
```

`/api/credentials` is the control: it is a staff page and must be stopped by a
gate, which is what proves the probe can see one. Exit status is `1` when a path
that must reach the console does not, and `2` when nothing answered at all. A
passing run reads:

```
  /api/health/digest                 200  app                 ok
  /api/mobile/v1                     200  app                 ok
  /api/mobile/v1/auth/login          405  app                 ok
  /api/mobile/v1/me                  401  app                 ok
  /api/internal/revenuecat/webhook   405  app                 ok
  /api/credentials                   302  authentik           ok
```

Those statuses are the proof: `200` on `/api/mobile/v1` is a phone that can sign
in, `405` on the two POST-only routes is the app's own router answering, and
`401` on `/api/mobile/v1/me` is the route's refusal rather than the middleware's
`{"ok":false,"error":"Sign in to use the console."}`.

The offline quota is recorded server-side (`downloads[]`) rather than on the
device, so reinstalling the app does not reset it.

## Configuration

Console (Compose service `console`, from `.env`):

| Variable | Purpose |
| --- | --- |
| `REVENUECAT_SECRET_KEY` | Reads a learner's entitlement. Unset: the sync route answers `503` and grants nothing. |
| `REVENUECAT_WEBHOOK_TOKEN` | Expected `Authorization: Bearer …` on `POST /api/internal/revenuecat/webhook`. Unset: the webhook answers `503`. |
| `REVENUECAT_ENTITLEMENT_ID` | Defaults to `plus`. |

Mobile build (public keys, baked in at build time — never secrets):

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_REVENUECAT_IOS_KEY` | RevenueCat public SDK key for the iOS app. |
| `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` | Public SDK key for the Android app. |

Store products, the RevenueCat project, the webhook URL, App Review notes and
the submission checklist are in
`upstream/atheniq-console/mobile/store/premium.md` (created by
`patches/atheniq-console/0003-atheniq-plus-subscription.patch`, with the SDK pin,
priority queue and edge checklist in `0004-plus-priority-and-sdk-pin.patch`).

## Builds and submission

`mobile/eas.json` carries `development`, `preview` and `production` profiles and
a `submit` block for both stores. `app.json` is at version `1.1.0`, iOS build
`2`, Android `versionCode 2`.

```bash
npx eas-cli build  --platform ios     --profile production
npx eas-cli build  --platform android --profile production
npx eas-cli submit --platform ios     --profile production
npx eas-cli submit --platform android --profile production
```

RevenueCat and the store billing libraries are native modules, so Expo Go
cannot take a payment: use a development build for sandbox purchases.

## Verification

- `cd upstream/atheniq-console && npm run test:premium` — 7 tests over the real
  modules: free quota and re-download, active/lapsed/granted memberships, the
  entitlement filter, `404` for an unknown subscriber, renewal / cancellation /
  expiration / refund mapping, and the registrar queue order (members first, a
  lapsed row without priority, input not mutated).
- A local console with `AUTH_PASSWORD` set was asked for every path
  (`npm run probe:edge -- --base http://127.0.0.1:3155`): `/api/mobile/v1`
  answered `200` with the catalog count, `/api/mobile/v1/me` its own `401`, both
  POST-only routes `405`, and `/api/credentials` the middleware's `401` in the
  same run. So the middleware is not the blocker — the edge is.
- **The edge does not pass either path yet.** `npm run probe:edge` on 28 Nov
  2026 answered `302` → Authentik for `/api/mobile/v1`, `/api/mobile/v1/auth/login`,
  `/api/mobile/v1/me` and `/api/internal/revenuecat/webhook`, and `200` for the
  `/api/health/digest` control. Until the two patterns above are added to the
  edge, RevenueCat's events will not arrive and no phone can reach the API. This
  is the one open item outside this repository.
- `npm run typecheck` in the console, and `tsc --noEmit` in `mobile`: both pass
  after the patch.
- `npm run check` at the repository root covers the estate (bridge and
  institution) and `scripts/probe-edge.test.mjs`, which pins which host the
  probe asks and that it refuses to guess one — not the console or the app.

Not proven here, and required before submission: a sandbox purchase, restore,
renewal, cancellation and refund on a device; the App Store and Play products
themselves; and the store review. Those need the store accounts, the RevenueCat
project and signing credentials, which are not in this repository.
