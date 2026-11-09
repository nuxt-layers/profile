import type { DisplayName, LookupPurpose } from '../../contracts'
import { DISCLOSURE_MAX_SUBJECTS } from '../../contracts'

/**
 * PUBLIC. Display names from Profile, batched: every name a page asks for in
 * the same tick, for the same group context and purpose, goes in one
 * request to Profile's display-names endpoint, so a member list costs one lookup
 * against Profile's rate limit.
 *
 * Runs in the browser only: Profile's answers depend on the viewer, and are
 * never shared between requests on the server. Answers are kept for a
 * minute, so a change of name or disclosure shows soon, and are dropped
 * whenever the signed-in viewer may have changed (`forgetProfileNames`).
 */
interface Batch { ids: Set<string>, waiters: Map<string, ((name: DisplayName) => void)[]> }

/** How long an answer is reused, in milliseconds. */
export const PROFILE_NAME_CACHE_MS = 60_000

const HIDDEN: DisplayName = Object.freeze({ kind: 'hidden' })
const cache = new Map<string, { name: DisplayName, until: string }>()
const batches = new Map<string, Batch>()

/** PUBLIC. Drops every cached name: call it when the viewer signs in or out. */
export function forgetProfileNames(): void {
  cache.clear()
}

export function useProfileNames() {
  const profile = useProfile()
  // Times through Clock (Layer Standard §5): canonical instants, compared by Clock.
  const clock = useClock()
  const instant = (value: string) => ({ kind: 'instant' as const, value })

  async function flush(key: string, groupId: string | null, purpose: LookupPurpose) {
    const batch = batches.get(key)!
    batches.delete(key)
    const ids = [...batch.ids]
    for (let start = 0; start < ids.length; start += DISCLOSURE_MAX_SUBJECTS) {
      const chunk = ids.slice(start, start + DISCLOSURE_MAX_SUBJECTS)
      let answers: { subjectId: string, displayName: DisplayName }[] = []
      try {
        answers = await profile.displayNames(chunk, purpose, groupId)
      }
      catch {
        // Unavailable or rate-limited: show the neutral fallback, and ask again next time.
      }
      const found = new Map(answers.map(answer => [answer.subjectId, answer.displayName]))
      const until = clock.add(instant(clock.now()), { seconds: PROFILE_NAME_CACHE_MS / 1000 }).value
      for (const id of chunk) {
        const name = found.get(id) ?? HIDDEN
        if (found.has(id)) cache.set(`${key}|${id}`, { name, until })
        for (const resolve of batch.waiters.get(id) ?? []) resolve(name)
      }
    }
  }

  /** The display name of one identity, as the signed-in viewer may see it. In the browser only; on the server, the fallback. */
  function displayName(identityId: string, groupId: string | null, purpose: LookupPurpose): Promise<DisplayName> {
    if (import.meta.server) return Promise.resolve(HIDDEN)
    const key = `${groupId ?? '-'}|${purpose}`
    const cached = cache.get(`${key}|${identityId}`)
    if (cached && clock.compare(instant(cached.until), instant(clock.now())) > 0) return Promise.resolve(cached.name)
    let batch = batches.get(key)
    if (!batch) {
      batch = { ids: new Set(), waiters: new Map() }
      batches.set(key, batch)
      setTimeout(() => flush(key, groupId, purpose), 0)
    }
    batch.ids.add(identityId)
    return new Promise((resolve) => {
      batch!.waiters.set(identityId, [...(batch!.waiters.get(identityId) ?? []), resolve])
    })
  }

  return { displayName }
}
