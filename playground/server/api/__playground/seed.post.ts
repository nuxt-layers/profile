import { randomBytes, randomUUID } from 'node:crypto'
import { createError, defineEventHandler } from 'h3'
import { DEFAULT_DISCLOSURE_SETTINGS } from '../../../../contracts'
import { playground } from '../../plugins/composition'

/** A UUIDv7, as a host's directory issues them. */
function uuidv7(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Test mode only: a fresh scenario, standing in for the host's directory.
 * - `viewer` has no record yet;
 * - `colleague` shares `group` with the viewer and discloses their name and
 *   contact email to the group;
 * - `paused` shares the group but is paused;
 * - `stranger` shares nothing with the viewer, though named;
 * - `leaver` left `group`, which keeps leavers' names;
 * - the viewer left `formerGroup`.
 */
export default defineEventHandler(async () => {
  if (process.env.PROFILE_PLAYGROUND_TEST !== '1') throw createError({ statusCode: 404 })
  await playground.ready
  const [viewer, colleague, paused, stranger, leaver, group, formerGroup] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()]

  const named = async (subjectId: string, name: string, audiences: Partial<typeof DEFAULT_DISCLOSURE_SETTINGS.audiences> = {}) => {
    await updateProfile({ subjectId, changes: { name, email: `${name.split(' ')[0]!.toLowerCase()}@example.com` }, correlationId: randomUUID() })
    await setProfileDisclosure({
      subjectId,
      settings: { ...DEFAULT_DISCLOSURE_SETTINGS, audiences: { ...DEFAULT_DISCLOSURE_SETTINGS.audiences, ...audiences } },
      correlationId: randomUUID(),
    })
  }
  await named(colleague, 'Ada Lovelace', { email: 'group' })
  await named(paused, 'Grace Hopper')
  await named(stranger, 'Alan Turing')
  await named(leaver, 'Mary Somerville')

  for (const subject of [colleague, paused]) {
    playground.relationships.set(`${viewer}|${subject}|-`, 'same-group')
    playground.relationships.set(`${viewer}|${subject}|${group}`, 'same-group')
  }
  playground.standings.set(paused, 'paused')
  playground.relationships.set(`${viewer}|${leaver}|${group}`, 'former-member')
  playground.departurePolicies.set(group, 'keep-name')
  // The departures, as the host tells Profile of them.
  await recordProfileDeparture({ commandId: uuidv7(), correlationId: randomUUID(), subjectId: leaver, groupId: group, endedAt: new Date().toISOString() })
  await recordProfileDeparture({ commandId: uuidv7(), correlationId: randomUUID(), subjectId: viewer, groupId: formerGroup, endedAt: new Date().toISOString() })

  return { viewer, colleague, paused, stranger, leaver, group, formerGroup }
})
