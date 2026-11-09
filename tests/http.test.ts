import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { EventHandler, H3Event } from 'h3'
import { createApp, createRouter, defineEventHandler, getRequestHeader, toWebHandler } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DisclosureContext, ProfileDisclosureContextPort } from '../contracts'
import { DEFAULT_DISCLOSURE_SETTINGS, PROFILE_LOOKUP_RATE_LIMIT } from '../contracts'
import { runProfileMigrations } from '../server/database/migrations'
import { uuidv7 } from '../server/internal/crypto'
import { originRejected } from '../server/internal/http'
import {
  clearProfileComposition,
  provideProfileAccessDecision,
  provideProfileClock,
  provideProfileDatabase,
  provideProfileDisclosureContext,
  provideProfileKeyWrapper,
  provideProfileNotifier,
  provideProfileRequestCoordinator,
  provideProfileRequestParts,
  provideProfileSubjectResolver,
} from '../server/internal/composition'
import { listProfileLegalHolds, provisionProfileRecord, recordProfileDeparture, placeProfileLegalHold, profileLegalHoldParts, runProfileMaintenance, updateProfile } from '../server/utils/profile-server'
import { createLocalProfileKeyWrapper } from '../server/utils/profile-keys'
import { createTestDatabase, hasDatabase, requireDatabaseInCi } from './support/database'
import { toPosix } from './support/paths'

requireDatabaseInCi()

const API = fileURLToPath(new URL('../server/api/profile', import.meta.url))

/** Every endpoint file, routed as Nuxt routes it: `[param]` → `:param`, method from the suffix. */
function endpointFiles(directory: string = API): { file: string, method: string, route: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return endpointFiles(path)
    const match = /^(.*)\.(get|post|put|patch|delete)\.ts$/.exec(toPosix(relative(API, path)))
    if (!match) throw new Error(`Unexpected file in server/api/profile: ${entry.name}`)
    const route = `/api/profile/${match[1]!}`.replace(/\[(\w+)\]/g, ':$1').replace(/\/index$/, '')
    return [{ file: path, method: match[2]!, route }]
  })
}

