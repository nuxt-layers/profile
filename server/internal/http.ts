import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { createError, defineEventHandler, getRequestHeader, getRequestURL, getRouterParam, isError, readBody } from 'h3'
import type { z } from 'zod'
import type { ProfileErrorBody, ProfileErrorCode, ProfileSubject } from '../../contracts'
import {
  PROFILE_API_PREFIX,
  PROFILE_CORRELATION_HEADER,
  PROFILE_ERROR_STATUS,
  PROFILE_STEP_UP_SECONDS,
  ProfileCompositionError,
  ProfileFailure,
  profileSubjectSchema,
  UUID_PATTERN,
  UUID_V7_PATTERN,
} from '../../contracts'
import { useProfileClock, useProfileSubjectResolver } from './composition'
import { profileTime } from './clock'

/**
 * PRIVATE. The HTTP boundary of `/api/profile/*` (docs/contracts.md §12).
 *
 * - Errors cross as `ProfileErrorBody`: the contract code, a localisation
 *   key, and a problem code for `validation-failed` and `conflict` only.
 *   Nothing in a response or a log names a value.
 * - Bodies are JSON objects parsed with strict schemas.
 * - The person comes only from the host's subject resolver, never from a
 *   request.
 */

const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:,[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/

export function profileHttpError(code: ProfileErrorCode, reason?: string) {
  const data: ProfileErrorBody = { code, messageKey: `profile.error.${code}` }
  if (reason && (code === 'conflict' || code === 'validation-failed') && CODE.test(reason) && reason.length <= 128) data.reason = reason
  return createError({ statusCode: PROFILE_ERROR_STATUS[code], statusMessage: code, data })
}

function detailOf(error: ProfileFailure): string | undefined {
  const prefix = `${error.code}: `
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : undefined
}

/** Translates anything thrown inside a handler into a contract error. */
export function toHttpError(error: unknown) {
  if (isError(error)) return error
  if (error instanceof ProfileFailure) {
    if (error.code === 'unavailable') console.error('[profile] request failed:', error.message)
    return profileHttpError(error.code, detailOf(error))
  }
  if (error instanceof ProfileCompositionError) {
    console.error(`[profile] ${error.message}`)
    return profileHttpError('unavailable')
  }
  console.error('[profile] unexpected failure:', error instanceof Error ? error.name : 'unknown')
  return profileHttpError('unavailable')
}

/** Wraps a handler so that every failure leaves as a contract error. */
export function profileHandler<T>(run: (event: H3Event) => Promise<T>) {
  return defineEventHandler(async (event) => {
    try {
      return await run(event)
    }
    catch (error) {
      throw toHttpError(error)
    }
  })
}

/** The request's correlation identifier: the client's, when valid, otherwise a new one. */
export function correlationOf(event: H3Event): string {
  const sent = getRequestHeader(event, PROFILE_CORRELATION_HEADER)?.toLowerCase()
  return sent && UUID_PATTERN.test(sent) ? sent : randomUUID()
}

/** The signed-in person. `unauthenticated` without one; `unavailable` if the resolver fails. */
export async function requireSubject(event: H3Event): Promise<ProfileSubject> {
  const resolver = useProfileSubjectResolver()
  let subject: unknown
  try {
    subject = await resolver.resolve(event)
  }
  catch {
    throw new ProfileFailure('unavailable', 'subject resolver failed')
  }
  if (subject == null) throw new ProfileFailure('unauthenticated')
  const parsed = profileSubjectSchema.safeParse(subject)
  if (!parsed.success) throw new ProfileFailure('unavailable', 'subject resolver returned a malformed subject')
  return parsed.data
}

/**
 * Refuses with `insufficient-assurance` unless the person signed in within
 * `PROFILE_STEP_UP_SECONDS`, judged by the host's clock (`unavailable` if it
 * answers an invalid time).
 */
export function requireRecentSignIn(subject: ProfileSubject, now?: string): void {
  const time = profileTime(useProfileClock())
  const at = now ?? time.now()
  let authenticatedAt: string
  try {
    authenticatedAt = time.canonical(subject.authenticatedAt)
  }
  catch {
    throw new ProfileFailure('insufficient-assurance')
  }
  // Recent: no more than a minute ahead of the clock, and no older than the step-up window.
  if (time.compare(authenticatedAt, time.addSeconds(at, 60)) > 0 || time.compare(authenticatedAt, time.addSeconds(at, -PROFILE_STEP_UP_SECONDS)) < 0) {
    throw new ProfileFailure('insufficient-assurance')
  }
}

/** A route parameter that must be an identifier. */
export function identifierParam(event: H3Event, name: string): string {
  const value = getRouterParam(event, name)
  if (!value || !UUID_V7_PATTERN.test(value)) throw new ProfileFailure('validation-failed')
  return value
}

/** The JSON body, parsed with a strict schema; problems come back as codes. */
export async function readJson<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await readBody(event)
  }
  catch {
    throw new ProfileFailure('validation-failed')
  }
  const parsed = schema.safeParse(body ?? {})
  if (!parsed.success) {
    const codes = [...new Set(parsed.error.issues.map(issue => issue.message))].filter(message => CODE.test(message))
    throw new ProfileFailure('validation-failed', codes.length > 0 ? codes.join(',') : undefined)
  }
  return parsed.data
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF defence for the state-changing endpoints: the request must carry an
 * Origin (or, failing that, a
 * Referer) matching the configured base URL. Without one, every
 * state-changing request is refused.
 */
export function originRejected(event: H3Event, baseUrl: string | undefined): boolean {
  if (!getRequestURL(event).pathname.startsWith(`${PROFILE_API_PREFIX}/`)) return false
  if (SAFE_METHODS.has(event.method)) return false
  let expected: string
  try {
    expected = new URL(baseUrl ?? '').origin
  }
  catch {
    return true
  }
  const origin = getRequestHeader(event, 'origin')
  const referer = getRequestHeader(event, 'referer')
  try {
    const actual = origin ? new URL(origin).origin : referer ? new URL(referer).origin : null
    return actual !== expected
  }
  catch {
    return true
  }
}
