// Two synthetic sellers. Every number is generated; none of it is real seller data.
import { fulfilmentFee, round2, type Dims } from './fees.ts'
import { addDays } from './recon.ts'
import { emptyDataset, type Dataset, type LedgerRow, type Txn } from './types.ts'

export interface SampleDef { id: string; name: string; blurb: string }
export const SAMPLES: SampleDef[] = [
  { id: 'hearth', name: 'Hearth & Loom (home goods)', blurb: '140 lost units never reimbursed, one cutting board re-measured into a bigger size tier, a short inbound shipment and placement fees on 43 units still in transit.' },
  { id: 'peak', name: 'Peak Botanics (supplements)', blurb: 'Dozens of refunds where the bottle never came back, one reimbursement paid at half of cost, and a few warehouse losses.' },
]

interface SkuDef { sku: string; fnsku: string; asin: string; title: string; price: number; cost: number; dims: Dims; perDay: number; returnRate: number; wrongDims?: Dims; remeasureDaysAgo?: number }

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const HEARTH: SkuDef[] = [
  { sku: 'HL-THROW-OAT', fnsku: 'X002HL0001', asin: 'B0HLTHRW01', title: 'Waffle-knit throw blanket, oat', price: 48, cost: 14.5, dims: { longest: 14, median: 11, shortest: 5, weightLb: 2.3 }, perDay: 6, returnRate: 0.05 },
  { sku: 'HL-MUG-SET4', fnsku: 'X002HL0002', asin: 'B0HLMUGS02', title: 'Stoneware mug set of 4', price: 39, cost: 11.2, dims: { longest: 13, median: 9, shortest: 6, weightLb: 4.1 }, perDay: 4, returnRate: 0.04 },
  { sku: 'HL-NAPKIN-6', fnsku: 'X002HL0003', asin: 'B0HLNAPK03', title: 'Linen napkins, set of 6', price: 26, cost: 6.8, dims: { longest: 10, median: 8, shortest: 0.6, weightLb: 0.55 }, perDay: 5, returnRate: 0.03 },
  { sku: 'HL-CANDLE-FIG', fnsku: 'X002HL0004', asin: 'B0HLCNDL04', title: 'Soy candle, fig and cedar', price: 22, cost: 5.1, dims: { longest: 5, median: 4, shortest: 4, weightLb: 1.1 }, perDay: 7, returnRate: 0.02 },
  { sku: 'HL-BOARD-WAL', fnsku: 'X002HL0005', asin: 'B0HLBORD05', title: 'Walnut cutting board, slim', price: 34, cost: 9.4, dims: { longest: 14.8, median: 10.9, shortest: 0.7, weightLb: 0.94 }, perDay: 5, returnRate: 0.02, wrongDims: { longest: 15.2, median: 11.1, shortest: 1.3, weightLb: 1.08 }, remeasureDaysAgo: 75 },
  { sku: 'HL-BASKET-L', fnsku: 'X002HL0006', asin: 'B0HLBSKT06', title: 'Seagrass storage basket, large', price: 44, cost: 12.9, dims: { longest: 17, median: 13, shortest: 7.5, weightLb: 2.9 }, perDay: 3, returnRate: 0.04 },
]

const PEAK: SkuDef[] = [
  { sku: 'PB-MAG-GLY-120', fnsku: 'X003PB0001', asin: 'B0PBMAGG01', title: 'Magnesium glycinate, 120 capsules', price: 24, cost: 5.2, dims: { longest: 4.6, median: 2.4, shortest: 2.4, weightLb: 0.42 }, perDay: 14, returnRate: 0.06 },
  { sku: 'PB-ASHW-60', fnsku: 'X003PB0002', asin: 'B0PBASHW02', title: 'Ashwagandha KSM-66, 60 capsules', price: 19, cost: 3.9, dims: { longest: 4.2, median: 2.2, shortest: 2.2, weightLb: 0.33 }, perDay: 11, returnRate: 0.07 },
  { sku: 'PB-D3K2-90', fnsku: 'X003PB0003', asin: 'B0PBD3K203', title: 'Vitamin D3 + K2, 90 softgels', price: 17, cost: 3.1, dims: { longest: 3.9, median: 2.1, shortest: 2.1, weightLb: 0.28 }, perDay: 9, returnRate: 0.05 },
  { sku: 'PB-COLL-POW', fnsku: 'X003PB0004', asin: 'B0PBCOLL04', title: 'Collagen peptides powder, 16 oz', price: 32, cost: 8.6, dims: { longest: 7.2, median: 4.8, shortest: 4.8, weightLb: 1.35 }, perDay: 7, returnRate: 0.08 },
  { sku: 'PB-ELEC-30', fnsku: 'X003PB0005', asin: 'B0PBELEC05', title: 'Electrolyte drink mix, 30 sticks', price: 28, cost: 6.4, dims: { longest: 6.5, median: 4.2, shortest: 3.1, weightLb: 0.9 }, perDay: 8, returnRate: 0.05 },
]

