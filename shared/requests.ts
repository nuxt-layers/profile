import { z } from 'zod'
import { correlationIdSchema, identifierSchema, instantSchema, reasonCodeSchema } from './identifiers'

/**
 * Data-subject requests and legal holds (docs/contracts.md §14;
 * iam-integration's data-subject request process). Profile is the person's
 * single point of contact: it records each request and each member's part,
 * coordinates the other members through the host's coordination port, and
 * keeps legal holds. Requests carry identifiers, codes and times only.
 */

export const REQUEST_TYPES = ['access', 'correction', 'erasure', 'restriction'] as const
export type RequestType = typeof REQUEST_TYPES[number]

/** The types the person opens from their own profile. Erasure is account closure; correction of their details is the profile itself. */
export const PERSON_REQUEST_TYPES = ['access', 'restriction'] as const satisfies readonly RequestType[]

/** Who opened a request: the person, or a platform operator acting on a request verified outside the platform. */
export const REQUEST_ORIGINS = ['person', 'operator'] as const
export type RequestOrigin = typeof REQUEST_ORIGINS[number]

/**
 * Each member's part of a request. Profile's own is `profile`;
 * `configuration` is the configuration layer's account settings, which it
 * holds for the person beside the IAM suite.
 */
export const REQUEST_PARTS = ['profile', 'identity', 'authentication', 'authorisation', 'configuration'] as const
export type RequestPart = typeof REQUEST_PARTS[number]

/** The other members' parts, which the host's coordination port answers for. */
export const COORDINATED_PARTS = ['identity', 'authentication', 'authorisation', 'configuration'] as const satisfies readonly RequestPart[]
export type CoordinatedPart = typeof COORDINATED_PARTS[number]

/**
 * - `pending` — not done yet;
 * - `done` — answered (an export bundle, or the change made);
 * - `exempt` — refused for this part, with a reason code;
 * - `held` — an erasure deferred by a legal hold.
 */
export const PART_STATUSES = ['pending', 'done', 'exempt', 'held'] as const
export type PartStatus = typeof PART_STATUSES[number]

export const REQUEST_STATUSES = ['open', 'completed'] as const
export type RequestStatus = typeof REQUEST_STATUSES[number]

/**
 * The parts each type of request involves by default. Erasure leaves out
 * `configuration`: the configuration layer deletes an account's settings
 * itself on `identity.closed`.
 */
export const DEFAULT_REQUEST_PARTS: Readonly<Record<RequestType, readonly RequestPart[]>> = Object.freeze({
  access: ['profile', 'identity', 'authentication', 'authorisation', 'configuration'],
  correction: ['profile'],
  erasure: ['profile', 'identity', 'authentication', 'authorisation'],
  restriction: ['profile'],
})

/** The parts a legal hold can cover: those erased on closure by Profile and by the event handler. */
export const LEGAL_HOLD_PARTS = ['profile', 'authentication', 'authorisation'] as const satisfies readonly RequestPart[]
export type LegalHoldPart = typeof LEGAL_HOLD_PARTS[number]

/** Policy defaults, UK data protection; a host's jurisdiction pack may set others. */
export const PROFILE_REQUEST_POLICY = Object.freeze({
  /** A request is due this many calendar months after it is opened. */
  dueMonths: 1,
  /** An access archive is downloadable for this many days after it is complete. */
  archiveDays: 7,
  /** A request still open this many days before its due date is raised to operators. */
  escalateDaysBeforeDue: 7,
  /** The longest a single legal hold may last; a longer one is a new hold. */
  holdMaxDays: 7 * 366,
})

/** Groups a correction or erasure request names, because their names identify the requester. Identity's identifiers only. */
const groupIds = z.array(identifierSchema).max(50)

/** Opening a request (`openProfileRequest`). */
export const openRequestSchema = z.strictObject({
  subjectId: identifierSchema,
  type: z.enum(REQUEST_TYPES),
  origin: z.enum(REQUEST_ORIGINS),
  /** Required from an operator: why, as a code, e.g. `verified-by-post`. */
  reasonCode: reasonCodeSchema.nullable().optional(),
  /** Overrides the default parts; Profile's own is always included. */
  parts: z.array(z.enum(REQUEST_PARTS)).min(1).max(REQUEST_PARTS.length).optional(),
  groupIds: groupIds.optional(),
  correlationId: correlationIdSchema,
})

export type OpenRequestInput = z.input<typeof openRequestSchema>

export const requestPartViewSchema = z.strictObject({
  part: z.enum(REQUEST_PARTS),
  status: z.enum(PART_STATUSES),
  reasonCode: reasonCodeSchema.nullable(),
  updatedAt: instantSchema,
})

