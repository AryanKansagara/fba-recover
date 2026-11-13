// Seller Central report parsing: delimiter sniffing, report detection, flexible column mapping and line-numbered validation.
import { emptyDataset, type CostRow, type CustomerReturn, type Dataset, type FeePreview, type InboundItem, type LedgerRow, type Reimbursement, type Txn } from './types.ts'

export interface Table { rows: string[][]; lines: number[] }

export function parseCsv(text: string): Table {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delim = sniffDelimiter(text)
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
      row = []
      line++
      rowLine = line
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
  }
  return { rows, lines }
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts = [',', '\t', ';', '|'].map(d => [d, head.split(d).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : ''
}

/**
 * Seller Central dates come as ISO 8601 (ledger, reimbursements), "Jul 14, 2026 8:12:33 AM PDT" (date range report),
 * M/D/YYYY (spreadsheets) or D.M.YYYY (EU settlement files). Returns the calendar day as written, or '' if unreadable.
 */
export function parseDate(raw: string): string {
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

/** "$1,234.50", "(3.20)", "-3,20" (EU decimal comma) and blanks. Returns NaN when unreadable. */
export function parseNum(raw: string): number {
  let s = raw.trim().replace(/^"|"$/g, '').replace(/[$£€\s]/g, '').replace(/^USD/i, '')
  if (s === '' || /^(null|n\/a|--)$/i.test(s)) return NaN
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  return neg ? -n : n
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(v => {
    const s = typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : v
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}

// ---------- Report kinds and fields ----------

export type Kind = 'ledger' | 'reimbursements' | 'returns' | 'fees' | 'txns' | 'inbound' | 'costs'

export const KINDS: Record<Kind, { label: string; noun: string }> = {
  ledger: { label: 'Inventory Ledger (detailed view)', noun: 'ledger events' },
  reimbursements: { label: 'Reimbursements', noun: 'reimbursements' },
  returns: { label: 'FBA customer returns', noun: 'returns' },
  fees: { label: 'Fee Preview', noun: 'SKUs' },
  txns: { label: 'Settlement / transactions', noun: 'transactions' },
  inbound: { label: 'Inbound shipment items', noun: 'shipment lines' },
  costs: { label: 'Product cost (COGS)', noun: 'SKUs' },
}

type FieldType = 'text' | 'num' | 'date'
export interface FieldSpec { key: string; label: string; required?: boolean; type: FieldType; aliases: string[] }

const f = (key: string, label: string, type: FieldType, aliases: string[], required = false): FieldSpec => ({ key, label, type, aliases, required })

export const FIELDS: Record<Kind, FieldSpec[]> = {
  ledger: [
    f('date', 'Date', 'date', ['date', 'date_and_time', 'event_date'], true),
    f('fnsku', 'FNSKU', 'text', ['fnsku'], true),
    f('msku', 'MSKU', 'text', ['msku', 'sku', 'merchant_sku', 'seller_sku']),
    f('asin', 'ASIN', 'text', ['asin']),
    f('title', 'Title', 'text', ['title', 'product_name']),
    f('event', 'Event Type', 'text', ['event_type', 'event', 'transaction_type'], true),
    f('ref', 'Reference ID', 'text', ['reference_id', 'reference', 'transaction_item_id']),
    f('qty', 'Quantity', 'num', ['quantity', 'qty'], true),
    f('fc', 'Fulfillment Center', 'text', ['fulfillment_center', 'fulfillment_center_id', 'fc']),
    f('disposition', 'Disposition', 'text', ['disposition']),
    f('reason', 'Reason', 'text', ['reason', 'reason_code', 'adjustment_reason']),
  ],
  reimbursements: [
    f('date', 'approval-date', 'date', ['approval_date', 'date', 'reimbursement_date'], true),
    f('id', 'reimbursement-id', 'text', ['reimbursement_id', 'id'], true),
    f('caseId', 'case-id', 'text', ['case_id']),
    f('orderId', 'amazon-order-id', 'text', ['amazon_order_id', 'order_id']),
    f('reason', 'reason', 'text', ['reason'], true),
    f('sku', 'sku', 'text', ['sku', 'msku', 'merchant_sku']),
    f('fnsku', 'fnsku', 'text', ['fnsku'], true),
    f('amountPerUnit', 'amount-per-unit', 'num', ['amount_per_unit']),
    f('amountTotal', 'amount-total', 'num', ['amount_total', 'amount']),
    f('qtyCash', 'quantity-reimbursed-cash', 'num', ['quantity_reimbursed_cash']),
    f('qtyInventory', 'quantity-reimbursed-inventory', 'num', ['quantity_reimbursed_inventory']),
    f('qtyTotal', 'quantity-reimbursed-total', 'num', ['quantity_reimbursed_total', 'quantity']),
  ],
  returns: [
    f('date', 'return-date', 'date', ['return_date', 'date'], true),
    f('orderId', 'order-id', 'text', ['order_id', 'amazon_order_id'], true),
    f('sku', 'sku', 'text', ['sku', 'msku', 'merchant_sku']),
    f('fnsku', 'fnsku', 'text', ['fnsku']),
    f('qty', 'quantity', 'num', ['quantity', 'qty']),
    f('disposition', 'detailed-disposition', 'text', ['detailed_disposition', 'disposition']),
    f('reason', 'reason', 'text', ['reason', 'return_reason']),
    f('status', 'status', 'text', ['status']),
  ],
  fees: [
    f('sku', 'sku', 'text', ['sku', 'msku', 'seller_sku'], true),
    f('fnsku', 'fnsku', 'text', ['fnsku']),
    f('asin', 'asin', 'text', ['asin']),
    f('title', 'product-name', 'text', ['product_name', 'title']),
    f('price', 'your-price', 'num', ['your_price', 'sales_price', 'price']),
    f('longest', 'longest-side', 'num', ['longest_side', 'length'], true),
    f('median', 'median-side', 'num', ['median_side', 'width'], true),
    f('shortest', 'shortest-side', 'num', ['shortest_side', 'height'], true),
    f('dimUnit', 'unit-of-dimension', 'text', ['unit_of_dimension', 'dimension_unit']),
    f('weight', 'item-package-weight', 'num', ['item_package_weight', 'weight', 'package_weight'], true),
    f('weightUnit', 'unit-of-weight', 'text', ['unit_of_weight', 'weight_unit']),
    f('tier', 'product-size-tier', 'text', ['product_size_tier', 'product_size_weight_band', 'size_tier']),
    f('expectedFee', 'expected-fulfillment-fee-per-unit', 'num', ['expected_fulfillment_fee_per_unit', 'expected_domestic_fulfilment_fee_per_unit', 'expected_domestic_fulfillment_fee_per_unit', 'estimated_fulfillment_fee']),
  ],
  txns: [
    f('date', 'posted-date / date/time', 'date', ['posted_date', 'posted_date_time', 'date_time', 'date'], true),
    f('type', 'transaction-type / type', 'text', ['transaction_type', 'type'], true),
    f('orderId', 'order-id', 'text', ['order_id', 'amazon_order_id']),
    f('sku', 'sku', 'text', ['sku', 'msku']),
    f('qty', 'quantity', 'num', ['quantity_purchased', 'quantity']),
    f('amountType', 'amount-type (settlement)', 'text', ['amount_type']),
    f('amountDescription', 'amount-description (settlement)', 'text', ['amount_description']),
    f('amount', 'amount (settlement)', 'num', ['amount']),
    f('principal', 'product sales (date range)', 'num', ['product_sales']),
    f('fbaFee', 'fba fees (date range)', 'num', ['fba_fees']),
    f('otherFee', 'other transaction fees (date range)', 'num', ['other_transaction_fees']),
    f('description', 'description', 'text', ['description']),
    f('shipmentId', 'shipment-id', 'text', ['shipment_id', 'fba_shipment_id']),
  ],
  inbound: [
    f('shipmentId', 'Shipment ID', 'text', ['shipment_id', 'fba_shipment_id'], true),
    f('sku', 'Merchant SKU', 'text', ['merchant_sku', 'sku', 'msku', 'seller_sku']),
    f('fnsku', 'FNSKU', 'text', ['fnsku', 'fulfillment_network_sku'], true),
    f('shipped', 'Units shipped', 'num', ['quantity_shipped', 'units_shipped', 'units_expected', 'shipped', 'expected'], true),
    f('received', 'Units received', 'num', ['quantity_received', 'units_received', 'received'], true),
    f('date', 'Closed / updated date', 'date', ['closed_date', 'last_updated', 'last_updated_date', 'date', 'shipment_date', 'created_date'], true),
    f('status', 'Status', 'text', ['status', 'shipment_status']),
  ],
  costs: [
    f('sku', 'SKU', 'text', ['sku', 'msku', 'seller_sku'], true),
    f('cost', 'Unit cost', 'num', ['cost', 'unit_cost', 'cogs', 'landed_cost', 'manufacturing_cost'], true),
    f('longest', 'Your longest side (in)', 'num', ['longest_side', 'length']),
    f('median', 'Your median side (in)', 'num', ['median_side', 'width']),
    f('shortest', 'Your shortest side (in)', 'num', ['shortest_side', 'height']),
    f('weightLb', 'Your packaged weight (lb)', 'num', ['weight_lb', 'weight', 'package_weight']),
  ],
}

// camelCase headers (SP-API and some connectors: "EventType", "SellerSKU") split into words first.
export const norm = (h: string) => h.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase().replace(/^"|"$/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

const SIGNATURES: [Kind, string[]][] = [
  ['ledger', ['event_type', 'fnsku']],
  ['reimbursements', ['reimbursement_id']],
  ['returns', ['detailed_disposition']],
  ['returns', ['license_plate_number']],
  ['costs', ['unit_cost']],
  ['costs', ['cogs']],
  ['fees', ['longest_side']],
  ['txns', ['amount_description']],
  ['txns', ['fba_fees']],
  ['txns', ['settlement_id']],
  ['inbound', ['shipment_id', 'fnsku']],
  ['inbound', ['shipment_id', 'fulfillment_network_sku']],
  ['costs', ['cost']],
]

/** Finds the header row (the date range report has a preamble) and the report kind. */
export function detect(t: Table): { kind: Kind | null; header: number } {
  for (let i = 0; i < Math.min(t.rows.length, 15); i++) {
    const h = t.rows[i].map(norm)
    const hit = SIGNATURES.find(([, need]) => need.every(n => h.includes(n)))
    if (hit) return { kind: hit[0], header: i }
  }
  return { kind: null, header: 0 }
}

export type Mapping = Record<string, number>

export function autoMap(kind: Kind, headers: string[]): Mapping {
  const h = headers.map(norm)
  const map: Mapping = {}
  const used = new Set<number>()
  for (const fs of FIELDS[kind]) {
    for (const a of fs.aliases) {
      const i = h.findIndex((x, j) => x === a && !used.has(j))
      if (i >= 0) { map[fs.key] = i; used.add(i); break }
    }
  }
  return map
}

export interface Issue { line: number; level: 'error' | 'warning'; message: string }
export interface Validated { kind: Kind; data: Partial<Dataset>; count: number; issues: Issue[]; skipped: number; total: number; range: [string, string] | null }

type Rec = Record<string, string | number>

const LEDGER_EVENTS = ['receipts', 'shipments', 'customerreturns', 'adjustments', 'whsetransfers', 'vendorreturns']
const toInches = (n: number, unit: string) => /cent|cm/i.test(unit) ? n / 2.54 : /milli|^mm$/i.test(unit) ? n / 25.4 : n
/** Seller Central writes "--" or "N/A" where a value does not apply (no sale price, item not measured yet). */
const NULLISH = /^(--|-|n\/a|null|none)$/i
const toLb = (n: number, unit: string) => /gram|^g$/i.test(unit) ? n / 453.592 : /kilo|kg/i.test(unit) ? n * 2.20462 : /ounce|oz/i.test(unit) ? n / 16 : n

/** Maps and validates the data rows below `header`. Line numbers are the file's own (1-based). */
export function validate(kind: Kind, t: Table, map: Mapping, header = 0): Validated {
  const specs = FIELDS[kind]
  const issues: Issue[] = []
  const recs: { r: Rec; line: number }[] = []
  let skipped = 0
  const missing = specs.filter(s => s.required && map[s.key] === undefined)
  if (kind === 'txns' && map.amount === undefined && map.fbaFee === undefined) missing.push({ key: 'fees', label: 'amount or fba fees', type: 'num', aliases: [] })
  if (missing.length) {
    return { kind, data: {}, count: 0, skipped: t.rows.length - header - 1, total: t.rows.length - header - 1, range: null, issues: [{ line: t.lines[header] ?? 1, level: 'error', message: `Map the required column${missing.length > 1 ? 's' : ''}: ${missing.map(m => m.label).join(', ')}.` }] }
  }
  for (let i = header + 1; i < t.rows.length; i++) {
    const row = t.rows[i], line = t.lines[i]
    // Settlement flat files open with a summary row (settlement id, period, total) that has no transaction type.
    if (kind === 'txns' && map.amountDescription !== undefined && !(row[map.type] ?? '').trim()) {
      issues.push({ line, level: 'warning', message: 'Settlement summary row (period and total), not a transaction; ignored.' })
      continue
    }
    const r: Rec = {}
    let bad = ''
    for (const s of specs) {
      const col = map[s.key]
      const cell = col === undefined ? '' : (row[col] ?? '').trim()
      const raw = s.type !== 'text' && NULLISH.test(cell) ? '' : cell
      if (s.type === 'text') r[s.key] = raw
      else if (s.type === 'date') {
        const d = raw ? parseDate(raw) : ''
        if (raw && !d) bad ||= `${s.label} "${raw}" is not a date`
        r[s.key] = d
      } else {
        const n = raw ? parseNum(raw) : NaN
        if (raw && Number.isNaN(n)) bad ||= `${s.label} "${raw}" is not a number`
        r[s.key] = Number.isNaN(n) ? NaN : n
      }
      if (s.required && (r[s.key] === '' || (s.type === 'num' && Number.isNaN(r[s.key])))) bad ||= `${s.label} is empty`
    }
    if (bad) { issues.push({ line, level: 'error', message: `${bad}; row skipped.` }); skipped++; continue }
    recs.push({ r, line })
  }

  const data: Partial<Dataset> = {}
  const num = (v: string | number | undefined, d = 0) => typeof v === 'number' && !Number.isNaN(v) ? v : d
  const str = (v: string | number | undefined) => typeof v === 'string' ? v : ''

  if (kind === 'ledger') {
    data.ledger = recs.map(({ r, line }) => {
      if (!LEDGER_EVENTS.includes(str(r.event).toLowerCase().replace(/[^a-z]/g, ''))) issues.push({ line, level: 'warning', message: `Unknown event type "${r.event}"; kept but not reconciled.` })
      return { date: str(r.date), fnsku: str(r.fnsku), msku: str(r.msku) || str(r.fnsku), asin: str(r.asin) || undefined, title: str(r.title) || undefined, event: canonEvent(str(r.event)), ref: str(r.ref), qty: num(r.qty), fc: str(r.fc) || undefined, disposition: str(r.disposition) || undefined, reason: str(r.reason) || undefined, line } satisfies LedgerRow
    })
  } else if (kind === 'reimbursements') {
    data.reimbursements = recs.map(({ r, line }) => {
      let cash = num(r.qtyCash), inv = num(r.qtyInventory)
      if (map.qtyCash === undefined && map.qtyInventory === undefined) cash = num(r.qtyTotal)
      const total = num(r.amountTotal), per = num(r.amountPerUnit, cash ? total / cash : 0)
      if (!cash && !inv && !total) issues.push({ line, level: 'warning', message: 'Reimbursement with no units and no amount.' })
      return { date: str(r.date), id: str(r.id), caseId: str(r.caseId) || undefined, orderId: str(r.orderId) || undefined, reason: str(r.reason), sku: str(r.sku), fnsku: str(r.fnsku), amountPerUnit: per, amountTotal: total || per * cash, qtyCash: cash, qtyInventory: inv, line } satisfies Reimbursement
    })
  } else if (kind === 'returns') {
    data.returns = recs.map(({ r, line }) => {
      if (!str(r.sku) && !str(r.fnsku)) issues.push({ line, level: 'warning', message: 'Return without SKU or FNSKU; matched by order only.' })
      return { date: str(r.date), orderId: str(r.orderId), sku: str(r.sku), fnsku: str(r.fnsku), qty: num(r.qty, 1) || 1, disposition: str(r.disposition) || undefined, reason: str(r.reason) || undefined, status: str(r.status) || undefined, line } satisfies CustomerReturn
    })
  } else if (kind === 'fees') {
    data.fees = recs.flatMap(({ r, line }) => {
      const du = str(r.dimUnit), wu = str(r.weightUnit)
      const fee: FeePreview = { sku: str(r.sku), fnsku: str(r.fnsku), asin: str(r.asin) || undefined, title: str(r.title) || undefined, price: num(r.price), longest: toInches(num(r.longest), du), median: toInches(num(r.median), du), shortest: toInches(num(r.shortest), du), weightLb: toLb(num(r.weight), wu), tier: str(r.tier) || undefined, expectedFee: num(r.expectedFee, NaN), line }
      if (fee.longest <= 0 || fee.weightLb <= 0) { issues.push({ line, level: 'error', message: 'Dimensions or weight are zero; row skipped.' }); skipped++; return [] }
      if (!fee.price) issues.push({ line, level: 'warning', message: 'No price; fees assume the $10 to $50 band.' })
      return [fee]
    })
  } else if (kind === 'txns') {
    data.txns = map.amountDescription !== undefined ? foldSettlement(recs) : recs.map(({ r, line }) => ({
      date: str(r.date), type: str(r.type), orderId: str(r.orderId), sku: str(r.sku), qty: num(r.qty), principal: num(r.principal), fbaFee: -num(r.fbaFee), otherFee: -num(r.otherFee), description: str(r.description) || undefined, shipmentId: str(r.shipmentId) || undefined, line,
    }) satisfies Txn)
  } else if (kind === 'inbound') {
    data.inbound = recs.map(({ r, line }) => {
      if (num(r.received) > num(r.shipped)) issues.push({ line, level: 'warning', message: `Received ${r.received} is more than shipped ${r.shipped} (overage).` })
      return { shipmentId: str(r.shipmentId), sku: str(r.sku) || str(r.fnsku), fnsku: str(r.fnsku), shipped: num(r.shipped), received: num(r.received), date: str(r.date), status: str(r.status) || undefined, line } satisfies InboundItem
    })
  } else {
    data.costs = recs.flatMap(({ r, line }) => {
      if (!(num(r.cost) > 0)) { issues.push({ line, level: 'error', message: 'Unit cost must be above zero; row skipped.' }); skipped++; return [] }
      const c: CostRow = { sku: str(r.sku), cost: num(r.cost), line }
      if (num(r.longest) > 0) Object.assign(c, { longest: num(r.longest), median: num(r.median), shortest: num(r.shortest), weightLb: num(r.weightLb) })
      return [c]
    })
  }
  const rows = Object.values(data)[0] as { date?: string }[]
  const dates = rows.map(x => x.date).filter((d): d is string => !!d).sort()
  return { kind, data, count: rows.length, issues, skipped, total: t.rows.length - header - 1, range: dates.length ? [dates[0], dates[dates.length - 1]] : null }
}

function canonEvent(e: string) {
  const k = e.toLowerCase().replace(/[^a-z]/g, '')
  return ({ receipts: 'Receipts', shipments: 'Shipments', customerreturns: 'CustomerReturns', adjustments: 'Adjustments', whsetransfers: 'WhseTransfers', vendorreturns: 'VendorReturns' } as Record<string, string>)[k] ?? e
}

/** Settlement flat file V2 has one row per amount; fold them into one line per order item. */
function foldSettlement(recs: { r: Rec; line: number }[]): Txn[] {
  const out = new Map<string, Txn>()
  for (const { r, line } of recs) {
    const type = String(r.type), desc = String(r.amountDescription), amt = typeof r.amount === 'number' && !Number.isNaN(r.amount) ? r.amount : 0
    const key = [r.date, type, r.orderId, r.sku, r.shipmentId, r.orderId || r.sku ? '' : desc].join('|')
    let t = out.get(key)
    if (!t) { t = { date: String(r.date), type, orderId: String(r.orderId), sku: String(r.sku), qty: 0, principal: 0, fbaFee: 0, otherFee: 0, shipmentId: String(r.shipmentId) || undefined, description: undefined, line }; out.set(key, t) }
    const q = typeof r.qty === 'number' && !Number.isNaN(r.qty) ? r.qty : 0
    t.qty = Math.max(t.qty, Math.abs(q))
    if (/^principal$/i.test(desc)) t.principal += amt
    else if (/fbaperunitfulfillmentfee|fba.?fulfil?ment.?fee/i.test(desc.replace(/\s/g, ''))) t.fbaFee -= amt
    else if (/fee/i.test(desc) || /fee/i.test(String(r.amountType))) { t.otherFee -= amt; t.description ??= desc }
  }
  return [...out.values()]
}

// ---------- Merge ----------

const keyOf = (x: object) => JSON.stringify(Object.entries(x).filter(([k]) => k !== 'line'))

/** Adds rows without duplicating identical ones, so re-importing an overlapping export is safe. */
export function mergeData(base: Dataset, add: Partial<Dataset>): Dataset {
  const out = { ...emptyDataset(), ...base }
  for (const k of Object.keys(add) as (keyof Dataset)[]) {
    const seen = new Set((out[k] as object[]).map(keyOf))
    const extra = (add[k] as object[]).filter(x => { const key = keyOf(x); if (seen.has(key)) return false; seen.add(key); return true })
    if (k === 'costs' || k === 'fees') {
      // Newer cost / fee rows replace older ones for the same SKU.
      const skus = new Set((add[k] as { sku: string }[]).map(x => x.sku))
      out[k] = [...(out[k] as { sku: string }[]).filter(x => !skus.has(x.sku)), ...(add[k] as { sku: string }[])] as never
    } else out[k] = [...out[k], ...extra] as never
  }
  return out
}

/** Writes a dataset slice back out with Seller Central column names, so the sample can be re-imported as a rehearsal. */
export function reportCsv(kind: Kind, ds: Dataset): string {
  switch (kind) {
    case 'ledger': return toCsv([['Date', 'FNSKU', 'ASIN', 'MSKU', 'Title', 'Event Type', 'Reference ID', 'Quantity', 'Fulfillment Center', 'Disposition', 'Reason'], ...ds.ledger.map(r => [r.date, r.fnsku, r.asin ?? '', r.msku, r.title ?? '', r.event, r.ref, r.qty, r.fc ?? '', r.disposition ?? '', r.reason ?? ''])])
    case 'reimbursements': return toCsv([['approval-date', 'reimbursement-id', 'case-id', 'amazon-order-id', 'reason', 'sku', 'fnsku', 'amount-per-unit', 'amount-total', 'quantity-reimbursed-cash', 'quantity-reimbursed-inventory', 'quantity-reimbursed-total'], ...ds.reimbursements.map(r => [r.date, r.id, r.caseId ?? '', r.orderId ?? '', r.reason, r.sku, r.fnsku, r.amountPerUnit, r.amountTotal, r.qtyCash, r.qtyInventory, r.qtyCash + r.qtyInventory])])
    case 'returns': return toCsv([['return-date', 'order-id', 'sku', 'fnsku', 'quantity', 'detailed-disposition', 'reason', 'status'], ...ds.returns.map(r => [r.date, r.orderId, r.sku, r.fnsku, r.qty, r.disposition ?? '', r.reason ?? '', r.status ?? ''])])
    case 'fees': return toCsv([['sku', 'fnsku', 'asin', 'product-name', 'your-price', 'longest-side', 'median-side', 'shortest-side', 'unit-of-dimension', 'item-package-weight', 'unit-of-weight', 'expected-fulfillment-fee-per-unit'], ...ds.fees.map(r => [r.sku, r.fnsku, r.asin ?? '', r.title ?? '', r.price, r.longest, r.median, r.shortest, 'inches', r.weightLb, 'pounds', r.expectedFee])])
    case 'txns': return toCsv([['date/time', 'type', 'order id', 'sku', 'description', 'quantity', 'product sales', 'fba fees', 'other transaction fees', 'shipment id'], ...ds.txns.map(t => [t.date, t.type, t.orderId, t.sku, t.description ?? '', t.qty, t.principal, -t.fbaFee, -t.otherFee, t.shipmentId ?? ''])])
    case 'inbound': return toCsv([['Shipment ID', 'Merchant SKU', 'FNSKU', 'Units expected', 'Units received', 'Last updated', 'Status'], ...ds.inbound.map(r => [r.shipmentId, r.sku, r.fnsku, r.shipped, r.received, r.date, r.status ?? ''])])
    case 'costs': return toCsv([['sku', 'unit_cost', 'longest_side', 'median_side', 'shortest_side', 'weight_lb'], ...ds.costs.map(c => [c.sku, c.cost, c.longest ?? '', c.median ?? '', c.shortest ?? '', c.weightLb ?? ''])])
  }
}
