# profile

Nuxt foundation layer (currently built on Nuxt 4) for the personal data that describes a person: what is held, who may see it, and how it is corrected, exported, anonymised or erased, under the person's control.

Part of the `nuxt-layers` Identity and Access Management (IAM) suite, with `authentication`, `identity`, `authorisation` and `iam-integration`.

Hosts compose it from [CONTRACT.md](CONTRACT.md) alone.

## Owns

- The personal data that describes a person: names, contact details and personal preferences, keyed by an opaque Identity identifier.
- What each context may see (fellow group members, the tenant, nobody), under the person's control.
- Applying each group's departure data policy (`keep-name`, `pseudonymise`, `anonymise`) to how a leaver is shown, and the leaver's right to anonymisation.
- The person's requests for access, correction, export and erasure, coordinating the other suite members' parts.
- Anonymisation by unlinking: deleting the record that links an identifier to a person, so other capabilities' data never needs rewriting.

## Never owns

| Not here | Owned by |
|---|---|
| Credentials and sign-in identifiers (including a sign-in email address) | Authentication |
| Identities, groups, tenants and memberships | Identity |
| Roles, grants and access decisions | Authorisation |
| Domain records (they hold identifiers, never names) | Domain capabilities |

Profile may hold the same email address as a sign-in identifier held by Authentication, as an independent contact detail. Changing one does not change the other unless the person asks for both, and erasure covers both.

## Interfaces

| Direction | Interface | Purpose |
|---|---|---|
| Consumes from Identity | Disclosure-context port | The viewer's relationship to each person, the person's standing, and the group's departure data policy |
| Consumes from Identity | Events `identity.provisioned`, `membership.ended`, `identity.closed` | Create the record, keep how a leaver is shown, erase on closure |
| Consumes from the host | Key-wrapping port | Wraps each person's data key with a versioned host key (KMS, HSM, vault) |
| Provides to domain capabilities | `lookupProfileDisplayNames` | Names for up to 200 identifiers, as the viewer may see them |
| Provides to the person | Own record, disclosure settings, departure anonymity, export | `/api/profile/*` endpoints, `useProfile()` and the default pages |
| Provides to hosts' pages | `ProfilePersonName` | A person's name as the viewer may see it, for Identity's `IdentityPersonName` and any other page |
| Publishes | `profile.created`, `profile.changed`, `profile.departure-anonymised`, `profile.anonymised` | Identifiers, attribute names and codes only |

## Documentation

- [Contract](CONTRACT.md): how a host installs, configures and composes Profile
- [Specification](docs/contracts.md): the record, disclosure, departures, encryption and erasure, events, ports and server functions in detail
- [Threat model](docs/threat-model.md): control register and gaps
- [Storage register](STORAGE-REGISTER.md), [design decisions](docs/design-decisions.md), [plan](PLAN.md) and [changelog](CHANGELOG.md)
- [Resources](RESOURCES.md): the governing decisions and suite processes Profile relies on, at the revisions reviewed

## Commands

- `pnpm install`, then `pnpm dev:prepare`
- `pnpm check`: typecheck and tests. The PostgreSQL suite needs `PROFILE_TEST_DATABASE_URL` (admin URL of a local, disposable PostgreSQL 16); it skips locally without it and fails in CI
- `pnpm build:playground`: proves the layer composes in a host
- `pnpm build:minimal-host`, then `pnpm smoke:minimal-host`: builds [`examples/minimal-host`](examples/minimal-host/server/plugins/profile.ts), the smallest host composing Profile alone, and checks it answers against a disposable database (needs `PROFILE_TEST_DATABASE_URL`). `pnpm check` holds it to ADR-0012's 50-line budget
- `pnpm test:e2e`: the default pages in a browser with axe. Needs `PROFILE_TEST_DATABASE_URL`; locally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if Playwright's own browser is not installed

## Documentation checks

`python3 scripts/check_markdown.py` checks headings, *In short* lines under `docs/`, local links, and that external links appear only in `RESOURCES.md`, pinned to a tag or commit.
