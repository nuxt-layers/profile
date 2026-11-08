/**
 * Playground composition root: supplies Profile's ports the way a host
 * would. The key wrapper uses a fixed development master key and the
 * disclosure context is a fixture: stand-ins for the host's KMS and for
 * Identity's port. Neither is fit for production.
 *
 * By default it composes nothing, so every operation fails closed: the
 * playground only proves the layer builds in a host.
 *
 * With PROFILE_PLAYGROUND_TEST=1 (browser tests only), it migrates and uses
 * a disposable database, takes the signed-in identity from the
 * `profile_playground_principal` cookie (and, if set, the sign-in time from
 * `profile_playground_signed_in_at`), standing in for Authentication, and
 * answers relationships the seed endpoint records. The other members' parts
 * of an access request and the notifier are stand-ins too: the notifier
 * keeps the last code for the tests, never delivering it.
 * - PROFILE_MIGRATION_DATABASE_URL  the migration role's connection
 * - PROFILE_DATABASE_URL            the runtime role's connection
 * - PROFILE_RUNTIME_ROLE            the runtime role's name
 */
import pg from 'pg'
import { getCookie } from 'h3'
import type { H3Event } from 'h3'
import type { DepartureAttribution, Relationship, SubjectStanding } from '../../../contracts'
import { UUID_V7_PATTERN } from '../../../contracts'

const testMode = process.env.PROFILE_PLAYGROUND_TEST === '1'

export interface PlaygroundState {
  ready: Promise<void>
  /** `${viewerId}|${subjectId}|${groupId ?? '-'}` → relationship. */
  relationships: Map<string, Relationship>
  standings: Map<string, SubjectStanding>
  /** groupId → the group's departure attribution. */
  departurePolicies: Map<string, DepartureAttribution>
  /** The last verification code "sent" (test mode only). */
  lastCode: string | null
}

export const playground: PlaygroundState = { ready: Promise.resolve(), relationships: new Map(), standings: new Map(), departurePolicies: new Map(), lastCode: null }

export default defineNitroPlugin(() => {
  // Outside the browser tests the playground composes nothing, so every
  // operation fails closed: it only proves the layer builds in a host.
  if (!testMode) return

  playground.ready = composeProfile({
    database: {
      dialect: 'postgres',
      pool: new pg.Pool({ connectionString: process.env.PROFILE_DATABASE_URL }),
      migrationPool: new pg.Pool({ connectionString: process.env.PROFILE_MIGRATION_DATABASE_URL }),
      runtimeRole: process.env.PROFILE_RUNTIME_ROLE ?? 'profile_runtime',
    },
    keyWrapper: createLocalProfileKeyWrapper({
      keys: { 'dev-1': Buffer.alloc(32, 7).toString('base64') },
      current: 'dev-1',
    }),

    // A host adapts Authentication's getAuthenticatedPrincipal(event) here.
    subjectResolver: {
      async resolve(event) {
        const principalId = getCookie(event as H3Event, 'profile_playground_principal')
        if (!principalId || !UUID_V7_PATTERN.test(principalId)) return null
        const signedInAt = Number(getCookie(event as H3Event, 'profile_playground_signed_in_at'))
        const authenticatedAt = new Date(Number.isFinite(signedInAt) && signedInAt > 0 ? signedInAt : Date.now()).toISOString()
        return { principalId, authenticatedAt, assurance: { level: 'aal2', phishingResistant: true } }
      },
    },

    disclosureContext: {
      async describe(request) {
        const groupId = request.groupId ?? null
        const attribution = groupId ? playground.departurePolicies.get(groupId) : undefined
        return {
          viewerId: request.viewerId,
          groupId,
          departurePolicy: attribution ? { attribution } : null,
          subjects: request.subjectIds.map(subjectId => ({
            subjectId,
            relationship: subjectId === request.viewerId
              ? 'self' as const
              : playground.relationships.get(`${request.viewerId}|${subjectId}|${groupId ?? '-'}`) ?? 'none' as const,
            standing: playground.standings.get(subjectId) ?? 'visible' as const,
          })),
          readAt: new Date().toISOString(),
        }
      },
    },

    // A host composes iam-integration's profileRequestCoordinatorFromMembers
    // over Identity, Authentication and Authorisation here; the stand-in
    // answers for each with an empty bundle.
    requestCoordinator: {
      async exportPart({ identityId, part }) {
        return { member: part, identityId, note: 'playground stand-in' }
      },
    },

    // A host composes iam-integration's profileAccessDecisionFromAuthorisation here.
    accessDecision: { async allows() { return false } },

    // A host delivers the code by email or SMS here. The playground never
    // sends anything: it keeps the code for the browser tests.
    notifier: {
      async send(message) {
        playground.lastCode = message.code
      },
    },
  }).then(() => undefined)
})
