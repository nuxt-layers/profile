# Resources

> **In short:** every external architectural document Profile relies on, each at the revision reviewed. Live software dependencies follow `master` (ADR-0008) and are declared in `package.json`, not here.

## Governing architecture (`nuxt-layers/architecture-rules`)

Reviewed at commit `3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2` (2026-11-08).

| Document | Why Profile relies on it |
|---|---|
| [Layer Standard](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/layer-standard.md) | Repository layout, public surface, manifest, consumption on `master`; §5 requires an owning capability (`clock` for dates and times) instead of reimplementing it |
| [Catalogue](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/catalogue.md) | Profile's one-line responsibility and its neighbours' |
| [Security](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/security.md) | Security baseline and data-store controls the threat model follows (replaces the Data Store Security Standard v0.1) |
| [Privacy](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/privacy.md) | Personal-data rules and the storage register (§5) |
| [Presentation](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/presentation.md) | Rules for the optional default pages |
| [ADR-0001 — Capability repositories and composition shells](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0001-capability-repositories-and-composition-shells.md) | Profile as its own capability repository |
| [ADR-0002 — Composition-supplied persistence and capability-owned schemas](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0002-composition-supplied-persistence-and-capability-owned-schemas.md) | The host supplies the pool; Profile owns its schema and fails closed |
| [ADR-0003 — Group model and identity first](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0003-group-model-and-identity-first.md) | Groups and memberships are Identity's |
| [ADR-0004 — Documentation placement](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0004-documentation-placement.md) | Which documents live here, and external links only in this file |
| [ADR-0005 — Identity and Access Management suite](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0005-iam-suite.md) | Profile's place in the IAM suite |
| [ADR-0006 — Polyglot persistence and data-store security](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0006-polyglot-persistence-and-data-store-security.md) | Runtime and owner roles; §6 places sign-in identifiers in Authentication |
| [ADR-0008 — Independent layer delivery](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0008-independent-layer-delivery.md) | Dependencies follow `master`; formal releases and tags are suspended |
| [ADR-0009 — Headless capability layers](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0009-headless-capability-layers.md) | The optional presentation part and the headless surface |
| [ADR-0010 — Documentation style](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0010-documentation-style.md) | Root files, *In short* lines, British spelling |
| [ADR-0011 — Shared rich text and configurable copy](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0011-shared-rich-text-and-configurable-copy.md) | Configurable message catalogue for the pages |
| [ADR-0012 — Trivial composition](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0012-trivial-composition.md) | `CONTRACT.md`, the shared port shapes and `examples/minimal-host` |
| [ADR-0013 — Development toolchain baseline](https://github.com/nuxt-layers/architecture-rules/blob/3436b1cc2a33401a7c3f08d5bc9ee9fe11ea93d2/docs/decisions/ADR-0013-development-toolchain-baseline.md) | pnpm, Node.js and pinned CI actions |

## Required capabilities

Contracts of capabilities Profile requires as packages (Layer Standard §5).

| Document | Why Profile relies on it |
|---|---|
| [Clock contract](https://github.com/nuxt-layers/clock/blob/7639c9659d37c68b04514a36211e166bb0abe5f9/CONTRACT.md) (reviewed at commit `7639c9659d37c68b04514a36211e166bb0abe5f9`, 2026-11-08) | The current time, arithmetic, comparison, interchange and formatting of every time Profile keeps, judges or shows; the `ClockPort` shape of `ProfileClock`; Node.js 26.13 or later and Nuxt 4.6 or later |

## IAM suite processes (`nuxt-layers/iam-integration`)

Reviewed at commit `fa2b93329e4a3799812a07022b909af38f65d577` (2026-11-08).

| Document | Why Profile relies on it |
|---|---|
| [IAM suite architecture](https://github.com/nuxt-layers/iam-integration/blob/fa2b93329e4a3799812a07022b909af38f65d577/docs/architecture.md) | §1 Profile as the only source of personal data; §7 the shared clock; §8 retention and disposal |
| [Joining and leaving](https://github.com/nuxt-layers/iam-integration/blob/fa2b93329e4a3799812a07022b909af38f65d577/docs/processes/joining-and-leaving.md) | The departure data policy |
| [Data-subject requests](https://github.com/nuxt-layers/iam-integration/blob/fa2b93329e4a3799812a07022b909af38f65d577/docs/processes/data-subject-requests.md) | Requests, parts and legal holds that Profile records |
| [Account closure](https://github.com/nuxt-layers/iam-integration/blob/fa2b93329e4a3799812a07022b909af38f65d577/docs/processes/account-closure.md) | Erasure follows closure |
| [Group deletion](https://github.com/nuxt-layers/iam-integration/blob/fa2b93329e4a3799812a07022b909af38f65d577/docs/processes/group-deletion.md) | Disposal of a deleted group's departures |
| [Retention](https://github.com/nuxt-layers/iam-integration/blob/fa2b93329e4a3799812a07022b909af38f65d577/docs/processes/retention.md) | Retention of events, requests and holds |
