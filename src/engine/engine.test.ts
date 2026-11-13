import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, detect, mergeData, parseCsv, parseDate, parseNum, reportCsv, validate } from './parse.ts'
import { checkTable, dimWeight, fulfilmentFee, inPeak, sizeTier, US_2026 } from './fees.ts'
import { addDays, analyze, rank, reasonGroup, reconcileLedger } from './recon.ts'
import { caseText, compareSnapshots, findingsCsv, snapshot } from './cases.ts'
import { generate } from './sample.ts'
import { emptyDataset, type Dataset, type LedgerRow, type Reimbursement } from './types.ts'

const AS_OF = '2026-11-09'
let n = 2
const led = (date: string, event: string, qty: number, reason = '', fnsku = 'X001', ref = ''): LedgerRow => ({ date, fnsku, msku: 'SKU1', event, qty, reason, ref: ref || `R${n}`, line: n++ })
const reimb = (date: string, reason: string, units: number, per = 10, extra: Partial<Reimbursement> = {}): Reimbursement => ({ date, id: `RB${n}`, reason, sku: 'SKU1', fnsku: 'X001', amountPerUnit: per, amountTotal: per * units, qtyCash: units, qtyInventory: 0, line: n++, ...extra })
const ds = (p: Partial<Dataset>): Dataset => ({ ...emptyDataset(), costs: [{ sku: 'SKU1', cost: 10, line: 2 }], ...p })

// ---------- Parsing ----------

test('parseDate reads the date formats Seller Central reports use', () => {
  assert.equal(parseDate('2026-07-14T08:12:33+00:00'), '2026-07-14')
  assert.equal(parseDate('Jul 14, 2026 8:12:33 AM PDT'), '2026-07-14')
  assert.equal(parseDate('7/4/2026'), '2026-07-04')
  assert.equal(parseDate('14.07.2026'), '2026-07-14')
  assert.equal(parseDate('2026-02-30'), '')
  assert.equal(parseDate('soon'), '')
})

test('parseNum handles currency, thousands, parentheses and decimal commas', () => {
  assert.equal(parseNum('$1,234.50'), 1234.5)
  assert.equal(parseNum('(3.20)'), -3.2)
  assert.equal(parseNum('-3,20'), -3.2)
  assert.ok(Number.isNaN(parseNum('abc')))
})

test('parseCsv sniffs tabs and keeps quoted delimiters and newlines', () => {
  const t = parseCsv('a\tb\n"x\ty"\t2\n')
  assert.deepEqual(t.rows, [['a', 'b'], ['x\ty', '2']])
  const c = parseCsv('a,b\n"line\nbreak",3\n4,5\n')
  assert.deepEqual(c.rows[1], ['line\nbreak', '3'])
  assert.equal(c.lines[2], 4)
})

test('detect recognises each report and skips the date range report preamble', () => {
  const kind = (h: string) => detect(parseCsv(h + '\n1,2\n')).kind
  assert.equal(kind('Date,FNSKU,ASIN,MSKU,Title,Event Type,Reference ID,Quantity'), 'ledger')
  assert.equal(kind('approval-date,reimbursement-id,case-id,reason,fnsku'), 'reimbursements')
  assert.equal(kind('return-date,order-id,sku,detailed-disposition'), 'returns')
  assert.equal(kind('sku,fnsku,longest-side,median-side'), 'fees')
  assert.equal(kind('settlement-id,transaction-type,amount-type,amount-description,amount'), 'txns')
  assert.equal(kind('Shipment ID,Merchant SKU,FNSKU,Units expected,Units received'), 'inbound')
  assert.equal(kind('sku,unit_cost'), 'costs')
  const pre = parseCsv('"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"\n"All amounts in USD"\ndate/time,settlement id,type,order id,sku,quantity,product sales,fba fees\n"Jul 1, 2026 1:00:00 AM PDT",1,Order,111,S,1,20.00,-3.40\n')
  assert.deepEqual(detect(pre), { kind: 'txns', header: 2 })
})

test('validate reports bad rows with their file line numbers and keeps the good ones', () => {
  const t = parseCsv('Date,FNSKU,MSKU,Event Type,Reference ID,Quantity,Reason\n2026-07-01,X1,S1,Adjustments,9,-2,M\nnot-a-date,X1,S1,Shipments,,-1,\n2026-07-02,,S1,Shipments,,-1,\n2026-07-03,X1,S1,Teleport,,1,\n')
  const v = validate('ledger', t, autoMap('ledger', t.rows[0]))
  assert.equal(v.count, 2)
  assert.equal(v.skipped, 2)
  assert.deepEqual(v.issues.map(i => [i.line, i.level]), [[3, 'error'], [4, 'error'], [5, 'warning']])
  assert.deepEqual(v.range, ['2026-07-01', '2026-07-03'])
})

