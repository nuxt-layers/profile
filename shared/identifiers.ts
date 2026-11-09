import { z } from 'zod'

/**
 * Identifiers, codes and instants. Profile keys every record by the opaque
 * identifier the host's directory gives a person, and never derives one
 * from personal data.
 */

/** A lower-case UUIDv7, as the host's directory issues for people and groups. */
export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Any RFC 9562 UUID, lower case. Correlation identifiers are issued by the host. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The host's opaque identifier of a person or a group. */
export const identifierSchema = z.string().regex(UUID_V7_PATTERN, 'Expected a lower-case UUIDv7')

/** The correlation identifier of the request that started a process, issued by the host. */
export const correlationIdSchema = z.string().regex(UUID_PATTERN, 'Expected a lower-case UUID')

/** ISO 8601 instant in UTC. */
export const instantSchema = z.iso.datetime()

/** A reason code, never free text: `legal-hold`, `person-request`. */
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const reasonCodeSchema = z.string().max(64).regex(REASON_CODE_PATTERN, 'Expected a reason code such as legal-hold')
