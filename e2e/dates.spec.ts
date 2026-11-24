import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const US = 'src/engine/fixtures/ledger-detail.csv'
const EU = 'src/engine/fixtures/ledger-detail-eu.csv'

const csv = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })
const HEAD = 'Date,FNSKU,Event Type,Quantity,Reference ID,Reason,MSKU,Title'
const row = (date: string, event: string, qty: number, ref: string, reason = '') => `${date},X0EU1,${event},${qty},${ref},${reason},EU-MUG,Sample mug`

/** A new seller on the Reports tab with one file dropped in. */
async function drop(page: Page, file: string | ReturnType<typeof csv>) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).first().click()
  await page.locator('input[type=file]').setInputFiles(file)
  const pending = page.locator('.pending')
  await expect(pending).toHaveCount(1)
  return pending
}
const order = (pending: ReturnType<Page['locator']>, name = 'Date') => pending.getByRole('radiogroup', { name: `Date order for ${name}` })

test('a day-first ledger is read day first, and its worklist matches the same ledger written month first', async ({ page }) => {
  const pending = await drop(page, EU)
  await expect(pending).toContainText('Dates in “Date” are read day first (DD/MM/YYYY): 14/09/2026 on line 6 can only be read that way')
  await expect(order(pending).getByRole('radio', { name: /^Day first/ })).toHaveAttribute('aria-checked', 'true')
  await expect(order(pending).getByRole('radio', { name: /^Month first/ })).toHaveAttribute('aria-checked', 'false')
  await expect(pending).toContainText('9 ledger events ready from 9 rows')
  await expect(pending).toContainText('Sep 2, 2026 to Oct 1, 2026')
  await pending.getByRole('button', { name: 'Import 9 ledger events' }).click()
  await expect(page.getByText('Imported 9 ledger events')).toBeVisible()
  await page.getByRole('link', { name: 'Case worklist' }).click()

  // Same findings and deadlines as the month-first fixture in app.spec.ts.
  await expect(page.locator('.finding')).toHaveCount(2)
  const lost = page.locator('.finding').first()
  await expect(lost).toContainText('3 units adjusted out on 2026-09-14')
  await expect(lost.locator('.finding-money')).toContainText('32 days left')
  await expect(lost.locator('.finding-money')).toContainText('Nov 13, 2026')
  await expect(page.locator('.finding').nth(1).locator('.finding-money')).toContainText('Nov 22, 2026')
})

test('the US ledger fixture still reads month first with the same result', async ({ page }) => {
  const pending = await drop(page, US)
  await expect(pending).toContainText('Dates in “Date” are read month first (MM/DD/YYYY): 09/14/2026 on line 6 can only be read that way')
  await expect(order(pending).getByRole('radio', { name: /^Month first/ })).toHaveAttribute('aria-checked', 'true')
  await expect(pending).toContainText('9 ledger events ready from 9 rows')
  await expect(pending).toContainText('Sep 2, 2026 to Oct 1, 2026')
  await expect(pending.getByRole('log', { name: 'Validation issues' })).toHaveCount(0)
})

test('the override re-reads the file and lists the rows that cannot be read that way, by line', async ({ page }) => {
  const pending = await drop(page, EU)
  await order(pending).getByRole('radio', { name: /^Month first/ }).click()
  await expect(pending).toContainText('You chose month first. The file reads day first')
  await expect(pending).toContainText('5 ledger events ready from 9 rows')
  await expect(pending).toContainText('4 skipped')
  const issues = pending.getByRole('log', { name: 'Validation issues' })
  await expect(issues).toContainText('line 6')
  await expect(issues).toContainText('Date "14/09/2026" is not a date when read month first (it is 2026-09-14 read day first); row skipped.')
  await expect(issues).toContainText('line 9')
  await expect(pending).toContainText('Jan 10, 2026 to Nov 9, 2026')

  await pending.getByRole('button', { name: 'Use detected' }).click()
  await expect(pending).toContainText('9 ledger events ready from 9 rows')
  await expect(pending.getByRole('log', { name: 'Validation issues' })).toHaveCount(0)
  await expect(order(pending).getByRole('radio', { name: /^Day first/ })).toHaveAttribute('aria-checked', 'true')
})

