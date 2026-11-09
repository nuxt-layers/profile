import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toPosix } from './support/paths'
import * as contracts from '../contracts'

const root = normalize(join(import.meta.dirname, '..'))

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => toPosix(join(dir, file)))
}

function imports(file: string): string[] {
  const source = readFileSync(join(root, file), 'utf8')
  return [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(([, specifier]) =>
    specifier!.startsWith('.') ? toPosix(relative(root, join(root, dirname(file), specifier!))) : specifier!)
}

const contractFiles = [...files('contracts'), ...files('shared')]

describe('Profile public contract', () => {
  it('imports nothing but zod and its own modules', () => {
    for (const file of contractFiles) {
      for (const target of imports(file)) {
        expect(target === 'zod' || /^(contracts|shared)\//.test(target), `${file} imports ${target}`).toBe(true)
      }
    }
  })

  it('never names a driver, key service or other capability\'s package', () => {
    const forbidden = /^pg$|kysely|drizzle|@aws-sdk|@google-cloud|@azure|^@nuxt-layers\/|^node:|^#|^h3$|^vue$|^nuxt/
    for (const file of contractFiles) {
      for (const target of imports(file)) expect(forbidden.test(target), `${file} imports ${target}`).toBe(false)
    }
  })

  it('names the record\'s attributes as OpenID Connect standard claims', () => {
    expect(contracts.PROFILE_ATTRIBUTES).toEqual(['name', 'given_name', 'family_name', 'preferred_username', 'locale', 'zoneinfo', 'email', 'phone_number'])
  })

  it('discloses the name to fellow group members by default, and nothing else to anyone', () => {
    const { audiences } = contracts.DEFAULT_DISCLOSURE_SETTINGS
    expect(audiences.name).toBe('group')
    for (const key of contracts.PROFILE_ATTRIBUTES) if (key !== 'name') expect(audiences[key]).toBe('nobody')
    expect(contracts.DEFAULT_DISCLOSURE_SETTINGS.displayName).toBe('name')
    expect(contracts.DEFAULT_DISCLOSURE_SETTINGS.anonymiseOnDeparture).toBe(false)
  })

  it('carries no attribute value in any event: identifiers, attribute names and codes only', () => {
    const at = '2026-10-09T12:00:00.000Z'
    const ids = { eventId: '01928c4e-0000-7000-8000-000000000001', occurredAt: at, correlationId: '01928c4e-0000-7000-8000-0000000000aa' }
    const identityId = '01928c4e-0000-7000-8000-000000000002'
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.changed', data: { identityId, attributes: ['name'], disclosure: false } }).success).toBe(true)
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.changed', data: { identityId, attributes: ['name'], disclosure: false, name: 'Ada' } }).success).toBe(false)
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.anonymised', data: { identityId: 'ada@example.com', reasonCode: 'identity-closed' } }).success).toBe(false)
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.anonymised', data: { identityId, reasonCode: 'Ada Lovelace' } }).success).toBe(false)
  })

  it('keeps errors coarse', () => {
    expect(contracts.PROFILE_ERROR_CODES).toEqual(['unauthenticated', 'forbidden', 'insufficient-assurance', 'validation-failed', 'conflict', 'rate-limited', 'unavailable'])
    expect(contracts.PROFILE_ERROR_STATUS).toMatchObject({ 'forbidden': 403, 'insufficient-assurance': 403, 'conflict': 409, 'rate-limited': 429 })
    expect(new contracts.ProfileFailure('forbidden').code).toBe('forbidden')
  })
})

describe('HTTP contract', () => {
  it('needs a recent sign-in for contact details and export, and takes the subject only from the resolver', () => {
    expect(contracts.PROFILE_STEP_UP_SECONDS).toBe(900)
    expect(contracts.STEP_UP_ATTRIBUTES).toEqual(['email', 'phone_number'])
    const body = { expectedVersion: 1, changes: { name: 'Ada' } }
    expect(contracts.updateProfileRequestSchema.safeParse(body).success).toBe(true)
    expect(contracts.updateProfileRequestSchema.safeParse({ ...body, subjectId: '01928c4e-0000-7000-8000-000000000001' }).success).toBe(false)
    expect(contracts.updateProfileRequestSchema.safeParse({ changes: body.changes }).success).toBe(false)
  })

  it('limits display-name lookups to 200 people a request', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `01928c4e-0000-7000-8000-${String(i).padStart(12, '0')}`)
    expect(contracts.displayNamesRequestSchema.safeParse({ subjectIds: ids(200), purpose: 'listing' }).success).toBe(true)
    expect(contracts.displayNamesRequestSchema.safeParse({ subjectIds: ids(201), purpose: 'listing' }).success).toBe(false)
    expect(contracts.displayNamesRequestSchema.safeParse({ subjectIds: ids(1), purpose: 'everything' }).success).toBe(false)
  })
})

