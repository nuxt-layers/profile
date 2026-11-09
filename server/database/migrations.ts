import type { PostgresPoolLike } from '../../contracts'

/**
 * PRIVATE. Versioned, append-only migrations for Profile's schema
 * (ADR-0002). `{{schema}}` is replaced with the validated, quoted schema
 * identifier. Never edit a released migration; add a new one.
 *
 * Every attribute value is stored encrypted with the person's own key
 * (docs/contracts.md §6); disclosure settings, identifiers and codes are
 * stored in the clear. Nothing here names a person in plaintext.
 */
export const PROFILE_MIGRATIONS: readonly { id: string, sql: string }[] = [
  {
    id: '0001_records_keys_departures_outbox',
    sql: `
-- Each person's data key, only ever stored wrapped by the host's key port.
create table {{schema}}."subject_key" (
  "identity_id" text primary key,
  "key_version" text not null check (length("key_version") between 1 and 200),
  "wrapped_key" text not null,
  "created_at" timestamptz not null default now(),
  "rewrapped_at" timestamptz
);
create index "subject_key_version_idx" on {{schema}}."subject_key" ("key_version");

-- The record: attributes encrypted as one value; disclosure settings in the clear.
create table {{schema}}."record" (
  "identity_id" text primary key references {{schema}}."subject_key" ("identity_id") on delete cascade,
  "ciphertext" bytea not null,
  "disclosure" jsonb not null,
  "version" integer not null default 1,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

-- How a leaver is shown in a group: their name at departure (encrypted with
-- their key), their pseudonym, or nothing once they chose anonymity.
create table {{schema}}."departure" (
  "group_id" text not null,
  "identity_id" text not null,
  "ended_at" timestamptz not null,
  "name_ciphertext" bytea,
  "pseudonym" integer check ("pseudonym" > 0),
  "anonymised" boolean not null default false,
  primary key ("group_id", "identity_id"),
  unique ("group_id", "pseudonym"),
  check (not "anonymised" or ("name_ciphertext" is null and "pseudonym" is null))
);
create index "departure_identity_idx" on {{schema}}."departure" ("identity_id");

create table {{schema}}."pseudonym_counter" (
  "group_id" text primary key,
  "last" integer not null
);

-- Identities whose record was erased: no record is ever created for them again.
create table {{schema}}."erased" (
  "identity_id" text primary key,
  "reason_code" text not null,
  "erased_at" timestamptz not null default now()
);

-- Identity events already applied (consumers are idempotent by event id).
create table {{schema}}."processed_event" (
  "event_id" text primary key,
  "processed_at" timestamptz not null default now()
);

-- Transactional outbox: written in the same transaction as the change.
create table {{schema}}."outbox" (
  "sequence" bigserial primary key,
  "event" jsonb not null,
  "created_at" timestamptz not null default now(),
  "published_at" timestamptz
);
create index "outbox_unpublished_idx" on {{schema}}."outbox" ("sequence") where "published_at" is null;
`,
  },
  {
    id: '0002_lookup_rate_limit',
    sql: `
-- Lookups each viewer made in the current window (PROFILE_LOOKUP_RATE_LIMIT).
create table {{schema}}."lookup_window" (
  "viewer_id" text not null,
  "window_start" timestamptz not null,
  "count" integer not null check ("count" > 0),
  primary key ("viewer_id", "window_start")
);
`,
  },
  {
    id: '0003_requests_holds_verification',
    sql: `
-- Data-subject requests (docs/contracts.md §14): identifiers, codes and
-- times only. They outlive an erasure, as the record of what was asked and
-- answered; any bundle a part holds is sealed with the person's key, so it
-- is unreadable once the key is gone, and is deleted with it anyway.
create table {{schema}}."request" (
  "request_id" text primary key,
  "identity_id" text not null,
  "type" text not null check ("type" in ('access', 'correction', 'erasure', 'restriction')),
  "origin" text not null check ("origin" in ('person', 'operator')),
  "reason_code" text,
  "status" text not null default 'open' check ("status" in ('open', 'completed')),
  "correlation_id" text not null,
  "opened_at" timestamptz not null,
  "due_at" timestamptz not null,
  "completed_at" timestamptz,
  "escalated_at" timestamptz,
  "rename_escalated_at" timestamptz,
  "archive_deleted_at" timestamptz,
  check ("origin" = 'person' or "reason_code" is not null)
);
create index "request_identity_idx" on {{schema}}."request" ("identity_id", "opened_at");
create index "request_open_idx" on {{schema}}."request" ("due_at") where "status" = 'open';

create table {{schema}}."request_part" (
  "request_id" text not null references {{schema}}."request" ("request_id") on delete cascade,
  "part" text not null check ("part" in ('profile', 'identity', 'authentication', 'authorisation')),
  "status" text not null default 'pending' check ("status" in ('pending', 'done', 'exempt', 'held')),
  "reason_code" text,
  -- An access request's bundle for this part, sealed with the person's key.
  "ciphertext" bytea,
  "updated_at" timestamptz not null default now(),
  primary key ("request_id", "part"),
  check ("status" <> 'exempt' or "reason_code" is not null)
);

-- Groups a correction or erasure request names, and when each was renamed.
create table {{schema}}."request_group" (
  "request_id" text not null references {{schema}}."request" ("request_id") on delete cascade,
  "group_id" text not null,
  "renamed_at" timestamptz,
  primary key ("request_id", "group_id")
);
create index "request_group_group_idx" on {{schema}}."request_group" ("group_id") where "renamed_at" is null;

-- Legal holds: they defer only the erasure of the parts they cover.
create table {{schema}}."legal_hold" (
  "hold_id" text primary key,
  "identity_id" text not null,
  "parts" text[] not null check (cardinality("parts") between 1 and 3 and "parts" <@ array['profile', 'authentication', 'authorisation']),
  "reason_code" text not null,
  "placed_at" timestamptz not null,
  "ends_at" timestamptz not null,
  "ended_at" timestamptz,
  "end_reason" text,
  check ("ends_at" > "placed_at")
);
create index "legal_hold_identity_idx" on {{schema}}."legal_hold" ("identity_id") where "ended_at" is null;

-- Identities Identity has closed, so a hold ending knows erasure is due.
create table {{schema}}."closed_identity" (
  "identity_id" text primary key,
  "closed_at" timestamptz not null
);

-- A closed person's record kept under a legal hold covering Profile: read
-- by no function, erased when the last such hold ends.
create table {{schema}}."held_closure" (
  "identity_id" text primary key references {{schema}}."subject_key" ("identity_id") on delete cascade,
  "closed_at" timestamptz not null
);

-- A contact detail's pending verification (docs/contracts.md §15): the code
-- only as a keyed digest bound to the value, deleted with the key.
create table {{schema}}."contact_verification" (
  "identity_id" text not null references {{schema}}."subject_key" ("identity_id") on delete cascade,
  "attribute" text not null check ("attribute" in ('email', 'phone_number')),
  "code_digest" bytea,
  "expires_at" timestamptz,
  "attempts" integer not null default 0,
  "window_start" timestamptz not null,
  "sends" integer not null default 0,
  primary key ("identity_id", "attribute")
);
`,
  },
  {
    // Retention (iam-integration retention). Requests and holds are records
    // the runtime role never deletes: only this function does, past periods
    // it refuses to shorten below their hard bounds, and never a completed
    // request of a person an active hold covers.
    id: '0004_retention',
    sql: `
create function {{schema}}.apply_retention(p_at timestamptz, p_request_days integer, p_hold_days integer)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare n_requests integer; n_holds integer;
begin
  delete from {{schema}}."request" r
    where r."status" = 'completed' and r."completed_at" <= p_at - make_interval(days => greatest(p_request_days, 365))
      and not exists (select 1 from {{schema}}."legal_hold" h where h."identity_id" = r."identity_id" and h."ended_at" is null and h."ends_at" > p_at);
  get diagnostics n_requests = row_count;
  delete from {{schema}}."legal_hold" where "ended_at" is not null and "ended_at" <= p_at - make_interval(days => greatest(p_hold_days, 30));
  get diagnostics n_holds = row_count;
  return jsonb_build_object('requests', n_requests, 'legalHolds', n_holds);
end $$;
revoke all on function {{schema}}.apply_retention(timestamptz, integer, integer) from public;
`,
  },
  {
    // The configuration layer's account settings join access requests (docs/contracts.md §14).
    id: '0005_configuration_part',
    sql: `
alter table {{schema}}."request_part" drop constraint "request_part_part_check",
  add constraint "request_part_part_check" check ("part" in ('profile', 'identity', 'authentication', 'authorisation', 'configuration'));
`,
  },
  {
    // Profile names only its own part; the host declares the others in
    // composeProfile (docs/contracts.md §14). Any part name in the code
    // grammar is stored, so every value already stored stays valid.
    id: '0006_host_declared_parts',
    sql: `
alter table {{schema}}."request_part" drop constraint "request_part_part_check",
  add constraint "request_part_part_check" check ("part" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length("part") <= 32);
alter table {{schema}}."legal_hold" drop constraint "legal_hold_parts_check",
  add constraint "legal_hold_parts_check" check (
    cardinality("parts") between 1 and 16
    and array_to_string("parts", ',', '*') ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(,[a-z][a-z0-9]*(-[a-z0-9]+)*)*$'
    and length(array_to_string("parts", ',')) <= 16 * 33
  );
`,
  },
  {
    // Retention periods are calendar days in the controller's zone, so
    // Profile computes each cutoff through Clock and passes the instant.
    // The function still refuses to delete anything younger than the hard
    // floors (365 and 30 days), whichever cutoff is earlier. 0004's
    // function stays for databases mid-upgrade; Profile no longer calls it.
    id: '0007_retention_cutoffs',
    sql: `
create function {{schema}}.apply_retention_before(p_at timestamptz, p_request_before timestamptz, p_hold_before timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp set timezone = 'UTC' as $$
declare n_requests integer; n_holds integer;
begin
  delete from {{schema}}."request" r
    where r."status" = 'completed' and r."completed_at" <= least(p_request_before, p_at - interval '365 days')
      and not exists (select 1 from {{schema}}."legal_hold" h where h."identity_id" = r."identity_id" and h."ended_at" is null and h."ends_at" > p_at);
  get diagnostics n_requests = row_count;
  delete from {{schema}}."legal_hold" where "ended_at" is not null and "ended_at" <= least(p_hold_before, p_at - interval '30 days');
  get diagnostics n_holds = row_count;
  return jsonb_build_object('requests', n_requests, 'legalHolds', n_holds);
end $$;
revoke all on function {{schema}}.apply_retention_before(timestamptz, timestamptz, timestamptz) from public;
`,
  },
]

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/

