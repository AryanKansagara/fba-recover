// The reconciliation engine: ledger -> unresolved lost/damaged units -> reimbursement matching -> findings with $ and deadlines.
import { fulfilmentFee, inPeak, round2, sizeTier, TIER_LABEL, US_2026, type Dims, type FeeTable } from './fees.ts'
import { DEFAULT_POLICY, type Dataset, type Finding, type FindingKind, type LedgerRow, type Policy, type Reimbursement } from './types.ts'

// ---------- Dates ----------

export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5)
export const today = () => new Date().toISOString().slice(0, 10)

// ---------- Reason codes ----------

/** Inventory Ledger adjustment reason codes (Seller Central "Adjustment reason codes" help page). */
export const REASONS: Record<string, { label: string; group: 'lost' | 'found' | 'damaged' | 'other' }> = {
  M: { label: 'Inventory misplaced', group: 'lost' },
  '5': { label: 'Unrecoverable inventory', group: 'lost' },
  F: { label: 'Inventory found', group: 'found' },
  '6': { label: 'Damaged at Amazon fulfilment centre', group: 'damaged' },
  '7': { label: 'Damaged in inbound transit (Amazon carrier)', group: 'damaged' },
  E: { label: 'Sellable item damaged at Amazon', group: 'damaged' },
  Q: { label: 'Damaged, miscellaneous (Amazon)', group: 'damaged' },
  H: { label: 'Damaged by customer', group: 'other' },
  U: { label: 'Damaged, merchant responsibility', group: 'other' },
  K: { label: 'Damaged, item defective', group: 'other' },
  D: { label: 'Destroyed / disposed', group: 'other' },
  O: { label: 'Inventory correction', group: 'other' },
  N: { label: 'Transferred ownership', group: 'other' },
  P: { label: 'Unsellable, redistributed', group: 'other' },
}

export function reasonGroup(r?: string): 'lost' | 'found' | 'damaged' | 'other' {
  if (!r) return 'other'
  const code = r.trim().toUpperCase()
  if (REASONS[code]) return REASONS[code].group
  const s = r.toLowerCase()
  if (/found/.test(s)) return 'found'
  if (/misplac|lost|unrecoverable/.test(s)) return 'lost'
  if (/damag/.test(s) && !/customer|merchant|defect|carrier.*seller/.test(s)) return 'damaged'
  return 'other'
}

const isWarehouseReimb = (r: Reimbursement) => /warehouse|lost_?outbound|damaged/i.test(r.reason) && !/inbound|return|reversal/i.test(r.reason)
const isInboundReimb = (r: Reimbursement) => /inbound/i.test(r.reason)
const isReversal = (r: Reimbursement) => /reversal/i.test(r.reason)
const reimbUnits = (r: Reimbursement) => Math.abs(r.qtyCash) + Math.abs(r.qtyInventory)

// ---------- Catalog and unit values ----------

export interface Catalog { sku(fnsku: string): string; fnsku(sku: string): string; title(key: string): string }

export function catalog(ds: Dataset): Catalog {
  const s2f = new Map<string, string>(), f2s = new Map<string, string>(), titles = new Map<string, string>()
  const link = (sku?: string, fnsku?: string, title?: string) => {
    if (sku && fnsku) { if (!s2f.has(sku)) s2f.set(sku, fnsku); if (!f2s.has(fnsku)) f2s.set(fnsku, sku) }
    if (title) { if (sku && !titles.has(sku)) titles.set(sku, title); if (fnsku && !titles.has(fnsku)) titles.set(fnsku, title) }
  }
  for (const r of ds.fees) link(r.sku, r.fnsku, r.title)
  for (const r of ds.ledger) link(r.msku, r.fnsku, r.title)
  for (const r of ds.inbound) link(r.sku, r.fnsku)
  for (const r of ds.reimbursements) link(r.sku, r.fnsku)
  for (const r of ds.returns) link(r.sku, r.fnsku)
  return {
    sku: f => f2s.get(f) ?? f,
    fnsku: s => s2f.get(s) ?? s,
    title: k => titles.get(k) ?? titles.get(f2s.get(k) ?? '') ?? titles.get(s2f.get(k) ?? '') ?? '',
  }
}

