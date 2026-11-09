import { z } from 'zod'
import type { DisclosureSettings, DisplayName } from './disclosure'
import { disclosureSettingsSchema, DISCLOSURE_MAX_SUBJECTS, LOOKUP_PURPOSES } from './disclosure'
import type { ProfileAttribute, ProfileAttributes } from './attributes'
import { profileChangesSchema } from './attributes'
import { identifierSchema } from './identifiers'

/**
 * Profile's HTTP API (docs/contracts.md §12): the person's own record and
 * choices, and display-name lookups for the host's pages.
 */

export const PROFILE_API_PREFIX = '/api/profile'

/** A client may send its correlation identifier; otherwise the server issues one. */
export const PROFILE_CORRELATION_HEADER = 'x-correlation-id'

/**
 * Authenticator assurance levels Profile distinguishes (NIST SP 800-63B):
 * `aal2` is needed for exports, contact-detail changes and naming suspended
 * members.
 */
export const PROFILE_ASSURANCE_LEVELS = ['aal1', 'aal2'] as const
export type ProfileAssuranceLevel = typeof PROFILE_ASSURANCE_LEVELS[number]

/**
 * The signed-in person, as the host's subject resolver gives it: who they
 * are (`principalId`, the same identifier their record is kept under), when
 * they last signed in, and how strongly. Never read from a request.
 */
export const profileSubjectSchema = z.strictObject({
  principalId: identifierSchema,
  authenticatedAt: z.iso.datetime(),
  assurance: z.strictObject({
    level: z.enum(PROFILE_ASSURANCE_LEVELS),
    phishingResistant: z.boolean(),
  }),
})

export type ProfileSubject = z.infer<typeof profileSubjectSchema>

/**
 * Exporting one's data, and changing a contact detail, need a sign-in within
 * this many seconds. Otherwise the answer is `insufficient-assurance`, and the
 * host sends the person to sign in again.
 */
export const PROFILE_STEP_UP_SECONDS = 900

/** Attributes whose change needs a recent sign-in. */
export const STEP_UP_ATTRIBUTES: readonly ProfileAttribute[] = Object.freeze(['email', 'phone_number'])

/** Display-name and profile lookups each viewer may make in a window (each lookup covers up to 200 people). */
export const PROFILE_LOOKUP_RATE_LIMIT = Object.freeze({ requests: 60, windowSeconds: 60 })

/** What the person sees of their own profile. `version` guards against lost updates. */
export interface ProfileOwnView {
  attributes: ProfileAttributes
  settings: DisclosureSettings
  /** 0 before anything is stored. */
  version: number
}

export interface ProfilePersonView {
  subjectId: string
  displayName: DisplayName
  attributes: ProfileAttributes
}

const expectedVersion = z.number().int().min(0)

/** `PATCH /api/profile/me` */
export const updateProfileRequestSchema = z.strictObject({ expectedVersion, changes: profileChangesSchema })

/** `PUT /api/profile/me/disclosure` */
export const disclosureRequestSchema = z.strictObject({ expectedVersion, settings: disclosureSettingsSchema })

/** `POST /api/profile/display-names`. An `administration` lookup names the group it is for. */
export const displayNamesRequestSchema = z.strictObject({
  subjectIds: z.array(identifierSchema).min(1).max(DISCLOSURE_MAX_SUBJECTS),
  groupId: identifierSchema.nullable().optional(),
  purpose: z.enum(LOOKUP_PURPOSES),
}).refine(body => body.purpose !== 'administration' || typeof body.groupId === 'string', 'group-required')

/** A group the person has left, as their own page lists it. Profile holds no group names: the host shows them. */
export interface ProfileDepartureView {
  groupId: string
  endedAt: string
  /** The person chose to be shown as "Former member" there. */
  anonymised: boolean
}