describe('Attributes', () => {
  const changes = (value: Record<string, unknown>) => contracts.profileChangesSchema.safeParse(value)

  it('normalises names and refuses unsafe ones', () => {
    expect(changes({ name: '  Ada   Lovelace ' })).toMatchObject({ success: true, data: { name: 'Ada Lovelace' } })
    expect(changes({ name: 'Ada‮Lovelace' }).success).toBe(false)
    expect(changes({ name: 'Аda' }).success).toBe(false)
    expect(changes({ given_name: '' }).success).toBe(false)
    expect(changes({ preferred_username: 'a'.repeat(65) }).success).toBe(false)
  })

  it('accepts a BCP 47 locale, an IANA time zone, an email address and an E.164 number', () => {
    expect(changes({ locale: 'en-GB', zoneinfo: 'Europe/London', email: 'ada@example.com', phone_number: '+447700900123' }).success).toBe(true)
    expect(changes({ locale: 'english' }).success).toBe(false)
    expect(changes({ zoneinfo: 'Mars/Olympus' }).success).toBe(false)
    expect(changes({ email: 'not an address' }).success).toBe(false)
    expect(changes({ phone_number: '07700 900123' }).success).toBe(false)
  })

  it('removes with null, and refuses an empty change or an unknown attribute', () => {
    expect(changes({ email: null }).success).toBe(true)
    expect(changes({}).success).toBe(false)
    expect(changes({ picture: 'https://example.com/a.png' }).success).toBe(false)
    expect(changes({ email_verified: true }).success).toBe(false)
  })

  it('holds a contact detail as verified only through verification: never set by a change', () => {
    expect(contracts.profileAttributesSchema.safeParse({ email: 'ada@example.com', email_verified: true }).success).toBe(true)
    expect(contracts.profileAttributesSchema.safeParse({ email: 'ada@example.com', email_verified: false }).success).toBe(true)
    expect(changes({ phone_number_verified: true }).success).toBe(false)
    expect(contracts.VERIFIABLE_ATTRIBUTES).toEqual(['email', 'phone_number'])
    expect(contracts.PROFILE_VERIFICATION_POLICY).toMatchObject({ codeDigits: 6, codeSeconds: 600, attempts: 5, sends: 5 })
  })

  it('names Profile\'s one permission at high risk, so no wildcard reaches it', () => {
    expect(contracts.PROFILE_PERMISSIONS).toEqual([{ name: 'profile.suspended-people:view', description: expect.any(String), risk: 'high', effect: 'view' }])
  })

  it('records requests and holds by identifiers, codes and times only', () => {
    const at = '2026-10-09T12:00:00.000Z'
    const ids = { eventId: '01928c4e-0000-7000-8000-000000000001', occurredAt: at, correlationId: '01928c4e-0000-7000-8000-0000000000aa' }
    const identityId = '01928c4e-0000-7000-8000-000000000002'
    const requestId = '01928c4e-0000-7000-8000-000000000003'
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.request-opened', data: { requestId, identityId, type: 'access', origin: 'person', parts: ['profile'], dueAt: at } }).success).toBe(true)
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.request-escalated', data: { requestId, identityId, reasonCode: 'Ada asked twice' } }).success).toBe(false)
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.legal-hold-ended', data: { holdId: requestId, identityId, parts: ['profile'], released: ['profile'], identityClosed: true, reasonCode: 'expired' } }).success).toBe(true)
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.contact-verified', data: { identityId, attribute: 'email', value: 'ada@example.com' } }).success).toBe(false)
    // Parts are the host's names: any part name in the code grammar, never free text.
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.request-opened', data: { requestId, identityId, type: 'erasure', origin: 'operator', parts: ['profile', 'sign-in'], dueAt: at } }).success).toBe(true)
    expect(contracts.profileEventSchema.safeParse({ ...ids, type: 'profile.request-opened', data: { requestId, identityId, type: 'erasure', origin: 'operator', parts: ['Sign in'], dueAt: at } }).success).toBe(false)
  })

  it('knows its own part only; the host declares the others, checked at composition', () => {
    expect(contracts.PROFILE_REQUEST_PART).toBe('profile')
    const alone = contracts.resolveProfileRequestParts()
    expect(alone).toEqual({ all: ['profile'], coordinated: [], holdable: ['profile'], directory: null, defaults: { access: ['profile'], correction: ['profile'], erasure: ['profile'], restriction: ['profile'] } })
    const declared = contracts.resolveProfileRequestParts({
      parts: [{ name: 'directory', coordinated: true, directory: true }, { name: 'sign-in', coordinated: true, holdable: true }, { name: 'settings' }],
      defaults: { erasure: ['sign-in', 'directory'] },
    })
    expect(declared).toEqual({
      all: ['profile', 'directory', 'sign-in', 'settings'],
      coordinated: ['directory', 'sign-in'],
      holdable: ['profile', 'sign-in'],
      directory: 'directory',
      defaults: { access: ['profile', 'directory', 'sign-in'], correction: ['profile'], erasure: ['profile', 'directory', 'sign-in'], restriction: ['profile'] },
    })
    for (const bad of [
      { parts: [{ name: 'profile' }] },
      { parts: [{ name: 'Sign In' }] },
      { parts: [{ name: 'a' }, { name: 'a' }] },
      { parts: [{ name: 'a', directory: true }, { name: 'b', directory: true }] },
      { parts: [{ name: 'a' }], defaults: { access: ['b'] } },
      { parts: [{ name: 'a', kind: 'x' }] },
      { parts: Array.from({ length: 16 }, (_, i) => ({ name: `p${i}` })) },
    ]) expect(() => contracts.resolveProfileRequestParts(bad as never), JSON.stringify(bad)).toThrow(TypeError)
  })

  it('takes the host\'s directory changes as its own strict, idempotent commands', () => {
    const command = { commandId: '01928c4e-0000-7000-8000-000000000001', correlationId: '01928c4e-0000-7000-8000-0000000000aa' }
    const subjectId = '01928c4e-0000-7000-8000-000000000002'
    expect(contracts.provisionCommandSchema.safeParse({ ...command, subjectId }).success).toBe(true)
    expect(contracts.provisionCommandSchema.safeParse({ ...command, subjectId, kind: 'person' }).success).toBe(false)
    expect(contracts.provisionCommandSchema.safeParse({ subjectId, correlationId: command.correlationId }).success).toBe(false)
    expect(contracts.departureCommandSchema.safeParse({ ...command, subjectId, groupId: subjectId, endedAt: '2026-10-09T12:00:00.000Z' }).success).toBe(true)
    expect(contracts.groupRenamedCommandSchema.safeParse({ ...command, groupId: 'not-an-id' }).success).toBe(false)
  })

  it('names no other capability in its exports or in its ports\' and subject\'s types', () => {
    for (const name of Object.keys(contracts)) expect(name, name).not.toMatch(/identity|authenticat|authoris|integration/i)
    const restated = ['shared/ports.ts', 'shared/disclosure.ts', 'shared/api.ts', 'shared/permissions.ts', 'shared/requests.ts', 'shared/events.ts', 'shared/commands.ts', 'shared/identifiers.ts', 'shared/errors.ts']
    for (const file of restated) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/\bIdentity\b|Identity's|\bAuthentication\b|\bAuthorisation\b|iam-integration|configuration layer/)
    }
  })

  it('dates a request a calendar month on, or to the month\'s last day', () => {
    expect(contracts.requestDueAt(new Date('2026-10-10T08:00:00.000Z')).toISOString()).toBe('2026-11-10T08:00:00.000Z')
    expect(contracts.requestDueAt(new Date('2027-01-31T08:00:00.000Z')).toISOString()).toBe('2027-02-28T08:00:00.000Z')
    expect(contracts.requestDueAt(new Date('2026-12-15T00:00:00.000Z')).toISOString()).toBe('2027-01-15T00:00:00.000Z')
  })
})