export interface UnitValue { value: number; basis: string; cost: boolean }

/** COGS when the seller provided it (Amazon now reimburses most warehouse losses at cost), else the average sale price. */
export function unitValues(ds: Dataset): (sku: string) => UnitValue {
  const cost = new Map(ds.costs.map(c => [c.sku, c.cost]))
  const sales = new Map<string, { amt: number; qty: number }>()
  for (const t of ds.txns) {
    if (!/order/i.test(t.type) || t.principal <= 0 || t.qty <= 0) continue
    const s = sales.get(t.sku) ?? { amt: 0, qty: 0 }
    s.amt += t.principal; s.qty += t.qty
    sales.set(t.sku, s)
  }
  const price = new Map(ds.fees.filter(f => f.price > 0).map(f => [f.sku, f.price]))
  return sku => {
    const c = cost.get(sku)
    if (c) return { value: c, basis: 'unit cost (COGS)', cost: true }
    const s = sales.get(sku)
    if (s?.qty) return { value: round2(s.amt / s.qty), basis: 'average sale price', cost: false }
    const p = price.get(sku)
    if (p) return { value: p, basis: 'listed price', cost: false }
    return { value: 0, basis: 'no price or cost on file', cost: false }
  }
}

// ---------- Ledger reconciliation ----------

export interface LossEvent { date: string; fnsku: string; units: number; remaining: number; kind: 'lost' | 'damaged'; ref: string; reason: string; fc?: string; line: number; reimbursedBy: string[] }

export interface SkuFlow {
  fnsku: string
  sku: string
  title: string
  received: number
  sold: number
  returned: number
  lost: number
  found: number
  damaged: number
  reimbursedUnits: number
  unreimbursed: number
  /** Unreimbursed units whose window has already closed */
  expiredUnits: number
  unitValue: number
}

/**
 * Per FNSKU: lost and damaged adjustments, offset by found adjustments (oldest loss first), then matched to warehouse
 * reimbursements by date proximity. Whatever is left is an unreimbursed loss event.
 */
