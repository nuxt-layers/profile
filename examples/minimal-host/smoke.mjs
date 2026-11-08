// Smoke test of the built minimal host (ADR-0012 §4) against a disposable
// PostgreSQL database. Needs PROFILE_TEST_DATABASE_URL (an admin URL) and
// `pnpm build:minimal-host` first.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const admin = process.env.PROFILE_TEST_DATABASE_URL
if (!admin) throw new Error('PROFILE_TEST_DATABASE_URL is required.')
const database = 'profile_minimal_host'
const role = 'profile_minimal_host_runtime'
const password = randomBytes(16).toString('hex')
const port = 3917
const origin = `http://127.0.0.1:${port}`

const client = new pg.Client({ connectionString: admin })
await client.connect()
await client.query(`drop database if exists "${database}" with (force)`)
await client.query(`drop role if exists "${role}"`)
await client.query(`create role "${role}" login password '${password}' nosuperuser nobypassrls`)
await client.query(`create database "${database}"`)
await client.end()

const migration = new URL(admin)
migration.pathname = `/${database}`
const runtime = new URL(migration)
runtime.username = role
runtime.password = password

const server = spawn(process.execPath, [fileURLToPath(new URL('./.output/server/index.mjs', import.meta.url))], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PROFILE_MIGRATION_DATABASE_URL: migration.toString(),
    PROFILE_DATABASE_URL: runtime.toString(),
    PROFILE_RUNTIME_ROLE: role,
    PROFILE_MASTER_KEY: randomBytes(32).toString('base64'),
    NUXT_PROFILE_BASE_URL: origin,
  },
})

function check(condition, message) {
  if (!condition) throw new Error(`Smoke test failed: ${message}`)
}

try {
  let me
  for (let attempt = 0; attempt < 60 && !me; attempt++) {
    me = await fetch(`${origin}/api/profile/me`).catch(() => undefined)
    if (!me) await new Promise(resolve => setTimeout(resolve, 500))
  }
  check(me, 'the host did not start')
  check(me.status === 401 && (await me.json()).code === 'unauthenticated', 'GET /api/profile/me without a subject must answer 401 unauthenticated')

  const crossOrigin = await fetch(`${origin}/api/profile/display-names`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' },
    body: '{}',
  })
  check(crossOrigin.status === 403, 'a state-changing request from another origin must be refused')

  const page = await fetch(`${origin}/profile`)
  check(page.status === 200 && page.headers.get('x-frame-options') === 'DENY', 'the default profile page must render with its headers')

  const tables = new pg.Client({ connectionString: migration.toString() })
  await tables.connect()
  const { rows } = await tables.query(`select count(*)::int as n from information_schema.tables where table_schema = 'profile' and table_name = 'record'`)
  await tables.end()
  check(rows[0].n === 1, 'composeProfile() must have migrated the profile schema')
  console.log('Minimal host smoke test passed.')
}
finally {
  server.kill()
}
