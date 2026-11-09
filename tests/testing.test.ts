import { afterEach, describe, expect, it } from 'vitest'
import { createProfileTestPorts } from '../server/utils/profile-testing'
import { profileTasks } from '../server/utils/profile-server'

const viewer = '01900000-0000-7000-8000-000000000001'
const subject = '01900000-0000-7000-8000-000000000002'
const group = '01900000-0000-7000-8000-000000000003'

describe('createProfileTestPorts', () => {
  const env = process.env.NODE_ENV
  afterEach(() => {
    process.env.NODE_ENV = env
  })

  it('refuses outside tests unless a demonstration opts in', () => {
    process.env.NODE_ENV = 'production'
    expect(() => createProfileTestPorts()).toThrow(/tests only/)
    expect(() => createProfileTestPorts({ demonstration: true })).not.toThrow()
  })

  it('resolves only the principal signed in, and nobody after sign-out', async () => {
    const ports = createProfileTestPorts()
    expect(await ports.subjectResolver.resolve({})).toBeNull()
    ports.signIn(viewer, { authenticatedAt: '2030-01-01T00:00:00.000Z' })
    expect(await ports.subjectResolver.resolve({})).toEqual({
      principalId: viewer,
      authenticatedAt: '2030-01-01T00:00:00.000Z',
      assurance: { level: 'aal2', phishingResistant: true },
    })
    ports.signOut()
    expect(await ports.subjectResolver.resolve({})).toBeNull()
  })

  it('discloses only what was set: self, relationships, standings and departure policies', async () => {
    const ports = createProfileTestPorts()
    ports.relate(viewer, subject, 'same-group', group)
    ports.setStanding(subject, 'paused')
    ports.setDeparturePolicy(group, 'pseudonymise')
    const inGroup = await ports.disclosureContext.describe({ viewerId: viewer, subjectIds: [viewer, subject], groupId: group }, { consistency: 'bounded' })
    expect(inGroup.departurePolicy).toEqual({ attribution: 'pseudonymise' })
    expect(inGroup.subjects).toEqual([
      { subjectId: viewer, relationship: 'self', standing: 'visible' },
      { subjectId: subject, relationship: 'same-group', standing: 'paused' },
    ])
    const outside = await ports.disclosureContext.describe({ viewerId: viewer, subjectIds: [subject], groupId: null }, { consistency: 'bounded' })
    expect(outside.subjects[0]!.relationship).toBe('none')
  })

  it('allows only what was granted, records instead of sending, and moves its clock only when told', async () => {
    const ports = createProfileTestPorts()
    ports.signIn(viewer)
    const asViewer = (await ports.subjectResolver.resolve({}))!
    expect(await ports.accessDecision.allows({ subject: asViewer, permission: 'profile.suspended-people:view', groupId: group })).toBe(false)
    ports.grant(viewer, 'profile.suspended-people:view', group)
    expect(await ports.accessDecision.allows({ subject: asViewer, permission: 'profile.suspended-people:view', groupId: group })).toBe(true)

    const message = { channel: 'email' as const, to: 'a@example.test', purpose: 'contact-verification' as const, attribute: 'email' as const, code: '123456', locale: null, expiresInSeconds: 600 }
    await ports.notifier.send(message)
    expect(ports.sent).toEqual([message])

    const fixed = '2031-02-03T04:05:06.000Z'
    ports.setNow(fixed)
    expect(ports.clock.now()).toBe(fixed)
    ports.setNow(null)
    expect(Math.abs(Date.parse(ports.clock.now()) - Date.now())).toBeLessThan(1000)
  })
})

describe('profileTasks', () => {
  it('offers maintenance in the shared shape, every 300 seconds', () => {
    const tasks = profileTasks()
    expect(tasks.map(({ name, every }) => ({ name, every }))).toEqual([{ name: 'profile.maintenance', every: 300 }])
    expect(typeof tasks[0]!.run).toBe('function')
  })
})
