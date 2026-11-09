import { ClockError, createClock, isValidTimeZone, timeZones } from '@nuxt-layers/clock/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProfileFailure } from '../contracts'
import { DEFAULT_PROFILE_TIME_ZONE, isProfileTimeZone, profileTime } from '../server/internal/clock'
import { clearProfileComposition, useProfileDatabase, useProfileTimeZone } from '../server/internal/composition'
import { composeProfile } from '../server/utils/profile-compose'

/** Profile's own reading of Clock (docs/contracts.md §16): errors, zones and calendar deadlines. */

const fixed = (instant: string) => ({ now: () => instant })
const london = (now = '2026-01-01T00:00:00.000Z') => profileTime(fixed(now), 'Europe/London')
const same = (a: string, b: string) => expect(Date.parse(a)).toBe(Date.parse(b))

describe('Clock\'s errors', () => {
  it('are ClockError through Clock\'s public /server entry', () => {
    const clock = createClock({ timeZone: 'UTC' })
    let caught: unknown
    try {
      clock.toZone('2026-01-01T00:00:00.000Z', 'europe/london')
    }
    catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClockError)
    expect((caught as ClockError).code).toBe('CLOCK_INVALID_TIME_ZONE')
  })

  it('never cross Profile\'s boundary raw: Profile fails closed as unavailable, naming Clock\'s code', () => {
    for (const run of [
      () => profileTime(fixed('not a time')).now(),
      () => profileTime(fixed('2026-01-01T00:00:00.000Z')).canonical('2026-01-01T00:00:00'),
      () => profileTime(fixed('2026-01-01T00:00:00.000Z'), 'europe/london').addDays('2026-01-01T00:00:00.000Z', 1),
    ]) {
      let caught: unknown
      try {
        run()
      }
      catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ProfileFailure)
      expect(caught).not.toBeInstanceOf(ClockError)
      expect((caught as ProfileFailure).code).toBe('unavailable')
      expect((caught as Error).message).toMatch(/CLOCK_INVALID_(INPUT|TIME_ZONE)/)
    }
  })
})

describe('time zones, through Clock', () => {
  it('accepts a zone spelt exactly, UTC, Etc zones and links; refuses mis-cased names, offsets and empty strings', () => {
    for (const valid of ['Europe/London', 'America/New_York', 'UTC', 'Etc/GMT+5', 'Europe/Kiev']) expect(isProfileTimeZone(valid), valid).toBe(true)
    for (const invalid of ['europe/london', 'EUROPE/LONDON', '+01:00', 'Z', '', ' ', 'Mars/Olympus', null, 1]) expect(isProfileTimeZone(invalid), String(invalid)).toBe(false)
  })

  it('offers the picker Clock\'s fixed, sorted list: primary zones plus UTC, no links, all valid', () => {
    const list = timeZones()
    expect(list).toContain('Europe/London')
    expect(list).toContain('UTC')
    expect(list).not.toContain('Europe/Kiev')
    expect(list).toEqual([...list].sort())
    expect(list.every(zone => isValidTimeZone(zone))).toBe(true)
    expect(timeZones()).toBe(list)
  })
})

describe('calendar deadlines', () => {
  it('reads days in the stated zone across the spring change (29 March 2026): 10:00 local stays 10:00 local', () => {
    // 10:00 GMT on 25 March, seven days on: 10:00 BST on 1 April, an hour earlier than 7 × 24 hours.
    same(london().addDays('2026-03-25T10:00:00.000Z', 7), '2026-04-01T09:00:00.000Z')
    same(london().addDays('2026-04-01T09:00:00.000Z', -7), '2026-03-25T10:00:00.000Z')
    // 01:30 on 29 March does not exist in London: compatible moves it forward by the gap, to 02:30 BST.
    same(london().addDays('2026-03-28T01:30:00.000Z', 1), '2026-03-29T01:30:00.000Z')
  })

  it('reads days in the stated zone across the autumn change (25 October 2026)', () => {
    // 10:00 BST on 20 October, seven days on: 10:00 GMT on 27 October, not 09:00.
    same(london().addDays('2026-10-20T09:00:00.000Z', 7), '2026-10-27T10:00:00.000Z')
    // 01:30 on 25 October happens twice: compatible picks the earlier, BST.
    same(london().addDays('2026-10-24T00:30:00.000Z', 1), '2026-10-25T00:30:00.000Z')
  })

  it('puts a month on in the stated zone, clamped to the month\'s last day', () => {
    // 12:00 GMT on 15 March, a month on: 12:00 BST on 15 April.
    same(london().addMonths('2026-03-15T12:00:00.000Z', 1), '2026-04-15T11:00:00.000Z')
    // 10:00 BST on 31 May → 30 June; 10:00 GMT on 31 January 2028 → 29 February (a leap year).
    same(london().addMonths('2026-05-31T09:00:00.000Z', 1), '2026-06-30T09:00:00.000Z')
    same(london().addMonths('2028-01-31T10:00:00.000Z', 1), '2028-02-29T10:00:00.000Z')
    // 10:00 GMT on 31 October (after the change) → 30 November.
    same(london().addMonths('2026-10-31T10:00:00.000Z', 1), '2026-11-30T10:00:00.000Z')
  })

  it('uses UTC without a stated zone, where a calendar day is 24 hours', () => {
    const time = profileTime(fixed('2026-01-01T00:00:00.000Z'))
    expect(time.timeZone()).toBe(DEFAULT_PROFILE_TIME_ZONE)
    same(time.addDays('2026-03-25T10:00:00.000Z', 7), '2026-04-01T10:00:00.000Z')
    same(time.addMonths('2027-01-31T08:00:00.000Z', 1), '2027-02-28T08:00:00.000Z')
  })

  it('keeps elapsed seconds as elapsed time, whatever the zone', () => {
    same(london().addSeconds('2026-03-29T00:30:00.000Z', 3600), '2026-03-29T01:30:00.000Z')
  })
})

describe('composeProfile\'s timeZone', () => {
  beforeEach(() => clearProfileComposition())
  const ports = () => ({
    database: { dialect: 'postgres' as const, pool: { query: async () => ({}), connect: async () => ({}) } },
    keyWrapper: { currentVersion: () => 'v1', wrap: async () => ({ version: 'v1', wrapped: '' }), unwrap: async () => new Uint8Array() },
    disclosureContext: { describe: async () => ({}) } as never,
  })

  it('is UTC without it, the host\'s zone with it, and refuses a zone Clock does not accept, supplying nothing', () => {
    expect(useProfileTimeZone()).toBeUndefined()
    for (const timeZone of ['europe/london', '+01:00', '']) {
      expect(() => composeProfile({ ...ports(), timeZone })).toThrow(TypeError)
      expect(() => useProfileDatabase()).toThrow()
      expect(useProfileTimeZone()).toBeUndefined()
    }
    composeProfile({ ...ports(), timeZone: 'Europe/London' }).catch(() => {})
    expect(useProfileTimeZone()).toBe('Europe/London')
  })
})
