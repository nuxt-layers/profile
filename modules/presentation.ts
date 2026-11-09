import { addComponentsDir, addImportsDir, createResolver, defineNuxtModule, extendPages } from 'nuxt/kit'

/**
 * Registers the layer's presentation: the default pages, the `Profile*`
 * components and the presentation auto-imports (`useProfileText`,
 * `useProfileAction`, `useProfileRoutes`, `useProfileNames`, `useProfileDates`,
 * `profileClasses`). The core (server, endpoints and `useProfile()`) never
 * depends on any of it.
 *
 * Hosts configure it in nuxt.config.ts:
 *   profile: { pages: { paths: { profile: '/me/profile' } } }  // move the pages
 *   profile: { pages: { enabled: false } }                     // own pages, keep the components
 *   profile: { presentation: false }                           // core only: register nothing here
 */
export interface ProfilePagePaths {
  /** The signed-in person's own profile. */
  profile: string
  /** Another person's profile, as the viewer may see it. Must contain `:subjectId`. */
  person: string
  /** The groups the person has left, to choose anonymity in one of them. */
  departures: string
  /** The person's data-subject requests. */
  requests: string
}

export interface ProfileModuleOptions {
  /** `false` registers no pages, components or presentation auto-imports. */
  presentation: boolean
  pages: {
    enabled: boolean
    paths: ProfilePagePaths
  }
}

const PAGES: { key: keyof ProfilePagePaths, file: string, parameter?: string }[] = [
  { key: 'profile', file: 'OwnProfilePage.vue' },
  { key: 'person', file: 'PersonPage.vue', parameter: ':subjectId' },
  { key: 'departures', file: 'DeparturesPage.vue' },
  { key: 'requests', file: 'RequestsPage.vue' },
]

export default defineNuxtModule<ProfileModuleOptions>({
  meta: { name: '@nuxt-layers/profile/presentation', configKey: 'profile' },
  defaults: {
    presentation: true,
    pages: {
      enabled: true,
      paths: {
        profile: '/profile',
        person: '/profile/people/:subjectId',
        departures: '/profile/departures',
        requests: '/profile/requests',
      },
    },
  },
  setup(options, nuxt) {
    if (!options.presentation) return

    const { resolve } = createResolver(import.meta.url)
    addComponentsDir({ path: resolve('../presentation/components'), prefix: 'Profile', pathPrefix: false })
    addImportsDir([resolve('../presentation/composables'), resolve('../presentation/utils')])
    // Type-check the presentation sources with the host's app code.
    nuxt.hook('prepare:types', ({ tsConfig }) => {
      const include = (tsConfig.include ??= [])
      include.push(resolve('../presentation/**/*'))
    })

    if (!options.pages.enabled) return
    for (const page of PAGES) {
      const path = options.pages.paths[page.key]
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error(`profile.pages.paths.${page.key} must be an absolute path, got '${path}'.`)
      }
      if (page.parameter && !path.includes(page.parameter)) {
        throw new Error(`profile.pages.paths.${page.key} must contain '${page.parameter}', got '${path}'.`)
      }
    }
    // The pages and ProfilePersonName link through the public routes; with
    // the pages off they stay empty, and nothing links to them.
    const runtimeRoutes = (nuxt.options.runtimeConfig.public as { profile: { routes: Record<string, string> } }).profile.routes
    Object.assign(runtimeRoutes, options.pages.paths)

    // The pages show personal data: never framed (clickjacking), never
    // cached, never leaking a path in a Referer. Headers a host sets for the
    // same path take precedence.
    const routeRules = (nuxt.options.routeRules ??= {}) as Record<string, { headers?: Record<string, string> }>
    for (const path of Object.values(options.pages.paths)) {
      const pattern = path.replace(/:\w+/g, '**')
      const rule = (routeRules[pattern] ??= {})
      rule.headers = {
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        ...rule.headers,
      }
    }

    extendPages((pages) => {
      for (const page of PAGES) {
        pages.push({ name: `profile-${page.key}`, path: options.pages.paths[page.key], file: resolve('../presentation/pages', page.file) })
      }
    })
  },
})
