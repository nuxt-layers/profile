import AxeBuilder from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { ORIGIN } from './constants'

/**
 * Profile's default pages and ProfilePersonName in a real browser, against
 * the built playground with its theme's real styles: the journeys,
 * keyboard-only use, reflow, and axe checks against the WCAG 2.2 AA rules.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

interface Scenario {
  viewer: string
  colleague: string
  paused: string
  stranger: string
  leaver: string
  group: string
  formerGroup: string
}

async function seed(request: APIRequestContext): Promise<Scenario> {
  const response = await request.post('/api/__playground/seed')
  expect(response.ok()).toBe(true)
  return response.json()
}

/**
 * Stands in for the host's sign-in service: the playground reads the signed-in identity
 * from this cookie in test mode, and the sign-in time from another.
 */
async function signInAs(context: BrowserContext, identityId: string, signedInAt?: number) {
  await context.clearCookies()
  await context.addCookies([
    { name: 'profile_playground_principal', value: identityId, url: ORIGIN },
    ...(signedInAt ? [{ name: 'profile_playground_signed_in_at', value: String(signedInAt), url: ORIGIN }] : []),
  ])
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
}

/**
 * WCAG 1.4.11 (non-text contrast), which axe does not check: a text field's
 * border and the keyboard focus indicator need 3:1 against their surface.
 */
async function expectNonTextContrast(page: Page, selector: string) {
  const ratios = await page.evaluate((target) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const luminance = (value: string) => {
      const [r, g, b] = parse(value).map((c) => {
        const v = c / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const ratio = (a: string, b: string) => {
      const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
      return (x! + 0.05) / (y! + 0.05)
    }
    const surface = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor
        if (colour !== 'rgba(0, 0, 0, 0)') return colour
      }
      return 'rgb(255, 255, 255)'
    }
    const input = document.querySelector(target) as HTMLInputElement
    input.focus()
    const style = getComputedStyle(input)
    return {
      border: ratio(style.borderTopColor, surface(input)),
      focus: ratio(style.outlineColor, surface(input)),
      focusVisible: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2,
    }
  }, selector)
  expect(ratios.focusVisible).toBe(true)
  expect(ratios.border).toBeGreaterThanOrEqual(3)
  expect(ratios.focus).toBeGreaterThanOrEqual(3)
}

async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

const OTHER = '01a120c9-2cd1-784a-a3d6-f725b2cb2eab'

const details = (page: Page) => page.getByRole('region', { name: 'Your details', exact: true })
const choices = (page: Page) => page.getByRole('region', { name: 'Who can see your details' })

test('asks a signed-out visitor to sign in, and returns them afterwards', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/profile')
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in?redirect=%2Fprofile')
  await expectAccessible(page)
})

test('protects every page from framing, caching and referrer leaks', async ({ request }) => {
  for (const path of ['/profile', `/profile/people/${OTHER}`, '/profile/departures', '/profile/requests']) {
    const response = await request.get(path)
    expect(response.headers()['x-frame-options'], path).toBe('DENY')
    expect(response.headers()['cache-control'], path).toBe('no-store')
    expect(response.headers()['referrer-policy'], path).toBe('no-referrer')
  }
})

test('lets a person fill in, change and remove their details by keyboard', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto('/profile')
  await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible()
  await expectAccessible(page)
  await expectNonTextContrast(page, '#profile-field-name')

  await details(page).getByLabel('Full name').fill('Katherine Johnson')
  await details(page).getByLabel('Nickname').fill('Kathy')
  await details(page).getByLabel('Time zone').selectOption('Europe/London')
  await details(page).getByRole('button', { name: 'Save' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Your details have been saved.' })).toBeVisible()
  await page.reload()
  await expect(details(page).getByLabel('Full name')).toHaveValue('Katherine Johnson')
  await expect(details(page).getByLabel('Time zone')).toHaveValue('Europe/London')

  await details(page).getByLabel('Nickname').fill('')
  await details(page).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your details have been saved.' })).toBeVisible()
  await page.reload()
  await expect(details(page).getByLabel('Nickname')).toHaveValue('')
  await expectAccessible(page)
})

test('explains an invalid detail in words, on the field, and focuses it', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto('/profile')
  const name = details(page).getByLabel('Full name')
  await name.fill('Pay\u200Broll')
  await details(page).getByLabel('Contact telephone').fill('07700 900123')
  await details(page).getByRole('button', { name: 'Save' }).click()
  await expect(name).toBeFocused()
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('This contains a character that is not allowed.')).toBeVisible()
  await expect(page.getByText('Enter a telephone number in international format, such as +447700900123.')).toBeVisible()
  await expectAccessible(page)
})

