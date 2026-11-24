import { expect, test } from './fixtures'

const LEDGER = 'src/engine/fixtures/ledger-detail.csv'

/** Opens a fresh browser profile on the synthetic Hearth & Loom seller. */
async function openSample(page: import('@playwright/test').Page) {
  await page.goto('/app')
  await page.getByRole('button', { name: /Hearth & Loom/ }).click()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+$/)
  await expect(page.getByRole('heading', { level: 1, name: /Hearth & Loom/ })).toBeVisible()
  await expect(page.locator('.finding').first()).toBeVisible()
}

const money = (s: string) => Number(s.replace(/[^0-9.]/g, ''))

test('sample seller: ranked cases with claim deadlines on a fixed clock', async ({ page }) => {
  await openSample(page)
  await expect(page.getByText('As of Oct 12, 2026')).toBeVisible()
  await expect(page.locator('.kpi', { hasText: 'Claimable now' })).toContainText('$2,322')
  await expect(page.locator('.kpi', { hasText: 'Next window closes' })).toContainText('Oct 15, 2026')

  const first = page.locator('.finding').first()
  await expect(first.locator('.finding-rank')).toHaveText('1')
  await expect(first).toContainText('HL-BOARD-WAL')
  await expect(first.locator('.finding-money b')).toHaveText('$955.00')
  await expect(first.locator('.finding-money')).toContainText('382 units × $2.50')
  await expect(first.locator('.finding-money')).toContainText('15 days left')
  await expect(first.locator('.finding-money')).toContainText('Oct 27, 2026')

  // The list is ranked by dollars per day left: a small claim closing soon can beat a larger one with weeks to go.
  const rows = await page.locator('.finding .finding-money').evaluateAll(els => els.map(el => (el as HTMLElement).innerText))
  expect(rows.length).toBeGreaterThan(5)
  const perDay = rows.map(t => {
    const days = /Closes today/.test(t) ? 0 : Number(t.match(/(\d+) days? left/)![1])
    return money(t.split('\n')[0]) / Math.max(1, days)
  })
  for (let i = 1; i < perDay.length; i++) expect(perDay[i], `finding ${i + 1} ranks below finding ${i}`).toBeLessThanOrEqual(perDay[i - 1])
  expect(rows[0]).toContain('15 days left')
  expect(rows[1]).toContain('13 days left')
})

test('a case moves through its statuses and its text can be opened', async ({ page }) => {
  await openSample(page)
  const first = page.locator('.finding').first()
  const status = first.getByLabel('Case status')
  await expect(status).toHaveValue('open')
  await expect(page.locator('.kpi', { hasText: 'Recovered (logged)' })).toContainText('$87')

  await status.selectOption('draft')
  await expect(page.getByText('Marked draft')).toBeVisible()
  await status.selectOption('filed')
  await expect(status).toHaveValue('filed')
  await first.getByRole('button', { name: 'Case text' }).click()
  await expect(first.locator('.case-text pre')).toContainText('FNSKU: X002HL0005')
  await first.getByLabel('Case ID').fill('17384920561')
  await first.getByLabel('Note').fill('Support asked for the supplier invoice')
  await first.getByLabel('Note').blur()

  // Reimbursed logs the finding's amount as recovered.
  await status.selectOption('reimbursed')
  await expect(first.getByLabel('Amount recovered ($)')).toHaveValue('955')
  await expect(page.locator('.kpi', { hasText: 'Recovered (logged)' })).toContainText('$1,042')
  await status.selectOption('denied')
  await expect(status).toHaveValue('denied')
})

