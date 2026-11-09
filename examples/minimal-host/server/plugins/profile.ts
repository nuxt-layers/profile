/**
 * Profile's composition in a minimal host (ADR-0012 §4). Everything here
 * counts against the 50-line budget (tests/minimal-host.test.ts).
 *
 * This host composes Profile alone, so Profile's own stand-ins answer where
 * Authentication and Identity would (nobody is signed in; only `self` is
 * disclosed). It opts in to them as a demonstration. The database comes
 * from the environment; without it startup fails closed.
 */
import pg from 'pg'

export default defineNitroPlugin(() => {
  const stand = createProfileTestPorts({ demonstration: true })
  composeProfile({
    database: {
      dialect: 'postgres',
      pool: new pg.Pool({ connectionString: process.env.PROFILE_DATABASE_URL }),
      migrationPool: new pg.Pool({ connectionString: process.env.PROFILE_MIGRATION_DATABASE_URL }),
      runtimeRole: process.env.PROFILE_RUNTIME_ROLE ?? 'profile_runtime',
    },
    keyWrapper: stand.keyWrapper,
    subjectResolver: stand.subjectResolver,
    disclosureContext: stand.disclosureContext,
  })
})