export function reconcileLedger(ds: Dataset, policy: Policy = DEFAULT_POLICY): { events: LossEvent[]; flows: Map<string, Omit<SkuFlow, 'sku' | 'title' | 'unitValue' | 'expiredUnits'>> } {
  const byF = new Map<string, LedgerRow[]>()
  for (const r of ds.ledger) { const l = byF.get(r.fnsku) ?? []; l.push(r); byF.set(r.fnsku, l) }
  const reimbByF = new Map<string, Reimbursement[]>()
  for (const r of ds.reimbursements) if (isWarehouseReimb(r) || isReversal(r)) { const l = reimbByF.get(r.fnsku) ?? []; l.push(r); reimbByF.set(r.fnsku, l) }

  const events: LossEvent[] = []
  const flows = new Map<string, Omit<SkuFlow, 'sku' | 'title' | 'unitValue' | 'expiredUnits'>>()
  for (const fnsku of new Set([...byF.keys(), ...reimbByF.keys()])) {
    const rows = (byF.get(fnsku) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)
    const flow = { fnsku, received: 0, sold: 0, returned: 0, lost: 0, found: 0, damaged: 0, reimbursedUnits: 0, unreimbursed: 0 }
    const evs: LossEvent[] = []
    const founds: { date: string; units: number }[] = []
    for (const r of rows) {
      if (r.event === 'Receipts') flow.received += Math.max(0, r.qty)
      else if (r.event === 'Shipments') flow.sold += Math.max(0, -r.qty)
      else if (r.event === 'CustomerReturns') flow.returned += Math.max(0, r.qty)
      else if (r.event === 'Adjustments') {
        const g = reasonGroup(r.reason)
        if ((g === 'lost' || g === 'damaged') && r.qty < 0) {
          const units = -r.qty
          g === 'lost' ? flow.lost += units : flow.damaged += units
          evs.push({ date: r.date, fnsku, units, remaining: units, kind: g, ref: r.ref, reason: r.reason ?? '', fc: r.fc, line: r.line, reimbursedBy: [] })
        } else if (g === 'found' && r.qty > 0) { flow.found += r.qty; founds.push({ date: r.date, units: r.qty }) }
      }
    }
    // Found units cancel the oldest open losses dated on or before (or shortly after) the find.
    for (const f of founds) {
      let left = f.units
      for (const e of evs) {
        if (!left) break
        if (e.kind !== 'lost' || !e.remaining || e.date > addDays(f.date, policy.matchDays)) continue
        const take = Math.min(left, e.remaining)
        e.remaining -= take; left -= take
      }
    }
    // Reversals claw back the most recent reimbursements first.
    const reimbs = (reimbByF.get(fnsku) ?? []).filter(r => !isReversal(r)).sort((a, b) => a.date.localeCompare(b.date)).map(r => ({ r, units: reimbUnits(r) }))
    let reversed = (reimbByF.get(fnsku) ?? []).filter(isReversal).reduce((s, r) => s + reimbUnits(r), 0)
    for (let i = reimbs.length - 1; i >= 0 && reversed > 0; i--) { const t = Math.min(reversed, reimbs[i].units); reimbs[i].units -= t; reversed -= t }
    for (const { r, units } of reimbs) {
      let left = units
      flow.reimbursedUnits += units
      const want: 'lost' | 'damaged' | null = /damag/i.test(r.reason) ? 'damaged' : /lost|misplac/i.test(r.reason) ? 'lost' : null
      // Closest open event first, same kind preferred, inside the match window; then anything still open.
      const near = (e: LossEvent) => Math.abs(daysBetween(e.date, r.date))
      const pass = (strict: boolean) => evs
        .filter(e => e.remaining > 0 && (!strict || ((!want || e.kind === want) && near(e) <= policy.matchDays && e.date <= addDays(r.date, 3))))
        .sort((a, b) => near(a) - near(b))
      for (const strict of [true, false]) {
        for (const e of pass(strict)) {
          if (!left) break
          const take = Math.min(left, e.remaining)
          e.remaining -= take; left -= take
          e.reimbursedBy.push(r.id)
        }
      }
    }
    flow.unreimbursed = evs.reduce((s, e) => s + e.remaining, 0)
    events.push(...evs)
    flows.set(fnsku, flow)
  }
  return { events, flows }
}

// ---------- Analysis ----------

export interface Analysis {
  asOf: string
  findings: Finding[]
  flows: SkuFlow[]
  /** Inbound shipments still being received (no claim yet) */
  inTransit: { shipmentId: string; units: number; date: string }[]
  totals: { open: number; upcoming: number; missed: number; count: number; byKind: Partial<Record<FindingKind, number>>; nextDeadline: string | null }
  notes: string[]
}

export const findingState = (f: Finding, asOf: string): 'open' | 'upcoming' | 'expired' => f.deadline < asOf ? 'expired' : f.opens > asOf ? 'upcoming' : 'open'

