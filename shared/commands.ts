import { z } from 'zod'
import { correlationIdSchema, identifierSchema, instantSchema } from './identifiers'

/**
 * Profile's commands (docs/contracts.md §9): what the host tells Profile
 * when something happens to a person or a group in its directory. The host
 * maps its own events onto them; Profile parses no other capability's
 * events.
 *
 * Each command is idempotent by `commandId`: the same id applied twice
 * answers `duplicate` and changes nothing. A host relaying an event passes
 * the event's own identifier, so a redelivery is harmless.
 */

const command = {
  /** The event or command identifier (a UUIDv7) Profile records as applied. */
  commandId: identifierSchema,
  /** The correlation identifier of the process, carried into Profile's events. */
  correlationId: correlationIdSchema,
}

/** `provisionProfileRecord`: a person now exists. Profile creates their empty record and key; none for a non-person, and never again for an erased one. */
export const provisionCommandSchema = z.strictObject({ ...command, subjectId: identifierSchema })

/** `recordProfileDeparture`: the person's membership of a group ended at `endedAt`; Profile keeps how they are shown there. */
export const departureCommandSchema = z.strictObject({ ...command, subjectId: identifierSchema, groupId: identifierSchema, endedAt: instantSchema })

/** `closeProfileSubject`: the person's account is closed. Profile erases the record, or keeps it unread while a legal hold covers Profile's part. */
export const closureCommandSchema = z.strictObject({ ...command, subjectId: identifierSchema })

/** `recordProfilePause`: the person paused their whole account. Completes the directory part of their open restriction requests. */
export const pauseCommandSchema = z.strictObject({ ...command, subjectId: identifierSchema })

/** `recordProfileGroupRenamed`: a group was renamed. Completes correction (and erasure) requests that named it, once every group they name is renamed. */
export const groupRenamedCommandSchema = z.strictObject({ ...command, groupId: identifierSchema })

/** `disposeProfileGroup`: a deleted group's disposal is due (the host calls it only then). Profile deletes what it keeps for the group. */
export const groupDisposalCommandSchema = z.strictObject({ ...command, groupId: identifierSchema })

export type ProvisionCommand = z.input<typeof provisionCommandSchema>
export type DepartureCommand = z.input<typeof departureCommandSchema>
export type ClosureCommand = z.input<typeof closureCommandSchema>
export type PauseCommand = z.input<typeof pauseCommandSchema>
export type GroupRenamedCommand = z.input<typeof groupRenamedCommandSchema>
export type GroupDisposalCommand = z.input<typeof groupDisposalCommandSchema>

/** A command's outcome: `applied`, or `duplicate` when its id was already applied. */
export type ProfileCommandResult = 'applied' | 'duplicate'
