# Profile Contract

> **In short:** how a host installs, configures and composes `@nuxt-layers/profile`, and everything it may call. This page is complete on its own; [`docs/contracts.md`](docs/contracts.md) is the maintainers' detailed specification behind it.

**Status:** in active development; consumers follow `master` (no formal releases). Interface: contract version 1 (`capability.json`).

Profile answers two questions: **what describes this person**, and **what may this viewer see of it, now?** It is the only canonical source of a person's names, contact details and preferences, keyed by Identity's identifier (a UUIDv7). It never holds sign-in identifiers, credentials, groups, memberships or permissions. It has no package dependency on any other `@nuxt-layers` capability, database driver, key service or UI library.

## Install

```bash
pnpm add "@nuxt-layers/profile@git+https://github.com/nuxt-layers/profile.git#master"
```

The layer is a Nuxt layer (peer dependency `nuxt` `^4.5.0`, Node.js 22 or later). Add it to `extends` and supply its ports from one Nitro plugin:

```ts
// nuxt.config.ts
export default defineNuxtConfig({ extends: ['@nuxt-layers/profile'] })
```

```ts
// server/plugins/profile.ts
export default defineNitroPlugin(() => {
  provideProfileDatabase({ dialect: 'postgres', pool: runtimePool, migrationPool: ownerPool, runtimeRole: 'profile_runtime' })
  provideProfileKeyWrapper(myKmsKeyWrapper) // or createLocalProfileKeyWrapper({ keys, current })
  provideProfileDisclosureContext({ describe: (request, options) => getIdentityDisclosureContext().describe(request, options) })
  provideProfileSubjectResolver({ resolve: event => getAuthenticatedPrincipal(event) })
  // Optional ports, each needed only for the feature named in "Host passes":
  provideProfileRequestCoordinator(profileRequestCoordinatorFromMembers({ exportIdentity, exportAuthentication, exportAuthorisation }))
  provideProfileAccessDecision(profileAccessDecisionFromAuthorisation({ authorise }))
  provideProfileNotifier(myNotifier)
  provideProfileClock(suiteClock)
  migrateProfileDatabase()
})
```

`examples/minimal-host` in this repository is a complete, tested host within the 50-line budget, supplying the four required ports. The `provide*` functions and server functions are Nitro auto-imports. Types and pure helpers come only from `@nuxt-layers/profile/contracts`, which imports nothing but `zod`. Other public entry points: `@nuxt-layers/profile/capability` (the manifest), `@nuxt-layers/profile/presentation` and `@nuxt-layers/profile/tailwind.css`. Every other path, including `server/internal` and `server/database`, is private.

## Settings

| Setting | Default | Does |
|---|---|---|
| `NUXT_PROFILE_BASE_URL` (`runtimeConfig.profile.baseUrl`) | empty | The host's public origin. State-changing `/api/profile/*` requests must carry a matching `Origin` (or `Referer`); while empty, all are refused |
| `NUXT_PUBLIC_PROFILE_LOCALE` | `en-GB` | Locale of the pages' text |
| `NUXT_PUBLIC_PROFILE_ROUTES_SIGN_IN` (`profile.routes.signIn`) | `/sign-in` | Where pages send a person to sign in, with `?redirect=` |
| `NUXT_PUBLIC_PROFILE_ROUTES_CLOSE_ACCOUNT` (`profile.routes.closeAccount`) | empty | The host's account-closure page, the only route to erasure |
| `profile.presentation` (`nuxt.config.ts`) | `true` | `false` registers no pages, components or presentation auto-imports |
| `profile.pages.enabled` | `true` | `false` keeps the components without the pages |
| `profile.pages.paths` | see Screens | Moves the pages; the person path must keep `:subjectId` |
| `profile.messages` (`app.config.ts`) | `presentation/messages.ts` | Wording overrides and further locales |
| `provideProfileRetention({ outboxDays, requestDays, endedHoldDays })` | 30, 730, 365 | Retention, within `PROFILE_RETENTION_BOUNDS` (7–365, 365–2555, 30–2555). Shorter than a default needs a `riskTreatment` reference |

Fixed policies, exported from the contract: `PROFILE_LOOKUP_RATE_LIMIT` (60 lookups a minute per viewer, each up to 200 people), `PROFILE_STEP_UP_SECONDS` (900: "recent sign-in"), `PROFILE_REQUEST_POLICY` (requests due one calendar month after opening, escalated 7 days before).

## Host passes

Required ports fail closed: a missing one throws `ProfileCompositionError`. There is no in-memory store and no default key.

