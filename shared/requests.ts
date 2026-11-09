import { z } from 'zod'
import { correlationIdSchema, identifierSchema, instantSchema, reasonCodeSchema } from './identifiers'

/**
 * Data-subject requests and legal holds (docs/contracts.md §14). Profile is
 * the person's single point of contact: it records each request and each
 * part, asks the host's coordination port for the coordinated parts, and
 * keeps legal holds. Parts other than Profile's own are the host's, by
 * declaration. Requests carry identifiers, codes and times only.
 */

export const REQUEST_TYPES = ['access', 'correction', 'erasure', 'restriction'] as const
export type RequestType = typeof REQUEST_TYPES[number]

/** The types the person opens from their own profile. Erasure is account closure; correction of their details is the profile itself. */
export const PERSON_REQUEST_TYPES = ['access', 'restriction'] as const satisfies readonly RequestType[]

/** Who opened a request: the person, or a platform operator acting on a request verified outside the platform. */
export const REQUEST_ORIGINS = ['person', 'operator'] as const
export type RequestOrigin = typeof REQUEST_ORIGINS[number]

/**
 * Profile's own part of every request: the only part Profile knows by name.
 * Every other part is the host's, declared in `composeProfile`'s
 * `requestParts` (`ProfileRequestPartsDeclaration`); Profile records it,
 * waits for it and reports it, and knows nothing more about what it holds.
 */
export const PROFILE_REQUEST_PART = 'profile'

/** A part's name: a lower-case code such as `accounts`, at most 32 characters. */
export const REQUEST_PART_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const requestPartSchema = z.string().max(32).regex(REQUEST_PART_PATTERN, 'Expected a part name such as accounts')
export type RequestPart = string

/** The most parts a request or a hold can have, Profile's own included. */
export const MAX_REQUEST_PARTS = 16

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
 * One part the host declares beside Profile's own:
 *
 * - `coordinated` — an access request's bundle for it comes from the host's
 *   `requestCoordinator.exportPart`; otherwise an operator settles it;
 * - `holdable` — a legal hold can cover it, deferring its erasure;
 * - `directory` — at most one part: the record of the person's groups and
 *   standing. Profile settles it from its own commands: `recordProfilePause`
 *   completes it in a restriction, `recordProfileGroupRenamed` (and
 *   `disposeProfileGroup`) in a correction once every group named is
 *   renamed, and, in an erasure, the same once `closeProfileSubject` has
 *   run. A request that names groups includes it.
 */
export const requestPartDeclarationSchema = z.strictObject({
  name: requestPartSchema.refine(name => name !== PROFILE_REQUEST_PART, 'reserved-part'),
  coordinated: z.boolean().optional(),
  holdable: z.boolean().optional(),
  directory: z.boolean().optional(),
})

const partList = z.array(requestPartSchema).max(MAX_REQUEST_PARTS)

/**
 * The host's parts (`composeProfile`'s `requestParts`), and the parts each
 * type of request involves by default. Profile's own is always included.
 * A type the host leaves out defaults to Profile's part, and, for access,
 * every coordinated part. Without a declaration, Profile's part is the only
 * one.
 */
export const requestPartsDeclarationSchema = z.strictObject({
  parts: z.array(requestPartDeclarationSchema).max(MAX_REQUEST_PARTS - 1),
  defaults: z.strictObject({ access: partList.optional(), correction: partList.optional(), erasure: partList.optional(), restriction: partList.optional() }).optional(),
})

export type ProfileRequestPartsDeclaration = z.input<typeof requestPartsDeclarationSchema>

/** A declaration, resolved and checked: every list in declaration order, Profile's part first. */
export interface ProfileRequestParts {
  /** Every part a new request or hold may name. */
  all: readonly RequestPart[]
  coordinated: readonly RequestPart[]
  holdable: readonly RequestPart[]
  directory: RequestPart | null
  defaults: Readonly<Record<RequestType, readonly RequestPart[]>>
}