test('validate refuses to import when a required column is not mapped', () => {
  const t = parseCsv('Date,FNSKU\n2026-07-01,X1\n')
  const v = validate('ledger', t, autoMap('ledger', t.rows[0]))
  assert.equal(v.count, 0)
  assert.match(v.issues[0].message, /Event Type/)
})

test('settlement flat file rows fold into one line per order item', () => {
  const t = parseCsv([
    'settlement-id,transaction-type,order-id,sku,quantity-purchased,amount-type,amount-description,amount,posted-date',
    '1,Order,111,S1,2,ItemPrice,Principal,40.00,2026-07-01',
    '1,Order,111,S1,,ItemFees,FBAPerUnitFulfillmentFee,-7.10,2026-07-01',
    '1,Order,111,S1,,ItemFees,Commission,-6.00,2026-07-01',
    '1,Refund,222,S1,1,ItemPrice,Principal,-20.00,2026-07-03',
  ].join('\n'))
  const v = validate('txns', t, autoMap('txns', t.rows[0]))
  const o = v.data.txns!.find(x => x.type === 'Order')!
  assert.deepEqual([o.qty, o.principal, o.fbaFee, o.otherFee], [2, 40, 7.1, 6])
  assert.equal(v.data.txns!.find(x => x.type === 'Refund')!.principal, -20)
})

test('fee preview converts centimetres and grams to inches and pounds', () => {
  const t = parseCsv('sku,longest-side,median-side,shortest-side,unit-of-dimension,item-package-weight,unit-of-weight,your-price\nS1,25.4,12.7,2.54,centimeters,453.592,grams,20\n')
  const f = validate('fees', t, autoMap('fees', t.rows[0])).data.fees![0]
  assert.equal(f.longest, 10)
  assert.equal(Math.round(f.weightLb * 1000) / 1000, 1)
})

test('mergeData skips duplicate rows on re-import and replaces cost rows by SKU', () => {
  const a = { ...emptyDataset(), ledger: [led('2026-07-01', 'Shipments', -1)], costs: [{ sku: 'S', cost: 5, line: 2 }] }
  const again = { ledger: [{ ...a.ledger[0], line: 99 }], costs: [{ sku: 'S', cost: 6, line: 3 }] }
  const m = mergeData(a, again)
  assert.equal(m.ledger.length, 1)
  assert.deepEqual(m.costs.map(c => c.cost), [6])
})

// ---------- Fees ----------

test('size tier follows the dimension and weight thresholds', () => {
  assert.equal(sizeTier({ longest: 14.8, median: 10.9, shortest: 0.7, weightLb: 0.94 }), 'small-standard')
  assert.equal(sizeTier({ longest: 15.2, median: 11.1, shortest: 1.3, weightLb: 1.08 }), 'large-standard')
  assert.equal(sizeTier({ longest: 30, median: 20, shortest: 10, weightLb: 25 }), 'small-bulky')
  assert.equal(sizeTier({ longest: 70, median: 30, shortest: 20, weightLb: 40 }), 'extra-large')
})

test('fulfilment fee uses dimensional weight, price bands and the dated surcharge', () => {
  const box = { longest: 12, median: 10, shortest: 8, weightLb: 2 }
  assert.equal(Math.round(dimWeight(box) * 100) / 100, 6.91)
  const before = fulfilmentFee(box, 20, '2026-03-01')
  assert.equal(before.tier, 'large-standard')
  assert.equal(before.fee, 8.45)
  const after = fulfilmentFee(box, 20, '2026-05-01')
  assert.equal(after.fee, Math.round(before.base * 1.035 * 100) / 100)
  const cheap = fulfilmentFee({ longest: 6, median: 4, shortest: 0.5, weightLb: 0.1 }, 8, '2026-03-01')
  assert.equal(cheap.fee, Math.round((3.32 - 0.77) * 100) / 100)
})

test('checkTable rejects a malformed user-edited fee table', () => {
  assert.doesNotThrow(() => checkTable(structuredClone(US_2026)))
  const bad = structuredClone(US_2026)
  bad.tiers['large-standard'].brackets[1].upToLb = 0.01
  assert.throws(() => checkTable(bad), /ascending/)
})

