/**
 * Failure categories at Profile's boundary (docs/contracts.md §7).
 *
 * `forbidden` is deliberately coarse: it never says whether a person or a
 * record exists, or which rule refused.
 */
export const PROFILE_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'insufficient-assurance',
  'validation-failed',
  'conflict',
  'rate-limited',
  'unavailable',
] as const

export type ProfileErrorCode = typeof PROFILE_ERROR_CODES[number]

/** HTTP status used when an error code crosses the HTTP boundary. */
export const PROFILE_ERROR_STATUS: Readonly<Record<ProfileErrorCode, number>> = {
  'unauthenticated': 401,
  'forbidden': 403,
  'insufficient-assurance': 403,
  'validation-failed': 400,
  'conflict': 409,
  'rate-limited': 429,
  'unavailable': 503,
}

/**
 * JSON body of an error from `/api/profile/*`. `reason` is a code, given
 * only for `validation-failed` (the problem, e.g. `invalid-email`) and
 * `conflict` (`version-changed`): never a value, and never for `forbidden`.
 */
export interface ProfileErrorBody {
  code: ProfileErrorCode
  /** Localisation key for the user-facing message, e.g. `profile.error.forbidden`. */
  messageKey: string
  reason?: string
}

export function isProfileErrorCode(value: unknown): value is ProfileErrorCode {
  return typeof value === 'string' && (PROFILE_ERROR_CODES as readonly string[]).includes(value)
}

/** Raised when the host has not supplied a required port. Profile fails closed: no implicit store or key. */
export class ProfileCompositionError extends Error {
  readonly port: string

  constructor(port: string) {
    super(`Profile port '${port}' has not been supplied by the host application. See CONTRACT.md.`)
    this.name = 'ProfileCompositionError'
    this.port = port
  }
}

/**
 * A server function's failure, carrying a contract code. `unavailable` means
 * the database, the key port or Identity's port failed, and the operation
 * failed closed. The detail is for server logs only and never names a value.
 */
export class ProfileFailure extends Error {
  readonly code: ProfileErrorCode

  constructor(code: ProfileErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ProfileFailure'
    this.code = code
  }
}
