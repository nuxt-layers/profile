import type { ProfileComposition } from '../../contracts'
import { ProfileCompositionError } from '../../contracts'
import {
  clearProfileComposition,
  provideProfileAccessDecision,
  provideProfileClock,
  provideProfileDatabase,
  provideProfileDisclosureContext,
  provideProfileKeyWrapper,
  provideProfileNotifier,
  provideProfileRequestCoordinator,
  provideProfileRetention,
  provideProfileSubjectResolver,
} from './profile-composition'
import { migrateProfileDatabase } from './profile-server'

const REQUIRED = ['database', 'keyWrapper', 'disclosureContext'] as const
const KNOWN = new Set<string>([...REQUIRED, 'subjectResolver', 'requestCoordinator', 'accessDecision', 'notifier', 'clock', 'retention'])
const PORT_NAMES: Record<typeof REQUIRED[number], string> = {
  database: 'ProfileDatabase',
  keyWrapper: 'ProfileKeyWrapper',
  disclosureContext: 'ProfileDisclosureContext',
}

/**
 * PUBLIC. Composes Profile in one call (ADR-0012 §1): supplies every port the
 * host passes, then migrates the database. Call it once from a Nitro plugin.
 *
 * All or nothing: a missing required port, an unknown option or an invalid
 * port throws before anything stays supplied, so Profile is either fully
 * composed or not composed at all (fail closed). Resolves with the migrations
 * applied; Profile's operations already wait for them, so a host need not.
 *
 * The `provide*` functions remain for hosts that compose port by port.
 */
export function composeProfile(composition: ProfileComposition): Promise<string[]> {
  if (!composition || typeof composition !== 'object') throw new TypeError('composeProfile expects an object of ports.')
  const unknown = Object.keys(composition).filter(key => !KNOWN.has(key))
  if (unknown.length) throw new TypeError(`composeProfile does not accept: ${unknown.join(', ')}.`)
  for (const key of REQUIRED) {
    if (composition[key] == null) throw new ProfileCompositionError(PORT_NAMES[key])
  }
  try {
    provideProfileDatabase(composition.database)
    provideProfileKeyWrapper(composition.keyWrapper)
    provideProfileDisclosureContext(composition.disclosureContext)
    if (composition.subjectResolver) provideProfileSubjectResolver(composition.subjectResolver)
    if (composition.requestCoordinator) provideProfileRequestCoordinator(composition.requestCoordinator)
    if (composition.accessDecision) provideProfileAccessDecision(composition.accessDecision)
    if (composition.notifier) provideProfileNotifier(composition.notifier)
    if (composition.clock) provideProfileClock(composition.clock)
    if (composition.retention) provideProfileRetention(composition.retention)
  }
  catch (error) {
    clearProfileComposition()
    throw error
  }
  return migrateProfileDatabase()
}