/** A request as the person (or an operator) sees it. Never a value. */
export const requestViewSchema = z.strictObject({
  requestId: identifierSchema,
  subjectId: identifierSchema,
  type: z.enum(REQUEST_TYPES),
  origin: z.enum(REQUEST_ORIGINS),
  reasonCode: reasonCodeSchema.nullable(),
  status: z.enum(REQUEST_STATUSES),
  openedAt: instantSchema,
  dueAt: instantSchema,
  completedAt: instantSchema.nullable(),
  escalatedAt: instantSchema.nullable(),
  groupIds,
  parts: z.array(requestPartViewSchema),
  /** For a completed access request: until when its archive can be downloaded; null once deleted or for other types. */
  archiveUntil: instantSchema.nullable(),
})

export type RequestView = z.infer<typeof requestViewSchema>
export type RequestPartView = z.infer<typeof requestPartViewSchema>

/** Settling one part by hand, for an operator (`settleProfileRequestPart`). */
export const settlePartSchema = z.strictObject({
  requestId: identifierSchema,
  part: z.enum(REQUEST_PARTS),
  outcome: z.enum(['done', 'exempt']),
  /** Required for `exempt`: the exemption claimed, e.g. `legal-privilege`. */
  reasonCode: reasonCodeSchema.nullable().optional(),
  correlationId: correlationIdSchema,
})

/** Placing a legal hold (`placeProfileLegalHold`), by an operator. */
export const placeHoldSchema = z.strictObject({
  identityId: identifierSchema,
  parts: z.array(z.enum(LEGAL_HOLD_PARTS)).min(1).max(LEGAL_HOLD_PARTS.length),
  reasonCode: reasonCodeSchema,
  endsAt: instantSchema,
  correlationId: correlationIdSchema,
})

export const legalHoldViewSchema = z.strictObject({
  holdId: identifierSchema,
  identityId: identifierSchema,
  parts: z.array(z.enum(LEGAL_HOLD_PARTS)),
  reasonCode: reasonCodeSchema,
  placedAt: instantSchema,
  endsAt: instantSchema,
  endedAt: instantSchema.nullable(),
})

export type LegalHoldView = z.infer<typeof legalHoldViewSchema>

/** `POST /api/profile/me/requests` */
export const personRequestSchema = z.strictObject({ type: z.enum(PERSON_REQUEST_TYPES) })

/** A request's due date: the same day of the month `months` later, or that month's last day. */
export function requestDueAt(openedAt: Date, months: number = PROFILE_REQUEST_POLICY.dueMonths): Date {
  const due = new Date(openedAt.getTime())
  const day = due.getUTCDate()
  due.setUTCDate(1)
  due.setUTCMonth(due.getUTCMonth() + months)
  const last = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate()
  due.setUTCDate(Math.min(day, last))
  return due
}

/**
 * How long Profile keeps records once their purpose is over (iam-integration
 * `docs/processes/retention.md`), in days: delivered outbox events,
 * completed data-subject requests and ended legal holds. A host may set
 * them within the bounds with `composeProfile`'s `retention`; shorter than the
 * default needs a `riskTreatment` reference. A request of a person a hold
 * covers is kept while the hold runs.
 */
export const PROFILE_RETENTION_BOUNDS = Object.freeze({
  outboxDays: { default: 30, min: 7, max: 365 },
  requestDays: { default: 730, min: 365, max: 2555 },
  endedHoldDays: { default: 365, min: 30, max: 2555 },
} as const)

export type ProfileRetentionSetting = keyof typeof PROFILE_RETENTION_BOUNDS
export type ProfileRetention = Readonly<Record<ProfileRetentionSetting, number>>

export const profileRetentionInputSchema = z.strictObject({
  outboxDays: z.number().int().min(PROFILE_RETENTION_BOUNDS.outboxDays.min).max(PROFILE_RETENTION_BOUNDS.outboxDays.max).optional(),
  requestDays: z.number().int().min(PROFILE_RETENTION_BOUNDS.requestDays.min).max(PROFILE_RETENTION_BOUNDS.requestDays.max).optional(),
  endedHoldDays: z.number().int().min(PROFILE_RETENTION_BOUNDS.endedHoldDays.min).max(PROFILE_RETENTION_BOUNDS.endedHoldDays.max).optional(),
  riskTreatment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/).nullable().optional(),
})

export type ProfileRetentionInput = z.input<typeof profileRetentionInputSchema>

/** The defaults with the host's values over them; refuses values out of bounds, and shortening without a risk treatment. */
export function resolveProfileRetention(input: ProfileRetentionInput = {}): ProfileRetention {
  const { riskTreatment, ...values } = profileRetentionInputSchema.parse(input)
  const resolved = Object.fromEntries((Object.keys(PROFILE_RETENTION_BOUNDS) as ProfileRetentionSetting[])
    .map(key => [key, values[key] ?? PROFILE_RETENTION_BOUNDS[key].default])) as Record<ProfileRetentionSetting, number>
  for (const key of Object.keys(resolved) as ProfileRetentionSetting[]) {
    if (resolved[key] < PROFILE_RETENTION_BOUNDS[key].default && !riskTreatment) {
      throw new TypeError(`Profile retention: ${key} below its default needs a riskTreatment reference.`)
    }
  }
  return Object.freeze(resolved)
}