/** Resolves the host's declaration; throws a `TypeError` naming the fault, at composition. */
export function resolveProfileRequestParts(input: ProfileRequestPartsDeclaration = { parts: [] }): ProfileRequestParts {
  const result = requestPartsDeclarationSchema.safeParse(input)
  if (!result.success) throw new TypeError(`composeProfile: \`requestParts\` is invalid: ${[...new Set(result.error.issues.map(issue => issue.message))].join(', ')}.`)
  const declared = result.data.parts
  const names = declared.map(part => part.name)
  if (new Set(names).size !== names.length) throw new TypeError('composeProfile: `requestParts` names a part twice.')
  const directories = declared.filter(part => part.directory === true)
  if (directories.length > 1) throw new TypeError('composeProfile: `requestParts` may declare one directory part at most.')
  const all = Object.freeze([PROFILE_REQUEST_PART, ...names])
  const coordinated = Object.freeze(declared.filter(part => part.coordinated === true).map(part => part.name))
  const order = (parts: Iterable<string>) => Object.freeze(all.filter(part => new Set(parts).has(part)))
  const defaults = {} as Record<RequestType, readonly RequestPart[]>
  for (const type of REQUEST_TYPES) {
    const listed = result.data.defaults?.[type]
    const unknown = (listed ?? []).filter(part => !all.includes(part))
    if (unknown.length) throw new TypeError(`composeProfile: \`requestParts.defaults.${type}\` names undeclared parts: ${unknown.join(', ')}.`)
    defaults[type] = order([PROFILE_REQUEST_PART, ...(listed ?? (type === 'access' ? coordinated : []))])
  }
  return Object.freeze({
    all,
    coordinated,
    holdable: Object.freeze([PROFILE_REQUEST_PART, ...declared.filter(part => part.holdable === true).map(part => part.name)]),
    directory: directories[0]?.name ?? null,
    defaults: Object.freeze(defaults),
  })
}

/** Parts in declaration order, Profile's first; a stored part no longer declared follows, alphabetically. */
export function orderRequestParts<T>(declaration: ProfileRequestParts, items: readonly T[], partOf: (item: T) => string): T[] {
  const rank = (part: string) => {
    const index = declaration.all.indexOf(part)
    return index === -1 ? declaration.all.length : index
  }
  return [...items].sort((a, b) => rank(partOf(a)) - rank(partOf(b)) || partOf(a).localeCompare(partOf(b)))
}

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

/** Groups a correction or erasure request names, because their names identify the requester. Group identifiers only. */
const groupIds = z.array(identifierSchema).max(50)

/** Opening a request (`openProfileRequest`). */
export const openRequestSchema = z.strictObject({
  subjectId: identifierSchema,
  type: z.enum(REQUEST_TYPES),
  origin: z.enum(REQUEST_ORIGINS),
  /** Required from an operator: why, as a code, e.g. `verified-by-post`. */
  reasonCode: reasonCodeSchema.nullable().optional(),
  /** Overrides the default parts, from those declared; Profile's own is always included. */
  parts: z.array(requestPartSchema).min(1).max(MAX_REQUEST_PARTS).optional(),
  groupIds: groupIds.optional(),
  correlationId: correlationIdSchema,
})

export type OpenRequestInput = z.input<typeof openRequestSchema>

export const requestPartViewSchema = z.strictObject({
  part: requestPartSchema,
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
  part: requestPartSchema,
  outcome: z.enum(['done', 'exempt']),
  /** Required for `exempt`: the exemption claimed, e.g. `legal-privilege`. */
  reasonCode: reasonCodeSchema.nullable().optional(),
  correlationId: correlationIdSchema,
})

/** Placing a legal hold (`placeProfileLegalHold`), by an operator. */
export const placeHoldSchema = z.strictObject({
  identityId: identifierSchema,
  /** From the holdable parts: Profile's own and those declared `holdable`. */
  parts: z.array(requestPartSchema).min(1).max(MAX_REQUEST_PARTS),
  reasonCode: reasonCodeSchema,
  endsAt: instantSchema,
  correlationId: correlationIdSchema,
})

export const legalHoldViewSchema = z.strictObject({
  holdId: identifierSchema,
  identityId: identifierSchema,
  parts: z.array(requestPartSchema),
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
 * How long Profile keeps records once their purpose is over, in days: delivered outbox events,
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
