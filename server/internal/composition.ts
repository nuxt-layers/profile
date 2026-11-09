import type {
  ProfileAccessDecision,
  ProfileClock,
  ProfileDatabase,
  ProfileDisclosureContextPort,
  ProfileKeyWrapper,
  ProfileNotifier,
  ProfileRequestCoordinator,
  ProfileRequestParts,
  ProfileRequestPartsDeclaration,
  ProfileRetention,
  ProfileRetentionInput,
  ProfileSubjectResolver,
} from '../../contracts'
import { ProfileCompositionError, ProfileFailure, resolveProfileRequestParts, resolveProfileRetention } from '../../contracts'
import { runProfileMigrations } from '../database/migrations'
import { systemProfileClock } from './clock'

/**
 * PRIVATE. Composition registry. Hosts compose only through `composeProfile`
 * (server/utils/profile-compose.ts), which calls the `provide*` functions
 * here; the layer's server code calls the `use*` functions.
 *
 * Required ports fail closed: using one before it is supplied throws
 * `ProfileCompositionError`. There is no implicit store and no implicit key.
 * The clock is the one optional port with a safe default: the system clock.
 */

let database: (ProfileDatabase & { schema: string }) | null = null
let keyWrapper: ProfileKeyWrapper | null = null
let disclosureContext: ProfileDisclosureContextPort | null = null
let subjectResolver: ProfileSubjectResolver | null = null
let requestCoordinator: ProfileRequestCoordinator | null = null
let accessDecision: ProfileAccessDecision | null = null
let notifier: ProfileNotifier | null = null
let clock: ProfileClock | null = null
let retention: ProfileRetention = resolveProfileRetention()
let requestParts: ProfileRequestParts = resolveProfileRequestParts()
let migration: Promise<string[]> | null = null

export function provideProfileDatabase(next: ProfileDatabase): void {
  if (next?.dialect !== 'postgres' || typeof next.pool?.query !== 'function' || typeof next.pool.connect !== 'function') {
    throw new TypeError('composeProfile: `database` expects { dialect: \'postgres\', pool } with a pg-compatible pool.')
  }
  const schema = next.schema ?? 'profile'
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError(`Invalid profile schema name '${schema}'.`)
  if (next.runtimeRole !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(next.runtimeRole)) throw new TypeError(`Invalid runtime role name '${next.runtimeRole}'.`)
  database = { ...next, schema }
}

export function provideProfileKeyWrapper(next: ProfileKeyWrapper): void {
  if (typeof next?.currentVersion !== 'function' || typeof next.wrap !== 'function' || typeof next.unwrap !== 'function') {
    throw new TypeError('composeProfile: `keyWrapper` expects an object with currentVersion(), wrap(key, context) and unwrap(key, context) functions.')
  }
  keyWrapper = next
}

export function provideProfileDisclosureContext(next: ProfileDisclosureContextPort): void {
  if (typeof next?.describe !== 'function') {
    throw new TypeError('composeProfile: `disclosureContext` expects an object with a describe(request, options) function.')
  }
  disclosureContext = next
}

/** The signed-in person for each `/api/profile/*` request, from the host's sign-in. */
export function provideProfileSubjectResolver(next: ProfileSubjectResolver): void {
  if (typeof next?.resolve !== 'function') {
    throw new TypeError('composeProfile: `subjectResolver` expects an object with a resolve(event) function.')
  }
  subjectResolver = next
}

/** Each coordinated part of an access request, from the host. */
export function provideProfileRequestCoordinator(next: ProfileRequestCoordinator): void {
  if (typeof next?.exportPart !== 'function') {
    throw new TypeError('composeProfile: `requestCoordinator` expects an object with an exportPart(input) function.')
  }
  requestCoordinator = next
}

/** The host's access decisions on Profile's permissions. */
export function provideProfileAccessDecision(next: ProfileAccessDecision): void {
  if (typeof next?.allows !== 'function') {
    throw new TypeError('composeProfile: `accessDecision` expects an object with an allows(input) function.')
  }
  accessDecision = next
}

