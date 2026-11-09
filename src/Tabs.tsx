import { useMemo, useState } from 'react'
import { compareSnapshots } from './engine/cases.ts'
import { fulfilmentFee, sizeTier, TIER_LABEL, type Dims } from './engine/fees.ts'
import { findingState } from './engine/recon.ts'
import type { TabProps } from './Project.tsx'
import { saveSnapshot } from './Project.tsx'
import { useDefaults } from './projectData.ts'
import { Sankey } from './Sankey.tsx'
import { deleteSnapshotCloud } from './sync.ts'
import { Empty, fmtMoney, fmtN, Link, toast } from './ui.tsx'

export default function Tabs(p: TabProps & { tab: 'skus' | 'fees' | 'history' }) {
  if (p.tab === 'skus') return <Skus {...p} />
  if (p.tab === 'fees') return <Fees {...p} />
  return <History {...p} />
}

function Skus({ a }: TabProps) {
  const [sel, setSel] = useState(a.flows[0]?.fnsku)
  const f = a.flows.find(x => x.fnsku === sel) ?? a.flows[0]
  if (!f) return <Empty title="No Inventory Ledger yet"><p className="muted">Import the Inventory Ledger (detailed view) to reconcile units per FNSKU.</p></Empty>
  const open = a.findings.filter(x => x.fnsku === f.fnsku && findingState(x, a.asOf) === 'open')
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2><span className="mono">{f.sku}</span> <span className="muted small">{f.fnsku}{f.title ? ` · ${f.title}` : ''}</span></h2>
          <span className="small">Open on this SKU: <b className="leak-text">{fmtMoney(open.reduce((s, x) => s + x.amount, 0))}</b></span>
        </div>
        <div className="sankey-wrap"><Sankey f={f} width={900} height={320} /></div>
        <p className="muted small">Ledger view over the imported period. Lost &amp; damaged counts adjustments with Amazon-responsibility reason codes (M, 5, 6, 7, E, Q). Found (F) cancels the oldest open losses; reimbursements are matched to the nearest loss within {a.findings.length ? 'the match window' : 'the window'} set in Reports &amp; settings.</p>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Per-FNSKU reconciliation</h2><span className="muted small">Click a row to see its flow</span></div>
        <div className="table-wrap">
          <table className="sku-table">
            <thead><tr><th>SKU</th><th className="num">Received</th><th className="num">Sold</th><th className="num">Returned</th><th className="num">Lost</th><th className="num">Damaged</th><th className="num">Found</th><th className="num">Reimbursed</th><th className="num">Unreimbursed</th><th className="num">Value</th></tr></thead>
            <tbody>{a.flows.map(x => (
              <tr key={x.fnsku} className={x.fnsku === f.fnsku ? 'sel' : ''} onClick={() => setSel(x.fnsku)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setSel(x.fnsku) }} aria-selected={x.fnsku === f.fnsku}>
                <th scope="row"><span className="mono">{x.sku}</span><small className="muted block">{x.title || x.fnsku}</small></th>
                <td className="num">{fmtN(x.received)}</td><td className="num">{fmtN(x.sold)}</td><td className="num">{fmtN(x.returned)}</td>
                <td className="num">{fmtN(x.lost)}</td><td className="num">{fmtN(x.damaged)}</td><td className="num">{fmtN(x.found)}</td><td className="num">{fmtN(x.reimbursedUnits)}</td>
                <td className={`num${x.unreimbursed - x.expiredUnits ? ' leak-text strong' : ''}`}>{fmtN(x.unreimbursed)}{x.expiredUnits ? <small className="muted block">{x.expiredUnits} closed</small> : null}</td>
                <td className="num">{fmtMoney((x.unreimbursed - x.expiredUnits) * x.unitValue)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Fees({ ds, a }: TabProps) {
  const { table } = useDefaults()
  const rows = useMemo(() => ds.fees.map(fp => {
    const cost = ds.costs.find(c => c.sku === fp.sku)
    const amz: Dims = { longest: fp.longest, median: fp.median, shortest: fp.shortest, weightLb: fp.weightLb }
    const mine: Dims | null = cost?.longest && cost.weightLb ? { longest: cost.longest, median: cost.median ?? 0, shortest: cost.shortest ?? 0, weightLb: cost.weightLb } : null
    const charged = ds.txns.filter(t => t.sku === fp.sku && /order/i.test(t.type) && t.fbaFee > 0 && t.qty > 0).map(t => t.fbaFee / t.qty).sort((x, y) => x - y)
    const med = charged.length ? charged[charged.length >> 1] : NaN
    const expAmz = fulfilmentFee(amz, fp.price || 20, a.asOf, table)
    const expMine = mine ? fulfilmentFee(mine, fp.price || 20, a.asOf, table) : null
    const finding = a.findings.find(f => f.kind === 'fee' && f.sku === fp.sku)
    return { fp, amz, mine, med, expAmz, expMine, finding, tierMismatch: mine ? sizeTier(mine) !== sizeTier(amz) : false }
  }), [ds, a, table])
  const dims = (d: Dims) => `${d.longest.toFixed(1)}×${d.median.toFixed(1)}×${d.shortest.toFixed(1)} in · ${d.weightLb.toFixed(2)} lb`
  if (!rows.length) return <Empty title="No Fee Preview yet"><p className="muted">Import the Fee Preview report (and a cost file with your own measured dimensions) to audit fulfilment fees. <Link href="/docs#fees">How</Link></p></Empty>
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Fulfilment fee audit</h2><span className="muted small">{table.name} · effective {table.effective} · +{table.surchargePct}% from {table.surchargeFrom}. <Link href="/settings#fees">Edit the table</Link></span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Amazon&rsquo;s measurements</th><th>Your measurements</th><th className="num">Expected fee</th><th className="num">Charged (median)</th><th className="num">Open overcharge</th></tr></thead>
            <tbody>{rows.map(r => {
              const exp = r.expMine ?? r.expAmz
              const over = r.med - exp.fee
              return (
                <tr key={r.fp.sku} className={r.tierMismatch ? 'flag' : ''}>
                  <th scope="row"><span className="mono">{r.fp.sku}</span><small className="muted block">{r.fp.title}</small></th>
                  <td>{dims(r.amz)}<small className={`block ${r.tierMismatch ? 'leak-text strong' : 'muted'}`}>{TIER_LABEL[r.expAmz.tier]} · {fmtMoney(r.expAmz.fee, 2)}</small></td>
                  <td>{r.mine ? <>{dims(r.mine)}<small className="muted block">{TIER_LABEL[r.expMine!.tier]} · {fmtMoney(r.expMine!.fee, 2)}</small></> : <span className="muted small">Add dimensions to your cost file</span>}</td>
                  <td className="num">{fmtMoney(exp.fee, 2)}<small className="muted block">{exp.shippingLb.toFixed(2)} lb billed</small></td>
                  <td className={`num${over > 0.05 ? ' leak-text strong' : ''}`}>{Number.isFinite(r.med) ? fmtMoney(r.med, 2) : '—'}</td>
                  <td className="num">{r.finding ? <b className="leak-text">{fmtMoney(r.finding.amount, 2)}</b> : <span className="muted">—</span>}</td>
                </tr>
              )
            })}</tbody>
          </table>
        </div>
        <p className="muted small">A highlighted row means Amazon&rsquo;s dimensions put the item in a bigger size tier than yours. Expected fees use the item price band (under $10, $10 to $50, over $50) and shipping weight: unit weight for small standard, otherwise the greater of unit and dimensional weight (L × W × H ÷ 139).</p>
      </div>
      {a.findings.filter(f => f.kind === 'fee-transit').length > 0 && (
        <div className="panel">
          <h2>Fees on units not received</h2>
          <ul className="plain">{a.findings.filter(f => f.kind === 'fee-transit').map(f => <li key={f.id}><b>{fmtMoney(f.amount, 2)}</b> · {f.detail}</li>)}</ul>
        </div>
      )}
    </>
  )
}

function History({ project, a, update }: TabProps) {
  const snaps = [...project.snapshots].sort((x, y) => x.period.localeCompare(y.period))
  const [ai, setAi] = useState(Math.max(0, snaps.length - 2))
  const [bi, setBi] = useState(snaps.length - 1)
  if (!snaps.length) return (
    <Empty title="No snapshots yet">
      <p className="muted">Save a snapshot each month (or press <kbd>S</kbd>) to track found against recovered dollars over time.</p>
      <button type="button" className="btn primary" onClick={() => saveSnapshot(project, a, update)}>Save {a.asOf.slice(0, 7)} snapshot</button>
    </Empty>
  )
  const A = snaps[Math.min(ai, snaps.length - 1)], B = snaps[Math.min(Math.max(bi, 0), snaps.length - 1)]
  const max = Math.max(1, ...snaps.flatMap(s => [s.found, s.recovered]))
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Found vs recovered by month</h2><div className="legend"><span><i style={{ background: 'var(--leak)' }} />Found (open + upcoming)</span><span><i style={{ background: 'var(--good)' }} />Recovered</span></div></div>
        <div className="hist2" role="img" aria-label={snaps.map(s => `${s.label}: found ${fmtMoney(s.found)}, recovered ${fmtMoney(s.recovered)}`).join('; ')}>
          {snaps.map(s => (
            <div key={s.id} className="hcol">
              <div className="hbars"><span className="f" style={{ height: `${(s.found / max) * 100}%` }} title={`Found ${fmtMoney(s.found)}`} /><span className="r" style={{ height: `${(s.recovered / max) * 100}%` }} title={`Recovered ${fmtMoney(s.recovered)}`} /></div>
              <small>{s.label.replace(/ \d{4}$/, '')}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Compare</h2>
          <div className="row gap-sm wrap">
            <select value={ai} onChange={e => setAi(Number(e.target.value))} aria-label="Earlier snapshot">{snaps.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}</select>
            <span aria-hidden="true">→</span>
            <select value={bi} onChange={e => setBi(Number(e.target.value))} aria-label="Later snapshot">{snaps.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}</select>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Metric</th><th className="num">{A.label}</th><th className="num">{B.label}</th><th className="num">Change</th></tr></thead>
            <tbody>{compareSnapshots(A, B).map(d => {
              const isCount = d.key === 'count'
              const ch = d.after - d.before
              const good = d.key === 'recovered' ? ch > 0 : ch < 0
              return <tr key={d.key}><th scope="row">{d.label}</th><td className="num">{isCount ? d.before : fmtMoney(d.before)}</td><td className="num">{isCount ? d.after : fmtMoney(d.after)}</td><td className={`num ${ch ? good ? 'diff-down' : 'diff-up' : 'muted'}`}>{ch > 0 ? '+' : ch < 0 ? '−' : ''}{isCount ? Math.abs(ch) : fmtMoney(Math.abs(ch))}</td></tr>
            })}</tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <h2>Snapshots</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Month</th><th className="num">Found</th><th className="num">Recovered</th><th className="num">Missed</th><th>Saved</th><th /></tr></thead>
          <tbody>{snaps.map(s => <tr key={s.id}><th scope="row">{s.label}</th><td className="num">{fmtMoney(s.found)}</td><td className="num">{fmtMoney(s.recovered)}</td><td className="num">{fmtMoney(s.missed)}</td><td className="small">{s.at ? new Date(s.at).toLocaleDateString() : '—'}</td>
            <td className="num"><button type="button" className="btn danger-ghost sm" onClick={() => {
              const before = project.snapshots
              update({ snapshots: before.filter(x => x.id !== s.id) })
              void deleteSnapshotCloud(s.id)
              toast(`Deleted the ${s.label} snapshot`, { undo: () => update({ snapshots: before }) })
            }}>Delete</button></td></tr>)}</tbody>
        </table></div>
      </div>
    </>
  )
}
