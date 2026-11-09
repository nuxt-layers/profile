import { globSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DISCLOSURE_AUDIENCES,
  DISPLAY_NAME_SOURCES,
  PROFILE_ATTRIBUTES,
  PART_STATUSES,
  PROFILE_ERROR_CODES,
  PROFILE_REQUEST_PART,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  SAFE_NAME_PROBLEMS,
  attributeSchemas,
} from '../contracts'
import { PROFILE_MESSAGES_EN_GB, resolveMessage } from '../presentation/messages'
import { DELIBERATE_PAIRINGS } from '../presentation/pairings'
import { profileClasses } from '../presentation/utils/profile-classes'

/**
 * The SemanticPresentationTheme rules: Fill, Pen and Edge of one surface
 * share a role and state, and cross-role pairings are deliberate. Every
 * utility, sizes included, resolves to a token of the theme the playground
 * composes.
 */

const CARD = 'fill-base-default'
const deliberate = new Set(DELIBERATE_PAIRINGS.map(({ token, on }) => `${token} on ${on}`))

type Token = { variant: string, utility: string, family: 'fill' | 'pen' | 'edge', name: string }

function tokens(classes: string): Token[] {
  return classes.split(/\s+/).flatMap((cls) => {
    const match = cls.match(/^((?:[\w-]+|aria-\[[^\]]+\]):)?(bg|text|border(?:-[trblxy])?|divide|outline)-(fill|pen|edge)-([a-z]+-[a-z]+)$/)
    if (!match) return []
    return [{ variant: match[1] ?? '', utility: match[2]!, family: match[3] as Token['family'], name: `${match[3]}-${match[4]}` }]
  })
}

/** The fill each pen or edge is drawn on, by the guide's reading of one class string. */
function pairings(classes: string): string[] {
  const all = tokens(classes)
  const fill = (variant: string) =>
    all.find(t => t.family === 'fill' && t.variant === variant)?.name ?? all.find(t => t.family === 'fill' && t.variant === '')?.name ?? CARD
  return all
    .filter(t => t.family !== 'fill')
    .map(t => `${t.name} on ${t.utility === 'outline' ? CARD : fill(t.variant)}`)
}

const sameRoleAndState = (pairing: string) => {
  const [token, , surface] = pairing.split(' ')
  return token!.replace(/^(pen|edge)-/, '') === surface!.replace(/^fill-/, '')
}

