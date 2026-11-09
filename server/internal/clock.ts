import { ClockError, createClock, isValidTimeZone } from '@nuxt-layers/clock/server'
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
 *
 * Deadlines in days or months are calendar deadlines, read in the
 * jurisdiction's zone (`composeProfile`'s `timeZone`, UTC without it): the
 * start is placed in that zone, calendar units are added with Clock's
 * `compatible` disambiguation, and the result converted back to an instant.
 * Seven days from 10:00 BST is 10:00 GMT, not 09:00.
 */

/** The deadline zone without the host's `timeZone`. */
export const DEFAULT_PROFILE_TIME_ZONE = 'UTC'

/** Profile's view of time: canonical instants, with Clock doing the work. */
export interface ProfileTime {
  /** The clock's current instant. */
  now(): string
  /** The zone calendar deadlines are read in. */
  timeZone(): string
  /** An instant as epoch milliseconds (for UUIDv7). */
  epochMilliseconds(instant: string): number
  /** Epoch milliseconds as an instant. */
  fromEpochMilliseconds(milliseconds: number): string
  /** A stored or supplied instant (a driver `Date` or an RFC 3339 string) in canonical form. */
  canonical(value: unknown): string
  /** `days` calendar days later (or earlier, if negative), at the same local time in the deadline zone. */
  addDays(instant: string, days: number): string
  /** `seconds` of elapsed time later (or earlier, if negative). */
  addSeconds(instant: string, seconds: number): string
  /** The same local day and time `months` later in the deadline zone, or that month's last day. */
  addMonths(instant: string, months: number): string
  /** -1, 0 or 1 as `a` is before, the same as or after `b`. */
  compare(a: string, b: string): -1 | 0 | 1
  /** The instant halfway between `a` and `b` in elapsed time, through Clock's `midpoint`, to the nanosecond. */
  midpoint(a: string, b: string): string
}

/** Clock's own failures, and anything else, never cross Profile's boundary raw. */
function unavailable(reason: string): never {
  throw new ProfileFailure('unavailable', reason)
}

/** Clock's own system clock, used when the host supplies none; made at first use, never at module initialisation. */
let systemClock: ReturnType<typeof createClock> | undefined
const system = () => (systemClock ??= createClock({ timeZone: 'UTC' }))

type Source<T> = T | (() => T)
const read = <T>(source: Source<T>): T => (typeof source === 'function' ? (source as () => T)() : source)

/**
 * Profile's time over the host's clock, or Clock's system clock without one,
 * with calendar deadlines in `zone` (UTC without it). Either may be a
 * function, read at each use, so a clock or zone composed later is still
 * the one used.
 */
export function profileTime(source?: Source<ProfileClock | undefined>, zone: Source<string | undefined> = undefined): ProfileTime {
  const clock = createClock({ timeZone: 'UTC' }, { now: () => (read(source) ?? system()).now() })
  const deadlineZone = () => read(zone) ?? DEFAULT_PROFILE_TIME_ZONE
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
  /** Calendar units added in the deadline zone, a gap or overlap resolved `compatible`. */
  const calendar = (value: string, amount: { days: number } | { months: number }) => guard(() => {
    const zoned = clock.add({ kind: 'zonedDateTime', value: clock.toZone(value, deadlineZone()) }, amount, { disambiguation: 'compatible' })
    return clock.toInstant(zoned.value)
  }, 'invalid instant')
  return Object.freeze({
    now: () => guard(() => clock.now(), 'clock failed'),
    timeZone: deadlineZone,
    epochMilliseconds: (value: string) => guard(() => Number(clock.formatInterchange(instant(value), 'epochMilliseconds')), 'invalid instant'),
    fromEpochMilliseconds: (milliseconds: number) => guard(() => clock.parseInterchange('epochMilliseconds', milliseconds).value, 'invalid instant'),
    canonical: (value: unknown) => guard(() => {
      if (value instanceof Date) return clock.parseInterchange('epochMilliseconds', value.getTime()).value
      if (typeof value === 'string') return clock.parseInterchange('rfc3339', value).value
      return unavailable('invalid instant')
    }, 'invalid instant'),
    addDays: (value: string, days: number) => calendar(value, { days }),
    addSeconds: (value: string, seconds: number) => guard(() => clock.add(instant(value), { seconds }).value, 'invalid instant'),
    addMonths: (value: string, months: number) => calendar(value, { months }),
    compare: (a: string, b: string) => guard(() => clock.compare(instant(a), instant(b)), 'invalid instant'),
    midpoint: (a: string, b: string) => guard(() => clock.midpoint(instant(a), instant(b)).value, 'invalid instant'),
  })
}

/** The clock's current instant, validated through Clock. */
export function timeFrom(port?: ProfileClock): string {
  return profileTime(port).now()
}

/** Whether `name` is a zone Clock accepts, spelt exactly. Never throws. */
export function isProfileTimeZone(name: unknown): name is string {
  return typeof name === 'string' && isValidTimeZone(name)
}
