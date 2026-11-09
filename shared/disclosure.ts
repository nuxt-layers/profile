import { z } from 'zod'
import type { ProfileAttribute, ProfileAttributes } from './attributes'
import { PROFILE_ATTRIBUTES, VERIFICATION_CLAIMS } from './attributes'
import { identifierSchema, instantSchema } from './identifiers'

/**
 * Disclosure (docs/contracts.md §4, §5): what a viewer may see of a person.
 *
 * The person chooses, for each attribute, its audience. The host's directory
 * supplies how the viewer is related to the person and the person's
 * standing, through the disclosure-context port; Profile applies its rules
 * here, as a pure function, so the same answer comes from every server
 * function.
 */

/**
 * - `nobody` — the person only;
 * - `group` — people who share a group with them, where both memberships
 *   are in effect;
 * - `tenant` — also anyone with a membership in effect in the same tenant.
 */
export const DISCLOSURE_AUDIENCES = ['nobody', 'group', 'tenant'] as const
export type DisclosureAudience = typeof DISCLOSURE_AUDIENCES[number]

/** Which of the person's names others see as their display name. */
export const DISPLAY_NAME_SOURCES = ['name', 'preferred_username', 'given_name'] as const
export type DisplayNameSource = typeof DISPLAY_NAME_SOURCES[number]

export const disclosureSettingsSchema = z.strictObject({
  audiences: z.strictObject(
    Object.fromEntries(PROFILE_ATTRIBUTES.map(key => [key, z.enum(DISCLOSURE_AUDIENCES)])) as { [K in ProfileAttribute]: z.ZodEnum<{ [A in DisclosureAudience]: A }> },
  ),
  displayName: z.enum(DISPLAY_NAME_SOURCES),
  /** Whether to be shown as "Former member" in every group the person leaves, whatever the group's policy. */
  anonymiseOnDeparture: z.boolean(),
})

export type DisclosureSettings = z.infer<typeof disclosureSettingsSchema>

/** Secure defaults: the name to fellow group members, everything else to nobody. */
export const DEFAULT_DISCLOSURE_SETTINGS: DisclosureSettings = Object.freeze({
  audiences: Object.freeze({
    name: 'group',
    given_name: 'nobody',
    family_name: 'nobody',
    preferred_username: 'nobody',
    locale: 'nobody',
    zoneinfo: 'nobody',
    email: 'nobody',
    phone_number: 'nobody',
  }),
  displayName: 'name',
  anonymiseOnDeparture: false,
}) as DisclosureSettings

// ---------------------------------------------------------------------------
// The disclosure context: what Profile asks the host's directory
// ---------------------------------------------------------------------------

/**
 * How the viewer is related to a person:
 *
 * - `self` — the viewer is the person;
 * - `same-group` — they share a group (or the group context), both
 *   memberships in effect;
 * - `former-member` — the person left the group context;
 * - `same-tenant` — they share only a tenant;
 * - `none` — anything else, including a person who does not exist.
 */
export const RELATIONSHIPS = ['self', 'same-group', 'former-member', 'same-tenant', 'none'] as const
export type Relationship = typeof RELATIONSHIPS[number]

/**
 * The person's standing as a whole: `visible`; `paused` (by their own
 * choice: shown only in attribution); `suspended` (by others); `closing`
 * (account closure under way); `gone` (closed). Only `visible` is listed.
 */
export const SUBJECT_STANDINGS = ['visible', 'paused', 'suspended', 'closing', 'gone'] as const
export type SubjectStanding = typeof SUBJECT_STANDINGS[number]

/** How a group shows the people who left it: by name, by pseudonym, or as "Former member". */
export const DEPARTURE_ATTRIBUTIONS = ['keep-name', 'pseudonymise', 'anonymise'] as const
export type DepartureAttribution = typeof DEPARTURE_ATTRIBUTIONS[number]

/** A membership's own state: only `active` is in effect; `paused` is the member's choice, `suspended` others'. */
export const MEMBERSHIP_STATES = ['active', 'paused', 'suspended', 'ended'] as const
export type MembershipState = typeof MEMBERSHIP_STATES[number]

/**
 * The subject's standing in the group context: their identity's standing,
 * made stricter by their own membership of the group. A member paused or
 * suspended in a group is hidden there as a paused or suspended person is
 * everywhere.
 */
export function standingInGroup(standing: SubjectStanding, membership: MembershipState | null | undefined): SubjectStanding {
  if (standing !== 'visible' && standing !== 'paused') return standing
  if (membership === 'suspended') return 'suspended'
  if (membership === 'paused') return 'paused'
  return standing
}

/** The largest batch Profile asks about: one viewer, up to 200 subjects. */
export const DISCLOSURE_MAX_SUBJECTS = 200

/**
 * The directory's answer, parsed before use so a malformed one fails closed.
 * Fields Profile does not use are tolerated and dropped.
 */
export const disclosureContextSchema = z.object({
  viewerId: identifierSchema,
  groupId: identifierSchema.nullable(),
  departurePolicy: z.object({ attribution: z.enum(DEPARTURE_ATTRIBUTIONS) }).nullable(),
  subjects: z.array(z.object({
    subjectId: identifierSchema,
    relationship: z.enum(RELATIONSHIPS),
    standing: z.enum(SUBJECT_STANDINGS),
    /** The subject's membership of the group context, when the viewer may know of it. */
    membershipInGroup: z.object({ state: z.enum(MEMBERSHIP_STATES) }).nullable().optional(),
  })).max(DISCLOSURE_MAX_SUBJECTS),
  readAt: instantSchema,
})

