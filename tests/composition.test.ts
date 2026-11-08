import { beforeEach, describe, expect, it } from 'vitest'
import { ProfileCompositionError, ProfileFailure } from '../contracts'
import { timeFrom } from '../server/internal/clock'
import {
  clearProfileComposition,
  provideProfileAccessDecision,
  provideProfileClock,
  provideProfileDatabase,
  provideProfileDisclosureContext,
  provideProfileKeyWrapper,
  provideProfileNotifier,
  provideProfileRequestCoordinator,
  useProfileAccessDecision,
  useProfileClock,
  useProfileDatabase,
  useProfileDisclosureContext,
  useProfileKeyWrapper,
  useProfileNotifier,
  useProfileRequestCoordinator,
} from '../server/utils/profile-composition'
import { composeProfile } from '../server/utils/profile-compose'

describe('composition', () => {
  beforeEach(() => clearProfileComposition())

  it('fails closed when a required port is missing: no implicit store, key or directory', () => {
    expect(() => useProfileDatabase()).toThrow(ProfileCompositionError)
    expect(() => useProfileKeyWrapper()).toThrow(ProfileCompositionError)
    expect(() => useProfileDisclosureContext()).toThrow(ProfileCompositionError)
    expect(() => useProfileRequestCoordinator()).toThrow(ProfileCompositionError)
    expect(() => useProfileAccessDecision()).toThrow(ProfileCompositionError)
    expect(() => useProfileNotifier()).toThrow(ProfileCompositionError)
  })

  it('validates what the host supplies', () => {
    const pool = { query: async () => ({}), connect: async () => ({}) }
    expect(() => provideProfileDatabase({ dialect: 'postgres', pool, schema: 'Bad Schema' })).toThrow(TypeError)
    expect(() => provideProfileDatabase({ dialect: 'postgres', pool, runtimeRole: 'x"; drop' })).toThrow(TypeError)
    provideProfileDatabase({ dialect: 'postgres', pool })
    expect(useProfileDatabase().schema).toBe('profile')
    expect(() => provideProfileKeyWrapper({} as never)).toThrow(TypeError)
    expect(() => provideProfileDisclosureContext({} as never)).toThrow(TypeError)
    expect(() => provideProfileRequestCoordinator({} as never)).toThrow(TypeError)
    expect(() => provideProfileAccessDecision({} as never)).toThrow(TypeError)
    expect(() => provideProfileNotifier({} as never)).toThrow(TypeError)
  })

  it('uses the system clock when the host supplies none, and the host\'s clock when it does', () => {
    const before = Date.now()
    const now = timeFrom(useProfileClock())
    expect(now.getTime()).toBeGreaterThanOrEqual(before)
    expect(now.getTime()).toBeLessThanOrEqual(Date.now())
    expect(() => provideProfileClock({} as never)).toThrow(TypeError)
    const fixed = new Date('2030-01-02T03:04:05Z')
    provideProfileClock({ now: () => fixed })
    expect(timeFrom(useProfileClock()).toISOString()).toBe('2030-01-02T03:04:05.000Z')
    clearProfileComposition()
    expect(Math.abs(timeFrom(useProfileClock()).getTime() - Date.now())).toBeLessThan(1000)
  })

  it('fails closed on a clock that throws or answers anything but a valid Date', () => {
    for (const now of [() => new Date(Number.NaN), () => Date.now() as unknown as Date, () => null as unknown as Date, () => { throw new Error('down') }]) {
      expect(() => timeFrom({ now })).toThrow(ProfileFailure)
      try {
        timeFrom({ now })
      }
      catch (error) {
        expect((error as ProfileFailure).code).toBe('unavailable')
      }
    }
  })
})

describe('composeProfile', () => {
  beforeEach(() => clearProfileComposition())

  const ports = () => ({
    database: { dialect: 'postgres' as const, pool: { query: async () => ({}), connect: async () => ({}) } },
    keyWrapper: { wrap: async () => ({}), unwrap: async () => ({}) } as never,
    disclosureContext: { describe: async () => ({}) } as never,
    subjectResolver: { resolve: async () => null },
  })

  it('refuses a composition missing a required port, and supplies nothing', () => {
    for (const missing of ['database', 'keyWrapper', 'disclosureContext'] as const) {
      const composition: Record<string, unknown> = ports()
      delete composition[missing]
      expect(() => composeProfile(composition as never)).toThrow(ProfileCompositionError)
      expect(() => useProfileDatabase()).toThrow(ProfileCompositionError)
    }
  })

  it('refuses options it does not know', () => {
    expect(() => composeProfile({ ...ports(), keys: {} } as never)).toThrow(TypeError)
    expect(() => useProfileDatabase()).toThrow(ProfileCompositionError)
  })

  it('is all or nothing: an invalid port leaves no port supplied', () => {
    expect(() => composeProfile({ ...ports(), notifier: {} as never })).toThrow(TypeError)
    expect(() => useProfileDatabase()).toThrow(ProfileCompositionError)
    expect(() => useProfileKeyWrapper()).toThrow(ProfileCompositionError)
    expect(() => useProfileDisclosureContext()).toThrow(ProfileCompositionError)
  })
})