/**
 * Builds a dataset whose dates end at `asOf`, so deadlines are live. Deterministic for a given (id, asOf).
 * Hearth & Loom: exactly 140 lost units remain unreimbursed after found adjustments and reimbursements.
 */
export function generate(id: string, asOf: string): Dataset {
  const ds = emptyDataset()
  const r = rng(id === 'hearth' ? 7 : 11)
  const skus = id === 'hearth' ? HEARTH : PEAK
  const DAYS = 180
  const start = addDays(asOf, -DAYS)
  let line = { ledger: 2, txns: 2, reimb: 2, returns: 2, inbound: 2 }
  let orderSeq = 0
  const orderId = () => { orderSeq++; const n = (1000000 + orderSeq * 7919 + (id === 'hearth' ? 0 : 500000)) % 10000000; return `11${id === 'hearth' ? 2 : 4}-${String(3000000 + orderSeq * 31).slice(0, 7)}-${String(n).padStart(7, '0')}` }
  const L = (row: Omit<LedgerRow, 'line'>) => { ds.ledger.push({ ...row, line: line.ledger++ }) }
  const T = (t: Omit<Txn, 'line'>) => { ds.txns.push({ ...t, line: line.txns++ }) }

  for (const s of skus) {
    ds.costs.push({ sku: s.sku, cost: s.cost, ...s.dims, line: ds.costs.length + 2 })
    const amazonNow = s.wrongDims ?? s.dims
    ds.fees.push({ sku: s.sku, fnsku: s.fnsku, asin: s.asin, title: s.title, price: s.price, ...amazonNow, tier: undefined, expectedFee: fulfilmentFee(amazonNow, s.price, asOf).fee, line: ds.fees.length + 2 })
  }

  // Inbound shipments: one per SKU every 45 days, received over a few days.
  let shipSeq = 0
  for (const s of skus) {
    for (let d = 0; d < DAYS; d += 45) {
      const ship = `FBA19${id === 'hearth' ? 'HL' : 'PB'}${String(++shipSeq).padStart(4, '0')}`
      const shipped = Math.round(s.perDay * 50 / 10) * 10
      const date = addDays(start, d - 8)
      ds.inbound.push({ shipmentId: ship, sku: s.sku, fnsku: s.fnsku, shipped, received: shipped, date: addDays(date, 6), status: 'Closed', line: line.inbound++ })
      L({ date: addDays(date, 6), fnsku: s.fnsku, msku: s.sku, asin: s.asin, title: s.title, event: 'Receipts', ref: ship, qty: shipped, fc: 'PHX7', disposition: 'SELLABLE' })
    }
  }

  // Daily sales, refunds and returns
  for (let d = 0; d < DAYS - 1; d++) {
    const date = addDays(start, d)
    for (const s of skus) {
      const n = Math.max(0, Math.round(s.perDay * (0.6 + r() * 0.8)))
      if (!n) continue
      let shippedToday = 0
      for (let k = 0; k < n; k++) {
        const oid = orderId()
        const qty = r() < 0.9 ? 1 : 2
        shippedToday += qty
        const dims = s.wrongDims && date >= addDays(asOf, -(s.remeasureDaysAgo ?? 0)) ? s.wrongDims : s.dims
        const fee = fulfilmentFee(dims, s.price, date).fee
        T({ date, type: 'Order', orderId: oid, sku: s.sku, qty, principal: round2(s.price * qty), fbaFee: round2(fee * qty), otherFee: 0 })
        if (r() < s.returnRate) {
          const rd = addDays(date, 4 + Math.floor(r() * 20))
          if (rd >= asOf) continue
          T({ date: rd, type: 'Refund', orderId: oid, sku: s.sku, qty, principal: -round2(s.price * qty), fbaFee: 0, otherFee: 0 })
          const back = addDays(rd, 3 + Math.floor(r() * 12))
          if (back < asOf) {
            ds.returns.push({ date: back, orderId: oid, sku: s.sku, fnsku: s.fnsku, qty, disposition: r() < 0.8 ? 'SELLABLE' : 'CUSTOMER_DAMAGED', reason: 'NOT_AS_DESCRIBED', status: 'Unit returned to inventory', line: line.returns++ })
            L({ date: back, fnsku: s.fnsku, msku: s.sku, asin: s.asin, title: s.title, event: 'CustomerReturns', ref: oid, qty, fc: 'PHX7', disposition: 'SELLABLE' })
          }
        }
      }
      L({ date, fnsku: s.fnsku, msku: s.sku, asin: s.asin, title: s.title, event: 'Shipments', ref: '', qty: -shippedToday, fc: 'PHX7', disposition: 'SELLABLE' })
    }
  }

  // Warehouse losses. [sku index, days ago, units, kind, outcome]
  type Loss = [number, number, number, 'M' | '6' | 'E', 'open' | 'found' | 'paid']
  const losses: Loss[] = id === 'hearth' ? [
    [0, 12, 9, 'M', 'open'], [0, 31, 14, 'M', 'open'], [0, 88, 6, 'M', 'open'], [0, 120, 8, 'M', 'paid'],
    [1, 8, 11, 'M', 'open'], [1, 44, 7, 'M', 'open'], [1, 52, 5, '6', 'open'], [1, 95, 6, 'M', 'found'],
    [2, 19, 16, 'M', 'open'], [2, 57, 12, 'M', 'open'], [2, 70, 10, 'M', 'paid'],
    [3, 5, 18, 'M', 'open'], [3, 27, 13, 'M', 'open'], [3, 66, 9, 'M', 'open'], [3, 100, 12, 'M', 'found'],
    [4, 23, 8, 'M', 'open'], [4, 40, 4, 'E', 'open'],
    [5, 15, 10, 'M', 'open'], [5, 49, 7, 'M', 'open'], [5, 140, 7, 'M', 'paid'],
  ] : [
    [0, 21, 6, 'M', 'open'], [1, 35, 4, 'M', 'paid'], [3, 18, 5, '6', 'open'], [4, 64, 3, 'M', 'open'], [2, 90, 8, 'M', 'found'],
  ]
  for (const [i, ago, units, code, outcome] of losses) {
    const s = skus[i], date = addDays(asOf, -ago)
    const ref = String(9100000000 + Math.floor(r() * 899999999))
    L({ date, fnsku: s.fnsku, msku: s.sku, asin: s.asin, title: s.title, event: 'Adjustments', ref, qty: -units, fc: 'PHX7', disposition: 'SELLABLE', reason: code })
    if (outcome === 'found') L({ date: addDays(date, 9), fnsku: s.fnsku, msku: s.sku, asin: s.asin, title: s.title, event: 'Adjustments', ref: String(Number(ref) + 1), qty: units, fc: 'PHX7', disposition: 'SELLABLE', reason: 'F' })
    if (outcome === 'paid') {
      const per = round2(s.cost * (id === 'peak' ? 0.5 : 1))
      ds.reimbursements.push({ date: addDays(date, 14), id: String(5800000000 + ds.reimbursements.length * 137), reason: code === 'M' ? 'Lost_Warehouse' : 'Damaged_Warehouse', sku: s.sku, fnsku: s.fnsku, amountPerUnit: per, amountTotal: round2(per * units), qtyCash: units, qtyInventory: 0, line: line.reimb++ })
    }
  }

  if (id === 'hearth') {
    // A shipment closed 40 days ago, 12 units short; and a recent one with placement fees on 43 units still in transit.
    const short = ds.inbound.find(x => x.sku === 'HL-MUG-SET4' && x.date <= addDays(asOf, -35) && x.date >= addDays(asOf, -80))!
    short.received -= 12
    const rec = ds.ledger.find(l => l.event === 'Receipts' && l.ref === short.shipmentId)!
    rec.qty -= 12
    const ship = 'FBA19HLT043'
    const shipDate = addDays(asOf, -6)
    ds.inbound.push({ shipmentId: ship, sku: 'HL-THROW-OAT', fnsku: 'X002HL0001', shipped: 120, received: 77, date: addDays(asOf, -3), status: 'Receiving', line: line.inbound++ })
    L({ date: addDays(asOf, -3), fnsku: 'X002HL0001', msku: 'HL-THROW-OAT', asin: 'B0HLTHRW01', title: HEARTH[0].title, event: 'Receipts', ref: ship, qty: 77, fc: 'PHX7', disposition: 'SELLABLE' })
    T({ date: shipDate, type: 'ServiceFee', orderId: '', sku: '', qty: 0, principal: 0, fbaFee: 0, otherFee: round2(120 * 0.68), description: 'FBA Inbound Placement Service Fee', shipmentId: ship })
  } else {
    // Refunds whose bottles never came back: some reimbursed by Amazon already, most not.
    const skuW = [0, 0, 1, 1, 3, 3, 4, 2, 0, 3]
    for (let k = 0; k < 34; k++) {
      const s = skus[skuW[k % skuW.length]]
      const ago = 20 + Math.floor(r() * 130)
      const date = addDays(asOf, -ago)
      const oid = orderId()
      const qty = k % 9 === 0 ? 2 : 1
      T({ date: addDays(date, -6), type: 'Order', orderId: oid, sku: s.sku, qty, principal: round2(s.price * qty), fbaFee: round2(fulfilmentFee(s.dims, s.price, date).fee * qty), otherFee: 0 })
      T({ date, type: 'Refund', orderId: oid, sku: s.sku, qty, principal: -round2(s.price * qty), fbaFee: 0, otherFee: 0 })
      if (k % 7 === 3) ds.reimbursements.push({ date: addDays(date, 50), id: String(5900000000 + k * 41), orderId: oid, reason: 'CustomerReturn', sku: s.sku, fnsku: s.fnsku, amountPerUnit: s.price, amountTotal: round2(s.price * qty), qtyCash: qty, qtyInventory: 0, line: line.reimb++ })
    }
  }
  ds.txns.sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)
  ds.ledger.sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)
  // Renumber lines in file order so case text points at the right rows of the downloaded CSVs.
  ds.txns.forEach((t, i) => { t.line = i + 2 })
  ds.ledger.forEach((t, i) => { t.line = i + 2 })
  return ds
}
