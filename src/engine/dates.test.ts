// Slash dates: the order (day first or month first) is decided once per file and date column, never guessed per row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { autoMap, detect, mergeData, parseCsv, parseDate, validate, type DateOrder, type Kind } from './parse.ts'
import { addDays, analyze } from './recon.ts'
import { emptyDataset, type Dataset } from './types.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

function run(text: string, dateOrder?: Record<number, DateOrder>, kind?: Kind) {
  const t = parseCsv(text)
  const d = detect(t)
  const k = kind ?? d.kind!
  return validate(k, t, autoMap(k, t.rows[d.header]), d.header, { dateOrder })
}

/** A ledger with the given dates in its Date column (and optionally an ISO "Date and Time" column per row). */
function ledger(dates: string[], iso?: string[]) {
  const head = 'Date,FNSKU,Event Type,Quantity,Reference ID,Reason' + (iso ? ',Date and Time' : '')
  return [head, ...dates.map((d, i) => `${d},X0AAA,Adjustments,-1,R${i},M${iso ? `,${iso[i]}` : ''}`)].join('\n') + '\n'
}
const days = (v: ReturnType<typeof run>) => v.data.ledger!.map(r => r.date)

// The importer as it was before this change, kept here so the new one can be compared with it.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const ymd = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : ''
}
function oldParseDate(raw: string): string {
  const s = raw.trim().replace(/^"|"$/g, '')
  if (!s) return ''
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return ymd(+m[3], +m[1], +m[2])
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (m) return ymd(+m[3], +m[2], +m[1])
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/)
  if (m && MONTHS.includes(m[1].toLowerCase())) return ymd(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2])
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})/)
  if (m && MONTHS.includes(m[2].toLowerCase())) return ymd(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1])
  return ''
}

test('parseDate: ISO, dotted and month-name dates are unchanged, and month first stays the default for a bare slash date', () => {
  const same = ['2026-07-14T08:12:33+00:00', '2026/07/14', '2026-7-4', 'Jul 14, 2026 8:12:33 AM PDT', 'July 4 2026', '14 Jul 2026', '4 July 2026', '14.07.2026', '1.2.2026', '2026-02-30', '30.02.2026', 'soon', '', '  ', '"2026-07-14"', '7/4', '7-4-2026', '31/10/26']
  for (const s of same) assert.equal(parseDate(s), oldParseDate(s), s)
  for (const s of same) assert.equal(parseDate(s, 'dmy'), oldParseDate(s), `${s} (day first)`)
})

test('parseDate: every slash value, month first as before and day first mirrored', () => {
  for (const y of [2026, 2028, 1999]) {
    for (let a = 0; a <= 32; a++) {
      for (let b = 0; b <= 32; b++) {
        const s = `${a}/${b}/${y}`
        assert.equal(parseDate(s), oldParseDate(s), s)
        assert.equal(parseDate(s, 'mdy'), oldParseDate(s), s)
        assert.equal(parseDate(s, 'dmy'), oldParseDate(`${b}/${a}/${y}`), s)
      }
    }
  }
  assert.equal(parseDate('31/10/2026', 'dmy'), '2026-10-31')
  assert.equal(parseDate('31/10/2026', 'mdy'), '')
  assert.equal(parseDate('10/31/2026', 'mdy'), '2026-10-31')
  assert.equal(parseDate('10/31/2026', 'dmy'), '')
  assert.equal(parseDate('05/10/2026 14:22:31', 'dmy'), '2026-10-05')
  assert.equal(parseDate('"05/10/2026"', 'mdy'), '2026-05-10')
})

test('a day above 12 settles the column, in either order', () => {
  const eu = run(ledger(['31/10/2026', '05/10/2026', '02/09/2026']))
  assert.deepEqual(days(eu), ['2026-10-31', '2026-10-05', '2026-09-02'])
  assert.deepEqual([eu.count, eu.skipped, eu.issues], [3, 0, []])
  assert.deepEqual([eu.dates[0].order, eu.dates[0].basis, eu.dates[0].detected, eu.dates[0].chosen], ['dmy', 'values', 'dmy', false])
  assert.deepEqual(eu.dates[0].counts, { dmy: 1, mdy: 0, either: 2 })

  const us = run(ledger(['10/31/2026', '05/10/2026', '02/09/2026']))
  assert.deepEqual(days(us), ['2026-10-31', '2026-05-10', '2026-02-09'])
  assert.deepEqual([us.dates[0].order, us.dates[0].basis], ['mdy', 'values'])
})

