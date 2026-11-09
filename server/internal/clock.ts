import { ClockError, createClock } from '@nuxt-layers/clock/server'
import type { ProfileClock } from '../../contracts'
import { ProfileFailure } from '../../contracts'

/**
 * PRIVATE. Profile's times, through Clock (docs/contracts.md §16).
 * Clock owns dates and times (Layer Standard §5), so Profile reads the
 * current time, does its arithmetic and compares instants only through
 * Clock's operations, never through `Date`. Every time is a canonical UTC
 * instant string, as Clock's `ClockPort` answers. A host clock that throws
 * or answers anything but a valid instant fails the operation closed as
 * `unavailable`: Profile never falls back to another time.
 */

/** Profile's view of time: canonical instants, with Clock doing the work. */
export interface ProfileTime {
  /** The clock's current instant. */
  now(): string
  /** An instant as epoch milliseconds (for UUIDv7). */
  epochMilliseconds(instant: string): number
  /** Epoch milliseconds as an instant. */
  fromEpochMilliseconds(milliseconds: number): string
  /** A stored or supplied instant (a driver `Date` or an RFC 3339 string) in canonical form. */
  canonical(value: unknown): string
  /** `days` of elapsed time later (or earlier, if negative). */
  addDays(instant: string, days: number): string
  /** `seconds` of elapsed time later (or earlier, if negative). */
  addSeconds(instant: string, seconds: number): string
  /** The same UTC calendar day `months` later, or that month's last day. */
  addMonths(instant: string, months: number): string
  /** -1, 0 or 1 as `a` is before, the same as or after `b`. */
  compare(a: string, b: string): -1 | 0 | 1
}

/** Clock's own failures, and anything else, never cross Profile's boundary raw. */
function unavailable(reason: string): never {
  throw new ProfileFailure('unavailable', reason)
}

/** Clock's own system clock, used when the host supplies none; made at first use, never at module initialisation. */
let systemClock: ReturnType<typeof createClock> | undefined
const system = () => (systemClock ??= createClock({ timeZone: 'UTC' }))

/**
 * Profile's time over the host's clock, or Clock's system clock without one.
 * `source` may be a function, read at each `now()`, so a clock composed
 * later is still the one used.
 */
export function profileTime(source?: ProfileClock | (() => ProfileClock | undefined)): ProfileTime {
  const port = (): ProfileClock | undefined => (typeof source === 'function' ? source() : source)
  const clock = createClock({ timeZone: 'UTC' }, { now: () => (port() ?? system()).now() })
  const instant = (value: string) => ({ kind: 'instant' as const, value })
  const guard = <T>(run: () => T, reason: string): T => {
    try {
      return run()
    }
    catch (error) {
      if (error instanceof ProfileFailure) throw error
      return unavailable(error instanceof ClockError ? `${reason}: ${error.code}` : reason)
    }
  }
  return Object.freeze({
    now: () => guard(() => clock.now(), 'clock failed'),
    epochMilliseconds: (value: string) => guard(() => Number(clock.formatInterchange(instant(value), 'epochMilliseconds')), 'invalid instant'),
    fromEpochMilliseconds: (milliseconds: number) => guard(() => clock.parseInterchange('epochMilliseconds', milliseconds).value, 'invalid instant'),
    canonical: (value: unknown) => guard(() => {
      if (value instanceof Date) return clock.parseInterchange('epochMilliseconds', value.getTime()).value
      if (typeof value === 'string') return clock.parseInterchange('rfc3339', value).value
      return unavailable('invalid instant')
    }, 'invalid instant'),
    addDays: (value: string, days: number) => guard(() => clock.add(instant(value), { hours: days * 24 }).value, 'invalid instant'),
    addSeconds: (value: string, seconds: number) => guard(() => clock.add(instant(value), { seconds }).value, 'invalid instant'),
    addMonths: (value: string, months: number) => guard(() => {
      const zoned = clock.add({ kind: 'zonedDateTime', value: clock.toZone(value, 'UTC') }, { months })
      return clock.toInstant(zoned.value)
    }, 'invalid instant'),
    compare: (a: string, b: string) => guard(() => clock.compare(instant(a), instant(b)), 'invalid instant'),
  })
}

/** The clock's current instant, validated through Clock. */
export function timeFrom(port?: ProfileClock): string {
  return profileTime(port).now()
}
