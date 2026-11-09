# Profile Specification (contract version 2)

> **In short:** the detailed rules behind Profile's public contract, for maintainers. Hosts compose from [`CONTRACT.md`](../CONTRACT.md) alone.

`@nuxt-layers/profile/contracts` is the only supported import path for this capability's types and pure helpers. It imports nothing but `zod`: no driver, key service or other capability's package.

Profile answers two questions: **what describes this person**, and **what may this viewer see of it, now?** It is the only canonical source of the personal data that describes a person. The host's sign-in service never stores or seeds it.

## 1. Boundaries

| Concern | Owner | How Profile sees it |
|---|---|---|
| Names, contact details and preferences that describe a person | **Profile** | Its own schema, encrypted per person (§6) |
| Who may see each attribute | **Profile**, under the person's control | Disclosure settings (§4) |
| Identities, groups, tenants, memberships, a person's standing | The host's directory | The disclosure-context port (§9) and Profile's own commands (§8.1), onto which the host maps its directory's changes |
| Sign-in identifiers, credentials, sessions | Authentication | Never: a contact email here is independent of a sign-in email there |
| Domain records | Domain capabilities | They store Identity's identifiers and ask Profile for names |
| Dates and times: the current time, arithmetic, comparison, interchange formats, time zones and formatting | Clock (a package dependency) | Every time through Clock's operations (§16); Profile reimplements none |

## 2. Keys

Every record is keyed by the host's directory identifier (a UUIDv7), never derived from personal data. Only people have a record. A record is created, empty, when the host calls `provisionProfileRecord` (§8.1), or when the person first saves something if that has not happened yet.

## 3. The record

The attributes are named as OpenID Connect standard claims:

| Attribute | Rule |
|---|---|
| `name`, `given_name`, `family_name` | Safe names: Unicode NFC, spaces collapsed, no control, format or private-use characters, one script or an allowed combination, 1 to 200 code points |
| `preferred_username` | A safe name of up to 64 code points |
| `locale` | A BCP 47 tag, e.g. `en-GB` |
| `zoneinfo` | An IANA time zone, e.g. `Europe/London`, spelt exactly; Clock's `isValidTimeZone` decides (§16) |
| `email` | An email address, with `email_verified` |
| `phone_number` | E.164, e.g. `+447700900123`, with `phone_number_verified` |

Contact details are stored unverified, and become verified only when the person types back a code Profile sent to them through the host's notifier (§15). Changing one makes it unverified again. Profile sends nothing else to them.

A change names only the attributes it changes: a value sets one, `null` removes it. An unknown attribute, an empty change or an attempt to set a verification claim is refused (`validation-failed`, with problem codes only, never the value).

## 4. Disclosure settings

The person chooses, for each attribute, its **audience**:

| Audience | Who sees it |
|---|---|
| `nobody` | The person only |
| `group` | People who share a group with them, both memberships in effect |
| `tenant` | Also anyone with a membership in effect in the same tenant |

The defaults are secure: `name` to `group`, everything else to `nobody`.

The person also chooses which name others see as their **display name**: `name`, `preferred_username` or `given_name` (default `name`). Others see it only if that attribute's audience includes them; otherwise they see the neutral fallback.

Finally, `anonymiseOnDeparture` (default `false`) shows the person as "Former member" in every group they leave, whatever the group's policy.

## 5. What a viewer sees

The host's disclosure-context port (§9) says how the viewer is related to each person (`self`, `same-group`, `former-member`, `same-tenant`, `none`) and the person's standing (`visible`, `paused`, `suspended`, `closing`, `gone`). Profile then applies its rules, as the pure functions `discloseAttributes` and `discloseDisplayName`:

1. The person sees everything of their own, whatever their standing.
2. A `suspended`, `closing` or `gone` person is hidden from everyone else.
3. A `paused` person is hidden from listings (`purpose: 'listing'`: member lists, profiles, search), but stays attributed on past contributions (`purpose: 'attribution'`).
   With a group context, the subject's own membership of that group makes their standing stricter (`standingInGroup`): a member paused there counts as `paused` there, and one suspended there as `suspended`, so a person hidden in a group is hidden there for every purpose a hidden person is.