test('a file where every date is ambiguous needs a visible choice, and the choice sets the deadline', async ({ page }) => {
  const file = [HEAD, row('01/10/2026', 'Receipts', 24, 'FBA1'), row('05/10/2026', 'Adjustments', -3, '9000000001', 'M')].join('\n') + '\n'
  const pending = await drop(page, csv('ambiguous-ledger.csv', file))

  const alert = pending.getByRole('alert')
  await expect(alert).toContainText('The dates in “Date” can be read two ways')
  await expect(alert).toContainText('01/10/2026 on line 2 is Oct 1, 2026 day first or Jan 10, 2026 month first')
  await expect(order(pending).getByRole('radio', { name: /^Day first/ })).toHaveAttribute('aria-checked', 'false')
  await expect(order(pending).getByRole('radio', { name: /^Month first/ })).toHaveAttribute('aria-checked', 'false')
  await expect(pending).toContainText('Waiting for the date order')
  await expect(pending.getByRole('log', { name: 'Validation issues' })).toContainText('line 2')
  await expect(pending.getByRole('button', { name: /^Import/ })).toBeDisabled()

  await order(pending).getByRole('radio', { name: /^Day first/ }).click()
  await expect(pending.getByRole('alert')).toHaveCount(0)
  await expect(pending).toContainText('You chose day first. Nothing in the file decides it.')
  await expect(pending).toContainText('2 ledger events ready from 2 rows. Dates Oct 1, 2026 to Oct 5, 2026')
  // The other choice reads the same file as January and May.
  await order(pending).getByRole('radio', { name: /^Month first/ }).click()
  await expect(pending).toContainText('Dates Jan 10, 2026 to May 10, 2026')
  await order(pending).getByRole('radio', { name: /^Day first/ }).click()
  await pending.getByRole('button', { name: 'Import 2 ledger events' }).click()
  await expect(page.getByText('Imported 2 ledger events')).toBeVisible()

  await page.getByRole('link', { name: 'Case worklist' }).click()
  const lost = page.locator('.finding').first()
  await expect(lost).toContainText('3 units adjusted out on 2026-10-05')
  await expect(lost.locator('.finding-money')).toContainText('53 days left')
  await expect(lost.locator('.finding-money')).toContainText('Dec 4, 2026')
})

test('a column that contradicts itself is held with line-numbered problems until one order is chosen', async ({ page }) => {
  const file = [HEAD, row('31/10/2026', 'Receipts', 24, 'FBA1'), row('05/10/2026', 'Adjustments', -3, '9000000001', 'M'), row('10/31/2026', 'Shipments', -1, '113-0000000-0000001')].join('\n') + '\n'
  const pending = await drop(page, csv('mixed-ledger.csv', file))
  await expect(pending.getByRole('alert')).toContainText('The dates in “Date” use both orders')
  await expect(pending.getByRole('alert')).toContainText('1 value only make sense day first (line 2: 31/10/2026) and 1 only month first (line 4: 10/31/2026)')
  const issues = pending.getByRole('log', { name: 'Validation issues' })
  await expect(issues).toContainText('"31/10/2026" can only be read day first (2026-10-31).')
  await expect(issues).toContainText('"10/31/2026" can only be read month first (2026-10-31).')
  await expect(pending.getByRole('button', { name: /^Import/ })).toBeDisabled()

  await order(pending).getByRole('radio', { name: /^Day first/ }).click()
  await expect(pending).toContainText('The file mixes both orders.')
  await expect(pending).toContainText('2 ledger events ready from 3 rows')
  await expect(pending).toContainText('1 skipped')
  await expect(pending.getByRole('log', { name: 'Validation issues' })).toContainText('Date "10/31/2026" is not a date when read day first')
  await expect(pending.getByRole('button', { name: 'Import 2 ledger events' })).toBeEnabled()
})

test('another date column in the same rows can settle an ambiguous one, and says so', async ({ page }) => {
  const file = [HEAD + ',Date and Time', row('01/10/2026', 'Receipts', 24, 'FBA1') + ',2026-10-01T09:00:00-07:00', row('05/10/2026', 'Adjustments', -3, '9000000001', 'M') + ',2026-10-05T14:22:31-07:00'].join('\n') + '\n'
  const pending = await drop(page, csv('evidence-ledger.csv', file))
  await expect(pending.getByRole('alert')).toHaveCount(0)
  await expect(pending).toContainText('Dates in “Date” are read day first (DD/MM/YYYY): on every row that could go either way, that is the reading that matches the “Date and Time” column.')
  await expect(pending).toContainText('2 ledger events ready from 2 rows. Dates Oct 1, 2026 to Oct 5, 2026')
})

test('ISO and month-name files show no date-order control at all', async ({ page }) => {
  const iso = [HEAD, row('2026-10-01', 'Receipts', 24, 'FBA1'), row('"Oct 5, 2026"', 'Adjustments', -3, '9000000001', 'M')].join('\n') + '\n'
  const pending = await drop(page, csv('iso-ledger.csv', iso))
  await expect(pending).toContainText('2 ledger events ready from 2 rows')
  await expect(pending.getByRole('radiogroup')).toHaveCount(0)
  await expect(pending.getByText('Dates in “Date”')).toHaveCount(0)
})

test('the Docs explain how day-first and month-first dates are decided', async ({ page }) => {
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: 'Date formats: day first or month first' })).toBeVisible()
  await expect(page.locator('#dates').locator('xpath=following-sibling::ul[1]')).toContainText('It does not guess.')
})
