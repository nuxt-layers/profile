/**
 * Profile's composition in a minimal host (ADR-0012 §4). Everything here
 * counts against the 50-line budget (tests/minimal-host.test.ts).
 *
 * Stand-ins, because this host composes Profile alone: nobody is signed in
 * (a host adapts Authentication's principal), and the disclosure context
 * knows only `self` (a host passes Identity's port through). The database
 * and the key come from the environment; without them startup fails closed.
 */
import pg from 'pg'

export default defineNitroPlugin(() => {
  provideProfileDatabase({
    dialect: 'postgres',
    pool: new pg.Pool({ connectionString: process.env.PROFILE_DATABASE_URL }),
    migrationPool: new pg.Pool({ connectionString: process.env.PROFILE_MIGRATION_DATABASE_URL }),
    runtimeRole: process.env.PROFILE_RUNTIME_ROLE ?? 'profile_runtime',
  })
  provideProfileKeyWrapper(createLocalProfileKeyWrapper({ keys: { k1: process.env.PROFILE_MASTER_KEY ?? '' }, current: 'k1' }))
  provideProfileSubjectResolver({ resolve: async () => null })
  provideProfileDisclosureContext({
    describe: async request => ({
      viewerId: request.viewerId,
      groupId: request.groupId ?? null,
      departurePolicy: null,
      subjects: request.subjectIds.map(subjectId => ({
        subjectId,
        relationship: subjectId === request.viewerId ? 'self' as const : 'none' as const,
        standing: 'visible' as const,
      })),
      readAt: new Date().toISOString(),
    }),
  })
  migrateProfileDatabase()
})
