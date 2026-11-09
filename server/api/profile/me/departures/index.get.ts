import { setResponseHeader } from 'h3'
import { profileHandler, requireSubject } from '../../../../internal/http'
import { listProfileDepartures } from '../../../../utils/profile-server'

/**
 * GET /api/profile/me/departures — the groups the person has left: the
 * directory's identifiers, dates, and whether they chose anonymity there.
 * Group names are the host's directory's: the page shows them through the
 * host.
 */
export default profileHandler(async (event) => {
  const subject = await requireSubject(event)
  setResponseHeader(event, 'cache-control', 'no-store')
  return { departures: await listProfileDepartures({ subjectId: subject.principalId }) }
})