test('the silent shift this fixes: 05/10/2026 in a day-first export is 5 October, not 10 May', () => {
  const file = ledger(['05/10/2026', '16/10/2026'])
  assert.deepEqual(days(run(file)), ['2026-10-05', '2026-10-16'])
  assert.equal(oldParseDate('05/10/2026'), '2026-05-10') // what the importer used to do, and 16/10/2026 was dropped
  assert.equal(oldParseDate('16/10/2026'), '')
})

test('values that read the same either way do not need a choice', () => {
  const v = run(ledger(['05/05/2026', '11/11/2026', '2026-03-04', '"Mar 4, 2026"']))
  assert.deepEqual(days(v), ['2026-05-05', '2026-11-11', '2026-03-04', '2026-03-04'])
  assert.deepEqual(v.dates, [])
  assert.equal(v.count, 4)
})

test('a fully ambiguous column blocks the import until a choice is made, and the choice is used', () => {
  const file = ledger(['05/10/2026', '03/11/2026', '07/12/2026'])
  const v = run(file)
  assert.deepEqual([v.count, v.data, v.skipped], [0, {}, 0])
  assert.equal(v.dates[0].order, null)
  assert.equal(v.dates[0].detected, null)
  assert.equal(v.issues.length, 1)
  assert.deepEqual([v.issues[0].level, v.issues[0].line], ['error', 2])
  assert.match(v.issues[0].message, /"05\/10\/2026" is 2026-10-05 day first or 2026-05-10 month first/)

  const dmy = run(file, { 0: 'dmy' })
  assert.deepEqual(days(dmy), ['2026-10-05', '2026-11-03', '2026-12-07'])
  assert.deepEqual([dmy.dates[0].order, dmy.dates[0].chosen, dmy.dates[0].basis], ['dmy', true, ''])
  const mdy = run(file, { 0: 'mdy' })
  assert.deepEqual(days(mdy), ['2026-05-10', '2026-03-11', '2026-07-12'])
  assert.deepEqual(mdy.range, ['2026-03-11', '2026-07-12'])
  // A choice for another column does not unblock this one.
  assert.equal(run(file, { 3: 'dmy' }).count, 0)
})

test('contradictory columns: line-numbered problems, nothing imported and no mixed reading', () => {
  const file = ledger(['31/10/2026', '05/10/2026', '10/31/2026', '12/13/2026'])
  const v = run(file)
  assert.deepEqual([v.count, v.data], [0, {}])
  assert.equal(v.dates[0].conflict, true)
  assert.equal(v.dates[0].order, null)
  assert.ok(v.issues.every(i => i.level === 'error'))
  assert.deepEqual(v.issues.slice(1).map(i => i.line), [2, 4, 5])
  assert.match(v.issues[0].message, /mixes both date orders: 1 value only make sense day first, 2 only month first/)
  assert.match(v.issues[1].message, /"31\/10\/2026" can only be read day first \(2026-10-31\)/)
  assert.match(v.issues[2].message, /"10\/31\/2026" can only be read month first \(2026-10-31\)/)

  // Once an order is chosen, every row is read that one way and the rows that do not fit are skipped with their line.
  const dmy = run(file, { 0: 'dmy' })
  assert.deepEqual(days(dmy), ['2026-10-31', '2026-10-05'])
  assert.deepEqual(dmy.issues.map(i => i.line), [4, 5])
  assert.match(dmy.issues[0].message, /Date "10\/31\/2026" is not a date when read day first \(it is 2026-10-31 read month first\); row skipped\./)
  assert.match(dmy.issues[1].message, /Date "12\/13\/2026" is not a date when read day first \(it is 2026-12-13 read month first\)/)
  assert.equal(dmy.skipped, 2)
  const mdy = run(file, { 0: 'mdy' })
  assert.deepEqual(days(mdy), ['2026-05-10', '2026-10-31', '2026-12-13'])
  assert.deepEqual(mdy.issues.map(i => i.line), [2])
})

test('an override beats what the values say, and the rows it cannot read are reported by line', () => {
  const file = ledger(['14/09/2026', '02/09/2026', '23/09/2026'])
  assert.equal(run(file).dates[0].order, 'dmy')
  const forced = run(file, { 0: 'mdy' })
  assert.deepEqual(days(forced), ['2026-02-09'])
  assert.deepEqual([forced.skipped, forced.issues.map(i => i.line)], [2, [2, 4]])
  assert.equal(forced.dates[0].detected, 'dmy')
  assert.equal(forced.dates[0].order, 'mdy')
  assert.equal(forced.dates[0].chosen, true)
})

