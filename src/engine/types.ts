// Normalized rows. Dates are YYYY-MM-DD (UTC calendar days); money is in the marketplace currency.

export interface LedgerRow {
  date: string
  fnsku: string
  msku: string
  asin?: string
  title?: string
  /** Receipts, Shipments, CustomerReturns, Adjustments, WhseTransfers, VendorReturns */
  event: string
  ref: string
  qty: number
  fc?: string
  disposition?: string
  /** Adjustment reason code (M, F, 5, 6, E, D, ...) */
  reason?: string
  line: number
}

export interface Reimbursement {
  date: string
  id: string
  caseId?: string
  orderId?: string
  /** Lost_Warehouse, Damaged_Warehouse, Lost_Inbound, CustomerReturn, CustomerServiceIssue, Reimbursement_Reversal, ... */
  reason: string
  sku: string
  fnsku: string
  amountPerUnit: number
  amountTotal: number
  qtyCash: number
  qtyInventory: number
  line: number
}

export interface CustomerReturn {
  date: string
  orderId: string
  sku: string
  fnsku: string
  qty: number
  disposition?: string
  reason?: string
  status?: string
  line: number
}

export interface FeePreview {
  sku: string
  fnsku: string
  asin?: string
  title?: string
  price: number
  /** Inches and pounds after unit conversion */
  longest: number
  median: number
  shortest: number
  weightLb: number
  tier?: string
  expectedFee: number
  line: number
}

/** One settlement / transaction line, already reduced to the parts the audit needs. */
export interface Txn {
  date: string
  /** Order, Refund, Adjustment, ServiceFee, ... */
  type: string
  orderId: string
  sku: string
  qty: number
  /** Item principal (positive for orders, negative for refunds) */
  principal: number
  /** FBA per-unit fulfilment fee for the line, as a positive number */
  fbaFee: number
  /** Any other fee on the line (placement, transportation...), positive */
  otherFee: number
  description?: string
  shipmentId?: string
  line: number
}

export interface InboundItem {
  shipmentId: string
  sku: string
  fnsku: string
  shipped: number
  received: number
  /** Created, shipped or closed date, whichever the export gives (the latest one wins) */
  date: string
  status?: string
  line: number
}

export interface CostRow {
  sku: string
  cost: number
  /** Seller-measured packaged dimensions (inches) and weight (lb), optional */
  longest?: number
  median?: number
  shortest?: number
  weightLb?: number
  line: number
}

export interface Dataset {
  ledger: LedgerRow[]
  reimbursements: Reimbursement[]
  returns: CustomerReturn[]
  fees: FeePreview[]
  txns: Txn[]
  inbound: InboundItem[]
  costs: CostRow[]
}

export const emptyDataset = (): Dataset => ({ ledger: [], reimbursements: [], returns: [], fees: [], txns: [], inbound: [], costs: [] })

export type FindingKind = 'lost' | 'damaged' | 'underpaid' | 'return' | 'inbound' | 'fee' | 'fee-transit'

export const KIND_LABEL: Record<FindingKind, string> = {
  lost: 'Lost in warehouse',
  damaged: 'Damaged in warehouse',
  underpaid: 'Reimbursed below value',
  return: 'Refunded, never returned',
  inbound: 'Inbound shortfall',
  fee: 'Fulfilment fee overcharge',
  'fee-transit': 'Fee on units not received',
}

export interface Finding {
  /** Stable across re-imports so case status survives */
  id: string
  kind: FindingKind
  fnsku: string
  sku: string
  title: string
  units: number
  /** Per-unit value used for the estimate */
  unitValue: number
  amount: number
  /** What the estimate is based on, for the case text and the UI */
  basis: string
  eventDate: string
  /** First day a claim can be opened (returns wait for Amazon's own window) */
  opens: string
  deadline: string
  refs: string[]
  /** Source file line numbers backing the finding */
  lines: number[]
  detail: string
  policy: string
  confidence: 'high' | 'medium' | 'low'
}

export type CaseStatus = 'open' | 'draft' | 'filed' | 'reimbursed' | 'denied'
export interface CaseState { status: CaseStatus; caseId?: string; recovered?: number; note?: string; updatedAt: number }

export interface Policy {
  /** Lost or damaged in a fulfilment centre: days after the ledger event */
  warehouseDays: number
  /** Customer returns: claim opens N days after the refund and closes M days after it */
  returnOpenDays: number
  returnCloseDays: number
  /** Inbound shortfall: days after the shipment was closed / last received */
  inboundDays: number
  /** Inbound shipments younger than this are still being received; no claim yet */
  inboundSettleDays: number
  /** Fee disputes (dimensions, fees on units not received): days after the charge */
  feeDays: number
  /** Reimbursement value disputes: days after the reimbursement */
  underpaidDays: number
  /** Flag reimbursements paying less than this share of the expected unit value */
  underpaidRatio: number
  /** Ignore fee differences smaller than this per unit */
  feeTolerance: number
  /** Window for matching a reimbursement to a ledger event (days either side) */
  matchDays: number
}

export const DEFAULT_POLICY: Policy = {
  warehouseDays: 60,
  returnOpenDays: 60,
  returnCloseDays: 120,
  inboundDays: 60,
  inboundSettleDays: 14,
  feeDays: 90,
  underpaidDays: 60,
  underpaidRatio: 0.9,
  feeTolerance: 0.05,
  matchDays: 45,
}

/** The date the defaults above were last checked against public summaries of the FBA reimbursement policy. */
export const POLICY_CHECKED = '2026-11-08'
