import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR-0012 §1 and §4: the minimal host composes Profile in no more than 50
 * lines of host code. Counted conservatively: every non-blank, non-comment
 * line of its configuration and server code, whether or not it names Profile.
 * The smoke test (smoke.mjs) is CI tooling, not host code.
 */
const BUDGET = 50
const root = 'examples/minimal-host'

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (['.nuxt', '.output', 'node_modules'].includes(name)) return []
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function codeLines(source: string): number {
  let inBlock = false
  return source.split('\n').filter((raw) => {
    const line = raw.trim()
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      return false
    }
    if (line.startsWith('/*')) {
      inBlock = !line.includes('*/')
      return false
    }
    return line !== '' && !line.startsWith('//')
  }).length
}

describe('examples/minimal-host', () => {
  const hostFiles = files(root).filter(path => /\.(?:ts|vue|mjs|js)$/.test(path) && !path.endsWith('smoke.mjs'))

  it('composes Profile within the ADR-0012 budget', () => {
    const total = hostFiles.reduce((sum, path) => sum + codeLines(readFileSync(path, 'utf8')), 0)
    expect(hostFiles.length).toBeGreaterThan(0)
    expect(total).toBeLessThanOrEqual(BUDGET)
  })

  it('composes Profile and nothing else, through public functions only', () => {
    for (const path of hostFiles) {
      const source = readFileSync(path, 'utf8')
      expect(source, path).not.toMatch(/server\/(?:internal|database)|@nuxt-layers\/(?!profile)/)
    }
  })
})
