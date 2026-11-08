/**
 * Public presentation surface of `@nuxt-layers/profile`
 * (`@nuxt-layers/profile/presentation`).
 *
 * The default pages and components depend on the contract and the client
 * API (`useProfile()`) only, and decide nothing: every request is decided
 * again on the server.
 */

export type { ProfileMessageKey, ProfileMessages } from './messages'
export { formatMessage, PROFILE_MESSAGES_EN_GB, resolveMessage } from './messages'
export { DELIBERATE_PAIRINGS } from './pairings'
export { profileClasses } from './utils/profile-classes'