4. In an `administration` lookup (a group's member list as its administrators see it), a `suspended` fellow member of the group is shown by display name only, never other attributes, and only within the audience the person chose for that name, to a viewer who holds `profile.suspended-people:view` on the group now. Profile asks the host's access decision through the access-decision port (§9), once per lookup and only when the answer could name someone. Otherwise it is a listing.
5. Otherwise each attribute is shown only to its audience: `same-group` reaches `group` and `tenant`; `same-tenant` reaches `tenant`; `none` reaches nothing.
6. A former member (§5.1) is shown by display name only, never by other attributes.

A display name is returned as a code, never as text the host must translate: `{ kind: 'name', value }`, `{ kind: 'pseudonym', number }`, `{ kind: 'former-member' }` or `{ kind: 'hidden' }`. Presentation localises them, for example "Former member 7", "Former member", "Member". A hidden answer is the same whether or not the person exists or has a record.

### 5.1 Departure data policy

When the host records a departure (`recordProfileDeparture`, §8.1), Profile keeps how the leaver will be shown in that group:

- the display name fellow members could see at that moment, encrypted with the leaver's key (null if they could see none);
- a pseudonym number, unique and stable within the group;
- nothing at all, if the person chose `anonymiseOnDeparture`.

A later lookup with that group as context applies the group's attribution, which the disclosure context supplies: `keep-name` shows the kept name, `pseudonymise` shows "Former member N", `anonymise` shows "Former member". The leaver may at any time choose anonymity in a group (`anonymiseProfileDeparture`): the kept name and the pseudonym are deleted, whatever the group's policy.

## 6. Encryption and erasure

Every attribute value, and every kept departure name, is encrypted with the person's own 256-bit data key (AES-256-GCM, a fresh nonce for each value). The additional authenticated data binds each value to the identity and its purpose, so a ciphertext cannot be moved to another person or another column. Disclosure settings, identifiers, pseudonym numbers and codes are stored in the clear: none describes the person.

The data key is stored only **wrapped** by the host's `ProfileKeyWrapper`, which binds the identity to the wrapping and versions its wrapping key.

**Erasure** (anonymisation by unlinking, ADR-0005 §2.8) deletes the record, the departures and the wrapped key, and records the identifier as erased so that no record is created for it again. Domain records keep the identifier, which then refers to nobody. It happens when the host closes the account (`closeProfileSubject`, §8.1), or through `eraseProfile` with a reason code, and is announced as `profile.anonymised`.

**Backups.** A backup taken before erasure still holds the wrapped key. The host therefore rotates its wrapping key: `rewrapProfileKeys()` moves every live key to the current version, and `profileKeyVersionsInUse()` shows when no live key needs an old one. Once every backup taken under an old version has expired, or sooner, the host retires that version. An erased person's key is never re-wrapped, so their data in older backups becomes unreadable when the version it was wrapped with is retired. Backups never hold plaintext.

## 7. Errors

| Code | HTTP | Meaning |
|---|---|---|
| `unauthenticated` | 401 | No signed-in subject |
| `forbidden` | 403 | Refused. Never says whether a person or record exists |
| `insufficient-assurance` | 403 | Needs a sign-in within the last 15 minutes (§12) |
| `validation-failed` | 400 | Malformed input; problem codes only |
| `conflict` | 409 | The record changed since the version the change was made against (`version-changed`) |
| `rate-limited` | 429 | The viewer's lookups for this window are spent |
| `unavailable` | 503 | Database, key port, subject resolver or disclosure-context port failure. Fails closed: no stale or partial answer |

## 8. Events

Written to Profile's transactional outbox in the same transaction as the change, and relayed by the host (`relayProfileOutbox`), at least once, in order.

| Event | Data |
|---|---|
| `profile.created` | `identityId` |
| `profile.changed` | `identityId`, the attribute names changed, whether disclosure changed |
| `profile.departure-anonymised` | `identityId`, `groupId`: drop any name cached for them there |
| `profile.anonymised` | `identityId`, `reasonCode`: drop every name cached for them |
| `profile.contact-verified` | `identityId`, `attribute` |
| `profile.request-opened` | `requestId`, `identityId`, `type`, `origin`, `parts`, `dueAt` (§14) |
| `profile.request-completed` | `requestId`, `identityId`, each part's `status` and `reasonCode` |
| `profile.request-escalated` | `requestId`, `identityId`, `reasonCode` (`due-soon`, `group-rename-overdue`): operators act |
| `profile.legal-hold-placed` | `holdId`, `identityId`, `parts`, `reasonCode`, `endsAt` |
| `profile.legal-hold-ended` | `holdId`, `identityId`, `parts`, `released` (no hold covers them any more), `identityClosed` (whether `closeProfileSubject` has run), `reasonCode`: the host erases the released parts of a closed account |
| `profile.group-disposed` | `groupId`, how many departures were removed and how many a hold kept (§17): the host's confirmation that Profile's part is gone |
| `profile.retention-applied` | How many delivered events, completed requests and ended holds were deleted, when a run deleted anything (§17) |

Events carry identifiers, attribute names and codes only: never a value.

Request and hold events name parts as stored: `profile` and the host's declared names (§14).

### 8.1 Commands

Profile parses no other capability's events. The host maps its directory's changes onto Profile's own commands (schemas in `shared/commands.ts`, exported from the contract). Each takes `commandId` (a UUIDv7; a host relaying an event passes the event's identifier) and `correlationId`, is a strict object, and is applied once: the id is recorded in `processed_event` in the same transaction as the effect and its outbox writes, so a repeat answers `duplicate` and changes nothing.

