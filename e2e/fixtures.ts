import { expect, test as base } from '@playwright/test'

/** The fixed "today" for every test, outside the Oct 15 to Jan 14 peak window the fee audit skips. */
export const NOW = '2026-10-12T12:00:00Z'

/**
 * Every test runs signed out with the network closed to anything but the preview server:
 * Supabase (and the Google Fonts stylesheet) are aborted, the clock is fixed so claim deadlines are stable,
 * and any uncaught page error fails the test.
 */
export const test = base.extend<{ blocked: string[] }>({
  blocked: async ({ context, baseURL }, use) => {
    const blocked: string[] = []
    const local = new URL(baseURL!).host
    await context.route(url => new URL(url).host !== local, route => {
      blocked.push(new URL(route.request().url()).host)
      return route.abort()
    })
    await context.clock.setFixedTime(new Date(NOW))
    await use(blocked)
  },
  page: async ({ page, blocked: _blocked }, use) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await use(page)
    expect(errors, 'uncaught page errors').toEqual([])
  },
})

export { expect }
