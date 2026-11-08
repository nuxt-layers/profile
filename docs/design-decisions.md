# Design Decisions

> **In short:** the choices made in Profile's design round, with the alternatives considered.

Decisions taken in Profile's design round, with the alternatives considered.

## 1. Scope of the first round

Foundation and storage together: the contract, composition, PostgreSQL storage, encryption, Identity's events, erasure and export. Endpoints and pages follow as separate phases.

## 2. Attributes

OpenID Connect standard claim names: `name`, `given_name`, `family_name`, `preferred_username`, `locale`, `zoneinfo`, plus contact `email` and `phone_number`, independent of Authentication's sign-in identifiers. No picture or postal address yet: a picture needs a file-storage port and image checks.

## 3. Disclosure

Per attribute, per context: `nobody`, `group` or `tenant`. Defaults: name to fellow group members, everything else to nobody. Per-group overrides and a single all-or-nothing setting were considered; the first adds much to explain and test, the second forces all-or-nothing on contact details.

## 4. Display name

The person picks which of their names others see (`name`, `preferred_username` or `given_name`). If it is not visible to the viewer, the neutral fallback is shown. A fixed rule (name, else nickname) was considered and rejected: the person should decide.

## 5. Contact details

Stored unverified (`*_verified: false`) and never used for sending. Verification needs a host notification port and one-time codes, deferred to phase 4.

## 6. Paused people

Hidden from listings and profiles, but still attributed on past contributions. Hiding attribution too was considered; it would erase a paused person's history from others' view while they may return.

## 7. Encryption and backups

Each person's attributes are encrypted with their own data key, which Profile stores only wrapped by the host's versioned key port, so erasure can reach backups (crypto-shredding). Keeping keys in Profile's database means a backup also holds the wrapped key; the host therefore rotates its wrapping key, Profile re-wraps live keys, and the host retires an old version once its backups expire. A separate key-store port (destroying each key in a KMS at once) was considered; it is stronger but asks every host to run a second store.

## 8. The HTTP API (phase 2)

- **Display-name lookups from the browser:** an endpoint, so client-side pages can show names, limited to 60 lookups a minute per viewer. Server-only lookups were considered; they would force every page that shows names to render on the server.
- **Recent sign-in:** for the data export (as the data-subject process requires) and for changing a contact detail. Names, locale, time zone and disclosure settings can be changed in any signed-in session. Requiring it for every change was considered and rejected as too frequent an interruption.
- **No erasure endpoint:** erasure follows account closure, or an operator acting on a verified request, so there is one path, as the data-subject process describes. The person can remove any attribute themselves.
- **Lost updates:** each change carries the version it was made against, and a stale one is refused. Last write wins was considered; it lets one tab undo another's edit silently.

## 9. The default pages (phase 3)

- **Which pages:** the person's own profile, one page with sections for details, disclosure and the download, and a page for another person's profile as the viewer may see it. Separate pages per area were considered; one page keeps the record's version in one place, so the sections never undo each other. Leaving the person page to hosts was considered; every host would rebuild the same disclosure-bound view.
- **The person-name component:** `ProfilePersonName` takes the identifier, the group in view and the purpose as props, and the host's `IdentityPersonName` is a thin wrapper that passes Identity's route through. Profile overriding `IdentityPersonName` itself was considered and rejected: it would tie Profile to Identity's component name and to the order of layers, against the rule that members never import one another.
- **Links from names:** optional and off by default, and only for a disclosed name while the person page is on; a fallback ("Member", "Former member") never links, so a link says nothing about who exists. Always linking was considered; it spends lookups on pages that only list names.
- **The document title** of the person page stays "Profile", never the name, so names do not reach browser history, tab lists or analytics through it.
- **Departure anonymity in one group:** the setting for every future departure is on the page; choosing it for one group already left needs that group's name, which is Identity's, and follows in phase 4 with the requests.

## 10. Requests and verification (phase 4)

Decided with the owner on 2026-10-10.

- **Coordination:** Profile records each request and each member's part, and asks the other members through a coordination port that iam-integration's adapter builds from their server-only exports; erasure, correction and restriction parts are completed by the members' own events. An events-only design was considered; the export would then need a callback carrying personal data. Coordinating only exports in this phase was considered; it would leave erasure untracked.
- **Legal holds:** per member part (Profile, Authentication, Authorisation), with a reason code and an end date. Closure still goes ahead; a held part is erased when its hold ends. Holding only Profile's own data was considered, and so was blocking the whole erasure, Identity's closure included; the first leaves other members' data unprotected, the second keeps a person who asked to leave on the platform.
- **Verification:** a 6-digit code through a host notifier, 10 minutes, 5 attempts, 5 sends an hour, kept as an HMAC under the person's own key bound to the value. A signed link for email was considered; two mechanisms to secure and test. Leaving verification to the host was considered; every host would re-implement the code rules.
- **Suspended members:** an `administration` lookup names them, by display name only, to viewers Authorisation allows `profile.suspended-people:view` on the group. The permission is `high`, not `medium` as first proposed: Authorisation's built-in `member` and `viewer` roles hold `*:view`, which would have reached a `medium` permission, and Authorisation rates disclosing personal data `high`. Showing their disclosed details too was considered, and so was a Profile page listing them; the first discloses more than administrators need, the second would need Identity's member list in Profile.
- **Membership standing:** with a group context, a member's own paused or suspended membership hides them there, as the pausing and suspension process says; before phase 4 only the identity's standing counted.
- **Groups left:** Identity names them in its own view of the person (`formerGroupNames`), and the host backs `ProfileGroupName` with them, as it backs `IdentityPersonName` with `ProfilePersonName`. A names map passed in by the host was considered; less reusable. Identifiers alone were considered; people cannot tell the groups apart.
- **Opening requests:** the person opens access and restriction requests from the page, after a recent sign-in; erasure is account closure, and correction is the profile itself. Operators open any type through server functions with a reason code; there is still no erasure endpoint.

