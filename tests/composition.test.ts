import { beforeEach, describe, expect, it } from 'vitest'
import { ProfileCompositionError, ProfileFailure } from '../contracts'
import { profileTime, timeFrom } from '../server/internal/clock'
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
  useProfileRequestParts,
  useProfileDisclosureContext,
  useProfileKeyWrapper,
  useProfileNotifier,
  useProfileRequestCoordinator,
} from '../server/internal/composition'
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

  it('uses Clock\'s system clock when the host supplies none, and the host\'s clock when it does', () => {
    const before = Date.now()
    const now = Date.parse(timeFrom(useProfileClock()))
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
    expect(() => provideProfileClock({} as never)).toThrow(TypeError)
    provideProfileClock({ now: () => '2030-01-02T03:04:05.000Z' })
    expect(timeFrom(useProfileClock())).toBe('2030-01-02T03:04:05.000Z')
    clearProfileComposition()
    expect(Math.abs(Date.parse(timeFrom(useProfileClock())) - Date.now())).toBeLessThan(1000)
  })

  it('reckons through Clock: a calendar month on clamps to the month\'s last day', () => {
    const time = profileTime({ now: () => '2026-10-10T08:00:00.000Z' })
    expect(Date.parse(time.addMonths('2026-10-10T08:00:00.000Z', 1))).toBe(Date.parse('2026-11-10T08:00:00.000Z'))
    expect(Date.parse(time.addMonths('2027-01-31T08:00:00.000Z', 1))).toBe(Date.parse('2027-02-28T08:00:00.000Z'))
    expect(Date.parse(time.addMonths('2026-12-15T00:00:00.000Z', 1))).toBe(Date.parse('2027-01-15T00:00:00.000Z'))
    expect(time.compare(time.addDays('2026-10-10T08:00:00.000Z', 1), '2026-10-11T08:00:00.000Z')).toBe(0)
  })

  it('fails closed on a clock that throws or answers anything but a valid instant', () => {
    for (const now of [() => 'not a time', () => '2026-10-10T00:00:00', () => new Date() as unknown as string, () => null as unknown as string, () => { throw new Error('down') }]) {
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

  it('refuses an invalid request-part declaration, or coordinated parts without the coordination port, supplying nothing', () => {
    const keyWrapper = { currentVersion: () => 'v1', wrap: async () => ({ version: 'v1', wrapped: '' }), unwrap: async () => new Uint8Array() }
    expect(() => composeProfile({ ...ports(), keyWrapper, requestParts: { parts: [{ name: 'profile' }] } })).toThrow(/requestParts/)
    expect(() => useProfileDatabase()).toThrow(ProfileCompositionError)
    expect(() => composeProfile({ ...ports(), requestParts: { parts: [{ name: 'sign-in', coordinated: true }] } })).toThrow(ProfileCompositionError)
    expect(() => useProfileDatabase()).toThrow(ProfileCompositionError)
    expect(useProfileRequestParts().all).toEqual(['profile'])

    // A valid declaration is what Profile then uses.
    composeProfile({ ...ports(), keyWrapper, requestParts: { parts: [{ name: 'sign-in', holdable: true }] } }).catch(() => {})
    expect(useProfileRequestParts()).toMatchObject({ all: ['profile', 'sign-in'], holdable: ['profile', 'sign-in'] })
  })

  it('is all or nothing: an invalid port leaves no port supplied', () => {
    expect(() => composeProfile({ ...ports(), notifier: {} as never })).toThrow(TypeError)
    expect(() => useProfileDatabase()).toThrow(ProfileCompositionError)
    expect(() => useProfileKeyWrapper()).toThrow(ProfileCompositionError)
    expect(() => useProfileDisclosureContext()).toThrow(ProfileCompositionError)
  })
})