// ---------- Ledger reconciliation ----------

test('reason codes map to lost, found and damaged groups', () => {
  assert.equal(reasonGroup('M'), 'lost')
  assert.equal(reasonGroup('5'), 'lost')
  assert.equal(reasonGroup('F'), 'found')
  assert.equal(reasonGroup('E'), 'damaged')
  assert.equal(reasonGroup('H'), 'other')
  assert.equal(reasonGroup('Damaged by customer'), 'other')
})

test('found adjustments offset the oldest lost units first', () => {
  const { events } = reconcileLedger(ds({ ledger: [led('2026-09-01', 'Adjustments', -5, 'M'), led('2026-09-20', 'Adjustments', -3, 'M'), led('2026-09-25', 'Adjustments', 4, 'F')] }))
  assert.deepEqual(events.map(e => e.remaining), [1, 3])
})

test('reimbursements match the nearest loss of the same kind', () => {
  const { events } = reconcileLedger(ds({
    ledger: [led('2026-06-01', 'Adjustments', -2, 'M'), led('2026-09-01', 'Adjustments', -4, 'M'), led('2026-09-02', 'Adjustments', -1, '6')],
    reimbursements: [reimb('2026-09-15', 'Lost_Warehouse', 4)],
  }))
  assert.deepEqual(events.map(e => e.remaining), [2, 0, 1])
})

test('a reimbursement reversal re-opens the units it clawed back', () => {
  const a = analyze(ds({ ledger: [led('2026-10-01', 'Adjustments', -3, 'M')], reimbursements: [reimb('2026-10-10', 'Lost_Warehouse', 3), reimb('2026-10-20', 'Reimbursement_Reversal', -2)] }), { asOf: AS_OF })
  const lost = a.findings.filter(f => f.kind === 'lost')
  assert.equal(lost.reduce((s, f) => s + f.units, 0), 2)
})

test('an unreimbursed loss is valued at cost with a 60-day deadline', () => {
  const a = analyze(ds({ ledger: [led('2026-10-01', 'Adjustments', -3, 'M', 'X001', '9000')] }), { asOf: AS_OF })
  const f = a.findings[0]
  assert.equal(f.kind, 'lost')
  assert.equal(f.amount, 30)
  assert.equal(f.deadline, addDays('2026-10-01', 60))
  assert.equal(a.totals.open, 30)
  assert.equal(f.id, 'lost:X001:2026-10-01:9000')
})

test('losses past the window count as missed, not open', () => {
  const a = analyze(ds({ ledger: [led('2026-06-01', 'Adjustments', -3, 'M')] }), { asOf: AS_OF })
  assert.equal(a.totals.open, 0)
  assert.equal(a.totals.missed, 30)
})

// ---------- Returns, inbound, value ----------

test('a refund opens a claim only after the return window, unless the unit came back or was reimbursed', () => {
  const t = (date: string, orderId: string) => ({ date, type: 'Refund', orderId, sku: 'SKU1', qty: 1, principal: -25, fbaFee: 0, otherFee: 0, line: n++ })
  const a = analyze(ds({
    txns: [t('2026-08-01', 'A'), t('2026-10-20', 'B'), t('2026-08-02', 'C'), t('2026-08-03', 'D')],
    returns: [{ date: '2026-08-10', orderId: 'C', sku: 'SKU1', fnsku: 'X001', qty: 1, line: 2 }],
    reimbursements: [reimb('2026-09-20', 'CustomerReturn', 1, 25, { orderId: 'D' })],
  }), { asOf: AS_OF })
  const r = a.findings.filter(f => f.kind === 'return')
  assert.deepEqual(r.map(f => f.refs[0]).sort(), ['A', 'B'])
  assert.equal(r.find(f => f.refs[0] === 'A')!.amount, 25)
  assert.equal(a.totals.open, 25)
  assert.equal(a.totals.upcoming, 25)
})

test('inbound shortfalls net off Lost_Inbound reimbursements; recent shipments wait', () => {
  const a = analyze(ds({
    inbound: [
      { shipmentId: 'FBA1', sku: 'SKU1', fnsku: 'X001', shipped: 100, received: 90, date: '2026-10-01', status: 'Closed', line: 2 },
      { shipmentId: 'FBA2', sku: 'SKU1', fnsku: 'X001', shipped: 50, received: 20, date: '2026-11-05', status: 'Receiving', line: 3 },
    ],
    reimbursements: [reimb('2026-10-15', 'Lost_Inbound', 4)],
  }), { asOf: AS_OF })
  const f = a.findings.filter(x => x.kind === 'inbound')
  assert.equal(f.length, 1)
  assert.equal(f[0].units, 6)
  assert.deepEqual(a.inTransit, [{ shipmentId: 'FBA2', units: 30, date: '2026-11-05' }])
})

