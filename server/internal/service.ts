import type {
  DepartureFacts,
  DisclosureContext,
  DisclosureSettings,
  DisplayName,
  LookupPurpose,
  PostgresPoolLike,
  ProfileAttribute,
  ProfileAttributes,
  ProfileDisclosureContextPort,
  ProfileEvent,
  ProfileEventPublisher,
  ProfileEventType,
  ProfileKeyWrapper,
  LegalHoldView,
  PartStatus,
  ProfileAccessDecision,
  ProfileDepartureView,
  ProfileNotifier,
  ProfileOwnView,
  ProfileCommandResult,
  ProfileRequestCoordinator,
  ProfileRequestParts,
  RequestPart,
  RequestView,
  VerifiableAttribute,
  ProfileRetention,
} from '../../contracts'
import {
  chosenDisplayName,
  closureCommandSchema,
  departureCommandSchema,
  groupDisposalCommandSchema,
  groupRenamedCommandSchema,
  openRequestSchema,
  orderRequestParts,
  pauseCommandSchema,
  PROFILE_REQUEST_PART,
  provisionCommandSchema,
  resolveProfileRequestParts,
  PERSON_REQUEST_TYPES,
  placeHoldSchema,
  PROFILE_REQUEST_POLICY,
  PROFILE_SUSPENDED_PEOPLE_PERMISSION,
  PROFILE_VERIFICATION_POLICY,
  profileSubjectSchema,
  requestDueAt,
  settlePartSchema,
  standingInGroup,
  VERIFIABLE_ATTRIBUTES,
  VERIFICATION_CHANNELS,
  verificationCodeSchema,
  correlationIdSchema,
  DEFAULT_DISCLOSURE_SETTINGS,
  disclosureContextSchema,
  disclosureSettingsSchema,
  discloseAttributes,
  discloseDisplayName,
  DISCLOSURE_MAX_SUBJECTS,
  identifierSchema,
  LOOKUP_PURPOSES,
  PROFILE_LOOKUP_RATE_LIMIT,
  PROFILE_ATTRIBUTES,
  profileAttributesSchema,
  profileChangesSchema,
  ProfileFailure,
  resolveProfileRetention,
  reasonCodeSchema,
  VERIFICATION_CLAIMS,
} from '../../contracts'
import type { PoolClientLike } from '../database/migrations'
import { quoteSchema } from '../database/migrations'
import { timeFrom } from './clock'
import { aad, codeDigest, newCode, newDataKey, open, sameDigest, seal, uuidv7 } from './crypto'

/**
 * PRIVATE. Profile's server operations. Every attribute value is encrypted
 * with the person's own key before it reaches the database, and decrypted
 * only to answer the person or a viewer the disclosure rules allow. Any
 * failure of the database, the key port or the disclosure-context port fails closed
 * (`ProfileFailure('unavailable')`), and no error or log carries a value.
 */

export interface ServiceDependencies {
  pool: PostgresPoolLike
  schema: string
  keys: ProfileKeyWrapper
  /** The host's disclosure-context port; required for lookups by other people. */
  disclosure: () => ProfileDisclosureContextPort
  /** The host's coordination port; required for data-subject requests. */
  coordinator?: () => ProfileRequestCoordinator
  /** The host's access decisions; required for administration lookups that meet a suspended member. */
  accessDecision?: () => ProfileAccessDecision
  /** The host's notification port; required for contact-detail verification. */
  notifier?: () => ProfileNotifier
  /** The host's clock (or the system clock); every time Profile keeps or judges comes from it. */
  now?: () => Date
  /** The retention periods; the defaults without them. */
  retention?: () => ProfileRetention
  /** The host's request parts beside Profile's own; Profile's only without them. */
  requestParts?: () => ProfileRequestParts
}

/** A port the host has not supplied fails closed. */
function missing(port: string): never {
  throw new ProfileFailure('unavailable', `${port} not supplied`)
}

export type OwnProfile = ProfileOwnView

export interface DepartureExport {
  groupId: string
  endedAt: string
  name: string | null
  pseudonym: number | null
  anonymised: boolean
}

type Client = PoolClientLike

function openOrFail(key: Uint8Array, sealed: Uint8Array, additional: string): string {
  try {
    return open(key, sealed, additional)
  }
  catch {
    throw new ProfileFailure('unavailable', 'stored value is malformed')
  }
}

function parse<T>(run: () => T): T {
  try {
    return run()
  }
  catch (error) {
    const issues = (error as { issues?: { message: string }[] }).issues
    const codes = issues ? [...new Set(issues.map(issue => issue.message))].join(',') : 'invalid input'
    throw new ProfileFailure('validation-failed', codes)
  }
}

