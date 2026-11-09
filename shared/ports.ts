import type { ProfileSubject } from './api'
import type { DisclosureContext } from './disclosure'
import type { ProfileEvent } from './events'
import type { ProfileRequestPartsDeclaration, ProfileRetentionInput, RequestPart } from './requests'
import type { VerifiableAttribute } from './verification'

/**
 * Ports the host supplies (CONTRACT.md, "Host passes"). Declared
 * structurally and in Profile's own terms, so the contract depends on no
 * driver, key service or other capability. The host adapts what it has to
 * these shapes.
 */

/** Structural shape of a `pg` pool. */
export interface PostgresPoolLike {
  query(text: string, values?: readonly unknown[]): Promise<unknown>
  connect(): Promise<unknown>
}

/**
 * Persistence (ADR-0002, ADR-0006). `pool` connects as the runtime role.
 * Migrations run through `migrationPool` when given (the role that owns the
 * schema), which then grants the runtime role only what it needs.
 */
export interface ProfileDatabase {
  dialect: 'postgres'
  pool: PostgresPoolLike
  /** Schema owned by this capability. Defaults to `profile`. */
  schema?: string
  migrationPool?: PostgresPoolLike
  /** The runtime role to grant, when migrations run as another role. */
  runtimeRole?: string
}

/** A person's data key, wrapped by the host. */
export interface WrappedProfileKey {
  /** The wrapping key's version, e.g. `2026-10`. */
  version: string
  /** The wrapped key, base64. */
  wrapped: string
}

/**
 * Key-wrapping port (docs/contracts.md §6). Profile generates one 256-bit
 * key per person and stores it only as wrapped here: by a KMS, an HSM or a
 * vault in production. The wrapping key is versioned so that the host can
 * rotate it: `rewrapProfileKeys()` moves every live key to the current
 * version, and once no key and no backup still needs an old version, the
 * host retires it. An erased person's key is never re-wrapped, so their
 * data in older backups becomes unreadable when that version is retired.
 *
 * `context.identityId` must be bound to the wrapping (as additional
 * authenticated data), so a wrapped key cannot be moved to another person.
 * A failure rejects, and Profile fails closed.
 */
export interface ProfileKeyWrapper {
  /** The version new keys are wrapped with. */
  currentVersion(): string
  wrap(key: Uint8Array, context: { identityId: string }): Promise<WrappedProfileKey>
  unwrap(key: WrappedProfileKey, context: { identityId: string }): Promise<Uint8Array>
}

/**
 * How fresh a directory answer must be: `strong` reads the latest state;
 * `bounded` may lag by the directory's own short, documented bound.
 */
export interface DirectoryReadOptions {
  consistency: 'strong' | 'bounded'
}

/**
 * Disclosure-context port: the host's directory answers, for one viewer and
 * up to 200 people, how the viewer is related to each person, each person's
 * standing, and the group context's departure policy (`DisclosureContext`).
 * Profile asks at every lookup, normally `bounded`, and never caches the
 * answer. A failure rejects, and Profile then shows nothing rather than
 * something stale.
 */
export interface ProfileDisclosureContextPort {
  describe(
    request: { viewerId: string, subjectIds: string[], groupId: string | null },
    options: DirectoryReadOptions,
  ): Promise<DisclosureContext>
}

/** Where `relayProfileOutbox` delivers events. A rejection leaves the event to be relayed again. */
export type ProfileEventPublisher = (event: ProfileEvent) => Promise<void>

/**
 * Subject-resolver port: the signed-in person for an HTTP request, from the
 * host's sign-in, or null. A failure rejects, and the endpoint answers
 * `unavailable`.
 */
export interface ProfileSubjectResolver {
  resolve(event: unknown): Promise<ProfileSubject | null>
}

/**
 * Coordination port for data-subject requests (docs/contracts.md §14): one
 * coordinated part of an access request (a part the host declared
 * `coordinated` in `requestParts`), as a machine-readable bundle, or null
 * when nothing is held for the person there. A failure rejects; Profile
 * keeps that part pending and retries it.
 */
export interface ProfileRequestCoordinator {
  exportPart(input: { identityId: string, part: RequestPart, correlationId: string }): Promise<unknown | null>
}

/**
 * Access-decision port: whether the signed-in viewer holds one of Profile's
 * permissions (`PROFILE_PERMISSIONS`) on a group now, as the host's access
 * decision answers. Any refusal is false; a failure rejects, and Profile
 * shows only what it shows anyone.
 */
export interface ProfileAccessDecision {
  allows(input: { subject: ProfileSubject, permission: string, groupId: string }): Promise<boolean>
}

/**
 * Notification port (docs/contracts.md §15): the host delivers a one-time
 * verification code to a contact detail, by email or SMS, in the person's
 * locale. Profile calls it for nothing else. A failure rejects, and the
 * code is not counted as sent.
 */
export interface ProfileNotifier {
  send(message: {
    channel: 'email' | 'sms'
    /** The contact detail itself: the only place Profile hands one out. */
    to: string
    purpose: 'contact-verification'
    attribute: VerifiableAttribute
    code: string
    /** The person's `locale`, if set. */
    locale: string | null
    /** Seconds until the code expires. */
    expiresInSeconds: number
  }): Promise<void>
}

/**
 * Clock port (docs/contracts.md §16): ADR-0012's shared clock shape, the same
 * `ClockPort` the host gives Clock and every capability. `now()` is
 * synchronous and answers a UTC ISO 8601 instant, such as
 * `2026-11-05T14:30:00.000Z`. Optional; without it Profile uses Clock's system
 * clock. Every time Profile keeps or judges comes from it, through Clock:
 * timestamps, events' `occurredAt`, expiries, due dates, hold ends and whether
 * a sign-in is recent. Trusted like a key, since it can make holds or expiries
 * end early. An answer Clock rejects, or a failure, fails the operation
 * closed as `unavailable`.
 */
export interface ProfileClock {
  now(): string
}

/**
 * Everything a host passes to `composeProfile` (ADR-0012 §1): the required
 * ports, the optional ones, and retention. Required members have no default,
 * so a missing one fails composition rather than a later request.
 */
export interface ProfileComposition {
  database: ProfileDatabase
  keyWrapper: ProfileKeyWrapper
  disclosureContext: ProfileDisclosureContextPort
  /** For the `/api/profile/*` endpoints; without it they answer `unavailable`. */
  subjectResolver?: ProfileSubjectResolver
  /** For data-subject requests. */
  requestCoordinator?: ProfileRequestCoordinator
  /** For `administration` lookups. */
  accessDecision?: ProfileAccessDecision
  /** For contact-detail verification. */
  notifier?: ProfileNotifier
  /** Clock's system clock without it. */
  clock?: ProfileClock
  /** The defaults without it. */
  retention?: ProfileRetentionInput
  /** The parts of data-subject requests beside Profile's own; without it, Profile's part only. */
  requestParts?: ProfileRequestPartsDeclaration
}
