# Profile Contract

> **In short:** how a host installs, configures and composes `@nuxt-layers/profile`, and everything it may call. This page is complete on its own; [`docs/contracts.md`](docs/contracts.md) is the maintainers' detailed specification behind it.

**Status:** in active development; consumers follow `master` (no formal releases). Interface: contract version 2 (`capability.json`).

Profile answers two questions: **what describes this person**, and **what may this viewer see of it, now?** It is the only canonical source of a person's names, contact details and preferences, keyed by the opaque identifier (a UUIDv7) the host's directory gives each person. It knows no other capability: it describes everything in its own terms, and the host translates. It never holds sign-in identifiers, credentials, groups, memberships or permissions. It has no package dependency on any other `@nuxt-layers` capability, database driver, key service or UI library.

## Install

```bash
pnpm add "@nuxt-layers/profile@git+https://github.com/nuxt-layers/profile.git#master"
```

The layer is a Nuxt layer (peer dependency `nuxt` `^4.6.0`, Node.js 26.13 or later). It extends Clock (`@nuxt-layers/clock`, installed with it, following `master`), which owns every date and time Profile keeps, judges or shows; Clock's `runtimeConfig.public.clock` settings (`locale`, `timeZone`, `hourCycle`) are the host's and also govern the dates the default pages show. Add Profile to `extends` and supply its ports from one Nitro plugin:

```ts
// nuxt.config.ts
export default defineNuxtConfig({ extends: ['@nuxt-layers/profile'] })
```

```ts
// server/plugins/profile.ts
export default defineNitroPlugin(() => {
  composeProfile({
    database: { dialect: 'postgres', pool: runtimePool, migrationPool: ownerPool, runtimeRole: 'profile_runtime' },
    keyWrapper: myKmsKeyWrapper, // or createLocalProfileKeyWrapper({ keys, current })
    disclosureContext: myDirectory, // { describe(request, options) }: see "Disclosure context"
    subjectResolver: { resolve: event => mySignedInPerson(event) },
    // Optional, each needed only for the feature named in "Host passes":
    requestParts: {
      parts: [
        { name: 'directory', coordinated: true, directory: true },
        { name: 'sign-in', coordinated: true, holdable: true },
      ],
      defaults: { erasure: ['directory', 'sign-in'] },
    },
    requestCoordinator: { exportPart: ({ identityId, part, correlationId }) => myExport(part, identityId) },
    accessDecision: { allows: ({ subject, permission, groupId }) => myDecide(subject, permission, groupId) },
    notifier: myNotifier,
    clock: myClock,
    retention: { outboxDays: 30 },
  })
})
```

`composeProfile(composition)` (type `ProfileComposition`) supplies every port at once and starts the migrations, returning their promise; it is all or nothing, throwing `ProfileCompositionError` for a missing required port and `TypeError` for an invalid port or an unknown option, with nothing left supplied. It is the only way to compose Profile: there are no per-port functions, and it is called once. `examples/minimal-host` in this repository is a complete, tested host within the 50-line budget, supplying the three required ports and a subject resolver. `composeProfile`, `createLocalProfileKeyWrapper` and the server functions are Nitro auto-imports. Types and pure helpers come only from `@nuxt-layers/profile/contracts`, which imports nothing but `zod`. Other public entry points: `@nuxt-layers/profile/capability` (the manifest), `@nuxt-layers/profile/presentation` and `@nuxt-layers/profile/tailwind.css`. Every other path, including `server/internal` and `server/database`, is private.

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
| `composeProfile({ retention: { outboxDays, requestDays, endedHoldDays } })` | 30, 730, 365 | Retention, within `PROFILE_RETENTION_BOUNDS` (7–365, 365–2555, 30–2555). Shorter than a default needs a `riskTreatment` reference |

Fixed policies, exported from the contract: `PROFILE_LOOKUP_RATE_LIMIT` (60 lookups a minute per viewer, each up to 200 people), `PROFILE_STEP_UP_SECONDS` (900: "recent sign-in"), `PROFILE_REQUEST_POLICY` (requests due one calendar month after opening, escalated 7 days before).

## Host passes

Required ports fail closed: a missing one throws `ProfileCompositionError`. There is no in-memory store and no default key.