| Command | Input beside the ids | Effect |
|---|---|---|
| `provisionProfileRecord` | `subjectId` | Creates the empty record and key (`profile.created`); never for an erased identifier. The host calls it for people only |
| `recordProfileDeparture` | `subjectId`, `groupId`, `endedAt` | Snapshots how the leaver is shown in the group (§5.1) |
| `closeProfileSubject` | `subjectId` | Records the closure; erases (§6, reason `identity-closed`) unless a hold covers `profile`, when the record is kept unread; marks each held part of open erasures `held`; settles the directory part (§14) |
| `recordProfilePause` | `subjectId` | Completes the directory part of open restriction requests |
| `recordProfileGroupRenamed` | `groupId` | Marks the group renamed in open requests, completing the directory part once every named group is renamed |
| `disposeProfileGroup` | `groupId` | Disposes of Profile's part of a deleted group (§17); the host calls it only when disposal is due, after any hold on the group |

Profile reads pausing, suspension and closure from the disclosure-context port at each lookup, so a standing is never stale.

## 9. Ports

Each is passed to `composeProfile` under its key (`database`, `keyWrapper`, `disclosureContext`, `subjectResolver`, `requestCoordinator`, `accessDecision`, `notifier`, `clock`), beside `timeZone` (§16), `retention` and `requestParts` (§14). Every port is stated in Profile's own terms; the host adapts what it has.

| Port | Required | Purpose |
|---|---|---|
| `ProfileDatabase` | Yes | PostgreSQL pool (runtime role), schema, and optionally the migration pool and the runtime role to grant |
| `ProfileKeyWrapper` | Yes | Wraps and unwraps each person's data key with a versioned host key (KMS, HSM, vault; `createLocalProfileKeyWrapper` for development) |
| `ProfileDisclosureContext` | Yes | The host's directory: relationship, standing, membership state and departure policy for one viewer and up to 200 people (`DisclosureContext`, §5), read `bounded`, parsed strictly |
| `ProfileSubjectResolver` | For the endpoints | The signed-in person for an HTTP request (`ProfileSubject`: `principalId`, `authenticatedAt`, `assurance.level` `aal1` or `aal2`, `assurance.phishingResistant`), from the host's sign-in |
| `ProfileRequestCoordinator` | When a declared part is `coordinated` | Each coordinated part of an access request (§14); a failure rejects that part only. Declaring a coordinated part without it fails composition |
| `ProfileAccessDecision` | For `administration` lookups | Whether the viewer holds one of Profile's permissions on a group now, by the host's access decision |
| `ProfileNotifier` | For verification | Delivers a verification code by email or SMS (§15); nothing else |
| `ProfileClock` | No: Clock's system clock without it | The current time, `{ now(): string }` (Clock's `ClockPort`, a UTC ISO 8601 instant), the same clock the host gives every capability (§16) |

Profile's own declaration of its permission (`PROFILE_PERMISSIONS`), for the host to register with its access decision:

| Permission | Risk | Effect | Allows |
|---|---|---|---|
| `profile.suspended-people:view` | `high` | `view` | Seeing the display names of a group's suspended members, in an `administration` lookup. `high` because it discloses personal data otherwise hidden: the host grants it by name only, never through a wildcard, to a group's owners and administrators, at `aal2` |

## 10. Server functions

