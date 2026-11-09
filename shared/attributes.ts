import { z } from 'zod'
import { safeNameSchema } from './safe-names'

/**
 * The attributes of a person's record (docs/contracts.md §3), named as the
 * OpenID Connect standard claims. Profile is their only canonical source:
 * the host's sign-in service never stores or seeds them.
 *
 * Contact details are independent of any sign-in identifiers.
 * They are stored unverified (`email_verified` and `phone_number_verified`
 * false) until the person types back a code Profile sent through the host's
 * notification port (§15), and become unverified again whenever they change.
 * Profile sends nothing else to them.
 */

export const PROFILE_ATTRIBUTES = [
  'name',
  'given_name',
  'family_name',
  'preferred_username',
  'locale',
  'zoneinfo',
  'email',
  'phone_number',
] as const

export type ProfileAttribute = typeof PROFILE_ATTRIBUTES[number]

/** A BCP 47 language tag, e.g. `en-GB`. */
export const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

/** An E.164 telephone number, e.g. `+447700900123`. */
export const PHONE_NUMBER_PATTERN = /^\+[1-9][0-9]{6,14}$/

/** What a person may set, each validated and normalised. */
export const attributeSchemas = {
  name: safeNameSchema(),
  given_name: safeNameSchema(),
  family_name: safeNameSchema(),
  preferred_username: safeNameSchema(64),
  locale: z.string().max(35).regex(LOCALE_PATTERN, 'invalid-locale'),
  /**
   * An IANA time zone. The contract imports only zod, so it checks the shape
   * here; whether the zone exists (spelt exactly, capitals included) is
   * Clock's `isValidTimeZone`, on the server and in the details page.
   */
  zoneinfo: z.string().min(1, 'invalid-time-zone').max(64, 'invalid-time-zone').regex(/^\S+$/, 'invalid-time-zone'),
  email: z.string().trim().max(254).pipe(z.email('invalid-email')),
  phone_number: z.string().trim().regex(PHONE_NUMBER_PATTERN, 'invalid-phone-number'),
} as const satisfies Record<ProfileAttribute, z.ZodType<string>>

/**
 * A change to the record: a value sets an attribute, `null` removes it, and
 * an attribute left out is unchanged.
 */
export const profileChangesSchema = z.strictObject(
  Object.fromEntries(PROFILE_ATTRIBUTES.map(key => [key, attributeSchemas[key].nullable().optional()])) as {
    [K in ProfileAttribute]: z.ZodOptional<z.ZodNullable<(typeof attributeSchemas)[K]>>
  },
).refine(changes => Object.keys(changes).length > 0, 'no-changes')

export type ProfileChanges = z.input<typeof profileChangesSchema>

/** The record as held: every attribute optional, plus the OIDC verification claims. */
export const profileAttributesSchema = z.strictObject({
  ...Object.fromEntries(PROFILE_ATTRIBUTES.map(key => [key, z.string().optional()])) as { [K in ProfileAttribute]: z.ZodOptional<z.ZodString> },
  email_verified: z.boolean().optional(),
  phone_number_verified: z.boolean().optional(),
})

export type ProfileAttributes = z.infer<typeof profileAttributesSchema>

/** The verification claim that follows an attribute, if any. */
export const VERIFICATION_CLAIMS: Readonly<Partial<Record<ProfileAttribute, 'email_verified' | 'phone_number_verified'>>> = Object.freeze({
  email: 'email_verified',
  phone_number: 'phone_number_verified',
})
