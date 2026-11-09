/**
 * Profile's own declaration of the permissions it asks the access-decision
 * port about, named `<resource>:<action>`. The host registers them with its
 * access decision, in whatever form that takes, and decides who holds them.
 * Each acts on a group: the resource is the group itself.
 */
export interface ProfilePermissionDefinition {
  name: string
  description: string
  risk: 'low' | 'medium' | 'high' | 'critical'
  effect: 'view' | 'change'
}

/**
 * A suspended member's name, to the administrators of a group they belong
 * to. `high`, because it discloses personal data that is otherwise hidden:
 * the host must grant it only by name (never through a wildcard or an
 * ordinary member's or viewer's role), and only at `aal2`.
 */
export const PROFILE_SUSPENDED_PEOPLE_PERMISSION = 'profile.suspended-people:view'

export const PROFILE_PERMISSIONS: readonly ProfilePermissionDefinition[] = Object.freeze([
  Object.freeze({
    name: PROFILE_SUSPENDED_PEOPLE_PERMISSION,
    description: 'See the names of the group\'s suspended members',
    risk: 'high',
    effect: 'view',
  }),
])
