// Case text, CSV export and monthly snapshots built from findings.
import { toCsv } from './parse.ts'
import { daysBetween, findingState, type Analysis } from './recon.ts'
import { KIND_LABEL, type CaseState, type Finding, type FindingKind } from './types.ts'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const SUBJECT: Record<FindingKind, string> = {
  lost: 'Reimbursement request: units lost in fulfilment centre',
  damaged: 'Reimbursement request: units damaged in fulfilment centre',
  underpaid: 'Reimbursement review: amount paid below item cost',
  return: 'Reimbursement request: customer refunded, item not returned',
  inbound: 'Inbound shipment reconciliation: units shipped but not received',
  fee: 'FBA fee review: fulfilment fee above size tier rate',
  'fee-transit': 'Fee refund: fees charged on units not received',
}

const ASK: Record<FindingKind, string> = {
  lost: 'Please investigate and reimburse the units that were neither found nor reimbursed.',
  damaged: 'Please reimburse the units damaged while in Amazon’s custody.',
  underpaid: 'Please review the reimbursement amount against the attached proof of cost and pay the difference.',
  return: 'Please reimburse the refunded units that were not returned to a fulfilment centre.',
  inbound: 'Please reconcile the shipment and reimburse the missing units. Proof of delivery and the packing list are attached.',
  fee: 'Please re-measure the item, correct the size tier, and refund the fee difference on the units already shipped.',
  'fee-transit': 'Please refund the fee charged on units that were never received.',
}

/** Copy-ready text for Seller Central > Help > Contact us. Plain text, no markdown. */
export function caseText(f: Finding, seller = ''): string {
  const lines = [
    `Subject: ${SUBJECT[f.kind]}${f.fnsku ? ` (FNSKU ${f.fnsku})` : ` (${f.sku})`}`,
    '',
    'Hello,',
    '',
    `${ASK[f.kind]}`,
    '',
    `FNSKU: ${f.fnsku || 'n/a'}`,
    `MSKU: ${f.sku}`,
    ...(f.title ? [`Product: ${f.title}`] : []),
    `Date of event: ${f.eventDate}`,
    `Units: ${f.units}`,
    ...(f.refs.length ? [`References: ${f.refs.join(', ')}`] : []),
    `Estimated amount: ${money(f.amount)} (${money(f.unitValue)} per unit, ${f.basis})`,
    '',
    `What we found: ${f.detail}`,
    '',
    `Policy: ${f.policy}`,
    '',
    `Source: ${f.kind === 'fee' || f.kind === 'fee-transit' ? 'Settlement / transaction report' : f.kind === 'return' ? 'Settlement refunds and FBA customer returns report' : f.kind === 'inbound' ? 'Shipment items' : 'Inventory Ledger (detailed view) and Reimbursements report'}, rows ${f.lines.slice(0, 12).join(', ')}${f.lines.length > 12 ? ', ...' : ''}.`,
    '',
    'Thank you,',
    seller || '[Your name / store]',
  ]
  return lines.join('\n')
}

export function findingsCsv(list: Finding[], cases: Record<string, CaseState>, asOf: string): string {
  return toCsv([
    ['id', 'type', 'fnsku', 'sku', 'title', 'units', 'unit_value', 'amount', 'basis', 'event_date', 'opens', 'deadline', 'days_left', 'state', 'case_status', 'case_id', 'recovered', 'references', 'detail'],
    ...list.map(f => {
      const c = cases[f.id]
      return [f.id, KIND_LABEL[f.kind], f.fnsku, f.sku, f.title, f.units, f.unitValue, f.amount, f.basis, f.eventDate, f.opens, f.deadline, daysBetween(asOf, f.deadline), findingState(f, asOf), c?.status ?? 'open', c?.caseId ?? '', c?.recovered ?? '', f.refs.join(' '), f.detail]
    }),
  ])
}

export interface Snapshot {
  id: string
  /** YYYY-MM */
  period: string
  label: string
  at: number
  found: number
  open: number
  missed: number
  recovered: number
  filed: number
  count: number
  byKind: Partial<Record<FindingKind, number>>
}

/** Recovered = what the seller logged as reimbursed on cases; found = open + upcoming claims at snapshot time. */
export function snapshot(a: Analysis, cases: Record<string, CaseState>, id: string, period: string, label: string): Snapshot {
  let recovered = 0, filed = 0
  for (const f of a.findings) {
    const c = cases[f.id]
    if (!c) continue
    if (c.status === 'reimbursed') recovered += c.recovered ?? f.amount
    if (c.status === 'filed') filed += f.amount
  }
  return { id, period, label, at: Date.now(), found: Math.round((a.totals.open + a.totals.upcoming) * 100) / 100, open: a.totals.open, missed: a.totals.missed, recovered: Math.round(recovered * 100) / 100, filed: Math.round(filed * 100) / 100, count: a.totals.count, byKind: a.totals.byKind }
}

export interface Delta { key: string; label: string; before: number; after: number }

export function compareSnapshots(a: Snapshot, b: Snapshot): Delta[] {
  const rows: Delta[] = [
    { key: 'found', label: 'Found (open + upcoming)', before: a.found, after: b.found },
    { key: 'recovered', label: 'Recovered', before: a.recovered, after: b.recovered },
    { key: 'filed', label: 'Filed, awaiting decision', before: a.filed, after: b.filed },
    { key: 'missed', label: 'Missed (window closed)', before: a.missed, after: b.missed },
    { key: 'count', label: 'Open findings', before: a.count, after: b.count },
  ]
  for (const k of Object.keys(KIND_LABEL) as FindingKind[]) {
    if (a.byKind[k] || b.byKind[k]) rows.push({ key: k, label: KIND_LABEL[k], before: a.byKind[k] ?? 0, after: b.byKind[k] ?? 0 })
  }
  return rows
}
