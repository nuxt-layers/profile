# Changelog

> **In short:** major changes to `@nuxt-layers/profile`, newest first. Formal releases are suspended during development (ADR-0008); consumers follow `master`.

## 2026-11-09

- Development toolchain moves to the ADR-0013 baseline: Node.js 26, pnpm 12.16.1 through Corepack, `@types/node` 26 and Nuxt 4.6.3 for development; `zod` ^4.6.7. Hosts' requirements are unchanged (Node.js 22 or later, `nuxt` ^4.5.0).
- CI sets pnpm up with Corepack instead of a third-party action (ADR-0013 §5). The layer workflow had not started since the move to `nuxt-layers`, most likely because the organisation's Actions policy refuses that action.
- Theme Manager is declared as `github:nuxt-layers/theme-manager#master`; pnpm 12 records it as an HTTPS Git resolution.

## 2026-11-08

- `composeProfile(composition)` is now the only way to compose Profile (ADR-0012 §1): one call, all or nothing, then migrations. **Breaking:** the `provide*` functions and `migrateProfileDatabase()` are no longer public; a host passes the same ports under `database`, `keyWrapper`, `disclosureContext`, `subjectResolver` (optional), `requestCoordinator`, `accessDecision`, `notifier`, `clock` and `retention`. New type `ProfileComposition` in `./contracts`.
- `examples/minimal-host`: the smallest host composing Profile alone (ADR-0012 §4), built and smoke-tested in CI against PostgreSQL, and held to the 50-line composition budget by `tests/minimal-host.test.ts`.
- Moved from the `nuxt4-layers` organisation to `nuxt-layers`: the package is now `@nuxt-layers/profile` (formerly `@nuxt4-layers/profile`), and the repository `nuxt-layers/profile`. Hosts change their dependency to `git+https://github.com/nuxt-layers/profile.git#master` and every `@nuxt4-layers/profile` import, `extends` entry and stylesheet import to `@nuxt-layers/profile`. No API, runtime key, environment variable, schema or event changes.
- Theme Manager (development only) now follows `nuxt-layers/theme-manager` on `master`.
- Root `CONTRACT.md`, `RESOURCES.md`, `PLAN.md` (formerly `docs/roadmap.md`) and `STORAGE-REGISTER.md`; `docs/composition-contract.md` folded into `CONTRACT.md`. External links now appear only in `RESOURCES.md`.
- Versioning follows ADR-0008: the semantic-versioning promise is withdrawn while releases are suspended, and the existing `v1.0.0` and `v1.1.0` tags remain historical records, not consumer pins. Contract version 1 is unchanged.

## Before the move (tag `v1.1.0`)

- Access requests gain a `configuration` part: the configuration layer's settings for the person's own account, answered through the coordination port like another member's part, and `null` where the host composes no configuration layer. `REQUEST_PARTS` and `COORDINATED_PARTS` gain the value, with migration `0005_configuration_part`; erasure requests are unchanged, since the configuration layer deletes those settings itself on closure. An addition: hosts' coordination ports answer the new part through iam-integration's `profileRequestCoordinatorFromMembers`.
- The layer's own tests pass on Windows as well as on Linux and macOS: the paths they compare with import specifiers and routes are written with `/` on every platform (`tests/support/paths.ts`). On Windows the contract, architecture and endpoint tests used to fail, or check nothing.

## 1.0.0 (2026-10-11, tag `v1.0.0`)

Everything in contract version 1 ([specification](docs/contracts.md)).

- The person's record under their control: every value encrypted with their own key, wrapped by the host's key service, with key rotation.
- Disclosure chosen by the person, the departure data policy, display-name lookups and contact-detail verification.
- Data-subject requests, legal holds, erasure on closure, export, end of life and retention.
- The `/api/profile/*` endpoints and the accessible default pages, including `ProfilePersonName`.