| Function | Does |
|---|---|
| `composeProfile(composition)` | Supplies every port and the request-part declaration in one call (ADR-0012 §1) and applies migrations through the migration pool, granting the runtime role data access only. The only way to compose Profile; the per-port registry is private (`server/internal/composition.ts`). All or nothing: a missing required port (`database`, `keyWrapper`, `disclosureContext`), an invalid port or an unknown option throws and leaves nothing supplied |
| `getOwnProfile({ subjectId })` | The person's own record, settings and `version` (0 before anything is stored); null once erased |
| `updateProfile({ subjectId, changes, correlationId, expectedVersion? })` | §3; with `expectedVersion`, `conflict` if the record changed since |
| `setProfileDisclosure({ subjectId, settings, correlationId, expectedVersion? })` | §4; likewise |
| `anonymiseProfileDeparture({ subjectId, groupId, correlationId })` | §5.1 |
| `lookupProfileDisplayNames({ viewerId, subjectIds, groupId?, purpose })` | Up to 200 display names, in the order asked (§5) |
| `consumeProfileLookup({ viewerId })` | Counts one lookup against the rate limit (§12); `rate-limited` once spent |
| `viewProfile({ viewerId, subjectId, groupId? })` | One person's display name and disclosed attributes, as a listing |
| `exportProfileData({ subjectId })` | Profile's part of a data-subject export, decrypted |
| `provisionProfileRecord`, `recordProfileDeparture`, `closeProfileSubject`, `recordProfilePause`, `recordProfileGroupRenamed`, `disposeProfileGroup` | Commands (§8.1) |
| `eraseProfile({ identityId, reasonCode, correlationId })` | §6 |
| `rewrapProfileKeys({ limit? })`, `profileKeyVersionsInUse()` | Key rotation (§6) |
| `relayProfileOutbox({ publish, limit? })` | §8 |
| `listProfileDepartures({ subjectId })` | The groups the person has left: identifiers, dates and whether they chose anonymity there |
| `openProfileRequest({ subjectId, type, origin, reasonCode?, parts?, groupIds?, correlationId })` | Opens a request (§14) |
| `listProfileRequests({ subjectId })`, `getProfileRequest({ requestId })` | The person's requests; one request, for operators |
| `getProfileRequestArchive({ subjectId, requestId })` | A completed access request's archive, while it lasts |
| `settleProfileRequestPart({ requestId, part, outcome, reasonCode?, correlationId })` | An operator marks a part `done`, or `exempt` with a reason code |
| `recordProfileRequestPart({ identityId, part, correlationId })` | The host reports its erasure of a declared part done (not `profile`, not the directory part) |
| `placeProfileLegalHold(...)`, `releaseProfileLegalHold(...)`, `listProfileLegalHolds({ identityId })` | Legal holds (§14), for operators |
| `profileLegalHoldParts(identityId)` | The parts under hold now, for the host's closure handling |
| `profileTasks()` | ADR-0012's scheduled-work shape: `profile.maintenance`, every 300 seconds, running `runProfileMaintenance()` |
| `createProfileTestPorts({ demonstration? })` | Stand-ins for every port but the database (ADR-0012 §3), refused unless `NODE_ENV` is `test` or a demonstration opts in |
| `runProfileMaintenance()` | Ends holds on their date, deletes expired archives, escalates requests, retries failed access parts, drops expired codes |
| `startProfileContactVerification(...)`, `confirmProfileContactVerification(...)` | §15 |

The operators' functions are server-only: a host never exposes them over HTTP.

The caller supplies `subjectId` and `viewerId` from the signed-in principal, never from a request body.

## 11. Versioning

This is contract version 1. During development, formal releases and tags are suspended (ADR-0008 ([resources](../RESOURCES.md))): consumers follow `master`, and the contract version, not a package version, describes interface compatibility. A change that breaks the contract (a removed or narrowed type, function, endpoint, event or port, or a stricter rule a host must act on) raises the contract version in `capability.json` and is recorded in `CHANGELOG.md` and [`CONTRACT.md`](../CONTRACT.md) in the same change. Additions keep the version. The `1.0.0` entry in `CHANGELOG.md` and the package version are historical development metadata, not a release consumers pin.

History: package 0.2 added the HTTP API (§12), record versions, the `insufficient-assurance`, `conflict` and `rate-limited` codes and the subject-resolver port; 0.3 the presentation (§13); 0.4 data-subject requests and legal holds (§14), contact-detail verification (§15), the `administration` purpose and Profile's permission; then the optional clock port (§16) and end of life (§17), with migration `0004_retention`. Verification means `email_verified` and `phone_number_verified` may be `true`.

## 12. HTTP API

Under `/api/profile`. Every endpoint takes the person or viewer only from the host's subject resolver (the signed-in principal), never from the request; parses bodies with strict schemas; and answers errors as `ProfileErrorBody`: the code, a localisation key, and a problem code for `validation-failed` and `conflict` only. State-changing requests must carry an `Origin` (or `Referer`) matching `NUXT_PROFILE_BASE_URL`; without one configured, they are all refused.

