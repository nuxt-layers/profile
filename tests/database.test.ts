import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DisclosureContext, ProfileDisclosureContextPort, ProfileEvent, ProfileKeyWrapper } from '../contracts'
import { DEFAULT_DISCLOSURE_SETTINGS, ProfileFailure, resolveProfileRequestParts } from '../contracts'
import { PROFILE_MIGRATIONS, runProfileMigrations } from '../server/database/migrations'
import { aad, open, uuidv7 } from '../server/internal/crypto'
import { createService } from '../server/internal/service'
import { createLocalProfileKeyWrapper } from '../server/utils/profile-keys'
import { createTestDatabase, hasDatabase, requireDatabaseInCi } from './support/database'

requireDatabaseInCi()

const master = (fill: number) => Buffer.alloc(32, fill).toString('base64')
const correlationId = () => uuidv7()

type Subject = DisclosureContext['subjects'][number]

describe.skipIf(!hasDatabase)('Profile storage on PostgreSQL', () => {
  let admin: pg.Pool
  let runtime: pg.Pool
  let drop: () => Promise<void>
  const role = `profile_runtime_${randomBytes(4).toString('hex')}`

  // A stand-in for the host's disclosure-context port: relationships and standings set per test.
  const relationships = new Map<string, Omit<Subject, 'subjectId'>>()
  let departurePolicy: DisclosureContext['departurePolicy'] = null
  let failing: 'reject' | 'malformed' | null = null
  const disclosure: ProfileDisclosureContextPort = {
    async describe(request, options) {
      expect(options.consistency).toBe('bounded')
      if (failing === 'reject') throw new Error('directory down')
      if (failing === 'malformed') return { viewerId: request.viewerId, subjects: 'oops' } as never
      return {
        viewerId: request.viewerId,
        groupId: request.groupId,
        departurePolicy: request.groupId ? departurePolicy : null,
        subjects: request.subjectIds.map(subjectId => subjectId === request.viewerId
          ? { subjectId, relationship: 'self', standing: 'visible' }
          : { subjectId, ...(relationships.get(subjectId) ?? { relationship: 'none', standing: 'visible' }) }),
        readAt: new Date().toISOString(),
      }
    },
  }

  let keys: ProfileKeyWrapper = createLocalProfileKeyWrapper({ keys: { v1: master(1) }, current: 'v1' })
  // The host's parts beside Profile's own: named by the host, unknown to Profile but by this declaration.
  const hostParts = resolveProfileRequestParts({
    parts: [
      { name: 'directory', coordinated: true, directory: true },
      { name: 'sign-in', coordinated: true, holdable: true },
      { name: 'permissions', coordinated: true, holdable: true },
      { name: 'settings', coordinated: true },
    ],
    defaults: { erasure: ['directory', 'sign-in', 'permissions'] },
  })
  const base = () => ({ pool: runtime, schema: 'profile', keys, disclosure: () => disclosure, requestParts: () => hostParts })
  const service = () => createService(base())

  const ids = { viewer: uuidv7(), ada: uuidv7(), grace: uuidv7(), group: uuidv7(), other: uuidv7() }
  const command = () => ({ commandId: uuidv7(), correlationId: correlationId() })
  const provision = (subjectId: string) => service().provisionRecord({ ...command(), subjectId })
  const depart = (subjectId: string, groupId: string) => service().recordDeparture({ ...command(), subjectId, groupId, endedAt: new Date().toISOString() })
  const outbox = async () => (await admin.query('select "event" from "profile"."outbox" order by "sequence"')).rows.map(row => row.event as ProfileEvent)
  const names = (subjectIds: string[], extra: { groupId?: string, purpose?: 'attribution' | 'listing' } = {}) =>
    service().displayNames({ viewerId: ids.viewer, subjectIds, groupId: extra.groupId ?? null, purpose: extra.purpose ?? 'listing' })

  beforeAll(async () => {
    const database = await createTestDatabase()
    drop = database.drop
    admin = new pg.Pool({ connectionString: database.url })
    await admin.query(`create role "${role}" login password 'runtime'`)
    const url = new URL(database.url)
    url.username = role
    url.password = 'runtime'
    runtime = new pg.Pool({ connectionString: url.toString() })
  })

  beforeEach(() => {
    relationships.clear()
    departurePolicy = null
    failing = null
  })

  afterAll(async () => {
    await runtime?.end()
    await admin?.query(`drop owned by "${role}"`).catch(() => {})
    await admin?.end()
    await drop?.()
    const cleanup = new pg.Client({ connectionString: process.env.PROFILE_TEST_DATABASE_URL })
    await cleanup.connect()
    await cleanup.query(`drop role if exists "${role}"`).catch(() => {})
    await cleanup.end()
  })

  it('applies every migration once, even when instances race, and grants the runtime role only data access', async () => {
    const results = await Promise.all([runProfileMigrations(admin, 'profile', role), runProfileMigrations(admin, 'profile', role)])
    expect(results.flat()).toEqual(PROFILE_MIGRATIONS.map(m => m.id))
    expect(await runProfileMigrations(admin, 'profile', role)).toEqual([])
    const owned = await admin.query(`select count(*)::int as n from pg_tables where schemaname = 'profile' and tableowner = $1`, [role])
    expect(owned.rows[0].n).toBe(0)
    await expect(runtime.query('create table "profile"."intruder" (x int)')).rejects.toThrow()
    await expect(runtime.query(`delete from "profile"."erased"`)).rejects.toThrow()
    for (const record of ['request', 'legal_hold', 'closed_identity']) await expect(runtime.query(`delete from "profile"."${record}"`)).rejects.toThrow()
    const bypass = await admin.query('select rolbypassrls, rolsuper from pg_roles where rolname = $1', [role])
    expect(bypass.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false })
  })

  it('creates an empty record for each person the host provisions, once per command id', async () => {
    expect(await provision(ids.ada)).toBe('applied')
    const provisioning = { ...command(), subjectId: ids.grace }
    expect(await service().provisionRecord(provisioning)).toBe('applied')
    expect(await service().provisionRecord(provisioning)).toBe('duplicate')
    expect(await service().own({ subjectId: ids.ada })).toEqual({ attributes: {}, settings: DEFAULT_DISCLOSURE_SETTINGS, version: 1 })
    const records = await admin.query('select "identity_id" from "profile"."record"')
    expect(records.rows.map(row => row.identity_id).sort()).toEqual([ids.ada, ids.grace].sort())
    expect((await outbox()).filter(e => e.type === 'profile.created').map(e => e.data.identityId).sort()).toEqual([ids.ada, ids.grace].sort())
    // Commands are strict: an unknown field, a missing id or a bad identifier is refused, and nothing is recorded.
    await expect(service().provisionRecord({ ...command(), subjectId: uuidv7(), kind: 'person' })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(service().provisionRecord({ correlationId: correlationId(), subjectId: uuidv7() })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(service().recordDeparture({ ...command(), subjectId: 'ada@example.com', groupId: ids.group, endedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'validation-failed' })
    expect((await admin.query('select count(*)::int as n from "profile"."record"')).rows[0].n).toBe(2)
  })

  it('keeps every value encrypted with the person\'s own key, and contact details unverified', async () => {
    const updated = await service().update({
      subjectId: ids.ada,
      correlationId: correlationId(),
      changes: { name: ' Ada  Lovelace ', given_name: 'Ada', email: 'ada@example.com', locale: 'en-GB' },
    })
    expect(updated.attributes).toEqual({ name: 'Ada Lovelace', given_name: 'Ada', email: 'ada@example.com', email_verified: false, locale: 'en-GB' })
    const dump = JSON.stringify((await admin.query(`select * from "profile"."record"`)).rows) + JSON.stringify(await outbox())
    for (const value of ['Lovelace', 'ada@example.com', 'en-GB']) expect(dump).not.toContain(value)
    const bytes = (await admin.query(`select "ciphertext" from "profile"."record" where "identity_id" = $1`, [ids.ada])).rows[0].ciphertext as Buffer
    expect(bytes.includes(Buffer.from('Lovelace'))).toBe(false)
    expect((await outbox()).at(-1)).toMatchObject({ type: 'profile.changed', data: { identityId: ids.ada, attributes: ['name', 'given_name', 'locale', 'email'], disclosure: false } })

    const removed = await service().update({ subjectId: ids.ada, correlationId: correlationId(), changes: { email: null, locale: null } })
    expect(removed.attributes).toEqual({ name: 'Ada Lovelace', given_name: 'Ada' })
    await expect(service().update({ subjectId: ids.ada, correlationId: correlationId(), changes: { name: 'Аda' } })).rejects.toMatchObject({ code: 'validation-failed' })
  })

  it('creates the record on first use when the provisioning event has not arrived yet', async () => {
    const early = uuidv7()
    await service().update({ subjectId: early, correlationId: correlationId(), changes: { name: 'Early Bird' } })
    expect(await provision(early)).toBe('applied')
    expect((await service().own({ subjectId: early }))?.attributes).toEqual({ name: 'Early Bird' })
  })

  it('discloses each attribute only to the audience the person chose', async () => {
    await service().update({ subjectId: ids.ada, correlationId: correlationId(), changes: { email: 'ada@example.com', preferred_username: 'countess' } })
    await service().setDisclosure({
      subjectId: ids.ada,
      correlationId: correlationId(),
      settings: { ...DEFAULT_DISCLOSURE_SETTINGS, audiences: { ...DEFAULT_DISCLOSURE_SETTINGS.audiences, email: 'tenant' } },
    })
    relationships.set(ids.ada, { relationship: 'same-group', standing: 'visible' })
    expect(await service().view({ viewerId: ids.viewer, subjectId: ids.ada })).toEqual({
      subjectId: ids.ada,
      displayName: { kind: 'name', value: 'Ada Lovelace' },
      attributes: { name: 'Ada Lovelace', email: 'ada@example.com', email_verified: false },
    })
    relationships.set(ids.ada, { relationship: 'same-tenant', standing: 'visible' })
    expect(await service().view({ viewerId: ids.viewer, subjectId: ids.ada })).toEqual({
      subjectId: ids.ada,
      displayName: { kind: 'hidden' },
      attributes: { email: 'ada@example.com', email_verified: false },
    })
    relationships.set(ids.ada, { relationship: 'none', standing: 'visible' })
    expect(await service().view({ viewerId: ids.viewer, subjectId: ids.ada })).toEqual({ subjectId: ids.ada, displayName: { kind: 'hidden' }, attributes: {} })
  })

  it('shows the name the person picked, in the order asked, and the same answer whether or not a record exists', async () => {
    await service().setDisclosure({
      subjectId: ids.grace,
      correlationId: correlationId(),
      settings: { ...DEFAULT_DISCLOSURE_SETTINGS, displayName: 'preferred_username', audiences: { ...DEFAULT_DISCLOSURE_SETTINGS.audiences, preferred_username: 'group' } },
    })
    await service().update({ subjectId: ids.grace, correlationId: correlationId(), changes: { name: 'Grace Hopper', preferred_username: 'amazing-grace' } })
    relationships.set(ids.ada, { relationship: 'same-group', standing: 'visible' })
    relationships.set(ids.grace, { relationship: 'same-group', standing: 'visible' })
    const stranger = uuidv7()
    relationships.set(stranger, { relationship: 'same-group', standing: 'visible' })
    expect(await names([ids.grace, stranger, ids.ada, ids.grace])).toEqual([
      { subjectId: ids.grace, displayName: { kind: 'name', value: 'amazing-grace' } },
      { subjectId: stranger, displayName: { kind: 'hidden' } },
      { subjectId: ids.ada, displayName: { kind: 'name', value: 'Ada Lovelace' } },
    ])
  })

  it('keeps a paused person attributed but out of listings, and hides a suspended one', async () => {
    relationships.set(ids.ada, { relationship: 'same-group', standing: 'paused' })
    expect(await names([ids.ada], { purpose: 'attribution' })).toEqual([{ subjectId: ids.ada, displayName: { kind: 'name', value: 'Ada Lovelace' } }])
    expect(await names([ids.ada], { purpose: 'listing' })).toEqual([{ subjectId: ids.ada, displayName: { kind: 'hidden' } }])
    relationships.set(ids.ada, { relationship: 'same-group', standing: 'suspended' })
    expect(await names([ids.ada], { purpose: 'attribution' })).toEqual([{ subjectId: ids.ada, displayName: { kind: 'hidden' } }])
  })

  it('fails closed when the disclosure-context port fails or answers malformed, and refuses bad input', async () => {
    failing = 'reject'
    await expect(names([ids.ada])).rejects.toMatchObject({ code: 'unavailable' })
    failing = 'malformed'
    await expect(names([ids.ada])).rejects.toMatchObject({ code: 'unavailable' })
    failing = null
    await expect(service().displayNames({ viewerId: ids.viewer, subjectIds: [], purpose: 'listing' })).rejects.toBeInstanceOf(ProfileFailure)
    await expect(service().displayNames({ viewerId: ids.viewer, subjectIds: Array.from({ length: 201 }, () => uuidv7()), purpose: 'listing' })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(service().displayNames({ viewerId: 'ada@example.com', subjectIds: [ids.ada], purpose: 'listing' })).rejects.toMatchObject({ code: 'validation-failed' })
  })

  it('applies the departure data policy with the name kept when the person left', async () => {
    await depart(ids.ada, ids.group)
    await depart(ids.grace, ids.group)
    // A later change of name does not change how the leaver is attributed.
    await service().update({ subjectId: ids.ada, correlationId: correlationId(), changes: { name: 'Augusta Ada King' } })
    relationships.set(ids.ada, { relationship: 'former-member', standing: 'visible' })
    relationships.set(ids.grace, { relationship: 'former-member', standing: 'visible' })
    const ask = () => names([ids.ada, ids.grace], { groupId: ids.group, purpose: 'attribution' })

    departurePolicy = { attribution: 'keep-name' }
    expect(await ask()).toEqual([
      { subjectId: ids.ada, displayName: { kind: 'name', value: 'Ada Lovelace' } },
      { subjectId: ids.grace, displayName: { kind: 'name', value: 'amazing-grace' } },
    ])
    departurePolicy = { attribution: 'pseudonymise' }
    expect(await ask()).toEqual([
      { subjectId: ids.ada, displayName: { kind: 'pseudonym', number: 1 } },
      { subjectId: ids.grace, displayName: { kind: 'pseudonym', number: 2 } },
    ])
    departurePolicy = { attribution: 'anonymise' }
    expect((await ask()).map(answer => answer.displayName)).toEqual([{ kind: 'former-member' }, { kind: 'former-member' }])

    // The leaver may always choose anonymity: the kept name and the pseudonym go.
    departurePolicy = { attribution: 'keep-name' }
    await service().anonymiseDeparture({ subjectId: ids.ada, groupId: ids.group, correlationId: correlationId() })
    expect((await ask())[0]!.displayName).toEqual({ kind: 'former-member' })
    const row = (await admin.query('select * from "profile"."departure" where "identity_id" = $1', [ids.ada])).rows[0]
    expect(row).toMatchObject({ name_ciphertext: null, pseudonym: null, anonymised: true })
    expect((await outbox()).at(-1)).toMatchObject({ type: 'profile.departure-anonymised', data: { identityId: ids.ada, groupId: ids.group } })
  })

  it('anonymises every departure for someone who chose it in advance', async () => {
    await service().setDisclosure({ subjectId: ids.grace, correlationId: correlationId(), settings: { ...DEFAULT_DISCLOSURE_SETTINGS, anonymiseOnDeparture: true } })
    await depart(ids.grace, ids.other)
    relationships.set(ids.grace, { relationship: 'former-member', standing: 'visible' })
    departurePolicy = { attribution: 'keep-name' }
    expect(await names([ids.grace], { groupId: ids.other, purpose: 'attribution' })).toEqual([{ subjectId: ids.grace, displayName: { kind: 'former-member' } }])
  })

  it('exports the person\'s own data, decrypted', async () => {
    const exported = await service().exportData({ subjectId: ids.grace })
    expect(exported?.attributes).toEqual({ name: 'Grace Hopper', preferred_username: 'amazing-grace' })
    expect(exported?.departures.map(d => [d.groupId, d.name, d.anonymised])).toEqual(expect.arrayContaining([[ids.group, 'amazing-grace', false], [ids.other, null, true]]))
  })

  it('rotates the wrapping key: live keys move to the new version, and an erased person\'s backed-up data dies with the old one', async () => {
    // A "backup" taken under v1.
    const backup = (await admin.query(`select k."identity_id", k."key_version", k."wrapped_key", r."ciphertext" from "profile"."subject_key" k join "profile"."record" r using ("identity_id") where k."identity_id" = $1`, [ids.ada])).rows[0]
    expect(backup.key_version).toBe('v1')

    // Ada's account is closed: her record, departures and key are erased, and never recreated.
    const closure = { ...command(), subjectId: ids.ada }
    expect(await service().closeSubject(closure)).toBe('applied')
    expect(await service().closeSubject(closure)).toBe('duplicate')
    expect((await outbox()).at(-1)).toMatchObject({ type: 'profile.anonymised', data: { identityId: ids.ada, reasonCode: 'identity-closed' } })
    for (const table of ['subject_key', 'record', 'departure']) {
      expect((await admin.query(`select 1 from "profile"."${table}" where "identity_id" = $1`, [ids.ada])).rows).toEqual([])
    }
    expect(await service().own({ subjectId: ids.ada })).toBeNull()
    expect(await service().exportData({ subjectId: ids.ada })).toBeNull()
    await expect(service().update({ subjectId: ids.ada, correlationId: correlationId(), changes: { name: 'Back Again' } })).rejects.toMatchObject({ code: 'forbidden' })
    await provision(ids.ada)
    expect((await admin.query('select 1 from "profile"."record" where "identity_id" = $1', [ids.ada])).rows).toEqual([])
    relationships.set(ids.ada, { relationship: 'same-group', standing: 'visible' })
    expect(await names([ids.ada])).toEqual([{ subjectId: ids.ada, displayName: { kind: 'hidden' } }])
    expect(await service().erase({ identityId: ids.ada, reasonCode: 'person-request', correlationId: correlationId() })).toBe(false)

    // The host rotates to v2: every live key moves; none is left on v1.
    keys = createLocalProfileKeyWrapper({ keys: { v1: master(1), v2: master(2) }, current: 'v2' })
    const before = await service().keyVersionsInUse()
    expect(before.find(v => v.version === 'v1')?.keys).toBeGreaterThan(0)
    let moved = 0
    for (let batch = await service().rewrapKeys({ limit: 1 }); batch > 0; batch = await service().rewrapKeys({ limit: 1 })) moved += batch
    expect(moved).toBe(before.find(v => v.version === 'v1')!.keys)
    expect((await service().keyVersionsInUse()).map(v => v.version)).toEqual(['v2'])

    // v1 is retired: the backup copy of Ada's key cannot be unwrapped, so her backed-up record is unreadable.
    keys = createLocalProfileKeyWrapper({ keys: { v2: master(2) }, current: 'v2' })
    await expect(keys.unwrap({ version: backup.key_version, wrapped: backup.wrapped_key }, { identityId: ids.ada })).rejects.toThrow()
    // Live records still read under v2.
    expect((await service().own({ subjectId: ids.grace }))?.attributes.name).toBe('Grace Hopper')
    // While v1 was still held, the backup would have opened: the test's backup is genuine.
    const old = createLocalProfileKeyWrapper({ keys: { v1: master(1) }, current: 'v1' })
    const key = await old.unwrap({ version: 'v1', wrapped: backup.wrapped_key }, { identityId: ids.ada })
    expect(open(key, backup.ciphertext, aad.record(ids.ada))).toContain('Augusta')
  })

  it('keeps a closed person\'s record under a legal hold, read by nobody, and erases it when the hold ends', async () => {
    const held = uuidv7()
    await provision(held)
    await service().update({ subjectId: held, correlationId: correlationId(), changes: { name: 'Hedy Held' } })
    const hold = await service().placeHold({ identityId: held, parts: ['profile', 'sign-in'], reasonCode: 'litigation', endsAt: new Date(Date.now() + 86_400_000).toISOString(), correlationId: correlationId() })
    expect(hold).toMatchObject({ identityId: held, parts: ['profile', 'sign-in'], endedAt: null })
    expect(await service().heldParts({ identityId: held })).toEqual(['profile', 'sign-in'])
    // Only Profile's part and the parts the host declared holdable can be held.
    for (const parts of [['directory'], ['settings'], ['undeclared']]) {
      await expect(service().placeHold({ identityId: held, parts, reasonCode: 'litigation', endsAt: new Date(Date.now() + 86_400_000).toISOString(), correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    }
    await expect(service().erase({ identityId: held, reasonCode: 'person-request', correlationId: correlationId() })).rejects.toMatchObject({ code: 'conflict' })
    await expect(service().placeHold({ identityId: held, parts: ['profile'], reasonCode: 'litigation', endsAt: new Date(Date.now() + 8 * 366 * 86_400_000).toISOString(), correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })

    const erasure = await service().openRequest({ subjectId: held, type: 'erasure', origin: 'operator', reasonCode: 'verified-by-post', correlationId: correlationId() })
    expect(erasure.parts.map(part => part.part)).toEqual(['profile', 'directory', 'sign-in', 'permissions'])
    await expect(service().openRequest({ subjectId: held, type: 'erasure', origin: 'person', correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(service().openRequest({ subjectId: held, type: 'erasure', origin: 'operator', correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })

    // The host closes the account: the record stays, but nothing reads it.
    await service().closeSubject({ ...command(), subjectId: held })
    expect((await admin.query('select 1 from "profile"."record" where "identity_id" = $1', [held])).rows).toHaveLength(1)
    expect(await service().own({ subjectId: held })).toBeNull()
    expect(await service().exportData({ subjectId: held })).toBeNull()
    await expect(service().update({ subjectId: held, correlationId: correlationId(), changes: { name: 'Back' } })).rejects.toMatchObject({ code: 'forbidden' })
    const status = async () => Object.fromEntries((await service().getRequest({ requestId: erasure.requestId }))!.parts.map(part => [part.part, part.status]))
    expect(await status()).toEqual({ profile: 'held', directory: 'done', 'sign-in': 'held', permissions: 'pending' })

    // The host erased its `permissions` part, which no hold covers. Profile's and the directory part are not the host's to report.
    for (const part of ['profile', 'directory', 'undeclared']) {
      await expect(service().recordRequestPart({ identityId: held, part, correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    }
    await service().recordRequestPart({ identityId: held, part: 'permissions', correlationId: correlationId() })
    expect((await status()).permissions).toBe('done')

    // The hold is released: Profile erases now, and tells the host which parts to erase.
    await service().releaseHold({ holdId: hold.holdId, reasonCode: 'case-closed', correlationId: correlationId() })
    expect((await admin.query('select 1 from "profile"."subject_key" where "identity_id" = $1', [held])).rows).toEqual([])
    const ended = (await outbox()).filter(e => e.type === 'profile.legal-hold-ended').at(-1)
    expect(ended?.data).toMatchObject({ holdId: hold.holdId, identityId: held, parts: ['profile', 'sign-in'], released: ['profile', 'sign-in'], identityClosed: true, reasonCode: 'case-closed' })
    expect(await status()).toEqual({ profile: 'done', directory: 'done', 'sign-in': 'pending', permissions: 'done' })
    await service().recordRequestPart({ identityId: held, part: 'sign-in', correlationId: correlationId() })
    expect(await service().getRequest({ requestId: erasure.requestId })).toMatchObject({ status: 'completed' })
    expect((await outbox()).filter(e => e.type === 'profile.request-completed').at(-1)?.data).toMatchObject({ requestId: erasure.requestId, identityId: held })
    await expect(service().releaseHold({ holdId: hold.holdId, reasonCode: 'case-closed', correlationId: correlationId() })).rejects.toMatchObject({ code: 'conflict' })
    // The request outlives the erasure, as identifiers and codes only.
    const dump = JSON.stringify((await admin.query('select * from "profile"."request" r join "profile"."request_part" p using ("request_id") where r."identity_id" = $1', [held])).rows)
    expect(dump).not.toContain('Hedy')
  })

  it('completes a correction when every group it names is renamed, and raises it to operators if the owners are slow', async () => {
    const person = uuidv7()
    await provision(person)
    const groupA = uuidv7()
    const groupB = uuidv7()
    const opened = await service().openRequest({ subjectId: person, type: 'correction', origin: 'operator', reasonCode: 'verified-by-email', groupIds: [groupA, groupB], correlationId: correlationId() })
    expect(opened).toMatchObject({ status: 'open', groupIds: [groupA, groupB].sort() })
    await service().settlePart({ requestId: opened.requestId, part: 'profile', outcome: 'done', correlationId: correlationId() })
    const renamedA = { ...command(), groupId: groupA }
    expect(await service().recordGroupRenamed(renamedA)).toBe('applied')
    expect(await service().recordGroupRenamed(renamedA)).toBe('duplicate')
    expect((await service().getRequest({ requestId: opened.requestId }))?.status).toBe('open')

    // Half the deadline passes with group B unrenamed: operators are told, once.
    const later = new Date(Date.parse(opened.openedAt) + 20 * 86_400_000)
    const atLater = () => createService({ ...base(), now: () => later })
    await atLater().maintain()
    await atLater().maintain()
    const escalations = (await outbox()).filter(e => e.type === 'profile.request-escalated' && e.data.requestId === opened.requestId)
    expect(escalations.map(e => e.data.reasonCode)).toEqual(['group-rename-overdue'])

    await service().recordGroupRenamed({ ...command(), groupId: groupB })
    expect(await service().getRequest({ requestId: opened.requestId })).toMatchObject({ status: 'completed' })
  })

  it('lets an operator exempt a part with a reason code, and ends holds on their end date', async () => {
    const person = uuidv7()
    await provision(person)
    const opened = await service().openRequest({ subjectId: person, type: 'restriction', parts: ['settings'], origin: 'operator', reasonCode: 'verified-by-post', correlationId: correlationId() })
    expect(opened.parts.map(part => `${part.part}:${part.status}`)).toEqual(['profile:done', 'settings:pending'])
    await expect(service().settlePart({ requestId: opened.requestId, part: 'settings', outcome: 'exempt', correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    const settled = await service().settlePart({ requestId: opened.requestId, part: 'settings', outcome: 'exempt', reasonCode: 'legitimate-grounds', correlationId: correlationId() })
    expect(settled).toMatchObject({ status: 'completed', parts: [expect.objectContaining({ part: 'profile', status: 'done' }), expect.objectContaining({ part: 'settings', status: 'exempt', reasonCode: 'legitimate-grounds' })] })

    const hold = await service().placeHold({ identityId: person, parts: ['permissions'], reasonCode: 'litigation', endsAt: new Date(Date.now() + 60_000).toISOString(), correlationId: correlationId() })
    const after = new Date(Date.now() + 120_000)
    const result = await createService({ ...base(), now: () => after }).maintain()
    expect(result.holdsEnded).toBeGreaterThanOrEqual(1)
    expect((await service().listHolds({ identityId: person }))[0]).toMatchObject({ holdId: hold.holdId, endedAt: expect.any(String) })
    expect((await outbox()).filter(e => e.type === 'profile.legal-hold-ended').at(-1)?.data).toMatchObject({ holdId: hold.holdId, released: ['permissions'], identityClosed: false, reasonCode: 'expired' })
  })

  it('completes the directory part of a restriction when the host records a pause, once per command id', async () => {
    const person = uuidv7()
    await provision(person)
    const opened = await service().openRequest({ subjectId: person, type: 'restriction', parts: ['directory'], origin: 'operator', reasonCode: 'verified-by-post', correlationId: correlationId() })
    expect(opened.parts.map(part => `${part.part}:${part.status}`)).toEqual(['profile:done', 'directory:pending'])
    const pause = { ...command(), subjectId: person }
    expect(await service().recordPause(pause)).toBe('applied')
    expect(await service().recordPause(pause)).toBe('duplicate')
    expect(await service().getRequest({ requestId: opened.requestId })).toMatchObject({ status: 'completed', parts: [expect.objectContaining({ part: 'profile' }), expect.objectContaining({ part: 'directory', status: 'done' })] })
    expect((await outbox()).filter(e => e.type === 'profile.request-completed').at(-1)?.data).toMatchObject({ requestId: opened.requestId, parts: [{ part: 'profile', status: 'done' }, { part: 'directory', status: 'done' }] })
  })

  it('accepts only the parts the host declared, and without a declaration only its own', async () => {
    const person = uuidv7()
    await provision(person)
    const operator = { subjectId: person, origin: 'operator' as const, reasonCode: 'verified-by-post' }
    await expect(service().openRequest({ ...operator, type: 'restriction', parts: ['undeclared'], correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(service().openRequest({ ...operator, type: 'restriction', parts: ['Not A Part'], correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    // Naming groups adds the directory part; a correction of the directory needs groups.
    const named = await service().openRequest({ ...operator, type: 'correction', groupIds: [uuidv7()], correlationId: correlationId() })
    expect(named.parts.map(part => part.part)).toEqual(['profile', 'directory'])
    await expect(service().openRequest({ ...operator, type: 'correction', parts: ['directory'], correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })

    // Without a declaration: Profile's part only, no groups, and no coordination port needed for access.
    const alone = createService({ pool: runtime, schema: 'profile', keys, disclosure: () => disclosure })
    const access = await alone.openRequest({ subjectId: person, type: 'access', origin: 'person', correlationId: correlationId() })
    expect(access).toMatchObject({ status: 'completed', parts: [expect.objectContaining({ part: 'profile', status: 'done' })] })
    await expect(alone.openRequest({ ...operator, type: 'correction', groupIds: [uuidv7()], correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(alone.openRequest({ ...operator, type: 'erasure', parts: ['sign-in'], correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(alone.placeHold({ identityId: person, parts: ['sign-in'], reasonCode: 'litigation', endsAt: new Date(Date.now() + 86_400_000).toISOString(), correlationId: correlationId() })).rejects.toMatchObject({ code: 'validation-failed' })
    // A pause or a rename with no directory part changes no request, and is still recorded once.
    const pause = { ...command(), subjectId: person }
    expect(await alone.recordPause(pause)).toBe('applied')
    expect(await alone.recordPause(pause)).toBe('duplicate')
    // Coordinated parts without the coordination port refuse an access request before recording anything.
    const before = (await admin.query('select count(*)::int as n from "profile"."request"')).rows[0].n
    await expect(service().openRequest({ subjectId: person, type: 'access', origin: 'person', correlationId: correlationId() })).rejects.toMatchObject({ code: 'unavailable' })
    expect((await admin.query('select count(*)::int as n from "profile"."request"')).rows[0].n).toBe(before)
  })

  it('keeps part names stored before host-declared parts valid and readable after migration 0006', async () => {
    const schema = `legacy_${randomBytes(4).toString('hex')}`
    await admin.query(`create schema "${schema}"`)
    await admin.query(`create table "${schema}"."schema_migration" ("id" text primary key, "applied_at" timestamptz not null default now())`)
    const released = PROFILE_MIGRATIONS.filter(m => m.id < '0006')
    for (const migration of released) {
      await admin.query(migration.sql.replaceAll('{{schema}}', `"${schema}"`))
      await admin.query(`insert into "${schema}"."schema_migration" ("id") values ($1)`, [migration.id])
    }
    const person = uuidv7()
    const requestId = uuidv7()
    await admin.query(`insert into "${schema}"."request" ("request_id", "identity_id", "type", "origin", "correlation_id", "opened_at", "due_at") values ($1, $2, 'access', 'person', $3, now(), now() + interval '30 days')`, [requestId, person, correlationId()])
    for (const part of ['profile', 'identity', 'authentication', 'authorisation', 'configuration']) {
      await admin.query(`insert into "${schema}"."request_part" ("request_id", "part", "updated_at") values ($1, $2, now())`, [requestId, part])
    }
    await admin.query(`insert into "${schema}"."legal_hold" ("hold_id", "identity_id", "parts", "reason_code", "placed_at", "ends_at") values ($1, $2, array['profile', 'authentication', 'authorisation'], 'litigation', now(), now() + interval '1 day')`, [uuidv7(), person])

    expect(await runProfileMigrations(admin, schema)).toEqual(PROFILE_MIGRATIONS.filter(m => m.id >= '0006').map(m => m.id))
    await admin.query(`grant usage on schema "${schema}" to "${role}"`)
    await admin.query(`grant select on all tables in schema "${schema}" to "${role}"`)
    const legacy = createService({ ...base(), schema })
    const view = await legacy.getRequest({ requestId })
    // Declared parts first in declaration order, then stored parts no longer declared, alphabetically.
    expect(view?.parts.map(part => part.part)).toEqual(['profile', 'authentication', 'authorisation', 'configuration', 'identity'])
    expect((await legacy.listHolds({ identityId: person }))[0]?.parts).toEqual(['profile', 'authentication', 'authorisation'])
    // The relaxed checks still refuse what is not a part name.
    for (const part of ['Profile', 'two words', 'x'.repeat(33), '']) {
      await expect(admin.query(`insert into "${schema}"."request_part" ("request_id", "part", "updated_at") values ($1, $2, now())`, [requestId, part])).rejects.toThrow()
    }
    for (const parts of [[], ['profile', 'Bad'], Array.from({ length: 17 }, (_, i) => `p${i}`)]) {
      await expect(admin.query(`insert into "${schema}"."legal_hold" ("hold_id", "identity_id", "parts", "reason_code", "placed_at", "ends_at") values ($1, $2, $3, 'litigation', now(), now() + interval '1 day')`, [uuidv7(), person, parts])).rejects.toThrow()
    }
    await admin.query(`drop schema "${schema}" cascade`)
  })

  it('fails closed when the key port fails', async () => {
    const saved = keys
    keys = { currentVersion: () => 'v2', wrap: async () => { throw new Error('kms down') }, unwrap: async () => { throw new Error('kms down') } }
    try {
      await expect(service().own({ subjectId: ids.grace })).rejects.toMatchObject({ code: 'unavailable' })
      await expect(service().update({ subjectId: uuidv7(), correlationId: correlationId(), changes: { name: 'New Person' } })).rejects.toMatchObject({ code: 'unavailable' })
    }
    finally {
      keys = saved
    }
  })

  it('disposes of a deleted group\'s departures when disposal is due, keeping those a legal hold covers', async () => {
    const doomed = uuidv7()
    const [kept, gone] = [uuidv7(), uuidv7()]
    for (const person of [kept, gone]) {
      await provision(person)
      await service().update({ subjectId: person, correlationId: correlationId(), changes: { name: 'Someone Leaving' } })
      await depart(person, doomed)
    }
    await service().placeHold({ identityId: kept, parts: ['profile'], reasonCode: 'litigation', endsAt: new Date(Date.now() + 86_400_000).toISOString(), correlationId: correlationId() })
    const departures = async () => (await admin.query('select "identity_id" from "profile"."departure" where "group_id" = $1', [doomed])).rows.map(row => row.identity_id)
    expect((await departures()).sort()).toEqual([kept, gone].sort())
    const disposal = { ...command(), groupId: doomed }
    expect(await service().disposeGroup(disposal)).toBe('applied')
    expect(await service().disposeGroup(disposal)).toBe('duplicate')
    expect(await departures()).toEqual([kept])
    expect((await outbox()).filter(e => e.type === 'profile.group-disposed').at(-1)).toMatchObject({ data: { groupId: doomed, departures: 1, heldDepartures: 1 } })
  })

  it('deletes delivered events, old completed requests and old ended holds under retention, never a held person\'s request', async () => {
    let at = new Date()
    const timed = () => createService({ ...base(), now: () => at })
    await timed().relayOutbox({ limit: 1000, publish: async () => {} })
    const person = uuidv7()
    await provision(person)
    await admin.query(`insert into "profile"."request" ("request_id", "identity_id", "type", "origin", "status", "correlation_id", "opened_at", "due_at", "completed_at")
      values ($1, $2, 'restriction', 'person', 'completed', $3, now() - interval '900 days', now() - interval '870 days', now() - interval '880 days'),
             ($4, $5, 'restriction', 'person', 'completed', $3, now() - interval '900 days', now() - interval '870 days', now() - interval '880 days')`,
    [uuidv7(), person, correlationId(), uuidv7(), ids.ada])
    await timed().placeHold({ identityId: ids.ada, parts: ['sign-in'], reasonCode: 'litigation', endsAt: new Date(Date.now() + 100 * 86_400_000).toISOString(), correlationId: correlationId() })
    at = new Date(Date.now() + 40 * 86_400_000)
    const { retention } = await timed().maintain()
    expect(retention.outboxEvents).toBeGreaterThan(0)
    expect(retention.requests).toBe(1)
    const left = await admin.query(`select "identity_id" from "profile"."request" where "completed_at" < now() - interval '800 days'`)
    expect(left.rows.map(row => row.identity_id)).toEqual([ids.ada])
    expect((await outbox()).filter(e => e.type === 'profile.retention-applied').at(-1)).toMatchObject({ data: { requests: 1 } })
    // The runtime role still cannot delete a request itself.
    await expect(runtime.query(`delete from "profile"."request"`)).rejects.toThrow()
  })

  it('relays the outbox in order, stopping at the first failure and resuming from it', async () => {
    const pending = (await admin.query('select count(*)::int as n from "profile"."outbox" where "published_at" is null')).rows[0].n as number
    const seen: string[] = []
    let calls = 0
    const relayed = await service().relayOutbox({ limit: 1000, publish: async (event) => {
      calls += 1
      if (calls === 3) throw new Error('broker down')
      seen.push(event.eventId)
    } })
    expect(relayed).toBe(2)
    const rest = await service().relayOutbox({ limit: 1000, publish: async (event) => { seen.push(event.eventId) } })
    expect(relayed + rest).toBe(pending)
    const all = (await outbox()).map(e => e.eventId)
    expect(seen).toEqual(all)
  })
})