describe('semantic presentation', () => {
  it('pairs pen and edge with a fill of the same role and state, or a listed deliberate pairing', () => {
    const offending = Object.entries(profileClasses).flatMap(([name, classes]) =>
      pairings(classes).filter(p => !sameRoleAndState(p) && !deliberate.has(p)).map(p => `${name}: ${p}`))
    expect(offending).toEqual([])
  })

  it('advances fill, pen and edge together through hover, active and disabled states', () => {
    const offending = Object.entries(profileClasses).flatMap(([name, classes]) => {
      const all = tokens(classes)
      const roles = (variant: string) => new Set(all.filter(t => t.variant === variant).map(t => `${t.family}-${t.name.split('-')[1]}`))
      const base = roles('')
      const missing = ['primaryButton', 'secondaryButton', 'dangerButton'].includes(name) ? ['hover:', 'active:', 'disabled:'].filter(v => roles(v).size === 0).map(v => `${name}: no ${v} state`) : []
      return missing.concat(['hover:', 'active:', 'disabled:'].flatMap((variant) => {
        const changed = roles(variant)
        if (changed.size === 0) return []
        return [...base].filter(r => !r.startsWith('edge-base') && !changed.has(r)).map(r => `${name}: ${r} has no ${variant} state`)
      }))
    })
    expect(offending).toEqual([])
  })

  it('uses every deliberate pairing and documents it for hosts', () => {
    const used = new Set(Object.values(profileClasses).flatMap(pairings))
    const contracts = readFileSync('docs/contracts.md', 'utf8')
    for (const { token, on } of DELIBERATE_PAIRINGS) {
      expect(used.has(`${token} on ${on}`), `${token} on ${on} unused`).toBe(true)
      expect(contracts, `${token} on ${on} undocumented`).toContain(`\`${token}\` on \`${on}\``)
    }
  })

  it('never reaches into the theme\'s private variables', () => {
    const files = [
      'tailwind.css',
      'playground/app/assets/css/main.css',
      ...['app', 'presentation'].flatMap(dir => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => /\.(vue|ts|css)$/.test(f)).map(f => join(dir, f))),
    ]
    const offending = files.filter(f => /--(ui|api|tm)-[a-z]/.test(readFileSync(f, 'utf8')))
    expect(offending).toEqual([])
  })

  it('resolves every utility to a theme token, never a Tailwind default', async () => {
    const classes = candidates()
    const css = await compileWithThemeManager(classes)
    const offGrammar = classes.filter((name) => {
      const escaped = name.replace(/[:./[\]=]/g, m => `\\${m}`)
      const rule = css.match(new RegExp(`\\.${escaped}(?::[a-z-]+)*\\s*\\{([^}]*)\\}`))?.[1]
      if (!rule) return false // not a utility (plain text in a string literal)
      return /calc\(var\(--spacing\)|--color-(?!fill-|pen-|edge-)[a-z]+-\d|--tracking-|--leading-|--default-font|\[/.test(rule)
    })
    expect(offGrammar).toEqual([])
  })

  it('names a semantic role (fill, pen or edge) in every colour utility', () => {
    const colour = /^(?:[a-z-]+:)*(?:bg|text|border|outline|divide|ring|fill|stroke|decoration|placeholder)-(?!fill-|pen-|edge-)(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/
    expect(candidates().filter(name => colour.test(name))).toEqual([])
  })
})

describe('text', () => {
  const has = (key: string) => key in PROFILE_MESSAGES_EN_GB

  it('words every error code, attribute, audience and display-name choice in the contract', () => {
    const keys = [
      ...PROFILE_ERROR_CODES.map(code => `profile.error.${code}`),
      ...PROFILE_ATTRIBUTES.map(attribute => `profile.attribute.${attribute}`),
      ...DISCLOSURE_AUDIENCES.map(audience => `profile.audience.${audience}`),
      ...DISPLAY_NAME_SOURCES.map(source => `profile.disclosure.displayNameSource.${source}`),
      ...REQUEST_TYPES.map(type => `profile.requests.type.${type}`),
      ...REQUEST_STATUSES.map(status => `profile.requests.status.${status}`),
      `profile.requests.part.${PROFILE_REQUEST_PART}`,
      'profile.requests.part.other',
      ...PART_STATUSES.map(status => `profile.requests.partStatus.${status}`),
    ]
    expect(keys.filter(key => !has(key))).toEqual([])
  })

  it('words every problem the contract\'s rules can name', () => {
    const problems = new Set<string>([...SAFE_NAME_PROBLEMS, 'version-changed', 'no-changes', 'invalid-code', 'wrong-code', 'code-expired', 'nothing-to-verify', 'invalid-attribute'])
    const samples: Record<string, string[]> = {
      name: ['', 'x'.repeat(201), 'a​b', 'Aлександр'],
      preferred_username: ['x'.repeat(65)],
      locale: ['not a locale'],
      zoneinfo: ['Mars/Olympus'],
      email: ['nobody'],
      phone_number: ['07700 900123'],
    }
    for (const [attribute, values] of Object.entries(samples)) {
      for (const value of values) {
        const parsed = attributeSchemas[attribute as keyof typeof attributeSchemas].safeParse(value)
        expect(parsed.success, `${attribute} accepted ${JSON.stringify(value)}`).toBe(false)
        for (const issue of parsed.error?.issues ?? []) problems.add(issue.message)
      }
    }
    expect([...problems].filter(problem => !has(`profile.reason.${problem}`))).toEqual([])
  })

  it('lets a host override wording per locale, and falls back to en-GB', () => {
    const overrides = { 'cy-GB': { 'profile.own.title': 'Eich proffil' } }
    expect(resolveMessage('profile.own.title', 'cy-GB', overrides)).toBe('Eich proffil')
    expect(resolveMessage('profile.common.save', 'cy-GB', overrides)).toBe('Save')
    expect(resolveMessage('profile.person.pseudonym', 'en-GB', undefined, { number: 7 })).toBe('Former member 7')
  })

  it('never takes words from anywhere but the catalogue', () => {
    // Visible text in templates comes from t() or nameOf(); a bare word between tags is a missed message.
    const offending = globSync('presentation/**/*.vue').flatMap((file) => {
      const template = readFileSync(file, 'utf8').split('<template>').slice(1).join('<template>')
      return [...template.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map(match => `${file}: ${match[1]!.trim()}`)
    })
    expect(offending).toEqual([])
  })
})

describe('pages and components', () => {
  it('reach the server only through useProfile(), and decide nothing', () => {
    const offending = globSync('presentation/**/*.{vue,ts}').filter(file => /\$fetch|useFetch\(|fetch\(|\/api\/profile/.test(readFileSync(file, 'utf8')))
    expect(offending).toEqual([])
  })

  it('keep names out of the document title', () => {
    const person = readFileSync('presentation/pages/PersonPage.vue', 'utf8')
    expect(person).toContain("useHead({ title: t('profile.person.title')")
  })

  it('never offer erasure', () => {
    const offending = globSync('presentation/**/*.{vue,ts}').filter(file => /erase|eraseProfile|delete my/i.test(readFileSync(file, 'utf8')))
    expect(offending).toEqual([])
  })
})

/** Every class-like token in the layer's string literals. */
function candidates(): string[] {
  const found = new Set<string>()
  for (const file of globSync('{app,presentation}/**/*.{vue,ts}')) {
    for (const literal of readFileSync(file, 'utf8').match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? []) {
      for (const token of literal.slice(1, -1).split(/\s+/)) {
        if (/^[a-z-]+(?::[a-z-[\]=]+)*:?[a-z0-9-./[\]]+$/.test(token)) found.add(token)
      }
    }
  }
  // Classes written in templates as plain attributes.
  for (const file of globSync('presentation/**/*.vue')) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\sclass="([^"]+)"/g)) {
      for (const token of match[1]!.split(/\s+/)) found.add(token)
    }
  }
  return [...found]
}

/** Compiles classes against the theme's public presentation.css export (never its private paths). */
async function compileWithThemeManager(classes: string[]): Promise<string> {
  const require = createRequire(import.meta.url)
  const { compile } = await import(require.resolve('@tailwindcss/node', { paths: [dirname(require.resolve('tailwindcss/package.json'))] }))
  const presentation = require.resolve('@nuxt-layers/theme-manager/presentation.css')
  const compiler = await compile(`@import ${JSON.stringify(presentation)};`, { base: dirname(presentation), onDependency: () => {} })
  return compiler.build(classes)
}
