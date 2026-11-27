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

### The webhook must be reachable without a session

RevenueCat calls the webhook from its own servers, with no cookie. Two gates
have to let it through:

1. **The console middleware.** `/api/internal/revenuecat/` is in `PUBLIC_PATHS`
   in `middleware.ts`, so the path reaches its route without a staff session.
   The route then checks `Authorization: Bearer $REVENUECAT_WEBHOOK_TOKEN` in
   constant time; without the token configured it answers `503` and writes
   nothing.
2. **The edge — not passing today.** Measured on 27 Nov 2026 against
   `https://registrar.atheniq.institute`: `/privacy` and `/api/health/digest`
   answer `200`, and **every other path is `302` to Authentik**
   (`auth.cerulean.innotel.us`, client `classroom`) — including
   `/api/internal/revenuecat/webhook` and `/api/mobile/v1/me`. So the webhook is
   not reachable, and neither is the mobile API through that host.
   `console.atheniq.institute` does not resolve yet.

   Fix it at the edge before the first event: add the webhook to whatever list
   already exempts `/api/health/digest` (Authentik proxy provider →
   *Unauthenticated paths*, or the equivalent NPM bypass), and add
   `^/api/mobile/` for the app itself:

   ```
   ^/api/internal/revenuecat/webhook$
   ^/api/mobile/
   ```

   The webhook still needs its bearer token; the bypass only removes the browser
   login that a server-to-server call cannot perform.

Probe it from outside before the first event (a `GET` writes nothing):

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://console.atheniq.institute/api/internal/revenuecat/webhook
```

Expect `405` — the route has no GET, which proves the request reached the app.
`302`/`303` to `auth.…/application/o/authorize/`, `401` with
`{"ok":false,"error":"Sign in to use the console."}`, or `403` from the edge
means a gate is still in front of it. `404` means nothing answers on that host
at all.

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
`upstream/atheniq-console/mobile/store/premium.md` (applied by
`patches/atheniq-console/0003-atheniq-plus-subscription.patch`).

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
- The webhook path was requested from a local console with `AUTH_PASSWORD` set:
  it answered `503` (its own unconfigured response) rather than the middleware's
  `401`, so no session gate stands in front of it. `GET` answered `405` and
  `/api/credentials` answered the middleware's `401` in the same run — the
  control path.
- **The edge does not pass it yet**: a `GET` on the public host is redirected to
  Authentik (see “The webhook must be reachable without a session”). Until that
  exemption is added, RevenueCat's events will not arrive, and the mobile API is
  equally unreachable from a phone. This is the one open item outside this
  repository.
- `npm run typecheck` in the console, and `tsc --noEmit` in `mobile`: both pass
  after the patch.
- `npm run check` at the repository root covers the estate (bridge and
  institution), not the console or the app.

Not proven here, and required before submission: a sandbox purchase, restore,
renewal, cancellation and refund on a device; the App Store and Play products
themselves; and the store review. Those need the store accounts, the RevenueCat
project and signing credentials, which are not in this repository.