describe.skipIf(!hasDatabase)('the /api/profile endpoints', () => {
  let pool: pg.Pool
  let drop: () => Promise<void>
  let handler: (request: Request) => Promise<Response>
  let resolverFails = false
  const relationships = new Map<string, DisclosureContext['subjects'][number]['relationship']>()
  const standings = new Map<string, DisclosureContext['subjects'][number]['standing']>()
  const membershipStates = new Map<string, 'active' | 'paused' | 'suspended'>()
  // Stand-ins for the host's adapters: the other members' exports, Authorisation, and the notifier.
  const administrators = new Set<string>()
  const decisions: { principalId: string, permission: string, groupId: string }[] = []
  const sent: { to: string, code: string, attribute: string, channel: string }[] = []
  let signInDown = false

  const disclosure: ProfileDisclosureContextPort = {
    async describe(request) {
      return {
        viewerId: request.viewerId,
        groupId: request.groupId,
        departurePolicy: null,
        subjects: request.subjectIds.map(subjectId => ({
          subjectId,
          relationship: subjectId === request.viewerId ? 'self' : relationships.get(subjectId) ?? 'none',
          standing: standings.get(subjectId) ?? 'visible',
          membershipInGroup: request.groupId && membershipStates.has(subjectId) ? { state: membershipStates.get(subjectId)! } : null,
        })),
        readAt: new Date().toISOString(),
      }
    },
  }

  async function call(method: string, path: string, options: { as?: string, body?: unknown, ageSeconds?: number } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.as) headers['x-test-principal'] = `${options.as}|${options.ageSeconds ?? 60}`
    const response = await handler(new Request(`http://profile.test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }))
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    return { status: response.status, data: json?.data ?? json, headers: response.headers }
  }

  async function person(): Promise<string> {
    const identityId = uuidv7()
    await provisionProfileRecord({ commandId: uuidv7(), correlationId: uuidv7(), subjectId: identityId })
    return identityId
  }

  beforeAll(async () => {
    const database = await createTestDatabase()
    drop = database.drop
    pool = new pg.Pool({ connectionString: database.url })
    await runProfileMigrations(pool, 'profile')
    const app = createApp()
    const router = createRouter()
    for (const endpoint of endpointFiles()) {
      const module = await import(endpoint.file) as { default: EventHandler }
      router[endpoint.method as 'get' | 'post' | 'put' | 'patch' | 'delete'](endpoint.route, module.default)
    }
    app.use(router)
    app.use(defineEventHandler(() => { throw new Error('no such route') }))
    handler = toWebHandler(app)
  })

  beforeEach(() => {
    clearProfileComposition()
    resolverFails = false
    signInDown = false
    relationships.clear()
    standings.clear()
    membershipStates.clear()
    administrators.clear()
    decisions.length = 0
    sent.length = 0
    // The host's parts, named by the host: Profile knows them only by this declaration.
    provideProfileRequestParts({
      parts: [
        { name: 'directory', coordinated: true, directory: true },
        { name: 'sign-in', coordinated: true, holdable: true },
        { name: 'permissions', coordinated: true, holdable: true },
        { name: 'settings', coordinated: true },
      ],
    })
    provideProfileRequestCoordinator({
      async exportPart({ identityId, part }) {
        if (part === 'sign-in' && signInDown) throw new Error('sign-in is down')
        return part === 'permissions' ? null : { part, identityId }
      },
    })
    provideProfileAccessDecision({
      async allows({ subject, permission, groupId }) {
        decisions.push({ principalId: subject.principalId, permission, groupId })
        return administrators.has(subject.principalId)
      },
    })
    provideProfileNotifier({ async send(message) { sent.push({ to: message.to, code: message.code, attribute: message.attribute, channel: message.channel }) } })
    provideProfileDatabase({ dialect: 'postgres', pool })
    provideProfileKeyWrapper(createLocalProfileKeyWrapper({ keys: { v1: Buffer.alloc(32, 3).toString('base64') }, current: 'v1' }))
    provideProfileDisclosureContext(disclosure)
    provideProfileSubjectResolver({
      async resolve(event) {
        if (resolverFails) throw new Error('sign-in is down')
        const header = getRequestHeader(event as H3Event, 'x-test-principal')
        if (!header) return null
        const [principalId, age] = header.split('|')
        return { principalId: principalId!, authenticatedAt: new Date(Date.now() - Number(age) * 1000).toISOString(), assurance: { level: 'aal2', phishingResistant: true } }
      },
    })
  })

  afterAll(async () => {
    clearProfileComposition()
    await pool?.end()
    await drop?.()
  })

  it('mounts every endpoint file under the route Nuxt would give it, and offers no erasure', () => {
    const routes = endpointFiles().map(endpoint => `${endpoint.method.toUpperCase()} ${endpoint.route}`).sort()
    expect(routes).toEqual([
      'GET /api/profile/me',
      'GET /api/profile/me/departures',
      'GET /api/profile/me/export',
      'GET /api/profile/me/requests',
      'GET /api/profile/me/requests/:requestId/archive',
      'GET /api/profile/people/:subjectId',
      'PATCH /api/profile/me',
      'POST /api/profile/display-names',
      'POST /api/profile/me/departures/:groupId/anonymise',
      'POST /api/profile/me/requests',
      'POST /api/profile/me/verification/:attribute/confirm',
      'POST /api/profile/me/verification/:attribute/send',
      'PUT /api/profile/me/disclosure',
    ])
  })

  it('answers unauthenticated without a subject, and unavailable when the resolver or a port fails', async () => {
    expect(await call('GET', '/api/profile/me')).toMatchObject({ status: 401, data: { code: 'unauthenticated', messageKey: 'profile.error.unauthenticated' } })
    const me = uuidv7()
    resolverFails = true
    expect(await call('GET', '/api/profile/me', { as: me })).toMatchObject({ status: 503, data: { code: 'unavailable' } })
    resolverFails = false
    clearProfileComposition()
    provideProfileSubjectResolver({ resolve: async () => ({ principalId: me, authenticatedAt: new Date().toISOString(), assurance: { level: 'aal1', phishingResistant: false } }) })
    expect(await call('GET', '/api/profile/me', { as: me })).toMatchObject({ status: 503, data: { code: 'unavailable' } })
  })

  it('lets the person read and change their own profile, refusing a stale version', async () => {
    const me = await person()
    const first = await call('GET', '/api/profile/me', { as: me })
    expect(first).toMatchObject({ status: 200, data: { attributes: {}, settings: DEFAULT_DISCLOSURE_SETTINGS, version: 1 } })

    const changed = await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { name: 'Ada Lovelace', locale: 'en-GB' } } })
    expect(changed).toMatchObject({ status: 200, data: { attributes: { name: 'Ada Lovelace', locale: 'en-GB' }, version: 2 } })

    // Another tab still holds version 1.
    const stale = await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { name: 'Someone Else' } } })
    expect(stale).toMatchObject({ status: 409, data: { code: 'conflict', reason: 'version-changed' } })
    expect((await call('GET', '/api/profile/me', { as: me })).data.attributes.name).toBe('Ada Lovelace')

    const settings = { ...DEFAULT_DISCLOSURE_SETTINGS, audiences: { ...DEFAULT_DISCLOSURE_SETTINGS.audiences, locale: 'group' } }
    expect(await call('PUT', '/api/profile/me/disclosure', { as: me, body: { expectedVersion: 2, settings } })).toMatchObject({ status: 200, data: { version: 3, settings } })
    expect(await call('PUT', '/api/profile/me/disclosure', { as: me, body: { expectedVersion: 2, settings } })).toMatchObject({ status: 409 })
  })

  it('needs a recent sign-in to change a contact detail, but not a name', async () => {
    const me = await person()
    const old = 20 * 60
    expect(await call('PATCH', '/api/profile/me', { as: me, ageSeconds: old, body: { expectedVersion: 1, changes: { email: 'ada@example.com' } } }))
      .toMatchObject({ status: 403, data: { code: 'insufficient-assurance', messageKey: 'profile.error.insufficient-assurance' } })
    expect(await call('PATCH', '/api/profile/me', { as: me, ageSeconds: old, body: { expectedVersion: 1, changes: { phone_number: null } } }))
      .toMatchObject({ status: 403, data: { code: 'insufficient-assurance' } })
    expect(await call('PATCH', '/api/profile/me', { as: me, ageSeconds: old, body: { expectedVersion: 1, changes: { name: 'Ada' } } })).toMatchObject({ status: 200 })
    expect(await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 2, changes: { email: 'ada@example.com' } } }))
      .toMatchObject({ status: 200, data: { attributes: { email: 'ada@example.com', email_verified: false } } })
  })

  it('needs a recent sign-in to export, and never lets the export be cached', async () => {
    const me = await person()
    await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { name: 'Ada Lovelace' } } })
    expect(await call('GET', '/api/profile/me/export', { as: me, ageSeconds: 20 * 60 })).toMatchObject({ status: 403, data: { code: 'insufficient-assurance' } })
    const exported = await call('GET', '/api/profile/me/export', { as: me })
    expect(exported).toMatchObject({ status: 200, data: { attributes: { name: 'Ada Lovelace' }, departures: [] } })
    expect(exported.headers.get('cache-control')).toBe('no-store')
  })

  it('validates bodies strictly, answering problem codes only, never values', async () => {
    const me = await person()
    const bad = await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { email: 'not an address' } } })
    expect(bad).toMatchObject({ status: 400, data: { code: 'validation-failed', reason: 'invalid-email' } })
    expect(JSON.stringify(bad.data)).not.toContain('not an address')
    expect(await call('PATCH', '/api/profile/me', { as: me, body: { changes: { name: 'Ada' } } })).toMatchObject({ status: 400 })
    expect(await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { name: 'Ada' }, subjectId: uuidv7() } })).toMatchObject({ status: 400 })
    expect(await call('POST', '/api/profile/me/departures/not-a-group/anonymise', { as: me })).toMatchObject({ status: 400 })
  })

  it('takes the person only from the signed-in subject: no endpoint acts on someone else', async () => {
    const ada = await person()
    const mallory = await person()
    await call('PATCH', '/api/profile/me', { as: ada, body: { expectedVersion: 1, changes: { name: 'Ada Lovelace', email: 'ada@example.com' } } })
    expect((await call('GET', '/api/profile/me', { as: mallory })).data.attributes).toEqual({})
  })

  it('shows other people only as disclosure allows, the same for unknown people', async () => {
    const viewer = await person()
    const ada = await person()
    await call('PATCH', '/api/profile/me', { as: ada, body: { expectedVersion: 1, changes: { name: 'Ada Lovelace', email: 'ada@example.com' } } })
    relationships.set(ada, 'same-group')
    expect(await call('GET', `/api/profile/people/${ada}`, { as: viewer })).toMatchObject({
      status: 200,
      data: { subjectId: ada, displayName: { kind: 'name', value: 'Ada Lovelace' }, attributes: { name: 'Ada Lovelace' } },
    })
    const names = await call('POST', '/api/profile/display-names', { as: viewer, body: { subjectIds: [ada], purpose: 'attribution' } })
    expect(names).toMatchObject({ status: 200, data: [{ subjectId: ada, displayName: { kind: 'name', value: 'Ada Lovelace' } }] })

    relationships.set(ada, 'none')
    const stranger = uuidv7()
    const hidden = await call('GET', `/api/profile/people/${ada}`, { as: viewer })
    const unknown = await call('GET', `/api/profile/people/${stranger}`, { as: viewer })
    expect(hidden.data).toEqual({ subjectId: ada, displayName: { kind: 'hidden' }, attributes: {} })
    expect(unknown.data).toEqual({ subjectId: stranger, displayName: { kind: 'hidden' }, attributes: {} })
  })

  it('anonymises the person\'s own departure from a group', async () => {
    const me = await person()
    const groupId = uuidv7()
    expect(await call('POST', `/api/profile/me/departures/${groupId}/anonymise`, { as: me })).toEqual(expect.objectContaining({ status: 200, data: { groupId, status: 'anonymised' } }))
  })

  it('lists the groups the person has left, for the page to choose anonymity in one', async () => {
    const me = await person()
    const left = uuidv7()
    await recordProfileDeparture({ commandId: uuidv7(), correlationId: uuidv7(), subjectId: me, groupId: left, endedAt: new Date().toISOString() })
    const before = await call('GET', '/api/profile/me/departures', { as: me })
    expect(before).toMatchObject({ status: 200, data: { departures: [{ groupId: left, anonymised: false }] } })
    expect(before.headers.get('cache-control')).toBe('no-store')
    await call('POST', `/api/profile/me/departures/${left}/anonymise`, { as: me })
    expect((await call('GET', '/api/profile/me/departures', { as: me })).data.departures).toEqual([expect.objectContaining({ groupId: left, anonymised: true })])
    expect((await call('GET', '/api/profile/me/departures', { as: await person() })).data.departures).toEqual([])
  })

  it('answers an access request from every coordinated part, as an archive only the person can download, after a recent sign-in', async () => {
    const me = await person()
    await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { name: 'Ada Lovelace' } } })
    expect(await call('POST', '/api/profile/me/requests', { as: me, ageSeconds: 20 * 60, body: { type: 'access' } })).toMatchObject({ status: 403, data: { code: 'insufficient-assurance' } })
    expect(await call('POST', '/api/profile/me/requests', { as: me, body: { type: 'erasure' } })).toMatchObject({ status: 400 })

    const opened = await call('POST', '/api/profile/me/requests', { as: me, body: { type: 'access' } })
    expect(opened).toMatchObject({ status: 201, data: { type: 'access', origin: 'person', status: 'completed' } })
    expect(opened.data.parts.map((part: { part: string, status: string }) => `${part.part}:${part.status}`)).toEqual(['profile:done', 'directory:done', 'sign-in:done', 'permissions:done', 'settings:done'])
    const { requestId } = opened.data

    const archive = await call('GET', `/api/profile/me/requests/${requestId}/archive`, { as: me })
    expect(archive).toMatchObject({ status: 200, data: { requestId, subjectId: me, parts: { profile: { attributes: { name: 'Ada Lovelace' } }, directory: { part: 'directory', identityId: me }, permissions: null, settings: { part: 'settings', identityId: me } } } })
    expect(archive.headers.get('cache-control')).toBe('no-store')
    expect(await call('GET', `/api/profile/me/requests/${requestId}/archive`, { as: me, ageSeconds: 20 * 60 })).toMatchObject({ status: 403, data: { code: 'insufficient-assurance' } })
    expect(await call('GET', `/api/profile/me/requests/${requestId}/archive`, { as: await person() })).toMatchObject({ status: 403, data: { code: 'forbidden' } })
    expect((await call('GET', '/api/profile/me/requests', { as: me })).data.requests).toEqual([expect.objectContaining({ requestId, archiveUntil: expect.any(String) })])
  })

  it('keeps an access request open while a coordinated part fails, never completing it partially', async () => {
    const me = await person()
    signInDown = true
    const opened = await call('POST', '/api/profile/me/requests', { as: me, body: { type: 'access' } })
    expect(opened.data).toMatchObject({ status: 'open', archiveUntil: null })
    expect(opened.data.parts.find((part: { part: string }) => part.part === 'sign-in').status).toBe('pending')
    expect(await call('GET', `/api/profile/me/requests/${opened.data.requestId}/archive`, { as: me })).toMatchObject({ status: 403 })
  })

  it('restricts every detail to the person on a restriction request', async () => {
    const me = await person()
    const opened = await call('POST', '/api/profile/me/requests', { as: me, body: { type: 'restriction' } })
    expect(opened.data).toMatchObject({ type: 'restriction', status: 'completed' })
    const own = await call('GET', '/api/profile/me', { as: me })
    expect(Object.values(own.data.settings.audiences)).toEqual(Object.values(own.data.settings.audiences).map(() => 'nobody'))
  })

  it('verifies a contact detail with a code sent through the notifier, until the detail changes', async () => {
    const me = await person()
    await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { email: 'ada@example.com' } } })
    expect(await call('POST', '/api/profile/me/verification/phone_number/send', { as: me })).toMatchObject({ status: 400, data: { reason: 'nothing-to-verify' } })
    expect(await call('POST', '/api/profile/me/verification/name/send', { as: me })).toMatchObject({ status: 400 })
    expect(await call('POST', '/api/profile/me/verification/email/send', { as: me, ageSeconds: 20 * 60 })).toMatchObject({ status: 403, data: { code: 'insufficient-assurance' } })

    expect(await call('POST', '/api/profile/me/verification/email/send', { as: me })).toMatchObject({ status: 200, data: { attribute: 'email', status: 'sent' } })
    expect(sent).toEqual([{ to: 'ada@example.com', code: expect.stringMatching(/^[0-9]{6}$/), attribute: 'email', channel: 'email' }])
    const code = sent[0]!.code
    const wrong = code === '000000' ? '000001' : '000000'
    expect(await call('POST', '/api/profile/me/verification/email/confirm', { as: me, body: { code: wrong } })).toMatchObject({ status: 400, data: { reason: 'wrong-code' } })
    const verified = await call('POST', '/api/profile/me/verification/email/confirm', { as: me, body: { code } })
    expect(verified).toMatchObject({ status: 200, data: { attributes: { email: 'ada@example.com', email_verified: true } } })
    expect(await call('POST', '/api/profile/me/verification/email/confirm', { as: me, body: { code } })).toMatchObject({ status: 409, data: { reason: 'code-expired' } })
    expect(await call('POST', '/api/profile/me/verification/email/send', { as: me })).toMatchObject({ status: 200, data: { status: 'verified' } })

    const changed = await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: verified.data.version, changes: { email: 'lovelace@example.com' } } })
    expect(changed.data.attributes).toMatchObject({ email: 'lovelace@example.com', email_verified: false })
  })

  it('spends a code after too many wrong attempts, and limits how many codes are sent', async () => {
    const me = await person()
    await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { phone_number: '+447700900123' } } })
    await call('POST', '/api/profile/me/verification/phone_number/send', { as: me })
    const code = sent.at(-1)!.code
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 5; i += 1) await call('POST', '/api/profile/me/verification/phone_number/confirm', { as: me, body: { code: wrong } })
    expect(await call('POST', '/api/profile/me/verification/phone_number/confirm', { as: me, body: { code } })).toMatchObject({ status: 409, data: { reason: 'code-expired' } })
    for (let i = 0; i < 4; i += 1) expect((await call('POST', '/api/profile/me/verification/phone_number/send', { as: me })).status).toBe(200)
    expect(await call('POST', '/api/profile/me/verification/phone_number/send', { as: me })).toMatchObject({ status: 429, data: { code: 'rate-limited' } })
    expect(sent.every(message => message.channel === 'sms' && message.to === '+447700900123')).toBe(true)
  })

  it('names a suspended member to the group\'s administrators only, by display name only, asking Authorisation once', async () => {
    const admin = await person()
    const member = await person()
    const suspended = await person()
    const groupId = uuidv7()
    await call('PATCH', '/api/profile/me', { as: suspended, body: { expectedVersion: 1, changes: { name: 'Sam Suspended', email: 'sam@example.com' } } })
    await call('PUT', '/api/profile/me/disclosure', { as: suspended, body: { expectedVersion: 2, settings: { ...DEFAULT_DISCLOSURE_SETTINGS, audiences: { ...DEFAULT_DISCLOSURE_SETTINGS.audiences, email: 'group' } } } })
    relationships.set(suspended, 'same-group')
    membershipStates.set(suspended, 'suspended')
    administrators.add(admin)
    const body = { subjectIds: [suspended], groupId, purpose: 'administration' }

    expect((await call('POST', '/api/profile/display-names', { as: admin, body })).data).toEqual([{ subjectId: suspended, displayName: { kind: 'name', value: 'Sam Suspended' } }])
    expect(decisions).toEqual([{ principalId: admin, permission: 'profile.suspended-people:view', groupId }])
    expect((await call('POST', '/api/profile/display-names', { as: member, body })).data).toEqual([{ subjectId: suspended, displayName: { kind: 'hidden' } }])
    // A listing, the person page and anyone else never show them.
    expect((await call('POST', '/api/profile/display-names', { as: admin, body: { ...body, purpose: 'listing' } })).data[0].displayName).toEqual({ kind: 'hidden' })
    expect((await call('GET', `/api/profile/people/${suspended}?groupId=${groupId}`, { as: admin })).data).toEqual({ subjectId: suspended, displayName: { kind: 'hidden' }, attributes: {} })
    expect(await call('POST', '/api/profile/display-names', { as: admin, body: { subjectIds: [suspended], purpose: 'administration' } })).toMatchObject({ status: 400 })

    // Nobody suspended in the answer: Authorisation is not asked.
    decisions.length = 0
    membershipStates.delete(suspended)
    expect((await call('POST', '/api/profile/display-names', { as: member, body })).data[0].displayName).toEqual({ kind: 'name', value: 'Sam Suspended' })
    expect(decisions).toEqual([])
  })

  it('limits each viewer\'s lookups per window, and no one else\'s', async () => {
    const viewer = await person()
    const other = await person()
    const body = { subjectIds: [uuidv7()], purpose: 'listing' }
    for (let i = 0; i < PROFILE_LOOKUP_RATE_LIMIT.requests; i += 1) {
      const answer = await call('POST', '/api/profile/display-names', { as: viewer, body })
      if (answer.status !== 200) throw new Error(`lookup ${i} answered ${answer.status}`)
    }
    expect(await call('POST', '/api/profile/display-names', { as: viewer, body })).toMatchObject({ status: 429, data: { code: 'rate-limited' } })
    expect(await call('GET', `/api/profile/people/${other}`, { as: viewer })).toMatchObject({ status: 429 })
    expect(await call('POST', '/api/profile/display-names', { as: other, body })).toMatchObject({ status: 200 })
  })

  describe('the clock', () => {
    const MINUTE = 60_000

    it('takes every time from the supplied clock: holds end, codes expire and sign-ins age by it', async () => {
      let offset = 0
      provideProfileClock({ now: () => new Date(Date.now() + offset).toISOString() })
      const me = await person()
      const hold = await placeProfileLegalHold({ identityId: me, parts: ['permissions'], reasonCode: 'litigation', endsAt: new Date(Date.now() + 60 * MINUTE).toISOString(), correlationId: uuidv7() })
      await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { email: 'ada@example.com' } } })
      expect(await call('POST', '/api/profile/me/verification/email/send', { as: me })).toMatchObject({ status: 200, data: { status: 'sent' } })
      const code = sent.at(-1)!.code

      // Eleven minutes later by the clock (not by the system's): the code has expired, and the sign-in is no longer recent.
      offset = 11 * MINUTE
      expect(await call('POST', '/api/profile/me/verification/email/confirm', { as: me, body: { code } })).toMatchObject({ status: 409, data: { reason: 'code-expired' } })
      offset = 16 * MINUTE
      expect(await call('GET', '/api/profile/me/export', { as: me })).toMatchObject({ status: 403, data: { code: 'insufficient-assurance' } })
      expect(await profileLegalHoldParts(me)).toEqual(['permissions'])

      // Past the hold's end by the clock: maintenance ends it, and the times written are the clock's.
      offset = 61 * MINUTE
      expect(await profileLegalHoldParts(me)).toEqual([])
      const before = Date.now() + offset
      expect((await runProfileMaintenance()).holdsEnded).toBeGreaterThanOrEqual(1)
      const [ended] = await listProfileLegalHolds({ identityId: me })
      expect(ended).toMatchObject({ holdId: hold.holdId, endedAt: expect.any(String) })
      expect(Date.parse(ended!.endedAt!)).toBeGreaterThanOrEqual(before)
      const { rows } = await pool.query(`select "event" from "profile"."outbox" where "event"->>'type' = 'profile.legal-hold-ended' and "event"->'data'->>'holdId' = $1`, [hold.holdId])
      expect(Date.parse(rows[0].event.occurredAt)).toBeGreaterThanOrEqual(before)
    })

    it('fails closed when the clock answers an invalid time or fails, never falling back to another time', async () => {
      const me = await person()
      for (const now of [() => 'not a time', () => '2026-10-10T00:00:00' as string, () => new Date() as unknown as string, () => { throw new Error('clock down') }]) {
        provideProfileClock({ now })
        await expect(updateProfile({ subjectId: me, changes: { name: 'Ada' }, correlationId: uuidv7() })).rejects.toMatchObject({ name: 'ProfileFailure', code: 'unavailable' })
        await expect(runProfileMaintenance()).rejects.toMatchObject({ code: 'unavailable' })
        expect(await call('PATCH', '/api/profile/me', { as: me, body: { expectedVersion: 1, changes: { name: 'Ada' } } })).toMatchObject({ status: 503, data: { code: 'unavailable' } })
        expect(await call('GET', '/api/profile/me/export', { as: me })).toMatchObject({ status: 503, data: { code: 'unavailable' } })
      }
      // Nothing was written under the bad clock.
      const { rows } = await pool.query(`select "version" from "profile"."record" where "identity_id" = $1`, [me])
      expect(rows).toEqual([{ version: 1 }])
    })
  })

  it('refuses state-changing requests from another origin, or with none configured', () => {
    const event = (method: string, path: string, origin?: string) => ({
      method,
      path,
      node: { req: { url: path, method, headers: { host: 'profile.test', ...(origin ? { origin } : {}) } } },
    }) as unknown as H3Event
    expect(originRejected(event('PATCH', '/api/profile/me', 'https://evil.test'), 'https://profile.test')).toBe(true)
    expect(originRejected(event('PATCH', '/api/profile/me', 'https://profile.test'), 'https://profile.test')).toBe(false)
    expect(originRejected(event('PATCH', '/api/profile/me'), 'https://profile.test')).toBe(true)
    expect(originRejected(event('PATCH', '/api/profile/me', 'https://profile.test'), '')).toBe(true)
    expect(originRejected(event('GET', '/api/profile/me'), '')).toBe(false)
    expect(originRejected(event('POST', '/api/elsewhere', 'https://evil.test'), 'https://profile.test')).toBe(false)
  })
})