test('the other date column in the same rows can settle an otherwise ambiguous column', () => {
  const file = ledger(['05/10/2026', '03/11/2026', '07/12/2026'], ['2026-10-05T14:22:31-07:00', '2026-11-03T01:10:02-07:00', '2026-12-07T23:59:59-08:00'])
  const v = run(file)
  assert.deepEqual(days(v), ['2026-10-05', '2026-11-03', '2026-12-07'])
  assert.deepEqual([v.dates[0].order, v.dates[0].basis, v.dates[0].evidence], ['dmy', 'evidence', 'Date and Time'])
  const us = run(ledger(['10/05/2026', '11/03/2026', '12/07/2026'], ['2026-10-05T14:22:31-07:00', '2026-11-03T01:10:02-07:00', '2026-12-07T23:59:59-08:00']))
  assert.deepEqual([days(us), us.dates[0].order, us.dates[0].basis], [['2026-10-05', '2026-11-03', '2026-12-07'], 'mdy', 'evidence'])
  // A day of slack covers time zones; a month does not.
  const tz = run(ledger(['05/10/2026', '03/11/2026'], ['2026-10-06T00:30:00+02:00', '2026-11-02T23:10:00-08:00']))
  assert.equal(tz.dates[0].order, 'dmy')
})

test('evidence that is missing, unrelated, thin or contradictory is not used', () => {
  const dates = ['05/10/2026', '03/11/2026', '07/12/2026']
  const blocked = (iso: string[]) => run(ledger(dates, iso)).count
  // A date column that is a fortnight later (a deposit date) fits neither reading.
  assert.equal(blocked(['2026-10-19', '2026-11-17', '2026-12-21']), 0)
  // One row out of line spoils the column.
  assert.equal(blocked(['2026-10-05', '2026-11-03', '2026-12-05']), 0)
  // A column with a blank, or with plain text, gives nothing.
  assert.equal(blocked(['2026-10-05', '', '2026-12-07']), 0)
  assert.equal(blocked(['x', 'y', 'z']), 0)
  // A single ambiguous row is one coincidence away from wrong: ask.
  assert.equal(run(ledger(['05/10/2026'], ['2026-10-05'])).count, 0)
  // Month-first and day-first readings can both be near a mixed column, so nothing is decided.
  assert.equal(blocked(['2026-10-05', '2026-03-11', '2026-12-07']), 0)
})

test('two other date columns that disagree decide nothing', () => {
  const head = 'Date,FNSKU,Event Type,Quantity,Reference ID,Date and Time,Reference date\n'
  const v = run(head + '05/10/2026,X0AAA,Adjustments,-1,R1,2026-10-05,2026-05-10\n03/11/2026,X0AAA,Adjustments,-1,R2,2026-11-03,2026-03-11\n')
  assert.equal(v.count, 0)
  assert.equal(v.dates[0].order, null)
})

test('ISO, dotted and month-name files are untouched: no date column is listed and every date is as before', () => {
  for (const [name, kind] of [['reimbursements.txt', 'reimbursements'], ['returns.txt', 'returns'], ['settlement-v2.txt', 'txns'], ['date-range.csv', 'txns']] as const) {
    const v = run(fixture(name))
    assert.equal(v.kind, kind)
    assert.deepEqual(v.dates, [], name)
  }
  const dotted = run('Date,FNSKU,Event Type,Quantity,Reference ID\n14.07.2026,X1,Adjustments,-1,R1\n05.10.2026,X1,Adjustments,-1,R2\n')
  assert.deepEqual([days(dotted), dotted.dates], [['2026-07-14', '2026-10-05'], []])
})

test('the US ledger fixture imports exactly as before', () => {
  const v = run(fixture('ledger-detail.csv'))
  assert.deepEqual([v.count, v.skipped, v.issues], [9, 0, []])
  assert.deepEqual([v.dates[0].order, v.dates[0].basis, v.dates[0].counts], ['mdy', 'values', { dmy: 0, mdy: 4, either: 4 }])
  assert.deepEqual(days(v), ['2026-09-02', '2026-09-05', '2026-09-09', '2026-09-11', '2026-09-14', '2026-09-20', '2026-09-23', '2026-09-23', '2026-10-01'])
  // Row for row the same as reading every value month first, which is what the old importer did.
  const t = parseCsv(fixture('ledger-detail.csv'))
  assert.deepEqual(days(v), t.rows.slice(1).map(r => oldParseDate(r[0])))
})