export function createService({ pool, schema, keys, disclosure, coordinator = () => missing('ProfileRequestCoordinator'), accessDecision = () => missing('ProfileAccessDecision'), notifier = () => missing('ProfileNotifier'), now: clockNow = () => new Date(), retention = () => resolveProfileRetention(), requestParts = () => resolveProfileRequestParts() }: ServiceDependencies) {
  const s = quoteSchema(schema)
  /** The clock's time; an invalid answer fails closed as `unavailable`. */
  const clock = { now: clockNow }
  const now = (): Date => timeFrom(clock)

  async function transaction<T>(run: (client: Client) => Promise<T>): Promise<T> {
    let client: Client
    try {
      client = await pool.connect() as Client
    }
    catch {
      throw new ProfileFailure('unavailable', 'database connection failed')
    }
    try {
      await client.query('begin')
      const result = await run(client)
      await client.query('commit')
      return result
    }
    catch (error) {
      await client.query('rollback').catch(() => {})
      if (error instanceof ProfileFailure) throw error
      throw new ProfileFailure('unavailable', 'database operation failed')
    }
    finally {
      client.release()
    }
  }

  function event<T extends ProfileEventType>(type: T, data: Extract<ProfileEvent, { type: T }>['data'], correlationId: string): ProfileEvent {
    const at = now()
    return { eventId: uuidv7(at.getTime()), type, occurredAt: at.toISOString(), correlationId, data } as ProfileEvent
  }

  async function emit(client: Client, profileEvent: ProfileEvent): Promise<void> {
    await client.query(`insert into ${s}."outbox" ("event", "created_at") values ($1::jsonb, $2)`, [JSON.stringify(profileEvent), profileEvent.occurredAt])
  }

  async function unwrap(identityId: string, version: string, wrapped: string): Promise<Uint8Array> {
    try {
      return await keys.unwrap({ version, wrapped }, { identityId })
    }
    catch {
      throw new ProfileFailure('unavailable', 'key unwrapping failed')
    }
  }

  async function isErased(client: Client, identityId: string): Promise<boolean> {
    const { rows } = await client.query(`select 1 from ${s}."erased" where "identity_id" = $1`, [identityId])
    return rows.length > 0
  }

  /**
   * Erased, or closed and kept only under a legal hold: either way no
   * function reads, changes or recreates the record.
   */
  async function isWithheld(client: Client | PostgresPoolLike, identityId: string): Promise<boolean> {
    const { rows } = await client.query(
      `select 1 from ${s}."erased" where "identity_id" = $1 union all select 1 from ${s}."held_closure" where "identity_id" = $1`,
      [identityId],
    ) as { rows: unknown[] }
    return rows.length > 0
  }

  /** Creates an empty record with a new key, unless one exists or the identity was erased (or is withheld under a hold). */
  async function ensureRecord(client: Client, identityId: string, correlationId: string): Promise<'exists' | 'created' | 'erased'> {
    if (await isWithheld(client, identityId)) return 'erased'
    const { rows } = await client.query(`select 1 from ${s}."record" where "identity_id" = $1`, [identityId])
    if (rows.length > 0) return 'exists'
    const key = newDataKey()
    let wrapped
    try {
      wrapped = await keys.wrap(key, { identityId })
    }
    catch {
      throw new ProfileFailure('unavailable', 'key wrapping failed')
    }
    const at = now().toISOString()
    const inserted = await client.query(
      `insert into ${s}."subject_key" ("identity_id", "key_version", "wrapped_key", "created_at") values ($1, $2, $3, $4) on conflict do nothing returning 1`,
      [identityId, wrapped.version, wrapped.wrapped, at],
    )
    if (inserted.rows.length === 0) return 'exists'
    await client.query(
      `insert into ${s}."record" ("identity_id", "ciphertext", "disclosure", "created_at", "updated_at") values ($1, $2, $3::jsonb, $4, $4)`,
      [identityId, seal(key, '{}', aad.record(identityId)), JSON.stringify(DEFAULT_DISCLOSURE_SETTINGS), at],
    )
    await emit(client, event('profile.created', { identityId }, correlationId))
    return 'created'
  }

  interface StoredRecord { key: Uint8Array, attributes: ProfileAttributes, settings: DisclosureSettings, version: number }

  /** Refuses a change made against an older version than the one stored (0 when none is). Locks the row. */
  async function checkVersion(client: Client, identityId: string, expected: number | undefined): Promise<void> {
    if (expected === undefined) return
    const { rows } = await client.query(`select "version" from ${s}."record" where "identity_id" = $1 for update`, [identityId])
    const current = (rows[0]?.version as number | undefined) ?? 0
    if (current !== expected) throw new ProfileFailure('conflict', 'version-changed')
  }

  const expectedVersionOf = (value: unknown): number | undefined =>
    value === undefined ? undefined : parse(() => { if (!Number.isInteger(value) || (value as number) < 0) throw new Error('invalid'); return value as number })

  async function decodeRecord(identityId: string, row: Record<string, unknown>): Promise<StoredRecord> {
    const key = await unwrap(identityId, row.key_version as string, row.wrapped_key as string)
    try {
      return {
        key,
        attributes: profileAttributesSchema.parse(JSON.parse(open(key, row.ciphertext as Uint8Array, aad.record(identityId)))),
        settings: disclosureSettingsSchema.parse(row.disclosure),
        version: row.version as number,
      }
    }
    catch {
      throw new ProfileFailure('unavailable', 'stored record is malformed')
    }
  }

  async function readRecord(client: Client | PostgresPoolLike, identityId: string, lock = false): Promise<StoredRecord | null> {
    const { rows } = await client.query(
      `select r."ciphertext", r."disclosure", r."version", k."key_version", k."wrapped_key"
       from ${s}."record" r join ${s}."subject_key" k using ("identity_id") where r."identity_id" = $1${lock ? ' for update of r' : ''}`,
      [identityId],
    ) as { rows: Record<string, unknown>[] }
    return rows[0] ? decodeRecord(identityId, rows[0]) : null
  }

  async function writeRecord(client: Client, identityId: string, record: StoredRecord): Promise<void> {
    await client.query(
      `update ${s}."record" set "ciphertext" = $2, "disclosure" = $3::jsonb, "version" = "version" + 1, "updated_at" = $4 where "identity_id" = $1`,
      [identityId, seal(record.key, JSON.stringify(record.attributes), aad.record(identityId)), JSON.stringify(record.settings), now().toISOString()],
    )
  }

  async function poolRead<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    }
    catch (error) {
      if (error instanceof ProfileFailure) throw error
      throw new ProfileFailure('unavailable', 'database read failed')
    }
  }

  /** Records for many identities at once, keyed by identity. Missing ones are absent. */
  async function readRecords(identityIds: readonly string[]): Promise<Map<string, StoredRecord>> {
    const records = new Map<string, StoredRecord>()
    if (identityIds.length === 0) return records
    const { rows } = await poolRead(() => pool.query(
      `select r."identity_id", r."ciphertext", r."disclosure", r."version", k."key_version", k."wrapped_key"
       from ${s}."record" r join ${s}."subject_key" k using ("identity_id") where r."identity_id" = any ($1::text[])`,
      [identityIds],
    ) as Promise<{ rows: Record<string, unknown>[] }>)
    for (const row of rows) records.set(row.identity_id as string, await decodeRecord(row.identity_id as string, row))
    return records
  }

  async function describe(viewerId: string, subjectIds: string[], groupId: string | null): Promise<DisclosureContext> {
    let answer: unknown
    try {
      answer = await disclosure().describe({ viewerId, subjectIds, groupId }, { consistency: 'bounded' })
    }
    catch (error) {
      if (error instanceof ProfileFailure || (error as Error)?.name === 'ProfileCompositionError') throw error
      throw new ProfileFailure('unavailable', 'disclosure context failed')
    }
    const parsed = disclosureContextSchema.safeParse(answer)
    if (!parsed.success || parsed.data.viewerId !== viewerId) throw new ProfileFailure('unavailable', 'disclosure context is malformed')
    return parsed.data
  }

  async function departures(groupId: string, identityIds: readonly string[], records: Map<string, StoredRecord>): Promise<Map<string, DepartureFacts>> {
    const facts = new Map<string, DepartureFacts>()
    if (identityIds.length === 0) return facts
    const { rows } = await poolRead(() => pool.query(
      `select "identity_id", "name_ciphertext", "pseudonym", "anonymised" from ${s}."departure" where "group_id" = $1 and "identity_id" = any ($2::text[])`,
      [groupId, identityIds],
    ) as Promise<{ rows: Record<string, unknown>[] }>)
    for (const row of rows) {
      const identityId = row.identity_id as string
      let name: string | null = null
      const record = records.get(identityId)
      if (row.name_ciphertext && record) {
        try {
          name = open(record.key, row.name_ciphertext as Uint8Array, aad.departureName(identityId, groupId))
        }
        catch {
          throw new ProfileFailure('unavailable', 'stored departure is malformed')
        }
      }
      facts.set(identityId, { name, pseudonym: (row.pseudonym as number | null) ?? null, anonymised: row.anonymised === true })
    }
    return facts
  }

  async function lookup(input: { viewerId: unknown, subjectIds: unknown, groupId?: unknown, purpose: unknown, subject?: unknown }) {
    const viewerId = parse(() => identifierSchema.parse(input.viewerId))
    const subjectIds = parse(() => [...new Set(identifierSchema.array().min(1).max(DISCLOSURE_MAX_SUBJECTS).parse(input.subjectIds))])
    const groupId = parse(() => identifierSchema.nullable().parse(input.groupId ?? null))
    const purpose = parse(() => identifierPurpose(input.purpose))
    // An administration lookup is for one group, by the signed-in viewer themselves.
    const viewer = purpose === 'administration' ? parse(() => profileSubjectSchema.parse(input.subject)) : null
    if (purpose === 'administration' && (groupId === null || viewer!.principalId !== viewerId)) throw new ProfileFailure('validation-failed', 'group-required')
    const context = await describe(viewerId, subjectIds, groupId)
    // In the group context, the subject's own membership there makes their standing stricter.
    const facts = new Map(context.subjects.map(subject => [subject.subjectId, {
      ...subject,
      standing: context.groupId && subject.relationship === 'same-group' ? standingInGroup(subject.standing, subject.membershipInGroup?.state) : subject.standing,
    }]))
    const suspendedHere = (id: string) => {
      const subject = facts.get(id)
      return Boolean(subject && subject.relationship === 'same-group' && subject.standing === 'suspended')
    }
    // The access decision is asked once, and only when the answer could name someone.
    let administrator = false
    if (viewer && context.groupId === groupId && subjectIds.some(suspendedHere)) {
      try {
        administrator = await accessDecision().allows({ subject: viewer, permission: PROFILE_SUSPENDED_PEOPLE_PERMISSION, groupId: groupId! })
      }
      catch (error) {
        if (error instanceof ProfileFailure) throw error
        throw new ProfileFailure('unavailable', 'access decision failed')
      }
    }
    // Decrypt only the records the viewer may see something of.
    const needed = subjectIds.filter((id) => {
      const subject = facts.get(id)
      if (!subject || subject.relationship === 'none') return false
      return subject.relationship === 'self' || subject.standing === 'visible' || subject.standing === 'paused' || (administrator && suspendedHere(id))
    })
    const records = await readRecords(needed)
    const formerMembers = context.groupId ? needed.filter(id => facts.get(id)?.relationship === 'former-member') : []
    const departed = context.groupId ? await departures(context.groupId, formerMembers, records) : new Map<string, DepartureFacts>()
    return subjectIds.map((subjectId) => {
      const subject = facts.get(subjectId)
      const record = records.get(subjectId) ?? null
      const disclosureInput = {
        relationship: subject?.relationship ?? 'none' as const,
        standing: subject?.standing ?? 'gone' as const,
        purpose,
        attributes: record?.attributes ?? null,
        settings: record?.settings ?? DEFAULT_DISCLOSURE_SETTINGS,
        departureAttribution: context.departurePolicy?.attribution ?? null,
        departure: departed.get(subjectId) ?? null,
        administrator,
      }
      return { subjectId, input: disclosureInput }
    })
  }

  function identifierPurpose(value: unknown): LookupPurpose {
    if (typeof value !== 'string' || !(LOOKUP_PURPOSES as readonly string[]).includes(value)) throw new ProfileFailure('validation-failed', 'invalid purpose')
    return value as LookupPurpose
  }

  async function erase(client: Client, identityId: string, reasonCode: string, correlationId: string): Promise<boolean> {
    await client.query(
      `update ${s}."request_part" p set "ciphertext" = null from ${s}."request" r where r."request_id" = p."request_id" and r."identity_id" = $1 and p."ciphertext" is not null`,
      [identityId],
    )
    await client.query(`delete from ${s}."departure" where "identity_id" = $1`, [identityId])
    await client.query(`delete from ${s}."subject_key" where "identity_id" = $1`, [identityId])
    const { rows } = await client.query(
      `insert into ${s}."erased" ("identity_id", "reason_code", "erased_at") values ($1, $2, $3) on conflict do nothing returning 1`,
      [identityId, reasonCode, now().toISOString()],
    )
    if (rows.length === 0) return false
    await emit(client, event('profile.anonymised', { identityId, reasonCode }, correlationId))
    return true
  }

  async function snapshotDeparture(client: Client, identityId: string, groupId: string, endedAt: string): Promise<void> {
    if (await isErased(client, identityId)) return
    const record = await readRecord(client, identityId)
    const settings = record?.settings ?? DEFAULT_DISCLOSURE_SETTINGS
    if (settings.anonymiseOnDeparture) {
      await client.query(
        `insert into ${s}."departure" ("group_id", "identity_id", "ended_at", "anonymised") values ($1, $2, $3, true)
         on conflict ("group_id", "identity_id") do update set "ended_at" = excluded."ended_at", "name_ciphertext" = null, "pseudonym" = null, "anonymised" = true`,
        [groupId, identityId, endedAt],
      )
      return
    }
    // The name fellow members could see when the person left, if any.
    const visibleToMembers = record && settings.audiences[settings.displayName] !== 'nobody' ? chosenDisplayName(record.attributes, settings) : null
    const nameCiphertext = record && visibleToMembers !== null ? seal(record.key, visibleToMembers, aad.departureName(identityId, groupId)) : null
    const existing = await client.query(`select "pseudonym", "anonymised" from ${s}."departure" where "group_id" = $1 and "identity_id" = $2 for update`, [groupId, identityId])
    const previous = existing.rows[0]
    if (previous?.anonymised === true) {
      await client.query(`update ${s}."departure" set "ended_at" = $3 where "group_id" = $1 and "identity_id" = $2`, [groupId, identityId, endedAt])
      return
    }
    let pseudonym = (previous?.pseudonym as number | null | undefined) ?? null
    if (pseudonym === null) {
      const counter = await client.query(
        `insert into ${s}."pseudonym_counter" ("group_id", "last") values ($1, 1)
         on conflict ("group_id") do update set "last" = ${s}."pseudonym_counter"."last" + 1 returning "last"`,
        [groupId],
      )
      pseudonym = counter.rows[0]!.last as number
    }
    await client.query(
      `insert into ${s}."departure" ("group_id", "identity_id", "ended_at", "name_ciphertext", "pseudonym") values ($1, $2, $3, $4, $5)
       on conflict ("group_id", "identity_id") do update set "ended_at" = excluded."ended_at", "name_ciphertext" = excluded."name_ciphertext", "pseudonym" = excluded."pseudonym"`,
      [groupId, identityId, endedAt, nameCiphertext, pseudonym],
    )
  }

  // -------------------------------------------------------------------------
  // Data-subject requests, legal holds and closure (docs/contracts.md §14)
  // -------------------------------------------------------------------------

  const iso = (value: unknown) => new Date(value as string).toISOString()
  const isoOrNull = (value: unknown) => (value == null ? null : iso(value))
  const DAY_MS = 86_400_000

  /** Requests matching `where` (on `r`), newest first, as views. */
  async function requestViews(client: Client | PostgresPoolLike, where: string, values: unknown[]): Promise<RequestView[]> {
    const { rows } = await client.query(
      `select r."request_id", r."identity_id", r."type", r."origin", r."reason_code", r."status", r."opened_at", r."due_at", r."completed_at",
              r."escalated_at", r."archive_deleted_at",
              coalesce((select json_agg(json_build_object('part', p."part", 'status', p."status", 'reasonCode', p."reason_code", 'updatedAt', p."updated_at"))
                from ${s}."request_part" p where p."request_id" = r."request_id"), '[]'::json) as "parts",
              coalesce((select json_agg(g."group_id" order by g."group_id") from ${s}."request_group" g where g."request_id" = r."request_id"), '[]'::json) as "group_ids"
       from ${s}."request" r where ${where} order by r."opened_at" desc, r."request_id" desc limit 100`,
      values,
    ) as { rows: Record<string, unknown>[] }
    return rows.map((row) => {
      const parts = orderRequestParts(requestParts(), (row.parts as { part: RequestPart, status: PartStatus, reasonCode: string | null, updatedAt: string }[])
        .map(part => ({ part: part.part, status: part.status, reasonCode: part.reasonCode, updatedAt: iso(part.updatedAt) })), part => part.part)
      const completedAt = isoOrNull(row.completed_at)
      const archiveUntil = row.type === 'access' && completedAt && row.archive_deleted_at == null
        ? new Date(Date.parse(completedAt) + PROFILE_REQUEST_POLICY.archiveDays * DAY_MS).toISOString()
        : null
      return {
        requestId: row.request_id as string,
        subjectId: row.identity_id as string,
        type: row.type as RequestView['type'],
        origin: row.origin as RequestView['origin'],
        reasonCode: (row.reason_code as string | null) ?? null,
        status: row.status as RequestView['status'],
        openedAt: iso(row.opened_at),
        dueAt: iso(row.due_at),
        completedAt,
        escalatedAt: isoOrNull(row.escalated_at),
        groupIds: row.group_ids as string[],
        parts,
        archiveUntil: archiveUntil && Date.parse(archiveUntil) > now().getTime() ? archiveUntil : null,
      }
    })
  }

  /** The parts of a person's data under legal hold now. */
  async function heldParts(client: Client | PostgresPoolLike, identityId: string): Promise<Set<RequestPart>> {
    const { rows } = await client.query(
      `select distinct unnest("parts") as "part" from ${s}."legal_hold" where "identity_id" = $1 and "ended_at" is null and "ends_at" > $2`,
      [identityId, now().toISOString()],
    ) as { rows: { part: RequestPart }[] }
    return new Set(rows.map(row => row.part))
  }

  /**
   * Profile's part of a disposed group (`disposeProfileGroup`): its departure records and pseudonyms, except those of people
   * a legal hold on Profile's part covers, and its references in
   * data-subject requests, which a deleted group's name no longer needs
   * (the correction is done). Announced as `profile.group-disposed`.
   */
  async function disposeGroup(client: Client, groupId: string, correlationId: string): Promise<void> {
    const at = now().toISOString()
    const { rows: renamed } = await client.query(
      `update ${s}."request_group" g set "renamed_at" = $2 from ${s}."request" r
       where r."request_id" = g."request_id" and g."group_id" = $1 and g."renamed_at" is null and r."status" = 'open'
       returning r."identity_id"`,
      [groupId, at],
    )
    for (const person of new Set(renamed.map(row => row.identity_id as string))) await settleDirectoryParts(client, person)
    await client.query(`delete from ${s}."request_group" g using ${s}."request" r where r."request_id" = g."request_id" and g."group_id" = $1 and r."status" = 'completed'`, [groupId])
    const held = `exists (select 1 from ${s}."legal_hold" h where h."identity_id" = d."identity_id" and h."ended_at" is null and h."ends_at" > $2 and 'profile' = any (h."parts"))`
    const { rows: gone } = await client.query(`delete from ${s}."departure" d where d."group_id" = $1 and not ${held} returning 1`, [groupId, at])
    const { rows: kept } = await client.query(`select count(*)::int as "n" from ${s}."departure" d where d."group_id" = $1`, [groupId])
    if (Number(kept[0]?.n ?? 0) === 0) await client.query(`delete from ${s}."pseudonym_counter" where "group_id" = $1`, [groupId])
    await emit(client, event('profile.group-disposed', { groupId, departures: gone.length, heldDepartures: Number(kept[0]?.n ?? 0) }, correlationId))
  }

  /**
   * Retention: delivered events, completed
   * requests (with their parts and group references) and ended legal holds
   * past their periods. A completed request of a person an active hold
   * covers is kept. Announced only when something was deleted, with counts.
   */
  async function applyRetention(at: Date): Promise<{ outboxEvents: number, requests: number, legalHolds: number }> {
    const periods = retention()
    const before = (days: number) => new Date(at.getTime() - days * DAY_MS).toISOString()
    return transaction(async (client) => {
      const outbox = await client.query(`delete from ${s}."outbox" where "published_at" is not null and "published_at" <= $1 returning 1`, [before(periods.outboxDays)])
      // Requests and holds through the owner's function, which holds the floors and the hold rule itself.
      const { rows } = await client.query(`select ${s}.apply_retention($1, $2, $3) as "result"`, [at.toISOString(), periods.requestDays, periods.endedHoldDays])
      const records = rows[0]?.result as { requests: number, legalHolds: number }
      const counts = { outboxEvents: outbox.rows.length, requests: records.requests, legalHolds: records.legalHolds }
      if (counts.outboxEvents + counts.requests + counts.legalHolds > 0) await emit(client, event('profile.retention-applied', counts, uuidv7(at.getTime())))
      return counts
    })
  }

  async function isClosed(client: Client, identityId: string): Promise<boolean> {
    const { rows } = await client.query(`select 1 from ${s}."closed_identity" where "identity_id" = $1`, [identityId])
    return rows.length > 0
  }

  /** Completes an open request once every part is done or exempt, announcing each part's outcome. */
  async function checkCompletion(client: Client, requestId: string): Promise<void> {
    const { rows } = await client.query(
      `select r."identity_id", r."status" as "request_status", r."correlation_id", p."part", p."status", p."reason_code"
       from ${s}."request" r join ${s}."request_part" p using ("request_id") where r."request_id" = $1 for update of r`,
      [requestId],
    )
    if (rows.length === 0 || rows[0]!.request_status !== 'open') return
    if (rows.some(row => row.status === 'pending' || row.status === 'held')) return
    await client.query(`update ${s}."request" set "status" = 'completed', "completed_at" = $2 where "request_id" = $1`, [requestId, now().toISOString()])
    const parts = orderRequestParts(requestParts(), rows
      .map(row => ({ part: row.part as RequestPart, status: row.status as PartStatus, reasonCode: (row.reason_code as string | null) ?? null })), part => part.part)
    await emit(client, event('profile.request-completed', { requestId, identityId: rows[0]!.identity_id as string, parts }, rows[0]!.correlation_id as string))
  }

  /** Sets the status of these parts of the person's open requests of this type, from the given statuses, and completes what it can. */
  async function setParts(client: Client, identityId: string, type: RequestView['type'], parts: readonly RequestPart[], status: PartStatus, from: readonly PartStatus[] = ['pending', 'held']): Promise<void> {
    const { rows } = await client.query(
      `update ${s}."request_part" p set "status" = $4, "updated_at" = $6
       from ${s}."request" r
       where r."request_id" = p."request_id" and r."identity_id" = $1 and r."type" = $2 and r."status" = 'open'
         and p."part" = any ($3::text[]) and p."status" = any ($5::text[])
       returning p."request_id"`,
      [identityId, type, parts, status, from, now().toISOString()],
    )
    for (const requestId of new Set(rows.map(row => row.request_id as string))) await checkCompletion(client, requestId)
  }

  /**
   * The directory part of a person's open correction and erasure requests
   * is done once every group they name is renamed, and, for erasure, once
   * the person's account is closed. Nothing without a directory part.
   */
  async function settleDirectoryParts(client: Client, identityId: string): Promise<void> {
    const directory = requestParts().directory
    if (!directory) return
    const closed = await isClosed(client, identityId)
    const { rows } = await client.query(
      `select r."request_id" from ${s}."request" r join ${s}."request_part" p using ("request_id")
       where r."identity_id" = $1 and r."status" = 'open' and p."part" = $3 and p."status" = 'pending'
         and (r."type" = 'correction' or (r."type" = 'erasure' and $2::boolean))
         and not exists (select 1 from ${s}."request_group" g where g."request_id" = r."request_id" and g."renamed_at" is null)`,
      [identityId, closed, directory],
    )
    for (const row of rows) {
      await client.query(`update ${s}."request_part" set "status" = 'done', "updated_at" = $2 where "request_id" = $1 and "part" = $3`, [row.request_id, now().toISOString(), directory])
      await checkCompletion(client, row.request_id as string)
    }
  }

  /**
   * The person's account is closed (`closeProfileSubject`): Profile erases
   * the record, unless a legal hold covers Profile's part, when it keeps it,
   * read by nobody, until the hold ends. Parts of open erasure requests
   * follow: each other holdable part a hold covers waits as `held`.
   */
  async function closeSubject(client: Client, identityId: string, correlationId: string): Promise<void> {
    await client.query(`insert into ${s}."closed_identity" ("identity_id", "closed_at") values ($1, $2) on conflict do nothing`, [identityId, now().toISOString()])
    const held = await heldParts(client, identityId)
    if (held.has('profile')) {
      await client.query(
        `insert into ${s}."held_closure" ("identity_id", "closed_at") select "identity_id", $2::timestamptz from ${s}."subject_key" where "identity_id" = $1 on conflict do nothing`,
        [identityId, now().toISOString()],
      )
      await setParts(client, identityId, 'erasure', ['profile'], 'held', ['pending'])
    }
    else {
      await erase(client, identityId, 'identity-closed', correlationId)
      await setParts(client, identityId, 'erasure', ['profile'], 'done')
    }
    const others = [...held].filter(part => part !== PROFILE_REQUEST_PART)
    if (others.length > 0) await setParts(client, identityId, 'erasure', others, 'held', ['pending'])
    await settleDirectoryParts(client, identityId)
  }

  /**
   * Ends a hold, then carries out what it deferred: Profile erases a closed
   * person's record if no hold covers it any more, and the host's handler
   * erases the other parts released (`profile.legal-hold-ended`).
   */
  async function endHold(client: Client, holdId: string, reasonCode: string, correlationId: string): Promise<boolean> {
    const ended = await client.query(
      `update ${s}."legal_hold" set "ended_at" = $2, "end_reason" = $3 where "hold_id" = $1 and "ended_at" is null returning "identity_id", "parts"`,
      [holdId, now().toISOString(), reasonCode],
    )
    const hold = ended.rows[0]
    if (!hold) return false
    const identityId = hold.identity_id as string
    const parts = hold.parts as RequestPart[]
    const remaining = await heldParts(client, identityId)
    const released = parts.filter(part => !remaining.has(part))
    const closed = await isClosed(client, identityId)
    if (closed && released.includes('profile')) {
      const kept = await client.query(`delete from ${s}."held_closure" where "identity_id" = $1 returning 1`, [identityId])
      if (kept.rows.length > 0) await erase(client, identityId, 'identity-closed', correlationId)
      await setParts(client, identityId, 'erasure', ['profile'], 'done')
    }
    // The host's parts wait again for the host to report them done.
    const others = released.filter(part => part !== 'profile')
    if (others.length > 0) await setParts(client, identityId, 'erasure', others, 'pending', ['held'])
    await emit(client, event('profile.legal-hold-ended', {
      holdId,
      identityId,
      parts: orderRequestParts(requestParts(), parts, part => part),
      released: orderRequestParts(requestParts(), released, part => part),
      identityClosed: closed,
      reasonCode,
    }, correlationId))
    return true
  }

  /** Profile's own part of an access request: the record, settings and departures, and the person's requests and holds. */
  async function profileBundle(identityId: string) {
    const record = await poolRead(() => readRecord(pool, identityId))
    const { rows } = await poolRead(() => pool.query(
      `select "group_id", "ended_at", "name_ciphertext", "pseudonym", "anonymised" from ${s}."departure" where "identity_id" = $1 order by "ended_at", "group_id"`,
      [identityId],
    ) as Promise<{ rows: Record<string, unknown>[] }>)
    const holds = await poolRead(() => pool.query(
      `select "hold_id", "parts", "reason_code", "placed_at", "ends_at", "ended_at" from ${s}."legal_hold" where "identity_id" = $1 order by "placed_at"`,
      [identityId],
    ) as Promise<{ rows: Record<string, unknown>[] }>)
    return {
      attributes: record?.attributes ?? {},
      settings: record?.settings ?? DEFAULT_DISCLOSURE_SETTINGS,
      departures: rows.map(row => ({
        groupId: row.group_id as string,
        endedAt: iso(row.ended_at),
        name: row.name_ciphertext && record ? openOrFail(record.key, row.name_ciphertext as Uint8Array, aad.departureName(identityId, row.group_id as string)) : null,
        pseudonym: (row.pseudonym as number | null) ?? null,
        anonymised: row.anonymised === true,
      })),
      requests: await poolRead(() => requestViews(pool, 'r."identity_id" = $1', [identityId])),
      legalHolds: holds.rows.map(row => ({ holdId: row.hold_id, parts: row.parts, reasonCode: row.reason_code, placedAt: iso(row.placed_at), endsAt: iso(row.ends_at), endedAt: isoOrNull(row.ended_at) })),
    }
  }

  /**
   * Answers the pending parts of an open access request: Profile's own, and
   * each coordinated part through the coordination port, one at a time. Each
   * bundle is sealed with the person's key. A part whose answer fails stays
   * pending, for maintenance to retry; a part neither Profile's nor
   * coordinated waits for an operator. Nothing partial is ever complete.
   */
  async function fulfilAccess(requestId: string): Promise<void> {
    const { rows } = await poolRead(() => pool.query(
      `select r."identity_id", r."correlation_id", p."part" from ${s}."request" r join ${s}."request_part" p using ("request_id")
       where r."request_id" = $1 and r."type" = 'access' and r."status" = 'open' and p."status" = 'pending' order by p."part"`,
      [requestId],
    ) as Promise<{ rows: { identity_id: string, correlation_id: string, part: RequestPart }[] }>)
    const coordinated = requestParts().coordinated
    for (const row of rows) {
      const identityId = row.identity_id
      if (row.part !== PROFILE_REQUEST_PART && !coordinated.includes(row.part)) continue
      let bundle: unknown
      try {
        bundle = row.part === PROFILE_REQUEST_PART
          ? await profileBundle(identityId)
          : await coordinator().exportPart({ identityId, part: row.part, correlationId: row.correlation_id })
      }
      catch {
        continue
      }
      await transaction(async (client) => {
        if (await ensureRecord(client, identityId, row.correlation_id) === 'erased') return
        const record = (await readRecord(client, identityId))!
        const sealed = seal(record.key, JSON.stringify(bundle ?? null), aad.requestPart(identityId, requestId, row.part))
        const updated = await client.query(
          `update ${s}."request_part" set "status" = 'done', "ciphertext" = $3, "updated_at" = $4 where "request_id" = $1 and "part" = $2 and "status" = 'pending' returning 1`,
          [requestId, row.part, sealed, now().toISOString()],
        )
        if (updated.rows.length > 0) await checkCompletion(client, requestId)
      })
    }
  }

  const holdView = (row: Record<string, unknown>): LegalHoldView => ({
    holdId: row.hold_id as string,
    identityId: row.identity_id as string,
    parts: orderRequestParts(requestParts(), row.parts as string[], part => part),
    reasonCode: row.reason_code as string,
    placedAt: iso(row.placed_at),
    endsAt: iso(row.ends_at),
    endedAt: isoOrNull(row.ended_at),
  })

  const verifiableOf = (value: unknown): VerifiableAttribute => {
    if (typeof value !== 'string' || !(VERIFIABLE_ATTRIBUTES as readonly string[]).includes(value)) throw new ProfileFailure('validation-failed', 'invalid-attribute')
    return value as VerifiableAttribute
  }

  /** Runs a command once: records its id and applies it in one transaction; `duplicate` if the id was already applied. */
  async function once(command: { commandId: string }, run: (client: Client) => Promise<void>): Promise<ProfileCommandResult> {
    return transaction(async (client) => {
      const fresh = await client.query(`insert into ${s}."processed_event" ("event_id", "processed_at") values ($1, $2) on conflict do nothing returning 1`, [command.commandId, now().toISOString()])
      if (fresh.rows.length === 0) return 'duplicate'
      await run(client)
      return 'applied'
    })
  }

  return {
    /** The person's own record and settings. Defaults for someone with no record yet; null once erased. */
    async own(input: { subjectId: unknown }): Promise<OwnProfile | null> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      if (await poolRead(() => isWithheld(pool, subjectId))) return null
      const record = await poolRead(() => readRecord(pool, subjectId))
      return record ? { attributes: record.attributes, settings: record.settings, version: record.version } : { attributes: {}, settings: DEFAULT_DISCLOSURE_SETTINGS, version: 0 }
    },

    /** The person changes their own attributes: values set, `null` removes. Contact details are stored unverified. */
    async update(input: { subjectId: unknown, changes: unknown, correlationId: unknown, expectedVersion?: unknown }): Promise<OwnProfile> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const changes = parse(() => profileChangesSchema.parse(input.changes))
      const expected = expectedVersionOf(input.expectedVersion)
      return transaction(async (client) => {
        await checkVersion(client, subjectId, expected)
        if (await ensureRecord(client, subjectId, correlationId) === 'erased') throw new ProfileFailure('forbidden')
        const record = (await readRecord(client, subjectId, true))!
        const attributes: Record<string, unknown> = { ...record.attributes }
        const changed: ProfileAttribute[] = []
        for (const key of PROFILE_ATTRIBUTES) {
          if (!(key in changes)) continue
          const value = changes[key]
          const claim = VERIFICATION_CLAIMS[key]
          if (value === null || value === undefined) {
            delete attributes[key]
            if (claim) delete attributes[claim]
          }
          else {
            attributes[key] = value
            if (claim) attributes[claim] = false
          }
          changed.push(key)
        }
        record.attributes = attributes as ProfileAttributes
        await writeRecord(client, subjectId, record)
        // A code sent to the old value never verifies the new one.
        const contacts = changed.filter(key => (VERIFIABLE_ATTRIBUTES as readonly string[]).includes(key))
        if (contacts.length > 0) await client.query(`delete from ${s}."contact_verification" where "identity_id" = $1 and "attribute" = any ($2::text[])`, [subjectId, contacts])
        await emit(client, event('profile.changed', { identityId: subjectId, attributes: changed, disclosure: false }, correlationId))
        return { attributes: record.attributes, settings: record.settings, version: record.version + 1 }
      })
    },

    /** The person sets who sees each attribute, which name others see, and their departure choice. */
    async setDisclosure(input: { subjectId: unknown, settings: unknown, correlationId: unknown, expectedVersion?: unknown }): Promise<OwnProfile> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const settings = parse(() => disclosureSettingsSchema.parse(input.settings))
      const expected = expectedVersionOf(input.expectedVersion)
      return transaction(async (client) => {
        await checkVersion(client, subjectId, expected)
        if (await ensureRecord(client, subjectId, correlationId) === 'erased') throw new ProfileFailure('forbidden')
        const record = (await readRecord(client, subjectId, true))!
        record.settings = settings
        await writeRecord(client, subjectId, record)
        await emit(client, event('profile.changed', { identityId: subjectId, attributes: [], disclosure: true }, correlationId))
        return { attributes: record.attributes, settings: record.settings, version: record.version + 1 }
      })
    },

    /**
     * The person chooses to be shown as "Former member" in a group, whatever
     * its policy: the name kept and the pseudonym are deleted.
     */
    async anonymiseDeparture(input: { subjectId: unknown, groupId: unknown, correlationId: unknown }): Promise<void> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      const groupId = parse(() => identifierSchema.parse(input.groupId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      await transaction(async (client) => {
        await client.query(
          `insert into ${s}."departure" ("group_id", "identity_id", "ended_at", "anonymised") values ($1, $2, $3, true)
           on conflict ("group_id", "identity_id") do update set "name_ciphertext" = null, "pseudonym" = null, "anonymised" = true`,
          [groupId, subjectId, now().toISOString()],
        )
        await emit(client, event('profile.departure-anonymised', { identityId: subjectId, groupId }, correlationId))
      })
    },

    /**
     * Counts one lookup by the viewer against `PROFILE_LOOKUP_RATE_LIMIT`.
     * Refuses with `rate-limited` once the window's allowance is spent.
     */
    async consumeLookup(input: { viewerId: unknown }): Promise<void> {
      const viewerId = parse(() => identifierSchema.parse(input.viewerId))
      const { requests, windowSeconds } = PROFILE_LOOKUP_RATE_LIMIT
      const at = now().getTime()
      const windowStart = new Date(at - (at % (windowSeconds * 1000))).toISOString()
      const count = await transaction(async (client) => {
        await client.query(`delete from ${s}."lookup_window" where "viewer_id" = $1 and "window_start" < $2`, [viewerId, windowStart])
        const { rows } = await client.query(
          `insert into ${s}."lookup_window" ("viewer_id", "window_start", "count") values ($1, $2, 1)
           on conflict ("viewer_id", "window_start") do update set "count" = ${s}."lookup_window"."count" + 1 returning "count"`,
          [viewerId, windowStart],
        )
        return rows[0]!.count as number
      })
      if (count > requests) throw new ProfileFailure('rate-limited')
    },

    /** Display names for up to 200 people, as the viewer may see them, in the order asked. */
    async displayNames(input: { viewerId: unknown, subjectIds: unknown, groupId?: unknown, purpose: unknown, subject?: unknown }): Promise<{ subjectId: string, displayName: DisplayName }[]> {
      const answers = await lookup(input)
      return answers.map(({ subjectId, input: disclosureInput }) => ({ subjectId, displayName: discloseDisplayName(disclosureInput) }))
    },

    /** One person's profile as the viewer may see it now. Never says whether a record exists. */
    async view(input: { viewerId: unknown, subjectId: unknown, groupId?: unknown }): Promise<{ subjectId: string, displayName: DisplayName, attributes: ProfileAttributes }> {
      const [answer] = await lookup({ viewerId: input.viewerId, subjectIds: [input.subjectId], groupId: input.groupId, purpose: 'listing' })
      return { subjectId: answer!.subjectId, displayName: discloseDisplayName(answer!.input), attributes: discloseAttributes(answer!.input) }
    },

    /** Profile's part of a data-subject export: the record, the settings and the departures, decrypted. */
    async exportData(input: { subjectId: unknown }): Promise<{ attributes: ProfileAttributes, settings: DisclosureSettings, departures: DepartureExport[] } | null> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      if (await poolRead(() => isWithheld(pool, subjectId))) return null
      const record = await poolRead(() => readRecord(pool, subjectId))
      const { rows } = await poolRead(() => pool.query(
        `select "group_id", "ended_at", "name_ciphertext", "pseudonym", "anonymised" from ${s}."departure" where "identity_id" = $1 order by "ended_at", "group_id"`,
        [subjectId],
      ) as Promise<{ rows: Record<string, unknown>[] }>)
      return {
        attributes: record?.attributes ?? {},
        settings: record?.settings ?? DEFAULT_DISCLOSURE_SETTINGS,
        departures: rows.map(row => ({
          groupId: row.group_id as string,
          endedAt: new Date(row.ended_at as string).toISOString(),
          name: row.name_ciphertext && record ? openOrFail(record.key, row.name_ciphertext as Uint8Array, aad.departureName(subjectId, row.group_id as string)) : null,
          pseudonym: (row.pseudonym as number | null) ?? null,
          anonymised: row.anonymised === true,
        })),
      }
    },

    // -----------------------------------------------------------------------
    // Commands from the host (docs/contracts.md §9). Each is idempotent by
    // `commandId`, recorded in the same transaction as its effect.
    // -----------------------------------------------------------------------

    /** A person now exists: their empty record and key. Never recreated once erased. */
    async provisionRecord(input: unknown): Promise<ProfileCommandResult> {
      const command = parse(() => provisionCommandSchema.parse(input))
      return once(command, client => ensureRecord(client, command.subjectId, command.correlationId).then(() => {}))
    },

    /** The person's membership of a group ended: keep how they are shown there. */
    async recordDeparture(input: unknown): Promise<ProfileCommandResult> {
      const command = parse(() => departureCommandSchema.parse(input))
      const endedAt = new Date(command.endedAt).toISOString()
      return once(command, client => snapshotDeparture(client, command.subjectId, command.groupId, endedAt))
    },

    /** The person's account is closed: erase the record, unless a legal hold covers Profile's part. */
    async closeSubject(input: unknown): Promise<ProfileCommandResult> {
      const command = parse(() => closureCommandSchema.parse(input))
      return once(command, client => closeSubject(client, command.subjectId, command.correlationId))
    },

    /** The person paused their account: the directory part of their open restriction requests is done. */
    async recordPause(input: unknown): Promise<ProfileCommandResult> {
      const command = parse(() => pauseCommandSchema.parse(input))
      return once(command, async (client) => {
        const directory = requestParts().directory
        if (directory) await setParts(client, command.subjectId, 'restriction', [directory], 'done', ['pending'])
      })
    },

    /** A group was renamed: requests naming it may now be complete. */
    async recordGroupRenamed(input: unknown): Promise<ProfileCommandResult> {
      const command = parse(() => groupRenamedCommandSchema.parse(input))
      return once(command, async (client) => {
        const { rows } = await client.query(
          `update ${s}."request_group" g set "renamed_at" = $2 from ${s}."request" r
           where r."request_id" = g."request_id" and g."group_id" = $1 and g."renamed_at" is null and r."status" = 'open'
           returning r."identity_id"`,
          [command.groupId, now().toISOString()],
        )
        for (const person of new Set(rows.map(row => row.identity_id as string))) await settleDirectoryParts(client, person)
      })
    },

    /** A deleted group's disposal is due: delete what Profile keeps for it. */
    async disposeGroup(input: unknown): Promise<ProfileCommandResult> {
      const command = parse(() => groupDisposalCommandSchema.parse(input))
      return once(command, client => disposeGroup(client, command.groupId, command.correlationId))
    },

    /**
     * Erases a person's record: deletes it, their departures and their key,
     * and records the identity so no record is created for it again.
     * Announced as `profile.anonymised`. Returns false if already erased.
     */
    async erase(input: { identityId: unknown, reasonCode: unknown, correlationId: unknown }): Promise<boolean> {
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const reasonCode = parse(() => reasonCodeSchema.parse(input.reasonCode))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      return transaction(async (client) => {
        if ((await heldParts(client, identityId)).has('profile')) throw new ProfileFailure('conflict', 'legal-hold')
        return erase(client, identityId, reasonCode, correlationId)
      })
    },

    /**
     * Maintenance: re-wraps up to `limit` keys still wrapped with an older
     * version under the current one. Returns how many were moved.
     */
    async rewrapKeys(input: { limit?: number } = {}): Promise<number> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 1000))
      const current = keys.currentVersion()
      const at = now().toISOString()
      return transaction(async (client) => {
        const { rows } = await client.query(
          `select "identity_id", "key_version", "wrapped_key" from ${s}."subject_key" where "key_version" <> $1 order by "identity_id" limit $2 for update skip locked`,
          [current, limit],
        )
        for (const row of rows) {
          const identityId = row.identity_id as string
          const key = await unwrap(identityId, row.key_version as string, row.wrapped_key as string)
          let wrapped
          try {
            wrapped = await keys.wrap(key, { identityId })
          }
          catch {
            throw new ProfileFailure('unavailable', 'key wrapping failed')
          }
          await client.query(
            `update ${s}."subject_key" set "key_version" = $2, "wrapped_key" = $3, "rewrapped_at" = $4 where "identity_id" = $1`,
            [identityId, wrapped.version, wrapped.wrapped, at],
          )
        }
        return rows.length
      })
    },

    /** How many live keys each wrapping-key version still protects, so the host knows when one can be retired. */
    async keyVersionsInUse(): Promise<{ version: string, keys: number }[]> {
      const { rows } = await poolRead(() => pool.query(
        `select "key_version", count(*)::int as "keys" from ${s}."subject_key" group by "key_version" order by "key_version"`,
      ) as Promise<{ rows: { key_version: string, keys: number }[] }>)
      return rows.map(row => ({ version: row.key_version, keys: row.keys }))
    },

    /**
     * Publishes up to `limit` outbox events in order. Stops at the first
     * failure, leaving it and the rest for the next run. Returns how many
     * were published.
     */
    async relayOutbox(input: { publish: ProfileEventPublisher, limit?: number }): Promise<number> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 1000))
      return transaction(async (client) => {
        const { rows } = await client.query(
          `select "sequence", "event" from ${s}."outbox" where "published_at" is null order by "sequence" limit $1 for update skip locked`,
          [limit],
        )
        const published: unknown[] = []
        for (const row of rows) {
          try {
            await input.publish(row.event as ProfileEvent)
          }
          catch {
            break
          }
          published.push(row.sequence)
        }
        if (published.length > 0) {
          await client.query(`update ${s}."outbox" set "published_at" = $2 where "sequence" = any ($1::bigint[])`, [published, now().toISOString()])
        }
        return published.length
      })
    },

    // -----------------------------------------------------------------------
    // Data-subject requests (docs/contracts.md §14)
    // -----------------------------------------------------------------------

    /**
     * Opens a data-subject request: records it, its parts and its due date,
     * and starts what can start now. An access request is answered at once
     * as far as the members answer; a restriction sets every audience to
     * `nobody`. The person may open only access and restriction requests;
     * an operator any type, with a reason code. Parts are Profile's own
     * and the host's declared ones; naming groups adds the directory part.
     */
    async openRequest(input: unknown): Promise<RequestView> {
      const request = parse(() => openRequestSchema.parse(input))
      if (request.origin === 'person' && (!(PERSON_REQUEST_TYPES as readonly string[]).includes(request.type) || request.reasonCode)) throw new ProfileFailure('validation-failed', 'not-for-person')
      if (request.origin === 'operator' && !request.reasonCode) throw new ProfileFailure('validation-failed', 'reason-required')
      const groupIds = [...new Set(request.groupIds ?? [])]
      if (groupIds.length > 0 && request.type !== 'correction' && request.type !== 'erasure') throw new ProfileFailure('validation-failed', 'groups-not-allowed')
      const declared = requestParts()
      if (request.parts?.some(part => !declared.all.includes(part))) throw new ProfileFailure('validation-failed', 'unknown-part')
      const wanted = new Set<RequestPart>([PROFILE_REQUEST_PART, ...(request.parts ?? declared.defaults[request.type])])
      if (groupIds.length > 0) {
        if (!declared.directory) throw new ProfileFailure('validation-failed', 'groups-not-allowed')
        wanted.add(declared.directory)
      }
      if (request.type === 'correction' && declared.directory && wanted.has(declared.directory) && groupIds.length === 0) throw new ProfileFailure('validation-failed', 'groups-required')
      const parts = declared.all.filter(part => wanted.has(part))
      // An access request with coordinated parts needs the coordination port: refuse it before recording anything if the host has not composed it.
      if (request.type === 'access' && parts.some(part => declared.coordinated.includes(part))) coordinator()
      const opened = now()
      const requestId = uuidv7(opened.getTime())
      const dueAt = requestDueAt(opened).toISOString()
      await transaction(async (client) => {
        if (await isWithheld(client, request.subjectId)) throw new ProfileFailure('forbidden')
        await client.query(
          `insert into ${s}."request" ("request_id", "identity_id", "type", "origin", "reason_code", "correlation_id", "opened_at", "due_at") values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [requestId, request.subjectId, request.type, request.origin, request.reasonCode ?? null, request.correlationId, opened.toISOString(), dueAt],
        )
        for (const part of parts) {
          await client.query(`insert into ${s}."request_part" ("request_id", "part", "updated_at") values ($1, $2, $3)`, [requestId, part, opened.toISOString()])
        }
        for (const groupId of groupIds) {
          await client.query(`insert into ${s}."request_group" ("request_id", "group_id") values ($1, $2)`, [requestId, groupId])
        }
        await emit(client, event('profile.request-opened', { requestId, identityId: request.subjectId, type: request.type, origin: request.origin, parts, dueAt }, request.correlationId))
        if (request.type === 'restriction') {
          await ensureRecord(client, request.subjectId, request.correlationId)
          const record = (await readRecord(client, request.subjectId, true))!
          record.settings = { ...record.settings, audiences: Object.fromEntries(PROFILE_ATTRIBUTES.map(key => [key, 'nobody'])) as DisclosureSettings['audiences'] }
          await writeRecord(client, request.subjectId, record)
          await emit(client, event('profile.changed', { identityId: request.subjectId, attributes: [], disclosure: true }, request.correlationId))
          await setParts(client, request.subjectId, 'restriction', ['profile'], 'done', ['pending'])
        }
        if (request.type === 'erasure' && await isClosed(client, request.subjectId)) await settleDirectoryParts(client, request.subjectId)
        await checkCompletion(client, requestId)
      })
      if (request.type === 'access') await fulfilAccess(requestId)
      const [view] = await poolRead(() => requestViews(pool, 'r."request_id" = $1', [requestId]))
      return view!
    },

    /** The person's requests, newest first (up to 100). */
    async listRequests(input: { subjectId: unknown }): Promise<RequestView[]> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      return poolRead(() => requestViews(pool, 'r."identity_id" = $1', [subjectId]))
    },

    /** One request, for an operator. Null when unknown. */
    async getRequest(input: { requestId: unknown }): Promise<RequestView | null> {
      const requestId = parse(() => identifierSchema.parse(input.requestId))
      const [view] = await poolRead(() => requestViews(pool, 'r."request_id" = $1', [requestId]))
      return view ?? null
    },

    /**
     * The archive of a completed access request, assembled from each
     * member's part, for the person who asked, for `archiveDays` after it
     * completed. Anything else is `forbidden`, alike.
     */
    async archive(input: { subjectId: unknown, requestId: unknown }): Promise<{ requestId: string, subjectId: string, openedAt: string, completedAt: string, parts: Record<string, unknown> }> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      const requestId = parse(() => identifierSchema.parse(input.requestId))
      const [view] = await poolRead(() => requestViews(pool, 'r."request_id" = $1 and r."identity_id" = $2', [requestId, subjectId]))
      if (!view || !view.archiveUntil || await poolRead(() => isWithheld(pool, subjectId))) throw new ProfileFailure('forbidden')
      const record = await poolRead(() => readRecord(pool, subjectId))
      if (!record) throw new ProfileFailure('forbidden')
      const { rows } = await poolRead(() => pool.query(
        `select "part", "ciphertext" from ${s}."request_part" where "request_id" = $1 and "status" = 'done'`,
        [requestId],
      ) as Promise<{ rows: { part: RequestPart, ciphertext: Uint8Array | null }[] }>)
      const parts: Record<string, unknown> = {}
      for (const row of orderRequestParts(requestParts(), rows, candidate => candidate.part)) {
        const part = row.part
        parts[part] = row.ciphertext ? JSON.parse(openOrFail(record.key, row.ciphertext, aad.requestPart(subjectId, requestId, part))) : null
      }
      return { requestId, subjectId, openedAt: view.openedAt, completedAt: view.completedAt!, parts }
    },

    /** An operator settles one part by hand: `done`, or `exempt` with the exemption claimed. */
    async settlePart(input: unknown): Promise<RequestView> {
      const settled = parse(() => settlePartSchema.parse(input))
      if (settled.outcome === 'exempt' && !settled.reasonCode) throw new ProfileFailure('validation-failed', 'reason-required')
      await transaction(async (client) => {
        const { rows } = await client.query(
          `update ${s}."request_part" p set "status" = $3, "reason_code" = $4, "updated_at" = $5 from ${s}."request" r
           where r."request_id" = p."request_id" and p."request_id" = $1 and p."part" = $2 and r."status" = 'open' and p."status" in ('pending', 'held')
           returning 1`,
          [settled.requestId, settled.part, settled.outcome, settled.outcome === 'exempt' ? settled.reasonCode : null, now().toISOString()],
        )
        if (rows.length === 0) throw new ProfileFailure('conflict', 'not-pending')
        await checkCompletion(client, settled.requestId)
      })
      const [view] = await poolRead(() => requestViews(pool, 'r."request_id" = $1', [settled.requestId]))
      return view!
    },

    /**
     * The host reports its erasure of one of its declared parts done, for
     * any open erasure request for the person. Not Profile's part, nor the
     * directory part, which Profile settles from its own commands.
     */
    async recordRequestPart(input: { identityId: unknown, part: unknown, correlationId: unknown }): Promise<void> {
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      parse(() => correlationIdSchema.parse(input.correlationId))
      const declared = requestParts()
      const part = input.part
      if (typeof part !== 'string' || part === PROFILE_REQUEST_PART || part === declared.directory || !declared.all.includes(part)) throw new ProfileFailure('validation-failed', 'invalid-part')
      await transaction(client => setParts(client, identityId, 'erasure', [part], 'done'))
    },

    // -----------------------------------------------------------------------
    // Legal holds (docs/contracts.md §14)
    // -----------------------------------------------------------------------

    /** An operator places a legal hold: it defers the erasure of the parts it covers until `endsAt` or release. */
    async placeHold(input: unknown): Promise<LegalHoldView> {
      const hold = parse(() => placeHoldSchema.parse(input))
      const at = now()
      const endsAt = Date.parse(hold.endsAt)
      if (!(endsAt > at.getTime()) || endsAt > at.getTime() + PROFILE_REQUEST_POLICY.holdMaxDays * DAY_MS) throw new ProfileFailure('validation-failed', 'invalid-end')
      const holdable = requestParts().holdable
      if (hold.parts.some(part => !holdable.includes(part))) throw new ProfileFailure('validation-failed', 'invalid-part')
      const holdId = uuidv7(at.getTime())
      const parts = holdable.filter(part => hold.parts.includes(part))
      const row = await transaction(async (client) => {
        const { rows } = await client.query(
          `insert into ${s}."legal_hold" ("hold_id", "identity_id", "parts", "reason_code", "placed_at", "ends_at") values ($1, $2, $3, $4, $5, $6) returning *`,
          [holdId, hold.identityId, parts, hold.reasonCode, at.toISOString(), new Date(endsAt).toISOString()],
        )
        await emit(client, event('profile.legal-hold-placed', { holdId, identityId: hold.identityId, parts, reasonCode: hold.reasonCode, endsAt: new Date(endsAt).toISOString() }, hold.correlationId))
        return rows[0]!
      })
      return holdView(row)
    },

    /** An operator releases a hold before its end date; what it deferred happens now. */
    async releaseHold(input: { holdId: unknown, reasonCode: unknown, correlationId: unknown }): Promise<void> {
      const holdId = parse(() => identifierSchema.parse(input.holdId))
      const reasonCode = parse(() => reasonCodeSchema.parse(input.reasonCode))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const ended = await transaction(client => endHold(client, holdId, reasonCode, correlationId))
      if (!ended) throw new ProfileFailure('conflict', 'not-active')
    },

    /** The parts of a person's data under legal hold now, for the host's closure handling. */
    async heldParts(input: { identityId: unknown }): Promise<RequestPart[]> {
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const held = await poolRead(() => heldParts(pool, identityId))
      return orderRequestParts(requestParts(), [...held], part => part)
    },

    /** A person's holds, current and past. */
    async listHolds(input: { identityId: unknown }): Promise<LegalHoldView[]> {
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const { rows } = await poolRead(() => pool.query(`select * from ${s}."legal_hold" where "identity_id" = $1 order by "placed_at" desc limit 100`, [identityId]) as Promise<{ rows: Record<string, unknown>[] }>)
      return rows.map(holdView)
    },

    /**
     * Maintenance: ends holds past their end date; deletes access archives
     * past `archiveDays`; raises to operators requests near their due date
     * and group renames overdue at half the deadline; retries access parts a
     * member failed; drops expired verification codes. Returns the counts.
     */
    async maintain(): Promise<{ holdsEnded: number, archivesDeleted: number, escalated: number, accessRetried: number, codesExpired: number, retention: { outboxEvents: number, requests: number, legalHolds: number } }> {
      const at = now()
      const atIso = at.toISOString()
      const expiredHolds = await poolRead(() => pool.query(
        `select "hold_id" from ${s}."legal_hold" where "ended_at" is null and "ends_at" <= $1 order by "ends_at" limit 100`,
        [atIso],
      ) as Promise<{ rows: { hold_id: string }[] }>)
      let holdsEnded = 0
      for (const { hold_id: holdId } of expiredHolds.rows) {
        if (await transaction(client => endHold(client, holdId, 'expired', uuidv7(at.getTime())))) holdsEnded += 1
      }
      const archivesDeleted = await transaction(async (client) => {
        const { rows } = await client.query(
          `update ${s}."request" set "archive_deleted_at" = $1
           where "type" = 'access' and "status" = 'completed' and "archive_deleted_at" is null and "completed_at" <= $2 returning "request_id"`,
          [atIso, new Date(at.getTime() - PROFILE_REQUEST_POLICY.archiveDays * DAY_MS).toISOString()],
        )
        if (rows.length > 0) await client.query(`update ${s}."request_part" set "ciphertext" = null where "request_id" = any ($1::text[])`, [rows.map(row => row.request_id)])
        return rows.length
      })
      const escalated = await transaction(async (client) => {
        const due = await client.query(
          `update ${s}."request" set "escalated_at" = $1 where "status" = 'open' and "escalated_at" is null and "due_at" <= $2
           returning "request_id", "identity_id", "correlation_id"`,
          [atIso, new Date(at.getTime() + PROFILE_REQUEST_POLICY.escalateDaysBeforeDue * DAY_MS).toISOString()],
        )
        for (const row of due.rows) {
          await emit(client, event('profile.request-escalated', { requestId: row.request_id as string, identityId: row.identity_id as string, reasonCode: 'due-soon' }, row.correlation_id as string))
        }
        const renames = await client.query(
          `update ${s}."request" r set "rename_escalated_at" = $1
           where r."status" = 'open' and r."rename_escalated_at" is null and r."type" in ('correction', 'erasure')
             and r."opened_at" + (r."due_at" - r."opened_at") / 2 <= $1
             and exists (select 1 from ${s}."request_group" g where g."request_id" = r."request_id" and g."renamed_at" is null)
           returning r."request_id", r."identity_id", r."correlation_id"`,
          [atIso],
        )
        for (const row of renames.rows) {
          await emit(client, event('profile.request-escalated', { requestId: row.request_id as string, identityId: row.identity_id as string, reasonCode: 'group-rename-overdue' }, row.correlation_id as string))
        }
        return due.rows.length + renames.rows.length
      })
      const open = await poolRead(() => pool.query(
        `select distinct r."request_id" from ${s}."request" r join ${s}."request_part" p using ("request_id")
         where r."type" = 'access' and r."status" = 'open' and p."status" = 'pending' limit 50`,
      ) as Promise<{ rows: { request_id: string }[] }>)
      for (const { request_id: requestId } of open.rows) await fulfilAccess(requestId)
      const codesExpired = await transaction(async (client) => {
        const { rows } = await client.query(
          `update ${s}."contact_verification" set "code_digest" = null, "expires_at" = null, "attempts" = 0 where "expires_at" <= $1 returning 1`,
          [atIso],
        )
        return rows.length
      })
      const retained = await applyRetention(at)
      return { holdsEnded, archivesDeleted, escalated, accessRetried: open.rows.length, codesExpired, retention: retained }
    },

    // -----------------------------------------------------------------------
    // Contact-detail verification (docs/contracts.md §15)
    // -----------------------------------------------------------------------

    /**
     * Sends a one-time code to the person's contact detail through the
     * host's notifier. `verified` if it already is; `rate-limited` after
     * `sends` codes in the window.
     */
    async startVerification(input: { subjectId: unknown, attribute: unknown, correlationId: unknown }): Promise<{ attribute: VerifiableAttribute, status: 'sent' | 'verified', expiresAt: string | null }> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      const attribute = verifiableOf(input.attribute)
      parse(() => correlationIdSchema.parse(input.correlationId))
      const policy = PROFILE_VERIFICATION_POLICY
      const claim = VERIFICATION_CLAIMS[attribute]!
      const outcome = await transaction(async (client) => {
        if (await isWithheld(client, subjectId)) throw new ProfileFailure('forbidden')
        const record = await readRecord(client, subjectId, true)
        const value = record?.attributes[attribute]
        if (!record || value === undefined) throw new ProfileFailure('validation-failed', 'nothing-to-verify')
        if (record.attributes[claim] === true) return { status: 'verified' as const, expiresAt: null }
        const at = now()
        const { rows } = await client.query(
          `select "window_start", "sends" from ${s}."contact_verification" where "identity_id" = $1 and "attribute" = $2 for update`,
          [subjectId, attribute],
        )
        let windowStart = rows[0] ? new Date(rows[0].window_start as string) : at
        let sends = (rows[0]?.sends as number | undefined) ?? 0
        if (at.getTime() - windowStart.getTime() >= policy.sendWindowSeconds * 1000) {
          windowStart = at
          sends = 0
        }
        if (sends >= policy.sends) return { status: 'rate-limited' as const, expiresAt: null }
        const code = newCode(policy.codeDigits)
        const expiresAt = new Date(at.getTime() + policy.codeSeconds * 1000).toISOString()
        await client.query(
          `insert into ${s}."contact_verification" ("identity_id", "attribute", "code_digest", "expires_at", "attempts", "window_start", "sends") values ($1, $2, $3, $4, 0, $5, $6)
           on conflict ("identity_id", "attribute") do update set "code_digest" = excluded."code_digest", "expires_at" = excluded."expires_at", "attempts" = 0,
             "window_start" = excluded."window_start", "sends" = excluded."sends"`,
          [subjectId, attribute, codeDigest(record.key, { identityId: subjectId, attribute, value, code }), expiresAt, windowStart.toISOString(), sends + 1],
        )
        try {
          await notifier().send({ channel: VERIFICATION_CHANNELS[attribute], to: value, purpose: 'contact-verification', attribute, code, locale: record.attributes.locale ?? null, expiresInSeconds: policy.codeSeconds })
        }
        catch (error) {
          if (error instanceof ProfileFailure) throw error
          throw new ProfileFailure('unavailable', 'notifier failed')
        }
        return { status: 'sent' as const, expiresAt }
      })
      if (outcome.status === 'rate-limited') throw new ProfileFailure('rate-limited')
      return { attribute, ...outcome }
    },

    /**
     * The person types back the code. Right: the detail is verified (until
     * it changes). Wrong: one of `attempts` spent (`validation-failed`,
     * `wrong-code`). Spent, expired or never sent: `conflict`, `code-expired`.
     */
    async confirmVerification(input: { subjectId: unknown, attribute: unknown, code: unknown, correlationId: unknown }): Promise<OwnProfile> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      const attribute = verifiableOf(input.attribute)
      const code = parse(() => verificationCodeSchema.parse(input.code))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const claim = VERIFICATION_CLAIMS[attribute]!
      const outcome = await transaction(async (client) => {
        if (await isWithheld(client, subjectId)) throw new ProfileFailure('forbidden')
        const record = await readRecord(client, subjectId, true)
        const value = record?.attributes[attribute]
        const { rows } = await client.query(
          `select "code_digest", "expires_at", "attempts" from ${s}."contact_verification" where "identity_id" = $1 and "attribute" = $2 for update`,
          [subjectId, attribute],
        )
        const pending = rows[0]
        if (!record || value === undefined || !pending?.code_digest || !(new Date(pending.expires_at as string).getTime() > now().getTime())) return 'expired' as const
        if (!sameDigest(codeDigest(record.key, { identityId: subjectId, attribute, value, code }), pending.code_digest as Uint8Array)) {
          const attempts = (pending.attempts as number) + 1
          await client.query(
            `update ${s}."contact_verification" set "attempts" = $3::int, "code_digest" = case when $3::int >= $4::int then null else "code_digest" end where "identity_id" = $1 and "attribute" = $2`,
            [subjectId, attribute, attempts, PROFILE_VERIFICATION_POLICY.attempts],
          )
          return 'wrong' as const
        }
        record.attributes = { ...record.attributes, [claim]: true } as ProfileAttributes
        await writeRecord(client, subjectId, record)
        await client.query(`update ${s}."contact_verification" set "code_digest" = null, "expires_at" = null, "attempts" = 0 where "identity_id" = $1 and "attribute" = $2`, [subjectId, attribute])
        await emit(client, event('profile.contact-verified', { identityId: subjectId, attribute }, correlationId))
        return { attributes: record.attributes, settings: record.settings, version: record.version + 1 }
      })
      if (outcome === 'expired') throw new ProfileFailure('conflict', 'code-expired')
      if (outcome === 'wrong') throw new ProfileFailure('validation-failed', 'wrong-code')
      return outcome
    },

    /** The groups the person has left, for their own page: identifiers and dates only (the host shows group names). */
    async departures(input: { subjectId: unknown }): Promise<ProfileDepartureView[]> {
      const subjectId = parse(() => identifierSchema.parse(input.subjectId))
      if (await poolRead(() => isWithheld(pool, subjectId))) return []
      const { rows } = await poolRead(() => pool.query(
        `select "group_id", "ended_at", "anonymised" from ${s}."departure" where "identity_id" = $1 order by "ended_at" desc, "group_id" limit 1000`,
        [subjectId],
      ) as Promise<{ rows: Record<string, unknown>[] }>)
      return rows.map(row => ({ groupId: row.group_id as string, endedAt: iso(row.ended_at), anonymised: row.anonymised === true }))
    },
  }
}

export type ProfileService = ReturnType<typeof createService>