export function analyze(ds: Dataset, opts: { policy?: Policy; table?: FeeTable; asOf?: string } = {}): Analysis {
  const policy = { ...DEFAULT_POLICY, ...opts.policy }
  const table = opts.table ?? US_2026
  const asOf = opts.asOf ?? today()
  const cat = catalog(ds)
  const val = unitValues(ds)
  const findings: Finding[] = []
  const notes: string[] = []
  const costOf = new Map(ds.costs.map(c => [c.sku, c]))

  // 1. Lost and damaged in the warehouse
  const { events, flows } = reconcileLedger(ds, policy)
  for (const e of events) {
    if (!e.remaining) continue
    const sku = cat.sku(e.fnsku), v = val(sku)
    const reasonLabel = REASONS[e.reason.toUpperCase()]?.label ?? e.reason
    findings.push({
      id: `${e.kind}:${e.fnsku}:${e.date}:${e.ref || e.line}`,
      kind: e.kind, fnsku: e.fnsku, sku, title: cat.title(e.fnsku),
      units: e.remaining, unitValue: v.value, amount: round2(e.remaining * v.value), basis: v.basis,
      eventDate: e.date, opens: e.date, deadline: addDays(e.date, policy.warehouseDays),
      refs: e.ref ? [e.ref] : [], lines: [e.line],
      detail: `${e.units} unit${e.units > 1 ? 's' : ''} adjusted out on ${e.date} (reason ${e.reason}: ${reasonLabel}${e.fc ? `, ${e.fc}` : ''}). ${e.units - e.remaining ? `${e.units - e.remaining} since found or reimbursed; ` : ''}${e.remaining} not found and not reimbursed.`,
      policy: `FBA inventory reimbursement policy: units ${e.kind === 'lost' ? 'lost' : 'damaged'} in an Amazon fulfilment centre are eligible when not found or reimbursed. File within ${policy.warehouseDays} days of the adjustment.`,
      confidence: e.remaining === e.units ? 'high' : 'medium',
    })
  }

  // 2. Reimbursements paid below value (needs COGS: Amazon pays at cost, so sale price is the wrong yardstick)
  if (!ds.costs.length && ds.reimbursements.length) notes.push('Import a product cost (COGS) file to check whether reimbursements were paid at full value.')
  for (const r of ds.reimbursements) {
    if (isReversal(r) || r.qtyCash <= 0 || r.amountPerUnit <= 0) continue
    const sku = r.sku || cat.sku(r.fnsku)
    const c = costOf.get(sku)
    if (!c || r.amountPerUnit >= c.cost * policy.underpaidRatio) continue
    const gap = round2((c.cost - r.amountPerUnit) * r.qtyCash)
    findings.push({
      id: `underpaid:${r.id}`, kind: 'underpaid', fnsku: r.fnsku, sku, title: cat.title(sku),
      units: r.qtyCash, unitValue: round2(c.cost - r.amountPerUnit), amount: gap, basis: 'unit cost (COGS) minus amount paid',
      eventDate: r.date, opens: r.date, deadline: addDays(r.date, policy.underpaidDays),
      refs: [r.id, ...(r.caseId ? [`case ${r.caseId}`] : [])], lines: [r.line, c.line],
      detail: `Reimbursement ${r.id} (${r.reason}) paid $${r.amountPerUnit.toFixed(2)} per unit for ${r.qtyCash} unit${r.qtyCash > 1 ? 's' : ''}; documented unit cost is $${c.cost.toFixed(2)} (${Math.round((r.amountPerUnit / c.cost) * 100)}% paid).`,
      policy: 'Reimbursements for lost or damaged inventory are based on the replacement cost of the item. Sellers can request a review with proof of cost (invoice) when the amount paid is below it.',
      confidence: 'medium',
    })
  }

  // 3. Refunded but not returned
  const returnedBy = new Map<string, number>()
  for (const r of ds.returns) { const k = r.orderId; returnedBy.set(k, (returnedBy.get(k) ?? 0) + r.qty) }
  const reimbByOrder = new Map<string, number>()
  for (const r of ds.reimbursements) if (r.orderId && !isReversal(r)) reimbByOrder.set(r.orderId, (reimbByOrder.get(r.orderId) ?? 0) + Math.max(1, reimbUnits(r)))
  const refunds = new Map<string, { date: string; sku: string; orderId: string; units: number; amount: number; lines: number[] }>()
  for (const t of ds.txns) {
    if (!/refund/i.test(t.type) || !t.orderId) continue
    const k = `${t.orderId}|${t.sku}`
    const x = refunds.get(k) ?? { date: t.date, sku: t.sku, orderId: t.orderId, units: 0, amount: 0, lines: [] }
    x.units += Math.max(1, t.qty); x.amount += Math.abs(t.principal); x.lines.push(t.line)
    if (t.date < x.date) x.date = t.date
    refunds.set(k, x)
  }
  for (const x of refunds.values()) {
    const back = Math.min(x.units, (returnedBy.get(x.orderId) ?? 0) + (reimbByOrder.get(x.orderId) ?? 0))
    returnedBy.set(x.orderId, Math.max(0, (returnedBy.get(x.orderId) ?? 0) - x.units))
    const missing = x.units - back
    if (missing <= 0) continue
    const per = x.amount && x.units ? round2(x.amount / x.units) : val(x.sku).value
    findings.push({
      id: `return:${x.orderId}:${x.sku}`, kind: 'return', fnsku: cat.fnsku(x.sku), sku: x.sku, title: cat.title(x.sku),
      units: missing, unitValue: per, amount: round2(per * missing), basis: x.amount ? 'refund amount' : val(x.sku).basis,
      eventDate: x.date, opens: addDays(x.date, policy.returnOpenDays), deadline: addDays(x.date, policy.returnCloseDays),
      refs: [x.orderId], lines: x.lines,
      detail: `Order ${x.orderId} was refunded on ${x.date} for ${x.units} unit${x.units > 1 ? 's' : ''}; ${missing === x.units ? (missing > 1 ? 'none of them' : 'it') : `${missing} of them`} never showed up in FBA customer returns and ${missing > 1 ? 'were' : 'was'} not reimbursed.`,
      policy: `Customer return reimbursement: when a customer is refunded and the item is not returned to a fulfilment centre, Amazon reimburses the seller. Claims open ${policy.returnOpenDays} days after the refund and close ${policy.returnCloseDays} days after it.`,
      confidence: 'high',
    })
  }

  // 4. Inbound shortfalls
  const inTransit: Analysis['inTransit'] = []
  const inboundReimb = new Map<string, { date: string; units: number }[]>()
  for (const r of ds.reimbursements) if (isInboundReimb(r)) { const l = inboundReimb.get(r.fnsku) ?? []; l.push({ date: r.date, units: reimbUnits(r) }); inboundReimb.set(r.fnsku, l) }
  for (const s of [...ds.inbound].sort((a, b) => a.date.localeCompare(b.date))) {
    const short = s.shipped - s.received
    if (short <= 0) continue
    const closed = /closed|complete/i.test(s.status ?? '')
    if (!closed && daysBetween(s.date, asOf) < policy.inboundSettleDays) { inTransit.push({ shipmentId: s.shipmentId, units: short, date: s.date }); continue }
    let left = short
    for (const r of inboundReimb.get(s.fnsku) ?? []) {
      if (r.date < addDays(s.date, -7) || !r.units) continue
      const t = Math.min(r.units, left); r.units -= t; left -= t
    }
    if (!left) continue
    const sku = s.sku || cat.sku(s.fnsku), v = val(sku)
    findings.push({
      id: `inbound:${s.shipmentId}:${s.fnsku}`, kind: 'inbound', fnsku: s.fnsku, sku, title: cat.title(s.fnsku),
      units: left, unitValue: v.value, amount: round2(left * v.value), basis: v.basis,
      eventDate: s.date, opens: s.date, deadline: addDays(s.date, policy.inboundDays),
      refs: [s.shipmentId], lines: [s.line],
      detail: `Shipment ${s.shipmentId}: ${s.shipped} shipped, ${s.received} received${closed ? ' (closed)' : ''}. ${left} unit${left > 1 ? 's' : ''} short and not reimbursed.`,
      policy: `Inbound shipment reimbursement: units shipped to Amazon but not received are eligible when the carrier proof of delivery covers them. File within ${policy.inboundDays} days of the shipment closing.`,
      confidence: closed ? 'high' : 'medium',
    })
  }

  // 5. Fulfilment fee audit
  const feeBySku = new Map(ds.fees.map(f => [f.sku, f]))
  const ordersBySku = new Map<string, typeof ds.txns>()
  for (const t of ds.txns) if (/order/i.test(t.type) && t.fbaFee > 0 && t.qty > 0) { const l = ordersBySku.get(t.sku) ?? []; l.push(t); ordersBySku.set(t.sku, l) }
  for (const [sku, lines] of ordersBySku) {
    const fp = feeBySku.get(sku), c = costOf.get(sku)
    const amazonDims: Dims | null = fp ? { longest: fp.longest, median: fp.median, shortest: fp.shortest, weightLb: fp.weightLb } : null
    const trueDims: Dims | null = c?.longest && c.weightLb ? { longest: c.longest, median: c.median ?? 0, shortest: c.shortest ?? 0, weightLb: c.weightLb } : null
    const dims = trueDims ?? amazonDims
    if (!dims) continue
    lines.sort((a, b) => a.date.localeCompare(b.date))
    let over = 0, overUnits = 0, missed = 0, first = '', peakUnits = 0
    const used: number[] = [], overCharged: number[] = []
    const charged = lines.map(t => round2(t.fbaFee / t.qty))
    for (const [i, t] of lines.entries()) {
      if (inPeak(t.date, table)) { peakUnits += t.qty; continue }
      const exp = fulfilmentFee(dims, t.principal > 0 ? t.principal / t.qty : fp?.price ?? 20, t.date, table).fee
      const d = charged[i] - exp
      if (d <= policy.feeTolerance) continue
      if (addDays(t.date, policy.feeDays) < asOf) { missed += d * t.qty; continue }
      over += d * t.qty; overUnits += t.qty; used.push(t.line); overCharged.push(charged[i])
      first ||= t.date
    }
    if (peakUnits) notes.push(`${sku}: ${peakUnits} unit${peakUnits > 1 ? 's' : ''} shipped in the holiday peak window were left out of the fee audit (peak rates are not in the fee table).`)
    if (over <= 0 && missed <= 0) continue
    // Where did the charged fee step up? The first line whose fee is above the SKU's earliest fee by more than the tolerance.
    const step = charged.findIndex(x => x - charged[0] > policy.feeTolerance)
    const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? 0 }
    const medOver = median(overCharged.length ? overCharged : charged)
    // Outliers are judged within each fee regime (before and after the step), not across it.
    const segs = step > 0 ? [charged.slice(0, step), charged.slice(step)] : [charged]
    const outliers = segs.reduce((n, seg) => { const m = median(seg); return n + seg.filter(x => Math.abs(x - m) > m * 0.25).length }, 0)
    const trueTier = sizeTier(dims), amzTier = amazonDims ? sizeTier(amazonDims) : null
    const mis = trueDims && amazonDims && (trueTier !== amzTier || fulfilmentFee(amazonDims, 20, asOf, table).fee - fulfilmentFee(trueDims, 20, asOf, table).fee > policy.feeTolerance)
    const fmtD = (d: Dims) => `${d.longest.toFixed(1)} x ${d.median.toFixed(1)} x ${d.shortest.toFixed(1)} in, ${d.weightLb.toFixed(2)} lb`
    const detail = [
      `Charged $${medOver.toFixed(2)} per unit (median of the overcharged lines) against an expected $${fulfilmentFee(dims, fp?.price ?? 20, asOf, table).fee.toFixed(2)} for ${TIER_LABEL[trueTier]} at ${fmtD(dims)}${trueDims ? ' (your measurements)' : ' (Amazon’s measurements, rate table check)'}.`,
      mis && amazonDims ? `Amazon has the item as ${fmtD(amazonDims)} (${TIER_LABEL[amzTier!]}).` : '',
      step > 0 ? `The fee rose from $${charged[0].toFixed(2)} to $${charged[step].toFixed(2)} on ${lines[step].date}, which usually means a re-measurement.` : '',
      outliers ? `${outliers} order line${outliers > 1 ? 's' : ''} differ from the usual fee by more than 25%.` : '',
      missed > 0 ? `A further $${missed.toFixed(2)} is older than the ${policy.feeDays}-day window.` : '',
    ].filter(Boolean).join(' ')
    if (over <= 0) { notes.push(`${sku}: fee overcharges of $${missed.toFixed(2)} are past the ${policy.feeDays}-day window.`); continue }
    findings.push({
      id: `fee:${sku}`, kind: 'fee', fnsku: cat.fnsku(sku), sku, title: cat.title(sku),
      units: overUnits, unitValue: round2(over / overUnits), amount: round2(over), basis: 'charged minus expected fulfilment fee',
      eventDate: first, opens: first, deadline: addDays(first, policy.feeDays),
      refs: step > 0 ? [`fee change ${lines[step].date}`] : [], lines: used.slice(0, 50),
      detail,
      policy: mis
        ? 'FBA fees are set by the size tier from Amazon’s measured dimensions and weight. If they are wrong, ask for a re-measurement and a refund of the fee difference on units already shipped.'
        : 'The fulfilment fee charged is above the published rate for this size tier and weight. Ask for a fee review and a refund of the difference.',
      confidence: mis ? 'high' : trueDims ? 'medium' : 'low',
    })
  }

  // 6. Fees charged on units that never arrived (placement / inbound fees) and fulfilment fees before first receipt
  const shipUnits = new Map<string, { shipped: number; received: number }>()
  for (const s of ds.inbound) { const x = shipUnits.get(s.shipmentId) ?? { shipped: 0, received: 0 }; x.shipped += s.shipped; x.received += Math.min(s.received, s.shipped); shipUnits.set(s.shipmentId, x) }
  const shipFees = new Map<string, { fee: number; date: string; lines: number[]; desc: string }>()
  for (const t of ds.txns) {
    if (!t.shipmentId || t.otherFee <= 0) continue
    const x = shipFees.get(t.shipmentId) ?? { fee: 0, date: t.date, lines: [], desc: t.description ?? 'Inbound fee' }
    x.fee += t.otherFee; x.lines.push(t.line); if (t.date < x.date) x.date = t.date
    shipFees.set(t.shipmentId, x)
  }
  for (const [id, x] of shipFees) {
    const u = shipUnits.get(id)
    if (!u || u.received >= u.shipped || !u.shipped) continue
    const per = x.fee / u.shipped, missing = u.shipped - u.received
    const transit = inTransit.some(t => t.shipmentId === id)
    findings.push({
      id: `fee-transit:${id}`, kind: 'fee-transit', fnsku: '', sku: id, title: `Shipment ${id}`,
      units: missing, unitValue: round2(per), amount: round2(per * missing), basis: 'per-unit share of the fee',
      eventDate: x.date, opens: x.date, deadline: addDays(x.date, policy.feeDays),
      refs: [id], lines: x.lines,
      detail: `${x.desc} of $${x.fee.toFixed(2)} was charged on ${u.shipped} units on ${x.date}, but only ${u.received} have been received${transit ? ' (shipment still receiving)' : ''}. $${per.toFixed(2)} per unit on ${missing} units.`,
      policy: 'Inbound placement and transportation fees are per unit received. Fees charged on units Amazon never received should be refunded.',
      confidence: transit ? 'low' : 'medium',
    })
  }
  // Only trust "no receipt yet" when the ledger already covered other SKUs at that date and this SKU had no earlier activity.
  const firstSeen = new Map<string, string>(), firstReceipt = new Map<string, string>()
  for (const r of ds.ledger) {
    if (!firstSeen.has(r.msku) || r.date < firstSeen.get(r.msku)!) firstSeen.set(r.msku, r.date)
    if (r.event === 'Receipts' && r.qty > 0 && (!firstReceipt.has(r.msku) || r.date < firstReceipt.get(r.msku)!)) firstReceipt.set(r.msku, r.date)
  }
  const ledgerStart = ds.ledger.reduce((m, r) => r.date < m ? r.date : m, '9999')
  for (const [sku, lines] of ordersBySku) {
    const fr = firstReceipt.get(sku)
    if (!fr || firstSeen.get(sku) !== fr) continue
    const early = lines.filter(t => t.date < fr && t.date > ledgerStart)
    if (!early.length) continue
    const fee = early.reduce((s, t) => s + t.fbaFee, 0), units = early.reduce((s, t) => s + t.qty, 0)
    findings.push({
      id: `fee-transit:${sku}:before-receipt`, kind: 'fee-transit', fnsku: cat.fnsku(sku), sku, title: cat.title(sku),
      units, unitValue: round2(fee / units), amount: round2(fee), basis: 'fulfilment fees charged',
      eventDate: early[0].date, opens: early[0].date, deadline: addDays(early[0].date, policy.feeDays),
      refs: early.slice(0, 5).map(t => t.orderId).filter(Boolean), lines: early.map(t => t.line),
      detail: `${units} unit${units > 1 ? 's' : ''} were charged FBA fulfilment fees before the first receipt of this SKU on ${fr}.`,
      policy: 'FBA fulfilment fees apply to units fulfilled from Amazon inventory. Fees charged before any unit was received point to a mis-assigned charge.',
      confidence: 'medium',
    })
  }

  // Flows for the Sankey and the SKU table
  const flowList: SkuFlow[] = [...flows.values()].map(f => {
    const sku = cat.sku(f.fnsku)
    const expiredUnits = findings.filter(x => (x.kind === 'lost' || x.kind === 'damaged') && x.fnsku === f.fnsku && x.deadline < asOf).reduce((s, x) => s + x.units, 0)
    return { ...f, sku, title: cat.title(f.fnsku), expiredUnits, unitValue: val(sku).value }
  }).sort((a, b) => b.unreimbursed * b.unitValue - a.unreimbursed * a.unitValue || b.received - a.received)

  findings.sort((a, b) => rank(a, asOf) - rank(b, asOf))
  const totals: Analysis['totals'] = { open: 0, upcoming: 0, missed: 0, count: 0, byKind: {}, nextDeadline: null }
  for (const f of findings) {
    const st = findingState(f, asOf)
    if (st === 'expired') { totals.missed += f.amount; continue }
    st === 'open' ? totals.open += f.amount : totals.upcoming += f.amount
    totals.count++
    totals.byKind[f.kind] = round2((totals.byKind[f.kind] ?? 0) + f.amount)
    if (st === 'open' && (!totals.nextDeadline || f.deadline < totals.nextDeadline)) totals.nextDeadline = f.deadline
  }
  totals.open = round2(totals.open); totals.upcoming = round2(totals.upcoming); totals.missed = round2(totals.missed)
  return { asOf, findings, flows: flowList, inTransit, totals, notes }
}

/**
 * Worklist order: open claims first, ranked by dollars per day left (a $40 claim closing in 3 days beats a $90 one
 * closing in 50), then claims not yet open, then expired ones.
 */
export function rank(f: Finding, asOf: string): number {
  const st = findingState(f, asOf)
  if (st === 'expired') return 2e9 - f.amount
  if (st === 'upcoming') return 1e9 + daysBetween(asOf, f.opens)
  const days = Math.max(1, daysBetween(asOf, f.deadline))
  return -(f.amount / days)
}
