import { displayNamesRequestSchema } from '../../../contracts'
import { profileHandler, readJson, requireSubject } from '../../internal/http'
import { consumeProfileLookup, lookupProfileDisplayNames } from '../../utils/profile-server'

/**
 * POST /api/profile/display-names — `{ subjectIds, groupId?, purpose }`:
 * up to 200 display names as the signed-in viewer may see them. Rate-limited
 * per viewer. An `administration` lookup names its group, and Profile asks
 * the host's access decision whether the viewer may see that group's
 * suspended members.
 */
export default profileHandler(async (event) => {
  const subject = await requireSubject(event)
  const body = await readJson(event, displayNamesRequestSchema)
  await consumeProfileLookup({ viewerId: subject.principalId })
  return lookupProfileDisplayNames({ viewerId: subject.principalId, subjectIds: body.subjectIds, groupId: body.groupId ?? null, purpose: body.purpose, subject })
})