test('case status, case ID and notes survive a reload', async ({ page }) => {
  await openSample(page)
  const url = page.url()
  const first = page.locator('.finding').first()
  await first.getByLabel('Case status').selectOption('filed')
  await first.getByRole('button', { name: 'Case text' }).click()
  await first.getByLabel('Case ID').fill('17384920561')
  await first.getByLabel('Note').fill('Follow up on Friday')
  await first.getByLabel('Note').blur()
  await page.waitForTimeout(300) // let the IndexedDB write finish

  await page.reload()
  await expect(page).toHaveURL(url)
  const again = page.locator('.finding').first()
  await expect(again).toContainText('HL-BOARD-WAL')
  await expect(again.getByLabel('Case status')).toHaveValue('filed')
  await again.getByRole('button', { name: 'Case text' }).click()
  await expect(again.getByLabel('Case ID')).toHaveValue('17384920561')
  await expect(again.getByLabel('Note')).toHaveValue('Follow up on Friday')

  // The seller list and the first-run choice are persisted too: no onboarding after a reload.
  await page.goto('/app')
  await expect(page.getByRole('heading', { level: 3, name: /Hearth & Loom/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Try the sample' })).toHaveCount(0)
})

test('import the synthetic ledger fixture through to a worklist', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).first().click()
  await expect(page).toHaveURL(/\/data$/)
  await page.locator('input[type=file]').setInputFiles(LEDGER)

  const pending = page.locator('.pending')
  await expect(pending).toContainText('ledger-detail.csv')
  await expect(pending).toContainText('Detected Inventory Ledger (detailed view)')
  await expect(pending).toContainText('9 ledger events ready from 9 rows')
  await expect(pending).toContainText('Sep 2, 2026 to Oct 1, 2026')
  await pending.getByRole('button', { name: 'Import 9 ledger events' }).click()
  await expect(page.getByText('Imported 9 ledger events')).toBeVisible()
  await expect(page.getByRole('table')).toContainText('ledger-detail.csv')

  await page.getByRole('link', { name: 'Case worklist' }).click()
  await expect(page.locator('.finding')).toHaveCount(2)
  const lost = page.locator('.finding').first()
  await expect(lost).toContainText('Lost in warehouse')
  await expect(lost).toContainText('BB-CUT-3PC')
  await expect(lost).toContainText('3 units adjusted out on 2026-09-14')
  await expect(lost.locator('.finding-money')).toContainText('2 units')
  await expect(lost.locator('.finding-money')).toContainText('32 days left')
  await expect(lost.locator('.finding-money')).toContainText('Nov 13, 2026')
  const damaged = page.locator('.finding').nth(1)
  await expect(damaged).toContainText('Damaged in warehouse')
  await expect(damaged.locator('.finding-money')).toContainText('41 days left')
  await expect(damaged.locator('.finding-money')).toContainText('Nov 22, 2026')

  // The imported data is still there after a reload.
  await page.reload()
  await expect(page.locator('.finding')).toHaveCount(2)
  await expect(page.locator('.kpi', { hasText: 'Next window closes' })).toContainText('Nov 13, 2026')
})

test('wrong-format and unreadable files give a useful message and the app stays usable', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).first().click()
  const input = page.locator('input[type=file]')
  const pending = page.locator('.pending')

  // Prose with no header row: nothing is guessed, and nothing can be imported.
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('just some words\nno table here\n') })
  await expect(pending).toHaveCount(1)
  await expect(pending).toContainText('Could not tell which report this is')
  await expect(pending.getByRole('button', { name: /^Import/ })).toBeDisabled()

  // A header with no rows, an empty file and binary noise are refused or left unimported.
  await input.setInputFiles({ name: 'header-only.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,FNSKU,Event Type,Quantity\n') })
  await expect(page.getByText('header-only.csv has no data rows.')).toBeVisible()
  await input.setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) })
  await expect(page.getByText('empty.csv has no data rows.')).toBeVisible()
  await input.setInputFiles({ name: 'noise.csv', mimeType: 'text/csv', buffer: Buffer.from([0, 159, 146, 150, 0, 255, 10, 1, 2, 3, 4, 10, 200, 201]) })
  await expect(pending).toHaveCount(2)
  await expect(pending.nth(1)).toContainText('Could not tell which report this is')
  await expect(pending.nth(1).getByRole('button', { name: /^Import/ })).toBeDisabled()

  // A real ledger with unreadable dates and quantities: line-numbered errors, bad rows skipped, good rows kept.
  const bad = [
    'Date,FNSKU,Event Type,Quantity,Reference ID,MSKU',
    '2026-09-14,X0AAA,Adjustments,-3,9876543210,SKU-A',
    'not a date,X0AAA,Adjustments,-1,9876543211,SKU-A',
    '2026-09-15,X0AAA,Adjustments,lots,9876543212,SKU-A',
    '2026-02-30,X0AAA,Adjustments,-1,9876543213,SKU-A',
  ].join('\n')
  await input.setInputFiles({ name: 'broken-ledger.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) })
  const broken = pending.nth(2)
  await expect(broken).toContainText('1 ledger events ready from 4 rows')
  await expect(broken).toContainText('3 skipped')
  const issues = broken.getByRole('log', { name: 'Validation issues' })
  await expect(issues).toContainText('line 3')
  await expect(issues).toContainText('Date "not a date" is not a date; row skipped.')
  await expect(issues).toContainText('line 4')
  await expect(issues).toContainText('Quantity "lots" is not a number; row skipped.')
  await expect(issues).toContainText('line 5')
  await expect(issues).toContainText('Date "2026-02-30" is not a date; row skipped.')

  // Cancelling clears each one, and the app still works: import a good file and open a sample.
  for (let i = 3; i > 0; i--) await pending.last().getByRole('button', { name: 'Cancel' }).click()
  await expect(pending).toHaveCount(0)
  await input.setInputFiles(LEDGER)
  await pending.getByRole('button', { name: /^Import 9/ }).click()
  await expect(page.getByText('Imported 9 ledger events')).toBeVisible()
  await page.goto('/app?sample=peak')
  await expect(page.getByRole('heading', { level: 1, name: /Peak Botanics/ })).toBeVisible()
  await expect(page.locator('.finding').first()).toBeVisible()
})

test('nothing leaves the browser: no Supabase request, no uncaught error across the main pages', async ({ page, blocked }) => {
  await openSample(page)
  for (const path of ['', '/calendar', '/skus', '/fees', '/history', '/data', '/report']) {
    await page.goto(page.url().replace(/\/(calendar|skus|fees|history|data|report)$/, '') + path)
    await expect(page.locator('main, .report').first()).toBeVisible()
  }
  await page.goto('/docs')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Getting your data out of Seller Central')
  await page.goto('/settings')
  await expect(page.locator('main')).toBeVisible()
  // Only the Google Fonts stylesheet is ever asked for, and it is aborted by the fixture.
  expect(blocked.filter(h => !/^fonts\.(googleapis|gstatic)\.com$/.test(h))).toEqual([])
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => /supabase|sb-/.test(k)))).toEqual([])
})