test('asks for a recent sign-in before a contact detail changes or the data is downloaded', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer, Date.now() - 60 * 60 * 1000)
  await page.goto('/profile')
  await details(page).getByLabel('Contact email').fill('katherine@example.com')
  await details(page).getByRole('button', { name: 'Save' }).click()
  await expect(details(page).getByRole('alert')).toContainText('sign in again to confirm it is you')
  await expect(details(page).getByRole('alert').getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/sign-in?redirect=%2Fprofile')

  await page.getByRole('button', { name: 'Download my profile data' }).click()
  await expect(page.getByRole('region', { name: 'Download your data' }).getByRole('alert')).toContainText('sign in again')

  await signInAs(context, scenario.viewer)
  await page.reload()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download my profile data' }).click()
  expect((await download).suggestedFilename()).toBe('profile-data.json')
  await expect(page.getByRole('status').filter({ hasText: 'Your download has started.' })).toBeVisible()
})

test('lets a person choose who sees each detail and which name others see', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto('/profile')
  const audiences = choices(page).getByRole('group', { name: 'Who can see each detail' })
  await expect(audiences.getByLabel('Full name')).toHaveValue('group')
  await expect(audiences.getByLabel('Contact email')).toHaveValue('nobody')
  await audiences.getByLabel('Nickname').selectOption('tenant')
  await choices(page).getByRole('radio', { name: 'Nickname' }).check()
  await page.getByRole('checkbox', { name: 'Show me as "Former member" in every group I leave' }).check()
  await choices(page).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your choices have been saved.' })).toBeVisible()
  await page.reload()
  await expect(audiences.getByLabel('Nickname')).toHaveValue('tenant')
  await expect(choices(page).getByRole('radio', { name: 'Nickname' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Show me as "Former member" in every group I leave' })).toBeChecked()
  await expectAccessible(page)
})

test('refuses a change made against an older version, and reloads', async ({ browser, request }) => {
  const scenario = await seed(request)
  const context = await browser.newContext()
  await signInAs(context, scenario.viewer)
  const first = await context.newPage()
  const second = await context.newPage()
  await first.goto('/profile')
  await second.goto('/profile')
  await details(first).getByLabel('Full name').fill('First tab')
  await details(first).getByRole('button', { name: 'Save' }).click()
  await expect(first.getByRole('status').filter({ hasText: 'Your details have been saved.' })).toBeVisible()

  await details(second).getByLabel('Full name').fill('Second tab')
  await details(second).getByRole('button', { name: 'Save' }).click()
  await expect(second.getByRole('alert')).toContainText('Your profile changed somewhere else.')
  await expect(details(second).getByLabel('Full name')).toHaveValue('First tab')
  await context.close()
})

test('shows another person only what they disclose to the viewer', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto(`/profile/people/${scenario.colleague}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeVisible()
  await expect(page.getByText('ada@example.com')).toBeVisible()
  await expect(page).toHaveTitle('Profile')
  await expectAccessible(page)

  // Not shared with the viewer, paused (a listing), or unknown: all read alike.
  for (const subject of [scenario.stranger, scenario.paused, OTHER, 'not-an-identifier']) {
    await page.goto(`/profile/people/${subject}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
    await expect(page.getByText('This profile is not available to you.')).toBeVisible()
  }
  await expectAccessible(page)
})

test('names people by what Profile discloses, and links disclosed names only', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto(`/?people=${[scenario.colleague, scenario.stranger, scenario.paused].join(',')}`)
  const list = page.getByRole('list')
  await expect(list.getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute('href', `/profile/people/${scenario.colleague}`)
  await expect(list.locator(`[data-identity-id="${scenario.stranger}"]`)).toHaveText('Member')
  await expect(list.locator(`[data-identity-id="${scenario.paused}"]`)).toHaveText('Member')
  await expect(list.getByRole('link')).toHaveCount(1)
  await expectAccessible(page)

  // In the group's context, a leaver is named under the group's departure data policy.
  await page.goto(`/?people=${scenario.leaver},${scenario.colleague}&groupId=${scenario.group}`)
  await expect(list.locator(`[data-identity-id="${scenario.leaver}"]`)).toHaveText('Mary Somerville')
  await expect(list.getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute('href', `/profile/people/${scenario.colleague}?groupId=${scenario.group}`)
})

test('verifies a contact detail with a code, by keyboard, and asks again once it changes', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto('/profile')
  await details(page).getByLabel('Contact email').fill('katherine@example.com')
  await details(page).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your details have been saved.' })).toBeVisible()

  await details(page).getByRole('button', { name: 'Send a code to verify it' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'We have sent a 6-digit code to this email address.' })).toBeVisible()
  await expectAccessible(page)
  const { code } = await (await request.get('/api/__playground/code')).json() as { code: string }
  await details(page).getByLabel('Code').fill(code)
  await page.keyboard.press('Enter')
  await expect(details(page).getByText('Verified', { exact: true })).toBeVisible()
  await page.reload()
  await expect(details(page).getByText('Verified', { exact: true })).toBeVisible()

  await details(page).getByLabel('Contact email').fill('kj@example.com')
  await details(page).getByRole('button', { name: 'Save' }).click()
  await expect(details(page).getByRole('button', { name: 'Send a code to verify it' })).toBeVisible()
  await expectAccessible(page)
})