| Endpoint | Does | Needs |
|---|---|---|
| `GET /me` | The person's own record, settings and version | Signed in |
| `PATCH /me` | `{ expectedVersion, changes }` (§3) | A sign-in within 15 minutes if the change touches `email` or `phone_number` |
| `PUT /me/disclosure` | `{ expectedVersion, settings }` (§4) | Signed in |
| `POST /me/departures/:groupId/anonymise` | §5.1 | Signed in |
| `GET /me/export` | Profile's part of the person's export, `Cache-Control: no-store` | A sign-in within 15 minutes |
| `POST /display-names` | `{ subjectIds (≤ 200), groupId?, purpose }` (§5); `administration` needs `groupId` | Signed in; rate-limited |
| `GET /people/:subjectId?groupId=` | One person's display name and disclosed attributes, as a listing | Signed in; rate-limited |
| `GET /me/departures` | The groups the person has left (§10) | Signed in |
| `GET /me/requests` | The person's requests and each part's progress (§14) | Signed in |
| `POST /me/requests` | `{ type }`: an `access` or `restriction` request; 201 | A sign-in within 15 minutes |
| `GET /me/requests/:requestId/archive` | A completed access request's archive, `Cache-Control: no-store` | A sign-in within 15 minutes |
| `POST /me/verification/:attribute/send` | Sends a code to `email` or `phone_number` (§15) | A sign-in within 15 minutes; 5 an hour |
| `POST /me/verification/:attribute/confirm` | `{ code }` | Signed in |

A change sent against an older version than the one stored is refused with `conflict` (`version-changed`), so one tab cannot silently undo another's edit; the client reads `/me` again and retries.

Each viewer may make `PROFILE_LOOKUP_RATE_LIMIT` lookups (60 a minute, each up to 200 people) through the two lookup endpoints, counted in Profile's database. Host server code calling `lookupProfileDisplayNames` directly is not limited.

There is no erasure endpoint: erasure follows account closure (`closeProfileSubject`, §8.1), or an operator's `eraseProfile` on a verified request. The person can remove any attribute themselves.

`useProfile()` is the client side of this API, for the user experience only: it decides nothing. The default pages (§13) use it and nothing else.

Responses are never for another person than the one asked for: a hidden answer is the same whether or not the person exists.

## 13. Presentation

The layer registers default pages and `Profile*` components (`modules/presentation.ts`), which a host configures in its `nuxt.config.ts` under `profile`:

| Page | Default path | Shows |
|---|---|---|
| `profile` | `/profile` | The signed-in person's own profile: their details, who sees each, the name others see, their departure choice, and a download of their data |
| `person` | `/profile/people/:subjectId` | Another person's display name and the details they disclose to the viewer, now. `?groupId=` names the group in view, so a leaver is shown under its departure data policy |
| `departures` | `/profile/departures` | The groups the person has left, each named by `ProfileGroupName`, and the choice, after confirming, to be shown as "Former member" in one of them |
| `requests` | `/profile/requests` | The person's requests: a copy of all their data, or a restriction; each request's progress and the archive's download; deleting their data is closing the account, linked from `profile.routes.closeAccount` |

The own-profile page links to both, and offers verification for each saved contact detail.

**Group names.** Group names belong to the host's directory. `ProfileGroupName` (prop `groupId`) reads "A group you left"; a host backs it with a component of the same name that shows its directory's name for the group, so Profile imports nothing of the host's.