test('reimbursements below cost are flagged with the gap', () => {
  const a = analyze(ds({ reimbursements: [reimb('2026-10-15', 'Lost_Warehouse', 4, 5), reimb('2026-10-16', 'Lost_Warehouse', 2, 9.5)] }), { asOf: AS_OF })
  const u = a.findings.filter(f => f.kind === 'underpaid')
  assert.equal(u.length, 1)
  assert.equal(u[0].amount, 20)
})

// ---------- Fees in the data ----------

test('fee audit catches a re-measured SKU and dates the step', () => {
  const trueDims = { longest: 14.8, median: 10.9, shortest: 0.7, weightLb: 0.94 }
  const wrong = { longest: 15.2, median: 11.1, shortest: 1.3, weightLb: 1.08 }
  const txns = ['2026-09-01', '2026-09-20', '2026-10-01', '2026-10-10'].map((date, i) => ({ date, type: 'Order', orderId: `O${i}`, sku: 'SKU1', qty: 1, principal: 30, fbaFee: fulfilmentFee(i < 2 ? trueDims : wrong, 30, date).fee, otherFee: 0, line: n++ }))
  const a = analyze({ ...emptyDataset(), txns, costs: [{ sku: 'SKU1', cost: 9, ...trueDims, line: 2 }], fees: [{ sku: 'SKU1', fnsku: 'X001', price: 30, ...wrong, expectedFee: 0, line: 2 }] }, { asOf: AS_OF })
  const f = a.findings.find(x => x.kind === 'fee')!
  assert.equal(f.units, 2)
  assert.equal(f.confidence, 'high')
  assert.equal(f.refs[0], 'fee change 2026-10-01')
  assert.equal(f.amount, Math.round((fulfilmentFee(wrong, 30, '2026-10-01').fee - fulfilmentFee(trueDims, 30, '2026-10-01').fee) * 2 * 100) / 100)
})

test('fee audit leaves holiday peak charges out instead of calling them overcharges', () => {
  const dims = { longest: 10, median: 6, shortest: 2, weightLb: 0.9 }
  const fee = fulfilmentFee(dims, 25, '2026-10-01').fee
  // Peak fees are higher; a +$0.40 charge inside Oct 15 - Jan 14 is expected, outside it is an overcharge.
  const txns = ['2026-10-10', '2026-10-20', '2026-12-30', '2027-01-03'].map((date, i) => ({ date, type: 'Order', orderId: `P${i}`, sku: 'SKU1', qty: 1, principal: 25, fbaFee: fee + 0.4, otherFee: 0, line: n++ }))
  const a = analyze({ ...emptyDataset(), txns, fees: [{ sku: 'SKU1', fnsku: 'X001', price: 25, ...dims, expectedFee: 0, line: 2 }] }, { asOf: '2027-01-05' })
  const f = a.findings.find(x => x.kind === 'fee')!
  assert.equal(f.units, 1)
  assert.equal(f.eventDate, '2026-10-10')
  assert.ok(a.notes.some(x => /3 units shipped in the holiday peak/.test(x)))
  assert.equal(inPeak('2026-10-14', US_2026), false)
  assert.equal(inPeak('2027-01-14', US_2026), true)
  assert.equal(inPeak('2026-12-01', { ...US_2026, peak: null }), false)
})

test('placement fees charged on units never received are refunded per unit', () => {
  const a = analyze(ds({
    inbound: [{ shipmentId: 'FBA9', sku: 'SKU1', fnsku: 'X001', shipped: 100, received: 57, date: '2026-09-01', status: 'Closed', line: 2 }],
    txns: [{ date: '2026-08-25', type: 'ServiceFee', orderId: '', sku: '', qty: 0, principal: 0, fbaFee: 0, otherFee: 50, description: 'FBA Inbound Placement Service Fee', shipmentId: 'FBA9', line: 2 }],
  }), { asOf: AS_OF })
  const f = a.findings.find(x => x.kind === 'fee-transit')!
  assert.equal(f.units, 43)
  assert.equal(f.amount, 21.5)
})

// ---------- Actions ----------