test('lets a person choose anonymity in one group they left, after confirming', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto('/profile')
  await choices(page).getByRole('link', { name: 'Choose this for a group you have already left' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Groups you have left' })).toBeVisible()
  await expect(page.locator(`[data-group-id="${scenario.formerGroup}"]`)).toHaveText('A group you left')
  await expectAccessible(page)

  await page.getByRole('button', { name: 'Show me as "Former member" here' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Show me as "Former member" here' }).click()
  await page.getByRole('button', { name: 'Yes, show me as "Former member"' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'You are shown there as "Former member" from now on.' })).toBeVisible()
  await expect(page.getByText('Shown as "Former member"', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show me as "Former member" here' })).toHaveCount(0)
  await expectAccessible(page)
})

test('answers a request for a copy of all the data, and offers no deletion but closing the account', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.goto('/profile')
  await page.getByRole('link', { name: 'Your requests about your data' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your requests about your data' })).toBeVisible()
  await expectAccessible(page)

  await page.getByRole('button', { name: 'Ask for a copy of my data' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your request has been made.' })).toBeVisible()
  const list = page.getByRole('region', { name: 'Your requests' })
  await expect(list.getByRole('heading', { name: 'A copy of your data' })).toBeVisible()
  await expect(list.getByText('Completed', { exact: true })).toBeVisible()
  // Profile's own part, a host part in the host's wording, and one in Profile's general wording.
  for (const part of ['Your profile', 'Your groups and memberships', 'Another part of your account']) await expect(list.getByText(part, { exact: true })).toBeVisible()
  const download = page.waitForEvent('download')
  await list.getByRole('button', { name: 'Download my data' }).click()
  expect((await download).suggestedFilename()).toBe('my-data.json')
  await expectAccessible(page)

  await signInAs(context, scenario.viewer, Date.now() - 60 * 60 * 1000)
  await page.reload()
  await page.getByRole('button', { name: 'Restrict who sees my details' }).click()
  await expect(page.getByRole('alert')).toContainText('sign in again')
})

test('reflows to 320 CSS pixels without scrolling sideways', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.viewer)
  await page.setViewportSize({ width: 320, height: 800 })
  for (const path of ['/profile', `/profile/people/${scenario.colleague}`, '/profile/departures', '/profile/requests']) {
    await page.goto(path)
    await expectNoHorizontalScroll(page)
  }
})
