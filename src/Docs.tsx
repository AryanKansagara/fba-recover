import { TIER_LABEL, type Tier } from './engine/fees.ts'
import { DEFAULT_POLICY, POLICY_CHECKED } from './engine/types.ts'
import { useDefaults } from './projectData.ts'
import { Code, fmtDay, Link } from './ui.tsx'

const REPORTS: [string, string, string[], string][] = [
  ['ledger', 'Inventory Ledger (detailed view)', [
    'Seller Central › Reports › Fulfillment › Inventory › Inventory Ledger.',
    'Choose “Detailed view”, Event type “All”, and the widest date range it allows (it keeps about 18 months). Export a month at a time if it times out.',
    'Click Generate report, then Download (CSV).',
  ], 'Date, FNSKU, ASIN, MSKU, Title, Event Type, Reference ID, Quantity, Fulfillment Center, Disposition, Reason, Country. Event types: Receipts, Shipments, CustomerReturns, Adjustments, WhseTransfers, VendorReturns.'],
  ['reimbursements', 'Reimbursements', [
    'Reports › Fulfillment › Payments › Reimbursements.',
    'Same date range as the ledger. Download CSV.',
  ], 'approval-date, reimbursement-id, case-id, amazon-order-id, reason, sku, fnsku, asin, condition, currency-unit, amount-per-unit, amount-total, quantity-reimbursed-cash, quantity-reimbursed-inventory, quantity-reimbursed-total.'],
  ['returns', 'FBA customer returns', [
    'Reports › Fulfillment › Customer Concessions › Returns.',
    'Include at least 120 days before your oldest refund. Download CSV.',
  ], 'return-date, order-id, sku, asin, fnsku, product-name, quantity, fulfillment-center-id, detailed-disposition, reason, status, license-plate-number.'],
  ['fees', 'Fee Preview', [
    'Reports › Fulfillment › Payments › Fee Preview.',
    'Request the .txt download (tab-delimited). It is generated within a few hours.',
  ], 'sku, fnsku, asin, product-name, your-price, longest-side, median-side, shortest-side, length-and-girth, unit-of-dimension, item-package-weight, unit-of-weight, product-size-tier, expected-fulfillment-fee-per-unit.'],
  ['txns', 'Settlement / transactions', [
    'Either: Reports › Payments › All Statements › Download Flat File V2 for each settlement period (one row per amount type).',
    'Or: Reports › Payments › Date Range Reports › Generate report › Transaction, then download the CSV. The preamble lines at the top are skipped automatically.',
  ], 'Flat File V2: settlement-id, transaction-type, order-id, shipment-id, amount-type, amount-description, amount, posted-date, sku, quantity-purchased. Date range: date/time, type, order id, sku, description, quantity, product sales, fba fees, other transaction fees.'],
  ['inbound', 'Shipment items', [
    'Send to Amazon › Shipments (or Inventory › FBA Inventory › Shipments).',
    'Open each shipment, Contents tab, export the item list. Add a “Last updated” column with the shipment close date if the export leaves it out.',
  ], 'Shipment ID, Merchant SKU, FNSKU, Units expected (shipped), Units received, Last updated / closed date, Status.'],
  ['costs', 'Product cost (optional, your own file)', [
    'One row per SKU with your landed unit cost. Amazon reimburses most warehouse losses at the cost to replace the item, so this is the right yardstick for “paid below value”.',
    'Add your own measured packaged dimensions and weight to catch re-measurements.',
  ], 'sku, unit_cost, longest_side, median_side, shortest_side, weight_lb (inches and pounds).'],
]

