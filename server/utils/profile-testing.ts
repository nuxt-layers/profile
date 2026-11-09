import { randomBytes } from 'node:crypto'
import type {
  DepartureAttribution,
  ProfileAccessDecision,
  ProfileClock,
  ProfileDisclosureContextPort,
  ProfileKeyWrapper,
  ProfileNotifier,
  ProfileRequestCoordinator,
  ProfileSubject,
  ProfileSubjectResolver,
  Relationship,
  SubjectStanding,
} from '../../contracts'
import { createLocalProfileKeyWrapper } from './profile-keys'

/** One message the recording notifier was asked to deliver. */
export type ProfileTestNotification = Parameters<ProfileNotifier['send']>[0]

export interface ProfileTestPorts {
  /** A local wrapper under a fresh random key: data does not outlive the process. */
  keyWrapper: ProfileKeyWrapper
  /** Answers from the relationships, standings and departure policies set below; everyone else is `none` and `visible`. */
  disclosureContext: ProfileDisclosureContextPort
  /** Answers the principal set by `signIn`, or null. */
  subjectResolver: ProfileSubjectResolver
  /** Allows only what `grant` allowed. */
  accessDecision: ProfileAccessDecision
  /** Delivers nothing: records each message in `sent`. */
  notifier: ProfileNotifier
  /** Answers every coordinated part with a small stand-in bundle. */
  requestCoordinator: ProfileRequestCoordinator
  /** The system clock until `setNow`; `setNow(null)` returns to it. */
  clock: ProfileClock

  signIn(principalId: string, options?: { authenticatedAt?: Date, assurance?: ProfileSubject['assurance'] }): void
  signOut(): void
  relate(viewerId: string, subjectId: string, relationship: Relationship, groupId?: string | null): void
  setStanding(subjectId: string, standing: SubjectStanding): void
  setDeparturePolicy(groupId: string, attribution: DepartureAttribution | null): void
  grant(viewerId: string, permission: string, groupId: string): void
  readonly sent: ProfileTestNotification[]
  setNow(now: Date | null): void
}

/**
 * PUBLIC. Stand-ins for every port but the database (ADR-0012 §3), to pass
 * to `composeProfile` in tests and demonstrations. The database has none:
 * Profile's store is PostgreSQL, and there is no in-memory store.
 *
 * Refused (throws) unless `NODE_ENV` is `test` or the caller passes
 * `{ demonstration: true }`: these ports sign anyone in, disclose by fiat
 * and deliver nothing, so they must never reach a real deployment by
 * accident. A demonstration host that opts in takes that risk knowingly.
 */
export function createProfileTestPorts(options: { demonstration?: boolean } = {}): ProfileTestPorts {
  if (process.env.NODE_ENV !== 'test' && options.demonstration !== true) {
    throw new Error('createProfileTestPorts is for tests only: run with NODE_ENV=test, or pass { demonstration: true } knowingly.')
  }

  let principal: ProfileSubject | null = null
  let now: Date | null = null
  const relationships = new Map<string, Relationship>()
  const standings = new Map<string, SubjectStanding>()
  const departurePolicies = new Map<string, DepartureAttribution>()
  const grants = new Set<string>()
  const sent: ProfileTestNotification[] = []
  const clock: ProfileClock = { now: () => (now ? new Date(now) : new Date()) }

  return {
    keyWrapper: createLocalProfileKeyWrapper({ keys: { test: randomBytes(32).toString('base64') }, current: 'test' }),
    disclosureContext: {
      async describe(request) {
        const groupId = request.groupId ?? null
        const attribution = groupId ? departurePolicies.get(groupId) : undefined
        return {
          viewerId: request.viewerId,
          groupId,
          departurePolicy: attribution ? { attribution } : null,
          subjects: request.subjectIds.map(subjectId => ({
            subjectId,
            relationship: subjectId === request.viewerId
              ? 'self' as const
              : relationships.get(`${request.viewerId}|${subjectId}|${groupId ?? '-'}`) ?? 'none' as const,
            standing: standings.get(subjectId) ?? 'visible' as const,
          })),
          readAt: clock.now().toISOString(),
        }
      },
    },
    subjectResolver: { resolve: async () => principal },
    accessDecision: {
      allows: async ({ subject, permission, groupId }) => grants.has(`${subject.principalId}|${permission}|${groupId}`),
    },
    notifier: {
      async send(message) {
        sent.push(message)
      },
    },
    requestCoordinator: {
      exportPart: async ({ identityId, part }) => ({ part, identityId, note: 'test stand-in' }),
    },
    clock,
    signIn(principalId, signInOptions = {}) {
      principal = {
        principalId,
        authenticatedAt: (signInOptions.authenticatedAt ?? clock.now()).toISOString(),
        assurance: signInOptions.assurance ?? { level: 'aal2', phishingResistant: true },
      }
    },
    signOut() {
      principal = null
    },
    relate(viewerId, subjectId, relationship, groupId = null) {
      relationships.set(`${viewerId}|${subjectId}|${groupId ?? '-'}`, relationship)
    },
    setStanding(subjectId, standing) {
      standings.set(subjectId, standing)
    },
    setDeparturePolicy(groupId, attribution) {
      if (attribution) departurePolicies.set(groupId, attribution)
      else departurePolicies.delete(groupId)
    },
    grant(viewerId, permission, groupId) {
      grants.add(`${viewerId}|${permission}|${groupId}`)
    },
    sent,
    setNow(next) {
      now = next
    },
  }
}