| Port (`provide…`) | Required | Shape and duty |
|---|---|---|
| `ProfileDatabase` | Yes | A `pg`-compatible pool connecting as a runtime role that owns nothing; `schema` (default `profile`); `migrationPool` and `runtimeRole`, so `migrateProfileDatabase()` runs as owner and grants the runtime role data access only. PostgreSQL 16 |
| `ProfileKeyWrapper` | Yes | `wrap`/`unwrap` each person's 256-bit data key with a versioned host key (KMS, HSM or vault), binding `context.identityId` and rejecting on failure. `createLocalProfileKeyWrapper({ keys, current })` for development and self-hosting |
| `ProfileDisclosureContext` | Yes | Identity's disclosure-context port, passed through unchanged: the viewer's relationship to each person, the person's standing and the group's departure data policy |
| `ProfileSubjectResolver` | For the endpoints | `resolve(event)` → the signed-in principal from Authentication (`principalId`, `authenticatedAt`, `assurance`) or `null` |
| `ProfileRequestCoordinator` | For data-subject requests | Each other member's part of an access request, from iam-integration's `profileRequestCoordinatorFromMembers`; answers `configuration` with `null` when no configuration layer is composed |
| `ProfileAccessDecision` | For `administration` lookups | Whether the viewer holds a Profile permission on a group now, from iam-integration's `profileAccessDecisionFromAuthorisation` |
| `ProfileNotifier` | For contact verification | Delivers a 6-digit code by email or SMS in the person's locale, and nothing else |
| `ProfileClock` | No | `{ now(): Date }`, the same clock given to every member; the system clock without it. Only server code composes it |

The host also:

1. Relays Identity's events to `applyProfileIdentityEvent` (iam-integration's `createIdentityEventHandler` with `applyProfileEvent`, `heldParts: profileLegalHoldParts`, `recordRequestPart: recordProfileRequestPart`).
2. Drains Profile's outbox with `relayProfileOutbox({ publish })` to name caches and to iam-integration's `createProfileEventHandler`.
3. Schedules `runProfileMaintenance()` every few minutes, and `rewrapProfileKeys()` after each change of wrapping-key version.
4. Gives operators server-only tooling over the request and legal-hold functions; never HTTP.
5. Takes `subjectId` and `viewerId` only from the signed-in principal, never from a request body.

## Client and server functions

### Server functions

| Function | Does |
|---|---|
| `migrateProfileDatabase()` | Applies migrations as owner; grants the runtime role data access only |
| `getOwnProfile({ subjectId })` | Own record, disclosure settings and `version` (0 before anything is stored); `null` once erased |
| `updateProfile({ subjectId, changes, correlationId, expectedVersion? })` | Sets or removes attributes; `conflict` if `expectedVersion` is stale |
| `setProfileDisclosure({ subjectId, settings, correlationId, expectedVersion? })` | Each attribute's audience: `group`, `tenant` or `nobody` (defaults: name to `group`, all else `nobody`) |
| `anonymiseProfileDeparture({ subjectId, groupId, correlationId })` | The leaver chooses to be shown as "Former member" in a group |
| `lookupProfileDisplayNames({ viewerId, subjectIds, groupId?, purpose })` | Up to 200 names, in order asked; `purpose` is `listing`, `attribution` or `administration` (needs `groupId`) |
| `consumeProfileLookup({ viewerId })` | Counts one lookup against the rate limit |
| `viewProfile({ viewerId, subjectId, groupId? })` | One person's display name and disclosed attributes |
| `listProfileDepartures({ subjectId })` | Groups the person has left |
| `exportProfileData({ subjectId })` | Profile's part of a data-subject export, decrypted |
| `applyProfileIdentityEvent(event)` | Consumes Identity's events, idempotently by event id |
| `eraseProfile({ identityId, reasonCode, correlationId })` | Deletes record, departures and wrapped key; the identifier is never re-created. `conflict` (`legal-hold`) while held |
| `rewrapProfileKeys({ limit? })`, `profileKeyVersionsInUse()` | Key rotation: retire a wrapping-key version only once no live key and no backup needs it |
| `relayProfileOutbox({ publish, limit? })` | Publishes events at least once, in order |
| `openProfileRequest`, `listProfileRequests`, `getProfileRequest`, `getProfileRequestArchive`, `settleProfileRequestPart`, `recordProfileRequestPart` | Data-subject requests (`access`, `restriction`, `correction`, `erasure`) and their parts |
| `placeProfileLegalHold`, `releaseProfileLegalHold`, `listProfileLegalHolds`, `profileLegalHoldParts` | Legal holds (at most 7 years) deferring erasure of `profile`, `authentication` or `authorisation` parts |
| `runProfileMaintenance()` | Ends holds, deletes expired archives, escalates requests, retries access parts, drops expired codes, applies retention |
| `startProfileContactVerification`, `confirmProfileContactVerification` | Verifies a saved `email` or `phone_number` |

### HTTP API (`/api/profile`)

