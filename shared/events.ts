import { z } from 'zod'
import { PROFILE_ATTRIBUTES } from './attributes'
import { correlationIdSchema, identifierSchema, instantSchema, reasonCodeSchema } from './identifiers'
import { MAX_REQUEST_PARTS, PART_STATUSES, REQUEST_ORIGINS, REQUEST_TYPES, requestPartSchema } from './requests'
import { VERIFIABLE_ATTRIBUTES } from './verification'

/**
 * Profile's events (docs/contracts.md §8). Each is written to Profile's
 * outbox in the same transaction as the change; the host relays them.
 * Delivery is at least once: consumers are idempotent by `eventId`.
 *
 * Events carry opaque identifiers, attribute names and codes only: never a
 * value from the record.
 */

const id = identifierSchema

const payloads = {
  /** A record exists for the identity (empty until the person fills it). */
  'profile.created': z.strictObject({ identityId: id }),
  /** The person changed attributes or their disclosure; names only, never values. */
  'profile.changed': z.strictObject({ identityId: id, attributes: z.array(z.enum(PROFILE_ATTRIBUTES)).max(PROFILE_ATTRIBUTES.length), disclosure: z.boolean() }),
  /** The person chose anonymity in a group they left: drop any name cached for them there. */
  'profile.departure-anonymised': z.strictObject({ identityId: id, groupId: id }),
  /** The record was erased and its key destroyed: drop every name cached for the identity. */
  'profile.anonymised': z.strictObject({ identityId: id, reasonCode: reasonCodeSchema }),
  /** The person proved they receive messages at a contact detail. */
  'profile.contact-verified': z.strictObject({ identityId: id, attribute: z.enum(VERIFIABLE_ATTRIBUTES) }),
  /** A data-subject request was opened (§14). */
  'profile.request-opened': z.strictObject({
    requestId: id,
    identityId: id,
    type: z.enum(REQUEST_TYPES),
    origin: z.enum(REQUEST_ORIGINS),
    parts: z.array(requestPartSchema).max(MAX_REQUEST_PARTS),
    dueAt: instantSchema,
  }),
  /** Every part of a request is answered: each part's outcome, and the exemption claimed for any refused. */
  'profile.request-completed': z.strictObject({
    requestId: id,
    identityId: id,
    parts: z.array(z.strictObject({ part: requestPartSchema, status: z.enum(PART_STATUSES), reasonCode: reasonCodeSchema.nullable() })).max(MAX_REQUEST_PARTS),
  }),
  /** A request needs operators: it is near its due date, or a group's owners have not renamed it in time. */
  'profile.request-escalated': z.strictObject({ requestId: id, identityId: id, reasonCode: reasonCodeSchema }),
  /** A legal hold now defers the erasure of these parts. */
  'profile.legal-hold-placed': z.strictObject({ holdId: id, identityId: id, parts: z.array(requestPartSchema).max(MAX_REQUEST_PARTS), reasonCode: reasonCodeSchema, endsAt: instantSchema }),
  /**
   * A legal hold ended. `released`: the parts no hold covers any more;
   * `identityClosed`: whether `closeProfileSubject` has run for the person,
   * so the host now carries out the erasures the hold deferred.
   */
  'profile.legal-hold-ended': z.strictObject({
    holdId: id,
    identityId: id,
    parts: z.array(requestPartSchema).max(MAX_REQUEST_PARTS),
    released: z.array(requestPartSchema).max(MAX_REQUEST_PARTS),
    identityClosed: z.boolean(),
    reasonCode: reasonCodeSchema,
  }),
  /**
   * Profile's part of a disposed group is gone (`disposeProfileGroup`): the
   * departure records and pseudonyms kept for it, and its references in
   * data-subject requests. Departures of people a legal hold covers are kept.
   */
  'profile.group-disposed': z.strictObject({ groupId: id, departures: z.number().int().min(0), heldDepartures: z.number().int().min(0) }),
  /** One maintenance run's deletions under the retention schedules: counts only. */
  'profile.retention-applied': z.strictObject({ outboxEvents: z.number().int().min(0), requests: z.number().int().min(0), legalHolds: z.number().int().min(0) }),
} as const

export type ProfileEventType = keyof typeof payloads
export const PROFILE_EVENT_TYPES = Object.freeze(Object.keys(payloads) as ProfileEventType[])

function eventSchema<T extends ProfileEventType>(type: T) {
  return z.strictObject({
    /** UUIDv7; consumers are idempotent by it. */
    eventId: id,
    type: z.literal(type),
    occurredAt: instantSchema,
    correlationId: correlationIdSchema,
    data: payloads[type],
  })
}

export const profileEventSchema = z.discriminatedUnion(
  'type',
  PROFILE_EVENT_TYPES.map(type => eventSchema(type)) as unknown as [ReturnType<typeof eventSchema>, ...ReturnType<typeof eventSchema>[]],
)

export type ProfileEvent = {
  [T in ProfileEventType]: { eventId: string, type: T, occurredAt: string, correlationId: string, data: z.infer<(typeof payloads)[T]> }
}[ProfileEventType]

export const PROFILE_EVENT_PAYLOADS: Readonly<Record<ProfileEventType, z.ZodType>> = Object.freeze(payloads)
