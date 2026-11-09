import { useEffect, useMemo, useState } from 'react'
import { analyze, findingState, today } from './engine/recon.ts'
import { KIND_LABEL } from './engine/types.ts'
import { sampleData } from './projectData.ts'
import { Sankey } from './Sankey.tsx'
import { fmtDay, fmtMoney, fmtN, Link } from './ui.tsx'

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

export function Countdown({ deadline }: { deadline: string }) {
  const now = useNow()
  // Claim windows close at the end of the deadline day.
  const left = Math.max(0, Date.parse(deadline + 'T23:59:59Z') - now)
  const d = Math.floor(left / 864e5), h = Math.floor(left / 36e5) % 24, m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return <span className="countdown" role="timer" aria-label={`${d} days ${h} hours left`}><b>{d}</b>d <b>{p(h)}</b>:<b>{p(m)}</b>:<b>{p(s)}</b></span>
}

function Hero() {
  const ds = useMemo(() => sampleData('hearth')!, [])
  const a = useMemo(() => analyze(ds, { asOf: today() }), [ds])
  const skus = a.flows.filter(f => f.lost + f.damaged > 0).slice(0, 5)
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 600px)').matches)
  useEffect(() => {
    const mq = matchMedia('(max-width: 600px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    if (paused || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setI(x => (x + 1) % skus.length), 6000)
    return () => clearInterval(t)
  }, [paused, skus.length])
  const f = skus[i]
  const open = a.findings.filter(x => (x.kind === 'lost' || x.kind === 'damaged') && x.fnsku === f.fnsku && findingState(x, a.asOf) === 'open')
  const skuOpen = open.reduce((s, x) => s + x.amount, 0)
  const next = open.map(x => x.deadline).sort()[0]
  return (
    <div className="ledger-card" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="ledger-bar">
        <span className="ledger-title">Inventory leak · <b>{f.sku}</b></span>
        <span className="badge synthetic">Synthetic seller</span>
      </div>
      <div className="sku-chips" role="tablist" aria-label="Choose a SKU">
        {skus.map((s, k) => <button key={s.fnsku} type="button" role="tab" aria-selected={k === i} className={k === i ? 'on' : ''} onClick={() => { setI(k); setPaused(true) }}>{s.sku.replace(/^HL-/, '')}</button>)}
      </div>
      <div className="ledger-body">
        {narrow ? <Sankey key={f.fnsku} f={f} width={380} height={300} compact /> : <Sankey key={f.fnsku} f={f} width={640} height={290} />}
      </div>
      <div className="ledger-foot">
        <div><small>Unreimbursed on this SKU</small><b className="leak-text">{fmtMoney(skuOpen)}</b></div>
        <div><small>{next ? 'Next window closes' : 'No open window'}</small>{next ? <Countdown deadline={next} /> : <b>—</b>}</div>
        <div><small>Whole account, open now</small><b>{fmtMoney(a.totals.open)}</b></div>
      </div>
      <p className="ledger-note">Running the real reconciliation engine on a synthetic Inventory Ledger: {fmtN(ds.ledger.length)} events, {fmtN(ds.reimbursements.length)} reimbursements.</p>
    </div>
  )
}

const CHECKS: [string, string, string][] = [
  ['Lost and damaged, never paid', 'Per-FNSKU ledger reconciliation. Found adjustments cancel the oldest losses, reimbursements are matched by date, what is left gets a claim and a 60-day clock.', 'lost'],
  ['Refunded, never returned', 'Every refund in your settlement checked against FBA customer returns and return reimbursements. Claims open when Amazon’s own window passes.', 'return'],
  ['Inbound shortfalls', 'Units shipped against units received, per shipment, net of Lost_Inbound reimbursements. Still-receiving shipments wait.', 'inbound'],
  ['Paid below value', 'Reimbursements compared with your unit cost. The 50%-of-value payouts sellers keep spotting on lost-in-warehouse claims.', 'underpaid'],
  ['Fee overcharges', 'Charged fulfilment fee per order line against a dated, editable US fee table. Catches re-measurements into a bigger size tier and dates the change.', 'fee'],
  ['Fees on units not received', 'Placement fees billed on the whole shipment while units are still in transit, and fulfilment fees charged before a SKU was ever received.', 'fee-transit'],
]

export function Landing() {
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <div className="eyebrow on-dark">For FBA sellers and their bookkeepers</div>
            <h1>Find the money Amazon owes you <span className="hl">before the window closes.</span></h1>
            <p className="lede">FBA Recover reconciles your Inventory Ledger, reimbursements, returns, inbound shipments and fees. It finds lost units nobody paid for, refunds that never came back and fees on the wrong size tier, then drafts the case text with the FNSKU, dates and ledger references.</p>
            <div className="hero-ctas">
              <Link href="/app?sample=hearth" className="btn primary lg">Try the sample seller</Link>
              <Link href="/app" className="btn on-dark lg">Import your reports</Link>
            </div>
            <p className="hero-note">No upload to a server, no 15 to 25% recovery fee. Reports are parsed in your browser.</p>
          </div>
          <Hero />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Claim windows are short and nobody reminds you</h2>
          <p>What sellers keep saying in r/AmazonFBA and r/FulfillmentByAmazon (paraphrased):</p>
        </div>
        <div className="voices">
          <blockquote><p>&ldquo;Q4 reminder: FBA reimbursement windows are short, and nobody tells you when they close.&rdquo;</p><cite>r/AmazonFBA</cite></blockquote>
          <blockquote><p>&ldquo;Lost in warehouse reimbursements are paying about half of what the item is worth.&rdquo;</p><cite>r/AmazonFBA</cite></blockquote>
          <blockquote><p>&ldquo;We were billed FBA fees on 43 units that were still in transit.&rdquo;</p><cite>r/AmazonFBA</cite></blockquote>
          <blockquote><p>&ldquo;How do you actually reconcile inventory differences with FBA? The ledger never adds up.&rdquo;</p><cite>r/FulfillmentByAmazon</cite></blockquote>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Six checks, one worklist</h2>
          <p>Each finding gets a dollar estimate, the date its claim window closes, and copy-ready case text. The worklist ranks by dollars per day left.</p>
        </div>
        <div className="features">
          {CHECKS.map(([t, d, k]) => (
            <article key={t} className="feature"><span className={`kind-dot k-${k}`} aria-hidden="true" /><h3>{t}</h3><p>{d}</p><small className="muted">{KIND_LABEL[k as keyof typeof KIND_LABEL]}</small></article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="steps">
          <div><b>1</b><h3>Download six reports</h3><p>Inventory Ledger, Reimbursements, Customer returns, Fee Preview, Settlement and Shipment items. <Link href="/docs">Exact clicks</Link>.</p></div>
          <div><b>2</b><h3>Drop them in</h3><p>Each file is detected, mapped and validated with line numbers. Overlapping exports do not double count.</p></div>
          <div><b>3</b><h3>File, track, report</h3><p>Copy the case text, log the case ID, mark it reimbursed. Monthly snapshots show found against recovered.</p></div>
        </div>
        <p className="muted small" style={{ marginTop: 18 }}>Policy windows and the fee table are dated estimates as of {fmtDay(today())}. Both are editable in Settings.</p>
      </section>

      <section className="cta-band">
        <div className="cta-inner">
          <div><h2>Start with the synthetic seller</h2><p>140 lost units, a mis-measured cutting board and fees on 43 units still in transit.</p></div>
          <Link href="/app?sample=hearth" className="btn primary lg">Open the sample</Link>
        </div>
      </section>
    </>
  )
}