test('worklist ranks by dollars per day left, then not-yet-open, then expired', () => {
  const base = { kind: 'lost' as const, fnsku: '', sku: '', title: '', units: 1, unitValue: 1, basis: '', eventDate: '', refs: [], lines: [], detail: '', policy: '', confidence: 'high' as const }
  const soon = { ...base, id: 'a', amount: 40, opens: '2026-10-01', deadline: '2026-11-12' }
  const later = { ...base, id: 'b', amount: 90, opens: '2026-10-01', deadline: '2026-12-29' }
  const upcoming = { ...base, id: 'c', amount: 500, opens: '2026-12-01', deadline: '2027-01-30' }
  const gone = { ...base, id: 'd', amount: 900, opens: '2026-08-01', deadline: '2026-10-01' }
  const order = [gone, upcoming, later, soon].sort((x, y) => rank(x, AS_OF) - rank(y, AS_OF)).map(f => f.id)
  assert.deepEqual(order, ['a', 'b', 'c', 'd'])
})

test('case text carries the FNSKU, dates, ledger references and policy', () => {
  const a = analyze(ds({ ledger: [led('2026-10-01', 'Adjustments', -3, 'M', 'X001', '9123')] }), { asOf: AS_OF })
  const txt = caseText(a.findings[0], 'Hearth & Loom')
  for (const s of ['FNSKU: X001', 'Date of event: 2026-10-01', 'References: 9123', 'Units: 3', '$30.00', 'within 60 days', 'Hearth & Loom']) assert.ok(txt.includes(s), s)
})

test('CSV export and snapshots include case status and recovered dollars', () => {
  const a = analyze(ds({ ledger: [led('2026-10-01', 'Adjustments', -3, 'M'), led('2026-10-05', 'Adjustments', -2, 'M')] }), { asOf: AS_OF })
  const cases = { [a.findings[0].id]: { status: 'reimbursed' as const, recovered: 18, updatedAt: 1 }, [a.findings[1].id]: { status: 'filed' as const, caseId: '123', updatedAt: 1 } }
  const csv = findingsCsv(a.findings, cases, AS_OF)
  assert.equal(csv.trim().split('\n').length, 3)
  assert.match(csv, /reimbursed/)
  const s1 = snapshot(a, {}, 's1', '2026-10', 'Oct'), s2 = snapshot(a, cases, 's2', '2026-11', 'Nov')
  assert.equal(s2.recovered, 18)
  const d = compareSnapshots(s1, s2).find(x => x.key === 'recovered')!
  assert.deepEqual([d.before, d.after], [0, 18])
})

// ---------- Samples ----------

test('the home-goods sample has exactly 140 unreimbursed lost units and a mis-measured SKU', () => {
  const a = analyze(generate('hearth', AS_OF), { asOf: AS_OF })
  assert.equal(a.findings.filter(f => f.kind === 'lost').reduce((s, f) => s + f.units, 0), 140)
  const fee = a.findings.find(f => f.kind === 'fee')!
  assert.equal(fee.sku, 'HL-BOARD-WAL')
  assert.equal(fee.confidence, 'high')
  assert.ok(a.findings.some(f => f.kind === 'fee-transit' && f.units === 43))
  assert.ok(a.findings.some(f => f.kind === 'inbound' && f.units === 12))
})

test('the supplements sample is mostly refunds that never came back', () => {
  const a = analyze(generate('peak', AS_OF), { asOf: AS_OF })
  const returns = a.findings.filter(f => f.kind === 'return' && f.deadline >= AS_OF)
  assert.ok(returns.length >= 20, `only ${returns.length}`)
  assert.ok(a.findings.some(f => f.kind === 'underpaid'))
  assert.ok((a.totals.byKind.return ?? 0) > (a.totals.byKind.lost ?? 0))
})

test('exported sample reports re-import to the same findings', () => {
  const src = generate('hearth', AS_OF)
  let back = emptyDataset()
  for (const kind of ['ledger', 'reimbursements', 'returns', 'fees', 'txns', 'inbound', 'costs'] as const) {
    const t = parseCsv(reportCsv(kind, src))
    const d = detect(t)
    assert.equal(d.kind, kind)
    const v = validate(kind, t, autoMap(kind, t.rows[d.header]), d.header)
    assert.equal(v.skipped, 0, `${kind}: ${v.issues[0]?.message}`)
    back = mergeData(back, v.data)
  }
  const a = analyze(src, { asOf: AS_OF }), b = analyze(back, { asOf: AS_OF })
  assert.equal(b.totals.open, a.totals.open)
  assert.deepEqual(b.findings.map(f => f.id).sort(), a.findings.map(f => f.id).sort())
})
