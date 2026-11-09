import { useEffect } from 'react'
import { daysBetween, findingState } from './engine/recon.ts'
import { KIND_LABEL, type FindingKind } from './engine/types.ts'
import { monthLabel, useAnalysis, useDefaults, useProject } from './projectData.ts'
import { fmtDay, fmtMoney, Link, SyntheticBadge } from './ui.tsx'

export default function Report({ id }: { id: string }) {
  const { loading, project, ds } = useProject(id)
  const a = useAnalysis(ds, project?.policy)
  const { sellerName, table } = useDefaults()
  useEffect(() => { if (project) document.title = `Recovery report · ${project.name}` }, [project?.name])
  if (loading || !a) return <div className="boot" role="status"><span className="spinner" /> Building the report</div>
  if (!project) return <div className="report"><p>Seller not found. <Link href="/app">Back to sellers</Link></p></div>

  const month = a.asOf.slice(0, 7)
  const cases = Object.entries(project.cases)
  const thisMonth = (t: number) => new Date(t).toISOString().slice(0, 7) === month
  const recoveredMonth = cases.filter(([, c]) => c.status === 'reimbursed' && thisMonth(c.updatedAt)).reduce((s, [, c]) => s + (c.recovered ?? 0), 0)
  const recoveredAll = cases.filter(([, c]) => c.status === 'reimbursed').reduce((s, [, c]) => s + (c.recovered ?? 0), 0)
  const open = a.findings.filter(f => findingState(f, a.asOf) === 'open')
  const due30 = open.filter(f => daysBetween(a.asOf, f.deadline) <= 30)
  const filed = cases.filter(([, c]) => c.status === 'filed')
  const kinds = Object.entries(a.totals.byKind) as [FindingKind, number][]
  const snaps = [...project.snapshots].sort((x, y) => x.period.localeCompare(y.period)).slice(-6)

  return (
    <article className="report">
      <div className="report-actions">
        <Link href={`/app/p/${id}`} className="btn ghost sm">Back</Link>
        <button type="button" className="btn primary sm" onClick={() => print()}>Print or save as PDF</button>
      </div>
      <header className="report-head">
        <div className="eyebrow">FBA recovery report · {monthLabel(month)}</div>
        <h1>{sellerName || project.name} {project.sampleId && <SyntheticBadge />}</h1>
        <p className="muted small">As of {fmtDay(a.asOf)}. Estimates use unit cost where provided, otherwise average sale price. Claim windows: lost/damaged {project.policy.warehouseDays} days, returns {project.policy.returnOpenDays} to {project.policy.returnCloseDays} days after refund, inbound {project.policy.inboundDays} days, fees {project.policy.feeDays} days. Fees: {table.name}.</p>
      </header>

      <div className="kpis">
        <div className="kpi leak"><small>Claimable now</small><b>{fmtMoney(a.totals.open)}</b><p>{open.length} findings</p></div>
        <div className="kpi"><small>Due in 30 days</small><b>{fmtMoney(due30.reduce((s, f) => s + f.amount, 0))}</b><p>{due30.length} claims</p></div>
        <div className="kpi"><small>Recovered this month</small><b>{fmtMoney(recoveredMonth)}</b><p>{fmtMoney(recoveredAll)} all time (logged)</p></div>
        <div className="kpi"><small>Missed</small><b>{fmtMoney(a.totals.missed)}</b><p>Window closed before filing</p></div>
      </div>

      <h2>By type</h2>
      <table>
        <thead><tr><th>Type</th><th className="num">Findings</th><th className="num">Open + upcoming</th></tr></thead>
        <tbody>{kinds.sort((x, y) => y[1] - x[1]).map(([k, v]) => <tr key={k}><th scope="row">{KIND_LABEL[k]}</th><td className="num">{a.findings.filter(f => f.kind === k && findingState(f, a.asOf) !== 'expired').length}</td><td className="num">{fmtMoney(v, 2)}</td></tr>)}</tbody>
      </table>

      <h2>File these first</h2>
      <table>
        <thead><tr><th>#</th><th>Type</th><th>SKU / FNSKU</th><th>Event</th><th className="num">Units</th><th className="num">Amount</th><th>Deadline</th><th>Status</th></tr></thead>
        <tbody>{open.slice(0, 25).map((f, i) => (
          <tr key={f.id}><td>{i + 1}</td><td>{KIND_LABEL[f.kind]}</td><td><span className="mono">{f.sku}</span>{f.fnsku && <small className="muted block">{f.fnsku}</small>}</td><td className="small">{fmtDay(f.eventDate)}{f.refs[0] ? <small className="muted block">{f.refs[0]}</small> : null}</td><td className="num">{f.units}</td><td className="num">{fmtMoney(f.amount, 2)}</td><td className="small">{fmtDay(f.deadline)}<small className="muted block">{daysBetween(a.asOf, f.deadline)} days</small></td><td className="small">{project.cases[f.id]?.status ?? 'not started'}{project.cases[f.id]?.caseId ? ` #${project.cases[f.id].caseId}` : ''}</td></tr>
        ))}</tbody>
      </table>
      {open.length > 25 && <p className="muted small">{open.length - 25} more in the worklist and the CSV export.</p>}

      <h2>Cases awaiting Amazon</h2>
      {filed.length ? <ul className="plain">{filed.map(([fid, c]) => { const f = a.findings.find(x => x.id === fid); return <li key={fid}>{f ? `${KIND_LABEL[f.kind]} · ${f.sku} · ${fmtMoney(f.amount, 2)}` : fid}{c.caseId ? ` · case ${c.caseId}` : ''} · updated {new Date(c.updatedAt).toLocaleDateString()}</li> })}</ul> : <p className="muted small">None filed.</p>}

      {snaps.length > 0 && <>
        <h2>Trend</h2>
        <table>
          <thead><tr><th>Month</th><th className="num">Found</th><th className="num">Recovered</th><th className="num">Missed</th></tr></thead>
          <tbody>{snaps.map(s => <tr key={s.id}><th scope="row">{s.label}</th><td className="num">{fmtMoney(s.found)}</td><td className="num">{fmtMoney(s.recovered)}</td><td className="num">{fmtMoney(s.missed)}</td></tr>)}</tbody>
        </table>
      </>}
      <p className="muted tiny report-foot">Prepared with FBA Recover, an independent tool not affiliated with Amazon. Amounts are estimates; Amazon decides reimbursement values. {project.sampleId ? 'Synthetic sample data.' : ''}</p>
    </article>
  )
}