export function quoteSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new TypeError(`Invalid profile schema name '${schema}'.`)
  return `"${schema}"`
}

export interface PoolClientLike {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  release(): void
}

/**
 * Applies pending migrations inside one transaction, serialised across
 * instances with a transaction-scoped advisory lock. With `runtimeRole`, the
 * schema's owner grants that role usage of the schema and data access to its
 * tables, and nothing else (ADR-0006 §5). Returns the ids applied.
 */
export async function runProfileMigrations(pool: PostgresPoolLike, schema: string, runtimeRole?: string): Promise<string[]> {
  const quoted = quoteSchema(schema)
  if (runtimeRole !== undefined && !ROLE_PATTERN.test(runtimeRole)) throw new TypeError(`Invalid runtime role name '${runtimeRole}'.`)
  const client = await pool.connect() as PoolClientLike
  const applied: string[] = []
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`profile-migrations:${schema}`])
    const existing = await client.query('select 1 from pg_namespace where nspname = $1', [schema])
    if (existing.rows.length === 0) await client.query(`create schema ${quoted}`)
    await client.query(`create table if not exists ${quoted}."schema_migration" ("id" text primary key, "applied_at" timestamptz not null default now())`)
    const { rows } = await client.query(`select "id" from ${quoted}."schema_migration"`)
    const done = new Set(rows.map(row => row.id))
    for (const migration of PROFILE_MIGRATIONS) {
      if (done.has(migration.id)) continue
      await client.query(migration.sql.replaceAll('{{schema}}', quoted))
      await client.query(`insert into ${quoted}."schema_migration" ("id") values ($1)`, [migration.id])
      applied.push(migration.id)
    }
    if (runtimeRole) {
      const role = `"${runtimeRole}"`
      await client.query(`grant usage on schema ${quoted} to ${role}`)
      await client.query(`grant select, insert, update, delete on ${quoted}."subject_key", ${quoted}."record", ${quoted}."departure", ${quoted}."pseudonym_counter", ${quoted}."processed_event", ${quoted}."outbox", ${quoted}."lookup_window" to ${role}`)
      await client.query(`grant select, insert, update, delete on ${quoted}."request_part", ${quoted}."request_group", ${quoted}."held_closure", ${quoted}."contact_verification" to ${role}`)
      // Requests, holds and closures are records: the runtime role never deletes them.
      await client.query(`grant select, insert, update on ${quoted}."request", ${quoted}."legal_hold", ${quoted}."closed_identity" to ${role}`)
      await client.query(`grant select, insert on ${quoted}."erased" to ${role}`)
      await client.query(`grant usage on sequence ${quoted}."outbox_sequence_seq" to ${role}`)
      await client.query(`grant execute on function ${quoted}.apply_retention(timestamptz, integer, integer) to ${role}`)
      await client.query(`grant execute on function ${quoted}.apply_retention_before(timestamptz, timestamptz, timestamptz) to ${role}`)
    }
    await client.query('commit')
    return applied
  }
  catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
  finally {
    client.release()
  }
}