test('the same ledger written day first imports to the identical dataset, findings and deadlines', () => {
  const us = run(fixture('ledger-detail.csv'))
  const eu = run(fixture('ledger-detail-eu.csv'))
  assert.deepEqual([eu.count, eu.skipped, eu.issues, eu.dates[0].order, eu.dates[0].basis], [9, 0, [], 'dmy', 'values'])
  assert.deepEqual(eu.data, us.data)
  assert.deepEqual(eu.range, us.range)
  const asOf = '2026-10-12'
  const a = analyze({ ...emptyDataset(), ...us.data } as Dataset, { asOf })
  const b = analyze({ ...emptyDataset(), ...eu.data } as Dataset, { asOf })
  assert.deepEqual(b.findings, a.findings)
  assert.deepEqual(b.findings.map(f => f.deadline), ['2026-11-13', '2026-11-22'])
})

test('overlapping exports in different date orders do not double count, and deadlines follow the chosen order', () => {
  const us = run(fixture('ledger-detail.csv'))
  const eu = run(fixture('ledger-detail-eu.csv'))
  const merged = mergeData(mergeData(emptyDataset(), us.data), eu.data)
  assert.equal(merged.ledger.length, 9)
  // An ambiguous file imported with each choice: the deadline is 60 days after the day that choice reads.
  const file = ledger(['05/10/2026', '03/11/2026'])
  const deadline = (o: DateOrder) => {
    const v = run(file, { 0: o })
    const a = analyze({ ...emptyDataset(), ...v.data } as Dataset, { asOf: '2026-11-04' })
    return a.findings.map(f => f.deadline).sort()
  }
  assert.deepEqual(deadline('dmy'), [addDays('2026-10-05', 60), addDays('2026-11-03', 60)])
  assert.deepEqual(deadline('mdy'), [addDays('2026-03-11', 60), addDays('2026-05-10', 60)])
})

test('other reports use the same rule', () => {
  const reimb = 'approval-date\treimbursement-id\treason\tfnsku\tamount-per-unit\tamount-total\tquantity-reimbursed-cash\n' +
    '31/10/2026\t1\tLost_Warehouse\tX1\t10\t10\t1\n05/10/2026\t2\tLost_Warehouse\tX1\t10\t10\t1\n'
  const v = run(reimb)
  assert.deepEqual([v.kind, v.dates[0].order, v.data.reimbursements!.map(r => r.date)], ['reimbursements', 'dmy', ['2026-10-31', '2026-10-05']])
  const ambiguous = run(reimb.replace('31/10/2026', '03/10/2026'))
  assert.deepEqual([ambiguous.count, ambiguous.dates[0].order], [0, null])
  const inbound = 'Shipment ID,FNSKU,Units expected,Units received,Last updated\nFBA1,X1,24,22,30/09/2026\nFBA2,X1,24,24,01/10/2026\n'
  assert.deepEqual(run(inbound).data.inbound!.map(r => r.date), ['2026-09-30', '2026-10-01'])
})

test('never wrong without saying so: random columns in both orders either come out right or are held for a choice', () => {
  let seed = 12345
  const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return Math.floor((seed / 4294967296) * n) }
  let settled = 0, held = 0
  for (let k = 0; k < 600; k++) {
    const n = 1 + rnd(6)
    const iso = Array.from({ length: n }, () => addDays('2025-01-01', rnd(700)))
    for (const order of ['dmy', 'mdy'] as const) {
      const text = iso.map(d => { const [y, m, day] = d.split('-'); return order === 'dmy' ? `${day}/${m}/${y}` : `${m}/${day}/${y}` })
      const v = run(ledger(text))
      if (v.count === 0) { held++; assert.equal(v.dates[0].order, null); assert.ok(v.issues.length >= 1); continue }
      settled++
      assert.deepEqual(days(v), iso, `${order} ${text.join(' ')}`)
      assert.equal(v.skipped, 0)
    }
    // Fully ambiguous columns are always held, whichever way they were written.
    const amb = iso.filter(d => Number(d.slice(8)) <= 12 && d.slice(5, 7) !== d.slice(8))
    if (amb.length === iso.length && amb.length) assert.equal(run(ledger(amb.map(d => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`))).count, 0)
  }
  assert.ok(settled > 200 && held > 20, `settled ${settled}, held ${held}`)
})
