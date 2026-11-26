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
| Priority registrar review | — | yes |

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

The offline quota is recorded server-side (`downloads[]`) rather than on the
device, so reinstalling the app does not reset it.

## Configuration

Console (Compose service `console`, from `.env`):

| Variable | Purpose |
| --- | --- |
| `REVENUECAT_SECRET_KEY` | Reads a learner's entitlement. Unset: the sync route answers `503` and grants nothing. |
| `REVENUECAT_WEBHOOK_TOKEN` | Expected `Authorization: Bearer …` on the webhook. Unset: the webhook answers `503`. |
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

- `cd upstream/atheniq-console && npm run test:premium` — 6 tests over the real
  modules: free quota and re-download, active/lapsed/granted memberships, the
  entitlement filter, `404` for an unknown subscriber, and renewal /
  cancellation / expiration / refund mapping.
- `npm run typecheck` in the console, and `tsc --noEmit` in `mobile`: both pass
  after the patch.
- `npm run check` at the repository root covers the estate (bridge and
  institution), not the console or the app.

Not proven here, and required before submission: a sandbox purchase, restore,
renewal, cancellation and refund on a device; the App Store and Play products
themselves; and the store review. Those need the store accounts, the RevenueCat
project and signing credentials, which are not in this repository.
