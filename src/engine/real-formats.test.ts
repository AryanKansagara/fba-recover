// Fixtures in ./fixtures follow the exact column layout of the Seller Central / SP-API downloads
// (header names and order, tab or comma delimiter, quoting, date formats, "--" placeholders, settlement summary row).
// The values are invented for one fictional SKU.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { autoMap, detect, mergeData, norm, parseCsv, validate, type Kind } from './parse.ts'
import { analyze } from './recon.ts'
import { emptyDataset, type Dataset } from './types.ts'

const load = (name: string) => {
  const t = parseCsv(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
  const { kind, header } = detect(t)
  assert.ok(kind, `${name} not detected`)
  return validate(kind, t, autoMap(kind, t.rows[header]), header)
}
const errors = (v: ReturnType<typeof load>) => v.issues.filter(i => i.level === 'error')

test('every real-layout export is detected as the right report and imports without errors', () => {
  const want: [string, Kind, number][] = [
    ['ledger-detail.csv', 'ledger', 9],
    ['reimbursements.txt', 'reimbursements', 3],
    ['returns.txt', 'returns', 1],
    ['settlement-v2.txt', 'txns', 3],
    ['date-range.csv', 'txns', 3],
  ]
  for (const [file, kind, count] of want) {
    const v = load(file)
    assert.equal(v.kind, kind, file)
    assert.equal(v.count, count, file)
    assert.deepEqual(errors(v), [], file)
  }
})

test('ledger: MM/DD/YYYY dates, quoted titles with commas and the extra reconciliation columns', () => {
  const v = load('ledger-detail.csv')
  const adj = v.data.ledger!.find(r => r.reason === 'M')!
  assert.deepEqual([adj.date, adj.qty, adj.ref, adj.fc], ['2026-09-14', -3, '9876543210', 'PHX7'])
  assert.equal(adj.title, 'Bamboo Cutting Board Set, 3 Pieces with Juice Groove')
  assert.deepEqual(v.range, ['2026-09-02', '2026-10-01'])
})

test('settlement V2: the summary row is a warning, not a skipped error, and tax rows do not count as fees', () => {
  const v = load('settlement-v2.txt')
  assert.equal(v.skipped, 0)
  assert.match(v.issues[0].message, /summary row/)
  const o = v.data.txns!.find(t => t.type === 'Order')!
  assert.deepEqual([o.qty, o.principal, o.fbaFee, o.otherFee], [1, 34.99, 7.89, 5.25])
  const fee = v.data.txns!.find(t => t.type === 'other-transaction')!
  assert.deepEqual([fee.otherFee, fee.shipmentId, fee.description], [14.4, 'FBA18Z4KQW2P', 'FBA Inbound Placement Service Fee'])
})

test('date range report: seven-line preamble, "Mon D, YYYY h:mm:ss AM TZ" dates and quoted thousands', () => {
  const t = parseCsv(readFileSync(new URL('./fixtures/date-range.csv', import.meta.url), 'utf8'))
  assert.deepEqual(detect(t), { kind: 'txns', header: 7 })
  const v = load('date-range.csv')
  const [order, refund] = v.data.txns!
  assert.deepEqual([order.date, order.principal, order.fbaFee], ['2026-09-05', 34.99, 7.89])
  assert.deepEqual([refund.type, refund.principal, refund.date], ['Refund', -34.99, '2026-09-08'])
})

test('fee preview: "--" placeholders in optional columns are blanks, unmeasured rows are reported', () => {
  const v = load('fee-preview.txt')
  assert.equal(v.count, 1)
  const f = v.data.fees![0]
  assert.deepEqual([f.price, f.longest, f.weightLb, f.expectedFee], [34.99, 17.8, 4.35, 7.89])
  assert.deepEqual(v.issues.map(i => [i.line, i.level]), [[3, 'error']])
})

test('fee preview in millimetres and kilograms (EU marketplaces) converts to inches and pounds', () => {
  const t = parseCsv('sku\tlongest-side\tmedian-side\tshortest-side\tunit-of-dimension\titem-package-weight\tunit-of-weight\tproduct-size-weight-band\n'
    + 'S1\t254\t127\t25.4\tMM\t1\tKG\tStandard Parcel\n')
  const f = validate('fees', t, autoMap('fees', t.rows[0])).data.fees![0]
  assert.deepEqual([f.longest, f.median, f.shortest, f.tier], [10, 5, 1, 'Standard Parcel'])
  assert.equal(Math.round(f.weightLb * 100) / 100, 2.2)
})

test('camelCase headers from SP-API and connector exports map like the Seller Central ones', () => {
  assert.equal(norm('EventType'), 'event_type')
  assert.equal(norm('ReferenceID'), 'reference_id')
  assert.equal(norm('FulfillmentNetworkSKU'), 'fulfillment_network_sku')
  assert.equal(norm('FNSKU'), 'fnsku')
  const led = parseCsv('Date\tFNSKU\tASIN\tMSKU\tTitle\tEventType\tReferenceID\tQuantity\tFulfillmentCenter\tDisposition\tReason\n11/21/2026\tX1\tB1\tS1\tT\tAdjustments\t42\t-1\tPHX7\tSELLABLE\tM\n')
  assert.equal(detect(led).kind, 'ledger')
  assert.equal(validate('ledger', led, autoMap('ledger', led.rows[0])).count, 1)
  const inb = parseCsv('ShipmentId,SellerSKU,FulfillmentNetworkSKU,QuantityShipped,QuantityReceived,QuantityInCase\nFBA1,S1,X1,24,22,12\n')
  assert.equal(detect(inb).kind, 'inbound')
  const m = autoMap('inbound', inb.rows[0])
  assert.deepEqual([m.shipmentId, m.sku, m.fnsku, m.shipped, m.received], [0, 1, 2, 3, 4])
})

test('end to end: found units and a Lost_Warehouse payment net off; Damaged_Inbound and CustomerReturn do not cover warehouse damage', () => {
  let ds: Dataset = emptyDataset()
  for (const f of ['ledger-detail.csv', 'reimbursements.txt', 'returns.txt', 'date-range.csv', 'fee-preview.txt']) ds = mergeData(ds, load(f).data)
  const a = analyze(ds, { asOf: '2026-10-15' })
  const lost = a.findings.find(f => f.kind === 'lost')!
  const dmg = a.findings.find(f => f.kind === 'damaged')!
  // 3 misplaced - 1 found - 1 reimbursed = 1; valued at the average sale price
  assert.deepEqual([lost.units, lost.amount, lost.deadline], [1, 34.99, '2026-11-13'])
  assert.deepEqual([dmg.units, dmg.refs], [2, ['9876543212']])
  // The refunded order was reimbursed with a unit of inventory, so no return claim
  assert.equal(a.findings.some(f => f.kind === 'return'), false)
  // Charged 7.89 is under the table's 7.92 for a 4.35 lb large standard item: no fee claim
  assert.equal(a.findings.some(f => f.kind === 'fee'), false)
})