| Endpoint | Does | Needs |
|---|---|---|
| `GET /me` | Own record, settings, version | Signed in |
| `PATCH /me` | `{ expectedVersion, changes }` | Signed in; recent sign-in if `email` or `phone_number` changes |
| `PUT /me/disclosure` | `{ expectedVersion, settings }` | Signed in |
| `POST /me/departures/:groupId/anonymise` | Departure anonymity | Signed in |
| `GET /me/departures` | Groups left | Signed in |
| `GET /me/export` | Own data, `no-store` | Recent sign-in |
| `POST /display-names` | `{ subjectIds (≤ 200), groupId?, purpose }` | Signed in; rate-limited |
| `GET /people/:subjectId?groupId=` | One person, as a listing | Signed in; rate-limited |
| `GET /me/requests`, `POST /me/requests` | Own requests; open `{ type: 'access' \| 'restriction' }` (201) | Signed in; recent sign-in to open |
| `GET /me/requests/:requestId/archive` | A completed access archive, `no-store` | Recent sign-in |
| `POST /me/verification/:attribute/send`, `…/confirm` | Send a code (5 an hour); confirm `{ code }` | Recent sign-in to send |

There is no erasure endpoint. Errors are `ProfileErrorBody` (`code`, a localisation key, and a `reason` for `validation-failed` and `conflict`). `useProfile()` is the browser client of this API, for the user experience only.

### Errors

| Code | HTTP | Meaning |
|---|---|---|
| `unauthenticated` | 401 | No signed-in subject |
| `forbidden` | 403 | Refused; never says whether a person or record exists |
| `insufficient-assurance` | 403 | Needs a sign-in within 15 minutes |
| `validation-failed` | 400 | Malformed input; problem codes only (`wrong-code` for verification) |
| `conflict` | 409 | `version-changed`, `legal-hold` or `code-expired` |
| `rate-limited` | 429 | Lookups or codes spent for this window |
| `unavailable` | 503 | A port, the database or the clock failed; fails closed |

### Events

Written to Profile's outbox in the same transaction as the change; identifiers, attribute names and codes only, never a value: `profile.created`, `profile.changed`, `profile.departure-anonymised`, `profile.anonymised`, `profile.contact-verified`, `profile.request-opened`, `profile.request-completed`, `profile.request-escalated`, `profile.legal-hold-placed`, `profile.legal-hold-ended`, `profile.group-disposed`, `profile.retention-applied`. Schemas: `PROFILE_EVENT_PAYLOADS`.

Consumed from Identity: `identity.provisioned`, `membership.ended`, `identity.closed`, `identity.paused`, `group.renamed`, `group.deleted` (when disposal is due) and `group.disposal-due`.

## Permissions

`PROFILE_PERMISSIONS`, for the host to add to Authorisation's catalogue:

| Permission | Risk | Effect | Allows |
|---|---|---|---|
| `profile.suspended-people:view` | `high` | `view` | Seeing a group's suspended members by name in an `administration` lookup. Not reached by `*:view` wildcards: name it in the `owner` and `administrator` roles |

## Screens

| Page | Default path | Shows |
|---|---|---|
| `profile` | `/profile` | Own details, who sees each, display name, departure choice, data download, contact verification |
| `person` | `/profile/people/:subjectId` | Another person's disclosed name and details; `?groupId=` applies the departure policy |
| `departures` | `/profile/departures` | Groups left, named by `ProfileGroupName`, with the anonymity choice |
| `requests` | `/profile/requests` | Own requests, progress and archive download; links to `closeAccount` for deletion |

Components: `ProfilePersonName` (props `identityId`, `groupId = null`, `purpose = 'listing'`, `link = false`; renders "Member" until and unless a name is disclosed) and `ProfileGroupName` (prop `groupId`; the host overrides it with a component of the same name showing Identity's group name). Composables: `useProfile()`, `useProfileText()`, `useProfileAction()`, `useProfileRoutes()`, `useProfileNames()`, `forgetProfileNames()` (call when the viewer changes without a page load).

Styling needs Theme Manager's SemanticPresentationTheme (optional): import its `presentation.css`, then `@nuxt-layers/profile/tailwind.css`, in the host's Tailwind stylesheet. Without it, pages work unstyled. Switch off with `profile.pages.enabled: false` or `profile.presentation: false`.

## Headless surface

Any screen drawing Profile, the default ones included, must:

- decide nothing: every change is decided again on the server;
- send changes against the version shown and reload on `conflict`;
- ask for a recent sign-in on `insufficient-assurance`;
- show an unknown, hidden and malformed person identically ("not available"), and render "Member" until a name is disclosed;
- look names up in the browser only, batched through `useProfileNames()`, and never put a name in a document title;
- offer no erasure: deletion is account closure;
- meet WCAG 2.2 AA.

## You will hit this

- Identifiers are UUIDv7 from Identity; only identities of kind `person` have a record.
- Attributes are OpenID Connect claim names (`name`, `given_name`, `family_name`, `preferred_username`, `locale`, `zoneinfo`, `email`, `phone_number`); check input with `attributeSchemas` from the contract.
- Without `NUXT_PROFILE_BASE_URL`, every state-changing request is refused.
- Export, contact-detail changes, opening requests and sending codes need a sign-in within 15 minutes.
- Standing (paused, suspended, closed) is read from Identity at every lookup; nothing is cached.
- A held closed record is readable by no function; `eraseProfile` is refused until the hold ends.
- Operators' functions are server-only; exposing them over HTTP breaks the contract.
- A Profile contact email is independent of Authentication's sign-in email.