| `composeProfile` key; port type | Required | Shape and duty |
|---|---|---|
| `database`; `ProfileDatabase` | Yes | A `pg`-compatible pool connecting as a runtime role that owns nothing; `schema` (default `profile`); `migrationPool` and `runtimeRole`, so the migrations run as owner and grants the runtime role data access only. PostgreSQL 16 |
| `keyWrapper`; `ProfileKeyWrapper` | Yes | `wrap`/`unwrap` each person's 256-bit data key with a versioned host key (KMS, HSM or vault), binding `context.identityId` and rejecting on failure. `createLocalProfileKeyWrapper({ keys, current })` for development and self-hosting |
| `disclosureContext`; `ProfileDisclosureContext` | Yes | The host's directory, answering "Disclosure context" below at every lookup |
| `subjectResolver`; `ProfileSubjectResolver` | For the endpoints | `resolve(event)` → the signed-in person `{ principalId, authenticatedAt, assurance: { level: 'aal1' \| 'aal2', phishingResistant } }` (`ProfileSubject`), or `null`. `principalId` is the identifier the person's record is kept under |
| `requestParts`; `ProfileRequestPartsDeclaration` | No | The parts of data-subject requests beside Profile's own `profile`; see "Request parts". Without it, `profile` only |
| `requestCoordinator`; `ProfileRequestCoordinator` | When a part is `coordinated` | `exportPart({ identityId, part, correlationId })` → that part's machine-readable bundle for an access request, or `null` when nothing is held; rejects on failure (the part stays pending and is retried). Declaring a coordinated part without it fails composition |
| `accessDecision`; `ProfileAccessDecision` | For `administration` lookups | `allows({ subject, permission, groupId })` → whether the viewer holds one of `PROFILE_PERMISSIONS` on the group now; rejects on failure |
| `notifier`; `ProfileNotifier` | For contact verification | Delivers a 6-digit code by email or SMS in the person's locale, and nothing else |
| `clock`; `ProfileClock` | No | `{ now(): string }`, Clock's `ClockPort`: synchronous, answering a UTC ISO 8601 instant such as `2026-11-05T14:30:00.000Z`; the same clock the host gives Clock and every capability. Clock's system clock without it. An answer Clock rejects, or a failure, fails the operation as `unavailable`. Only server code composes it |

### Disclosure context

`describe({ viewerId, subjectIds (≤ 200), groupId | null }, { consistency: 'strong' | 'bounded' })` resolves to `DisclosureContext`, parsed strictly (a malformed answer or a rejection fails closed; extra fields are dropped):

| Field | Values |
|---|---|
| `viewerId`, `groupId` | Echoed |
| `departurePolicy` | `{ attribution: 'keep-name' \| 'pseudonymise' \| 'anonymise' }` for the group context, or `null` |
| `subjects[]` | `{ subjectId, relationship, standing, membershipInGroup? }` |
| `relationship` | `self`, `same-group` (a shared group, both memberships in effect), `former-member` (left the group context), `same-tenant`, `none` (also for an unknown person) |
| `standing` | `visible`, `paused` (own choice; attribution only), `suspended`, `closing`, `gone` |
| `membershipInGroup` | `{ state: 'active' \| 'paused' \| 'suspended' \| 'ended' }` or `null`; a paused or suspended membership hides the person in that group |
| `readAt` | ISO instant |

### Request parts

Profile knows one part by name: its own, `profile` (`PROFILE_REQUEST_PART`). Every other part is the host's, declared in `requestParts` and checked at composition (`TypeError` on a fault):