export type DisclosureContext = z.infer<typeof disclosureContextSchema>

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * Why a name is being looked up:
 *
 * - `attribution` — who wrote or did something in the past;
 * - `listing` — who is here now (member lists, profiles, search);
 * - `administration` — a group's member list as its administrators see it:
 *   a listing, except that a suspended member is named, by display name
 *   only, to a viewer who holds `profile.suspended-people:view` on the group.
 *
 * A paused person is left out of listings but stays attributed.
 */
export const LOOKUP_PURPOSES = ['attribution', 'listing', 'administration'] as const
export type LookupPurpose = typeof LOOKUP_PURPOSES[number]

/**
 * A display name as the viewer may see it. Never text the host must
 * translate: `pseudonym` and the fallbacks are codes the presentation
 * localises ("Former member 7", "Former member", "Member").
 */
export type DisplayName =
  | { kind: 'name', value: string }
  | { kind: 'pseudonym', number: number }
  | { kind: 'former-member' }
  | { kind: 'hidden' }

/** What Profile knows about a person's departure from the group context. */
export interface DepartureFacts {
  /** Their display name as fellow members saw it when they left, or null. */
  name: string | null
  /** Their stable number in the group, or null once they chose anonymisation. */
  pseudonym: number | null
  /** The person chose to be anonymous in this group. */
  anonymised: boolean
}

export interface DisclosureInput {
  relationship: Relationship
  standing: SubjectStanding
  purpose: LookupPurpose
  /** Null when the person has no record (never set one, or erased). */
  attributes: ProfileAttributes | null
  settings: DisclosureSettings
  /** The group's departure attribution, when a group context applies. */
  departureAttribution: DepartureAttribution | null
  departure: DepartureFacts | null
  /**
   * For `administration` only: the viewer holds `profile.suspended-people:view`
   * on the group context, as the host's access decision answered for this lookup.
   */
  administrator?: boolean
}

const AUDIENCE_RANK: Readonly<Record<DisclosureAudience, number>> = { nobody: 0, group: 1, tenant: 2 }

/** The widest audience that includes a viewer with this relationship, or null for the person themselves. */
function reach(relationship: Relationship): number {
  switch (relationship) {
    case 'same-group': return AUDIENCE_RANK.group
    case 'same-tenant': return AUDIENCE_RANK.tenant
    default: return Number.POSITIVE_INFINITY
  }
}

/** Whether the standing allows anything to be shown to another person for this purpose. */
function shown(standing: SubjectStanding, purpose: LookupPurpose): boolean {
  if (standing === 'visible') return true
  return standing === 'paused' && purpose === 'attribution'
}

/** A suspended fellow member, named to the group's administrators in an administration listing (display name only). */
function namedToAdministrator(input: DisclosureInput): boolean {
  return input.purpose === 'administration' && input.administrator === true && input.standing === 'suspended' && input.relationship === 'same-group'
}

/** The attributes the viewer may see. The person sees all of their own. */
export function discloseAttributes(input: Omit<DisclosureInput, 'departureAttribution' | 'departure'>): ProfileAttributes {
  const { attributes, settings, relationship } = input
  if (!attributes) return {}
  if (relationship === 'self') return { ...attributes }
  if (relationship !== 'same-group' && relationship !== 'same-tenant') return {}
  if (!shown(input.standing, input.purpose)) return {}
  const disclosed: Record<string, unknown> = {}
  for (const key of PROFILE_ATTRIBUTES) {
    const value = attributes[key]
    if (value === undefined) continue
    if (AUDIENCE_RANK[settings.audiences[key]] < reach(relationship)) continue
    disclosed[key] = value
    const claim = VERIFICATION_CLAIMS[key]
    if (claim) disclosed[claim] = attributes[claim] === true
  }
  return disclosed as ProfileAttributes
}

/** The display name the person chose, if set: the value fellow members would see. */
export function chosenDisplayName(attributes: ProfileAttributes | null, settings: DisclosureSettings): string | null {
  return attributes?.[settings.displayName] ?? null
}

/** The display name the viewer may see. */
export function discloseDisplayName(input: DisclosureInput): DisplayName {
  const { relationship, settings } = input
  if (relationship === 'self') {
    const own = chosenDisplayName(input.attributes, settings)
    return own === null ? { kind: 'hidden' } : { kind: 'name', value: own }
  }
  if (namedToAdministrator(input)) {
    const visible = discloseAttributes({ ...input, standing: 'visible', purpose: 'listing' })
    const name = visible[settings.displayName]
    return name === undefined ? { kind: 'hidden' } : { kind: 'name', value: name }
  }
  if (!shown(input.standing, input.purpose)) return { kind: 'hidden' }
  if (relationship === 'former-member') {
    const departure = input.departure
    if (!departure || departure.anonymised) return { kind: 'former-member' }
    switch (input.departureAttribution) {
      case 'keep-name': return departure.name === null ? { kind: 'former-member' } : { kind: 'name', value: departure.name }
      case 'pseudonymise': return departure.pseudonym === null ? { kind: 'former-member' } : { kind: 'pseudonym', number: departure.pseudonym }
      default: return { kind: 'former-member' }
    }
  }
  const visible = discloseAttributes(input)
  const name = visible[settings.displayName]
  return name === undefined ? { kind: 'hidden' } : { kind: 'name', value: name }
}