export default function Docs() {
  const { table } = useDefaults()
  const p = DEFAULT_POLICY
  return (
    <section className="page narrow docs">
      <div className="eyebrow">Docs</div>
      <h1>Getting your data out of Seller Central</h1>
      <p className="lede">Six reports cover every check. Download them, drop them on a seller&rsquo;s <b>Reports &amp; settings</b> tab, check the mapping, import. Everything is parsed in your browser.</p>
      <nav className="toc" aria-label="On this page">
        <a href="#reports">Reports</a><a href="#windows">Claim windows</a><a href="#claim">What to claim</a><a href="#fees">Fee table</a><a href="#matching">How matching works</a><a href="#privacy">Privacy</a>
      </nav>

      <h2 id="reports">The reports</h2>
      <p className="muted small">Menu paths as of {fmtDay(POLICY_CHECKED)}. Seller Central moves menus around; the report names have stayed stable, so search for the name if a path has changed.</p>
      {REPORTS.map(([id, name, steps, cols]) => (
        <div key={id} id={`r-${id}`} className="doc-report">
          <h3>{name}</h3>
          <ol>{steps.map(s => <li key={s}>{s}</li>)}</ol>
          <p className="small"><b>Columns used:</b> <span className="muted">{cols}</span> Names are matched loosely (case, spaces, dashes); anything else can be mapped by hand.</p>
        </div>
      ))}
      <Code label="cost file example (CSV)" code={'sku,unit_cost,longest_side,median_side,shortest_side,weight_lb\nHL-BOARD-WAL,9.40,14.8,10.9,0.7,0.94\nHL-THROW-OAT,14.50,14,11,5,2.3\n'} />

      <h2 id="windows">Claim windows</h2>
      <p>Defaults as of <b>{fmtDay(POLICY_CHECKED)}</b>, from Amazon&rsquo;s FBA inventory reimbursement policy as summarised in 2026 seller guides. Amazon shortened most windows in late 2024 and 2025, and public summaries still disagree in places, so each one is editable per seller. Check the policy page in Seller Central Help before relying on a date.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Situation</th><th>Default window</th><th>Clock starts</th></tr></thead>
        <tbody>
          <tr><th scope="row">Lost or damaged in a fulfilment centre</th><td>{p.warehouseDays} days</td><td>The ledger adjustment date</td></tr>
          <tr><th scope="row">Customer refunded, item not returned</th><td>Opens day {p.returnOpenDays}, closes day {p.returnCloseDays}</td><td>The refund date (Amazon gets time to receive the return and auto-reimburse first)</td></tr>
          <tr><th scope="row">Inbound shipment short</th><td>{p.inboundDays} days</td><td>The shipment closing; shipments updated in the last {p.inboundSettleDays} days are treated as still receiving</td></tr>
          <tr><th scope="row">Reimbursement paid below value</th><td>{p.underpaidDays} days</td><td>The reimbursement approval date</td></tr>
          <tr><th scope="row">Fee overcharge, fees on units not received</th><td>{p.feeDays} days</td><td>The charge date</td></tr>
        </tbody>
      </table></div>

      <h2 id="claim">What to claim, and what not to</h2>
      <ul>
        <li><b>Claim:</b> adjustments with reason codes M (misplaced) and 5 (unrecoverable) not offset by an F (found) or a reimbursement; damage codes 6, 7, E and Q (Amazon&rsquo;s responsibility).</li>
        <li><b>Do not claim:</b> H (customer damaged), U (merchant responsibility), K (defective), D (disposed on your removal order). They are shown in the ledger but not counted.</li>
        <li><b>Returns:</b> only after Amazon&rsquo;s own window. Before that, Amazon will reply that the return is still expected.</li>
        <li><b>Value:</b> since 2025 most warehouse losses are reimbursed at the cost to replace the item, not the sale price. Keep supplier invoices ready for value disputes.</li>
        <li><b>Fees:</b> if a SKU jumped size tier, ask for a re-measurement first, then the refund for orders already charged.</li>
      </ul>
      <p>Every finding in the worklist has copy-ready case text with the FNSKU, dates, ledger reference IDs, the source rows and the policy reason. Paste it into Help › Get support › Selling on Amazon › FBA inventory issue (or Fees for fee findings), then log the case ID.</p>

      <h2 id="fees">Fee table</h2>
      <p><b>{table.name}</b>, effective {fmtDay(table.effective)}, with a {table.surchargePct}% fuel and logistics surcharge from {fmtDay(table.surchargeFrom)}. Base rates are for items priced $10 to $50; under $10 adds {table.lowPriceAdj.toFixed(2)}, over $50 adds +{table.highPriceAdj.toFixed(2)} (standard size). Source: {table.source}. Amazon publishes the authoritative numbers in Seller Central; compare a few SKUs against the Revenue Calculator and edit the table in <Link href="/settings#fees">Settings</Link> if they differ.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Tier</th><th>Limits</th><th>Fee from</th></tr></thead>
        <tbody>{(Object.keys(TIER_LABEL) as Tier[]).map(t => (
          <tr key={t}><th scope="row">{TIER_LABEL[t]}</th><td className="small">{{ 'small-standard': '≤ 15 × 12 × 0.75 in, ≤ 16 oz', 'large-standard': '≤ 18 × 14 × 8 in, ≤ 20 lb', 'small-bulky': '≤ 37 × 28 × 20 in, ≤ 50 lb, length + girth ≤ 130 in', 'large-bulky': '≤ 59 × 33 × 33 in, ≤ 50 lb, length + girth ≤ 130 in', 'extra-large': 'anything larger or heavier' }[t]}</td><td className="num">${table.tiers[t].brackets[0].fee.toFixed(2)}</td></tr>
        ))}</tbody>
      </table></div>
      <p className="small muted">Shipping weight is the unit weight for small standard and the greater of unit and dimensional weight (L × W × H ÷ 139, width and height at least 2 in) for every other tier.</p>

      <h2 id="matching">How matching works</h2>
      <ol>
        <li>Ledger rows are grouped by FNSKU. Negative adjustments with a lost or damaged reason become loss events.</li>
        <li>Found (F) adjustments cancel the oldest open lost units dated before the find (or within the match window after it).</li>
        <li>Lost_Warehouse and Damaged_Warehouse reimbursements (cash and inventory) are matched to the nearest open event of the same kind within {p.matchDays} days, then to anything still open. Reimbursement_Reversal rows claw back the latest reimbursements first.</li>
        <li>What remains is a finding, valued at your unit cost (or average sale price if you have not imported costs), with a deadline from the window above.</li>
        <li>The worklist ranks open findings by dollars per day left, so a small claim closing this week beats a bigger one with seven weeks to go.</li>
      </ol>

      <h2 id="privacy">Privacy</h2>
      <p>Reports are parsed in your browser and kept in this browser&rsquo;s IndexedDB. Signing in (optional) syncs each seller&rsquo;s case tracker, claim windows, snapshots and reports under {1.5} MB to your account; larger reports stay on the device. Export or delete everything from the account menu.</p>
    </section>
  )
}