/** The host's delivery of verification codes to contact details. */
export function provideProfileNotifier(next: ProfileNotifier): void {
  if (typeof next?.send !== 'function') {
    throw new TypeError('composeProfile: `notifier` expects an object with a send(message) function.')
  }
  notifier = next
}

/**
 * Optional: how long Profile keeps delivered events, completed requests and
 * ended legal holds, within
 * `PROFILE_RETENTION_BOUNDS`. Without it, the defaults. Shorter than a
 * default needs `riskTreatment`; an invalid value fails at composition.
 */
export function provideProfileRetention(input: ProfileRetentionInput): void {
  retention = resolveProfileRetention(input)
}

export function useProfileRetention(): ProfileRetention {
  return retention
}

/**
 * Optional: the parts of data-subject requests beside Profile's own, which
 * are coordinated, which can be held, which is the directory part, and the
 * defaults per type. Without it, Profile's part only. An invalid
 * declaration fails at composition.
 */
export function provideProfileRequestParts(input: ProfileRequestPartsDeclaration): void {
  requestParts = resolveProfileRequestParts(input)
}

export function useProfileRequestParts(): ProfileRequestParts {
  return requestParts
}

/**
 * The host's clock: the same clock it gives every capability, or none.
 * Trusted like a key: only the host's server code composes it, and no
 * request can set or move it.
 */
export function provideProfileClock(next: ProfileClock): void {
  if (typeof next?.now !== 'function') {
    throw new TypeError('composeProfile: `clock` expects an object with a now() function.')
  }
  clock = next
}

/** The host's clock, or the system clock when none is supplied. */
export function useProfileClock(): ProfileClock {
  return clock ?? systemProfileClock
}

export function useProfileRequestCoordinator(): ProfileRequestCoordinator {
  if (!requestCoordinator) throw new ProfileCompositionError('ProfileRequestCoordinator')
  return requestCoordinator
}

export function useProfileAccessDecision(): ProfileAccessDecision {
  if (!accessDecision) throw new ProfileCompositionError('ProfileAccessDecision')
  return accessDecision
}

export function useProfileNotifier(): ProfileNotifier {
  if (!notifier) throw new ProfileCompositionError('ProfileNotifier')
  return notifier
}

export function useProfileSubjectResolver(): ProfileSubjectResolver {
  if (!subjectResolver) throw new ProfileCompositionError('ProfileSubjectResolver')
  return subjectResolver
}

export function useProfileDatabase(): ProfileDatabase & { schema: string } {
  if (!database) throw new ProfileCompositionError('ProfileDatabase')
  return database
}

export function useProfileKeyWrapper(): ProfileKeyWrapper {
  if (!keyWrapper) throw new ProfileCompositionError('ProfileKeyWrapper')
  return keyWrapper
}

export function useProfileDisclosureContext(): ProfileDisclosureContextPort {
  if (!disclosureContext) throw new ProfileCompositionError('ProfileDisclosureContext')
  return disclosureContext
}

/**
 * Applies pending migrations to Profile's schema, through the migration pool
 * when supplied (then granting the runtime role). Started by `composeProfile`.
 */
export function startProfileMigrations(): Promise<string[]> {
  const database = useProfileDatabase()
  migration = runProfileMigrations(database.migrationPool ?? database.pool, database.schema, database.runtimeRole)
  migration.catch((error) => {
    console.error('[profile] database migrations failed:', error instanceof Error ? error.message : error)
  })
  return migration
}

/** Waits for migrations, if started; fails closed as `unavailable` if they failed. */
export async function profileMigrationsDone(): Promise<void> {
  if (migration) await migration.catch(() => { throw new ProfileFailure('unavailable', 'migrations failed') })
}

/** Removes every supplied port: on a failed composition, and in tests. */
export function clearProfileComposition(): void {
  database = null
  keyWrapper = null
  disclosureContext = null
  subjectResolver = null
  requestCoordinator = null
  accessDecision = null
  notifier = null
  clock = null
  retention = resolveProfileRetention()
  requestParts = resolveProfileRequestParts()
  migration = null
}