| Field | Meaning |
|---|---|
| `parts[].name` | A code (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, ≤ 32 characters), unique, not `profile`; at most 15 |
| `parts[].coordinated` | An access request's bundle comes from `requestCoordinator.exportPart`; otherwise an operator settles it |
| `parts[].holdable` | A legal hold can cover it (Profile's part always can) |
| `parts[].directory` | At most one: Profile settles it from its commands (pausing completes a restriction; renaming every named group completes a correction, and, after closure, an erasure). A request naming groups includes it; without it, naming groups is refused |
| `defaults.<type>` | The parts a request of that type gets unless the operator names them; `profile` always added. Missing types: `profile`, and for `access` every coordinated part |

Requests and holds may name only `profile` and declared parts (`validation-failed`: `unknown-part`, `invalid-part`, `groups-not-allowed`). Lists come in declaration order, `profile` first; a part stored earlier and no longer declared still reads back, after the declared ones. The presentation words `profile` itself; the host words its parts with `profile.requests.part.<name>` in `profile.messages`, falling back to "Another part of your account".

The host also:

1. Maps its directory's changes onto Profile's commands (see "Commands"), passing the event's own identifier as `commandId`; when a person's account closes, erases its own holdable parts unless `profileLegalHoldParts` lists them, then reports each with `recordProfileRequestPart`.
2. Drains Profile's outbox with `relayProfileOutbox({ publish })` to its name caches and its own handlers (for example, erasing parts a `profile.legal-hold-ended` released).
3. Runs `profileTasks()` on its one scheduler: each `{ name, every, run }` with `every` in seconds (today `profile.maintenance` every 300). Runs `rewrapProfileKeys()` after each change of wrapping-key version.
4. Gives operators server-only tooling over the request and legal-hold functions; never HTTP.
5. Takes `subjectId` and `viewerId` only from the signed-in principal, never from a request body.

## Client and server functions

### Server functions

| Function | Does |
|---|---|
| `composeProfile(composition)` | Supplies every port in one call and migrates as owner, granting the runtime role data access only; all or nothing |
| `getOwnProfile({ subjectId })` | Own record, disclosure settings and `version` (0 before anything is stored); `null` once erased |
| `updateProfile({ subjectId, changes, correlationId, expectedVersion? })` | Sets or removes attributes; `conflict` if `expectedVersion` is stale |
| `setProfileDisclosure({ subjectId, settings, correlationId, expectedVersion? })` | Each attribute's audience: `group`, `tenant` or `nobody` (defaults: name to `group`, all else `nobody`) |
| `anonymiseProfileDeparture({ subjectId, groupId, correlationId })` | The leaver chooses to be shown as "Former member" in a group |
| `lookupProfileDisplayNames({ viewerId, subjectIds, groupId?, purpose })` | Up to 200 names, in order asked; `purpose` is `listing`, `attribution` or `administration` (needs `groupId`) |
| `consumeProfileLookup({ viewerId })` | Counts one lookup against the rate limit |
| `viewProfile({ viewerId, subjectId, groupId? })` | One person's display name and disclosed attributes |
| `listProfileDepartures({ subjectId })` | Groups the person has left |
| `exportProfileData({ subjectId })` | Profile's part of a data-subject export, decrypted |
| `provisionProfileRecord`, `recordProfileDeparture`, `closeProfileSubject`, `recordProfilePause`, `recordProfileGroupRenamed`, `disposeProfileGroup` | Profile's commands; see "Commands" |
| `eraseProfile({ identityId, reasonCode, correlationId })` | Deletes record, departures and wrapped key; the identifier is never re-created. `conflict` (`legal-hold`) while held |
| `rewrapProfileKeys({ limit? })`, `profileKeyVersionsInUse()` | Key rotation: retire a wrapping-key version only once no live key and no backup needs it |
| `relayProfileOutbox({ publish, limit? })` | Publishes events at least once, in order |
| `openProfileRequest`, `listProfileRequests`, `getProfileRequest`, `getProfileRequestArchive`, `settleProfileRequestPart` | Data-subject requests (`access`, `restriction`, `correction`, `erasure`) and their parts |
| `recordProfileRequestPart({ identityId, part, correlationId })` | The host's erasure of one declared part (not the directory part) is done |
| `placeProfileLegalHold`, `releaseProfileLegalHold`, `listProfileLegalHolds`, `profileLegalHoldParts` | Legal holds (at most 7 years) deferring erasure of `profile` and holdable parts |
| `profileTasks()` | Profile's scheduled work, `{ name, every, run }[]` (`every` in seconds) |
| `runProfileMaintenance()` | Ends holds, deletes expired archives, escalates requests, retries access parts, drops expired codes, applies retention |
| `startProfileContactVerification`, `confirmProfileContactVerification` | Verifies a saved `email` or `phone_number` |

### Testing

`createProfileTestPorts()` (also `@nuxt-layers/profile/testing`) returns stand-ins for every port but the database, to pass to `composeProfile` in tests: `keyWrapper` (a fresh random key), `disclosureContext`, `subjectResolver`, `accessDecision`, `notifier` (records to `sent`, delivers nothing), `requestCoordinator` and `clock`, steered with `signIn(principalId, { authenticatedAt?, assurance? })`, `signOut()`, `relate(viewerId, subjectId, relationship, groupId?)`, `setStanding(subjectId, standing)`, `setDeparturePolicy(groupId, attribution | null)`, `grant(viewerId, permission, groupId)` and `setNow(instant | null)` (a UTC ISO 8601 string; `signIn`'s `authenticatedAt` is one too). It throws unless `NODE_ENV` is `test` or the caller passes `{ demonstration: true }`. The database is always real PostgreSQL.

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

### Commands

The host tells Profile what happened in its directory through these server functions. Each takes `commandId` (a UUIDv7; pass the event's own identifier) and `correlationId`, is strict (unknown fields are `validation-failed`), applies once, and answers `'applied'` or `'duplicate'`.

| Function | Input beside the ids | Profile |
|---|---|---|
| `provisionProfileRecord` | `subjectId` | Creates the person's empty record and key (`profile.created`). Call it for people only; an erased person is never recreated |
| `recordProfileDeparture` | `subjectId`, `groupId`, `endedAt` | Keeps how the leaver is shown in the group: name, pseudonym, or nothing if they chose anonymity |
| `closeProfileSubject` | `subjectId` | Erases record, departures and key (`profile.anonymised`, reason `identity-closed`), or, while a hold covers `profile`, keeps them unread; marks held parts of open erasures `held`; settles the directory part |
| `recordProfilePause` | `subjectId` | The whole account paused: completes the directory part of open restriction requests |
| `recordProfileGroupRenamed` | `groupId` | Completes the directory part of requests naming it, once all they name are renamed |
| `disposeProfileGroup` | `groupId` | Call when the group's disposal is due: deletes its departures and pseudonyms (held people's kept) and request references (`profile.group-disposed`) |

### Events

Written to Profile's outbox in the same transaction as the change; identifiers, attribute names and codes only, never a value: `profile.created`, `profile.changed`, `profile.departure-anonymised`, `profile.anonymised`, `profile.contact-verified`, `profile.request-opened`, `profile.request-completed`, `profile.request-escalated`, `profile.legal-hold-placed`, `profile.legal-hold-ended`, `profile.group-disposed`, `profile.retention-applied`. Schemas: `PROFILE_EVENT_PAYLOADS`.

Request and hold events name parts as stored: `profile` and the host's names.

## Permissions

`PROFILE_PERMISSIONS` is Profile's own declaration (`{ name, description, risk, effect }`), for the host to register with its access decision:

| Permission | Risk | Effect | Allows |
|---|---|---|---|
| `profile.suspended-people:view` | `high` | `view` | Seeing a group's suspended members by name in an `administration` lookup. Grant it by name only, never through a wildcard, to a group's owners and administrators, at `aal2` |

## Screens

| Page | Default path | Shows |
|---|---|---|
| `profile` | `/profile` | Own details, who sees each, display name, departure choice, data download, contact verification |
| `person` | `/profile/people/:subjectId` | Another person's disclosed name and details; `?groupId=` applies the departure policy |
| `departures` | `/profile/departures` | Groups left, named by `ProfileGroupName`, with the anonymity choice |
| `requests` | `/profile/requests` | Own requests, progress and archive download; links to `closeAccount` for deletion |

Components: `ProfilePersonName` (props `identityId`, `groupId = null`, `purpose = 'listing'`, `link = false`; renders "Member" until and unless a name is disclosed) and `ProfileGroupName` (prop `groupId`; the host overrides it with a component of the same name showing the host's group name). Composables: `useProfile()`, `useProfileText()`, `useProfileAction()`, `useProfileRoutes()`, `useProfileNames()`, `forgetProfileNames()` (call when the viewer changes without a page load).

Styling needs a provider of the SemanticPresentationTheme capability (optional), composed by the host: import that provider's `presentation.css`, then `@nuxt-layers/profile/tailwind.css`, in the host's Tailwind stylesheet. Without it, pages work unstyled. Switch off with `profile.pages.enabled: false` or `profile.presentation: false`.

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

- Identifiers are UUIDv7 from the host's directory; only people have a record (call `provisionProfileRecord` for nothing else).
- Attributes are OpenID Connect claim names (`name`, `given_name`, `family_name`, `preferred_username`, `locale`, `zoneinfo`, `email`, `phone_number`); check input with `attributeSchemas` from the contract.
- Without `NUXT_PROFILE_BASE_URL`, every state-changing request is refused.
- Export, contact-detail changes, opening requests and sending codes need a sign-in within 15 minutes.
- Standing (paused, suspended, closed) is read from the disclosure context at every lookup; nothing is cached.
- Removing a part from `requestParts` leaves its stored rows readable, but new requests and holds can no longer name it.
- A held closed record is readable by no function; `eraseProfile` is refused until the hold ends.
- Operators' functions are server-only; exposing them over HTTP breaks the contract.
- A Profile contact email is independent of the host's sign-in email.
- Every time Profile answers is a canonical UTC instant string from Clock; dates on the default pages are shown in Clock's configured `timeZone` (UTC unless the host sets it).