`profile: { pages: { paths: { ... } } }` moves the pages (the person path must keep `:subjectId`); `profile: { pages: { enabled: false } }` keeps the components without the pages; `profile: { presentation: false }` registers nothing. Every page is sent with `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, unless the host sets those headers itself. The person page's document title is always "Profile": a name never reaches the browser's history or tab list from it.

**What the pages decide: nothing.** They call `useProfile()` and show what the server answers; every change is decided again on the server. Fields are checked first with the contract's own `attributeSchemas`, so a problem is shown on its field; changes are sent against the version shown, and a `conflict` reloads the record. Contact-detail changes and the download ask for a recent sign-in when the server answers `insufficient-assurance`, with a link to sign in again. There is no erasure on any page (§12). An unknown person, one hidden from the viewer and a malformed identifier read alike: "This profile is not available to you."

**Names.** `ProfilePersonName` shows one person's name as Profile discloses it to the signed-in viewer:

| Prop | Default | Meaning |
|---|---|---|
| `identityId` | — | The person's identifier in the host's directory |
| `groupId` | `null` | The group the name is shown in, for the departure data policy |
| `purpose` | `listing` | `listing` leaves out a paused person; `attribution` keeps them named (§5) |
| `link` | `false` | Links a disclosed name to the person page, when that page is on. A fallback never links |

It renders "Member" on the server and until the answer arrives, and whenever Profile shows nothing, the same whether or not the person exists; "Former member N" and "Former member" come from the codes. Lookups go through `useProfileNames()`, in the browser only: every name a page asks for in one tick, for one group and purpose, is one request (up to 200 people) against the rate limit (§12); answers are kept for a minute and dropped by `forgetProfileNames()`, which a host calls when the viewer signs in or out. A host's own pages name people through `ProfilePersonName`, directly or through a person-name component of their own that passes `identityId` and the group in view to it, so Profile imports nothing of the host's.

**Text.** Every word comes from `presentation/messages.ts` (en-GB) through `useProfileText()`. Hosts change wording or add locales in `app.config.ts` under `profile.messages`, set the locale with `NUXT_PUBLIC_PROFILE_LOCALE`, and point `profile.routes.signIn` (`NUXT_PUBLIC_PROFILE_ROUTES_SIGN_IN`) at their sign-in page, to which the pages link with `?redirect=`. Validation failures and conflicts are explained from the error's `reason` (`profile.reason.*`), otherwise from its code.

**Styling.** The pages style only through the SemanticPresentationTheme vocabulary (`profileClasses`), the theme's public `presentation.css` and its size scales, never raw colours or Tailwind's default sizes; a host imports `@nuxt-layers/profile/tailwind.css` after its SemanticPresentationTheme stylesheet. Fill, Pen and Edge of one surface share role and state. The deliberate exceptions, which a host's theme must keep legible:

- `pen-muted-default` on `fill-base-default`: hints, notes and definition terms on the card;
- `edge-error-default` on `fill-input-default`: an invalid field's border;
- `edge-base-active` on `fill-base-default`: the keyboard focus indicator.

**Accessibility.** WCAG 2.2 AA: landmarks and one `h1` per page, labelled sections, fieldsets and fields, errors announced and focused (the first invalid field takes focus), status messages announced politely, keyboard operation throughout, 24-pixel targets, reflow at 320 CSS pixels. Browser tests (`tests/e2e/pages.spec.ts`) run axe's WCAG 2.2 AA rules and check non-text contrast with the playground theme's real styles.

## 14. Data-subject requests and legal holds

Profile is the person's single point of contact for requests about their data. It records each request and each part, and keeps legal holds; whoever holds a part answers for it.

**Parts.** Profile names one part, its own: `profile` (`PROFILE_REQUEST_PART`). The host declares every other part in `composeProfile`'s `requestParts` (`ProfileRequestPartsDeclaration`), resolved and checked at composition by `resolveProfileRequestParts` (a `TypeError` names the fault):

| Declaration | Meaning |
|---|---|
| `name` | A code (`REQUEST_PART_PATTERN`, ≤ 32 characters), unique, not `profile`; at most 15 (`MAX_REQUEST_PARTS` is 16 with Profile's) |
| `coordinated` | An access request's bundle comes from the coordination port; otherwise an operator settles the part (`settleProfileRequestPart`) |
| `holdable` | A legal hold may cover it; `profile` always may |
| `directory` | At most one: the person's groups and standing. Profile settles it from its commands (§8.1); a request naming groups includes it, and without it naming groups is `groups-not-allowed` |
| `defaults.<type>` | The parts a request of that type gets unless the operator names them; `profile` is always added. A missing type gets `profile`, and for `access` every coordinated part |

Parts are validated against the declaration: a request naming an undeclared part is `unknown-part`, a hold naming a part not holdable or `recordProfileRequestPart` naming `profile`, the directory part or an undeclared one is `invalid-part`. Views and events list parts in declaration order, `profile` first; a part stored earlier and no longer declared still reads back, after the declared ones, alphabetically. Stored values are part names only (migration 0006 checks the grammar, not a list).

| Type | Who opens it | Parts by default | What happens |
|---|---|---|---|
| `access` | The person (recent sign-in) or an operator | `profile` and every coordinated part | Profile's own part, then each coordinated part through the coordination port, one at a time; each bundle sealed with the person's key. A coordinated part that fails stays pending and is retried by maintenance; others wait for an operator. Complete when every part is answered; the archive is downloadable by the person for 7 days, then deleted |
| `restriction` | The person (recent sign-in) or an operator | `profile` | Every audience becomes `nobody` at once; the directory part, if named, is done on `recordProfilePause` |
| `correction` | An operator | `profile` (and the directory part with `groupIds`) | The directory part is done when every group named is renamed (`recordProfileGroupRenamed`, or disposed); raised to operators at half the deadline |
| `erasure` | An operator (the person closes their account) | `profile`, unless the host's defaults add parts | Done as closure completes: the directory part on `closeProfileSubject` (and any renames), Profile's on its erasure, the host's others as it reports them (`recordProfileRequestPart`) |

A part is `pending`, `done`, `exempt` (with a reason code) or `held`; a request completes once every part is `done` or `exempt`. It is due one calendar month after opening (`PROFILE_REQUEST_POLICY`), in the deadline zone (§16), and raised to operators (`profile.request-escalated`) 7 days before. Requests outlive an erasure, as identifiers, codes and times only.

**Legal holds** are placed and released by operators, with a reason code and an end date at most 7 years ahead. They cover `profile` and any holdable part, and defer only those parts' erasure, never access, correction or restriction, and never the closure itself:

- On `closeProfileSubject`, a hold covering Profile keeps the record, readable by no function (`getOwnProfile` and `exportProfileData` answer null; changes are `forbidden`), and `eraseProfile` is refused (`conflict`, `legal-hold`). Each other held part of an open erasure becomes `held`.
- The host's closure handling reads `profileLegalHoldParts` and leaves its own held parts alone.
- When a hold ends (released, or its end date in maintenance), `profile.legal-hold-ended` names the parts no hold covers any more; Profile erases a closed person's record if Profile's part is among them, the host's released parts become `pending` again, and the host erases them.

## 15. Contact-detail verification

The person verifies a saved `email` or `phone_number`: Profile sends a 6-digit code through the host's notifier (email, or SMS for a telephone number), and the person types it back.

- Sending needs a sign-in within 15 minutes; 5 codes per detail an hour (`rate-limited`).
- A code lasts 10 minutes and allows 5 attempts; a wrong one is `validation-failed` (`wrong-code`), a spent, expired or unsent one `conflict` (`code-expired`).
- The code is kept only as an HMAC under the person's own data key, bound to the identity, the attribute and the value it was sent to: it verifies nothing else, and is destroyed with the key.
- A verified detail becomes unverified when it changes. `profile.contact-verified` carries the identity and the attribute name only.
- Profile sends nothing else to a contact detail.

## 16. Time

Profile reads the current time from the clock the host supplies (`composeProfile({ clock: { now } })`), as iam-integration's architecture §7 ([resources](../RESOURCES.md)) asks of every member; without one, it uses Clock's system clock. A host supplies the same clock to every member, or none.

Clock owns dates and times (Layer Standard §5; Clock's contract in [resources](../RESOURCES.md)), so Profile reimplements none of it. The port is Clock's `ClockPort`, `{ now(): string }`, answering a UTC ISO 8601 instant. Profile's server code reads it through a Clock instance (`createClock` in UTC, private to `server/internal/clock.ts`) and does every addition (calendar days for holds, archives, escalation and retention, and a calendar month, clamped to the month's last day, for a request's due date, all in the deadline zone below; elapsed seconds for codes, windows and recent sign-in), comparison and conversion (driver values and supplied instants through `parseInterchange('rfc3339' | 'epochMilliseconds')`, UUIDv7 milliseconds through `formatInterchange`) with Clock's operations. The default pages format dates with `useClock().format` in the pages' locale and Clock's configured time zone, so SSR and hydration agree; `useProfileNames` times its cache with Clock too. The contract (`contracts/`, `shared/`) still imports only zod: its instant schemas check wire shape only, and every time is re-read through Clock on the server.

**Deadlines across daylight saving.** A deadline in days or months is a calendar deadline, read in the jurisdiction's zone: `composeProfile`'s `timeZone` (an IANA name Clock's `isValidTimeZone` accepts; `UTC` without it). Profile places the start in that zone, adds calendar units with Clock's `compatible` disambiguation (a nonexistent local time moves forward by the gap; a repeated one takes the earlier), and converts back to an instant, as Clock's contract recommends. Seven days from 10:00 BST on 20 October 2026 is 10:00 GMT on 27 October, not 09:00. Clock's configured `timeZone` is presentation only and never the deadline zone; the person's `zoneinfo` is not used either, so every person's deadlines follow the controller's one rule. Retention cutoffs are computed this way and passed to the owner's `apply_retention_before` function, which still refuses anything younger than its hard floors. A request view carries the zone (`timeZone`), and the default pages show its due and archive dates in it, naming it.

**Zones.** `zoneinfo` is validated by Clock's `isValidTimeZone` on the server (`updateProfile`, answering `invalid-time-zone`) and in the details page, before sending; the contract checks only the shape (a non-empty string without spaces, at most 64 characters), since it may import only zod. A name must be spelt exactly, capitals included; links such as `Europe/Kiev`, `Etc/*` and `UTC` are valid, offsets are not. The picker lists Clock's `timeZones()`, a fixed list the same on the server and in every browser, so it renders during SSR; a stored value outside the list (a link) stays selectable and is never changed silently.

- Every time Profile keeps or judges comes from the clock: the times it writes (records, keys, erasures, departures, requests, parts, holds, closures, codes, the outbox) and events' `occurredAt`; when a hold, a request's due date or escalation, an access archive, a verification code or its sending window, and a lookup rate-limit window ends; and whether a sign-in is recent enough for the endpoints that need one. The database judges no time of its own: each such time is passed to it from the clock. A correction or erasure is raised to operators for an unrenamed group at a time Profile computes through Clock when the request opens (halfway to its due date, in elapsed time) and stores (`rename_escalate_at`, migration `0009_rename_escalate_at`); requests opened earlier were backfilled once with the same halfway point.
- **One deliberate exception: retention floors.** `apply_retention_before` caps the cutoffs it is given at 365 days (requests) and 30 days (ended holds) before the run's time, with PostgreSQL's own interval arithmetic in UTC. The real retention rule is computed through Clock; the floor is a backstop the owner's function enforces inside the database, so a misbehaving runtime role or application cannot delete records younger than it. A floor computed by the application would be only as trustworthy as the application, so it stays in SQL. It can differ from Clock's calendar arithmetic by at most an hour across daylight saving, and only ever in the direction of keeping records longer.
- A clock that throws, or answers anything Clock rejects as an instant (`CLOCK_INVALID_INPUT`), fails the operation as `unavailable`; Profile recognises Clock's failures with `instanceof ClockError` (imported from `@nuxt-layers/clock/server`) and no `ClockError` crosses Profile's boundary. Profile never falls back to another time.
- The clock is trusted like a key: whoever supplies it can end a hold, an archive or a code's life early. Only the host composes it, from server code; no request can set or move it. A clock that can be moved is for tests only.

## 17. End of life

Profile's part of the suite's group deletion and retention processes ([resources](../RESOURCES.md)).

**A deleted group.** When the host calls `disposeProfileGroup` (only once the group's disposal is due, after any hold on the group or its tenant has ended), Profile removes the group's departure records and, once none is left, its pseudonym counter; it keeps the departure of anyone a legal hold on Profile's part covers. A data-subject request naming the group no longer needs its rename: the group's part of it is done. It writes `profile.group-disposed`, which the host relays as Profile's confirmation.

**Re-homing.** Profile keeps every record in the one store the host composes, whatever the person's home tenant, so `identity.rehomed` needs nothing from it. A host that keeps people's records in different data regions composes one Profile per region, and moving a record between them is the host's migration; Profile does not yet place records by region.

**Retention.** `runProfileMaintenance` also deletes delivered outbox events after `outboxDays` (30, within 7 to 365), completed data-subject requests after `requestDays` (730, within 365 to 2555) unless a legal hold covers the person, and ended legal holds after `endedHoldDays` (365, within 30 to 2555). A host sets them with `composeProfile`'s `retention`, within `PROFILE_RETENTION_BOUNDS`; shorter than a default needs a `riskTreatment` reference. Requests and holds are records the runtime role cannot delete: only the owner's `apply_retention_before` function (migration `0007_retention_cutoffs`; `0008_drop_day_retention` drops the day-based function it replaces) deletes them, given cutoffs computed in the deadline zone (§16), and it never goes below the hard floors of 365 and 30 days. A run that deleted anything writes `profile.retention-applied` with counts only.


## 18. Shared shapes: open questions

ADR-0012 §2 asks every capability for the same caller, access, mail and scheduled-work shapes ([resources](../RESOURCES.md)). Profile meets the clock, events and scheduled-work shapes. Three ports differ, and are kept until the architecture decides, because adopting the shared shape as written would lose something Profile relies on or break the host's adapters:

| Shared shape | Profile's port | What blocks adopting it |
|---|---|---|
| `resolveCaller(event) → { tenantId, subjectId \| null, assurance }` | `subjectResolver.resolve(event) → { principalId, authenticatedAt, assurance } \| null` | The shared caller has no sign-in time, which Profile's recent-sign-in rule (§12) needs; Profile does not use `tenantId` |
| `decide(caller, action, resource) → { allowed, reason }` | `accessDecision.allows({ subject, permission, groupId }) → boolean` | Equivalent meaning; a rename that the host's access-decision adapter must follow in the same change |
| `send({ to, template, data })` | `notifier.send({ channel, to, purpose, attribute, code, locale, expiresInSeconds })` | Profile also sends by SMS; the shared shape has no channel |

ADR-0012 §2a, which would place these meanings in each capability's contract, is a proposed amendment, not yet accepted. Profile changes these ports once the amendment is decided, in the same change as the host's adapters (`PLAN.md`, phase 14).
