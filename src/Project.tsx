import { lazy, Suspense, useEffect, useState } from 'react'
import { findingsCsv, snapshot } from './engine/cases.ts'
import type { Analysis } from './engine/recon.ts'
import type { CaseState, Policy } from './engine/types.ts'
import { monthLabel, useAnalysis, useDefaults, useProject } from './projectData.ts'
import { uuid, type Dataset, type Project } from './store.ts'
import { download, Empty, fmtDay, fmtMoney, go, isTyping, Link, Modal, SyntheticBadge, toast } from './ui.tsx'
import { Countdown } from './Landing.tsx'

const Worklist = lazy(() => import('./Worklist.tsx'))
const Tabs = lazy(() => import('./Tabs.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['worklist', 'Case worklist'], ['calendar', 'Deadlines'], ['skus', 'SKU ledger'], ['fees', 'Fee audit'], ['history', 'History'], ['data', 'Reports & settings']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: Project
  ds: Dataset
  a: Analysis
  setCase(id: string, p: Partial<CaseState>): void
  setPolicy(p: Partial<Policy>): void
  update(p: Partial<Project>): void
}

export function saveSnapshot(project: Project, a: Analysis, update: (p: Partial<Project>) => void) {
  const period = a.asOf.slice(0, 7)
  const s = snapshot(a, project.cases, uuid(), period, monthLabel(period))
  const prev = project.snapshots.find(x => x.period === period)
  // One snapshot per month: saving again replaces this month's, keeping its id so the cloud copy is updated in place.
  update({ snapshots: [...project.snapshots.filter(x => x.period !== period), prev ? { ...s, id: prev.id } : s].sort((x, y) => x.period.localeCompare(y.period)) })
  toast(`${prev ? 'Updated' : 'Saved'} the ${s.label} snapshot`, { tone: 'ok' })
}

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds, update, setPolicy, setCase } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'worklist') as Tab
  const a = useAnalysis(ds, project?.policy)
  const defaults = useDefaults()
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name} · FBA Recover` }, [project?.name])
  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'worklist' ? '' : '/' + t}`, { keepScroll: true })
  const exportCsv = () => { if (project && a) download(`${project.name.replace(/\W+/g, '-').toLowerCase()}-findings-${a.asOf}.csv`, findingsCsv(a.findings, project.cases, a.asOf)) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || !project || !a) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { setTab(TABS[n - 1][0]); return }
      if (e.key === 's') saveSnapshot(project, a, update)
      else if (e.key === 'p') go(`/app/p/${id}/report`)
      else if (e.key === 'e') exportCsv()
      else if (e.key === '?') setHelp(true)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Reconciling the ledger</div>
  if (!project || !ds) return (
    <section className="page narrow"><Empty title="Seller not found">
      <p className="muted">It may have been deleted, or it lives on another device. Sign in to sync, or go back to your sellers.</p>
      <Link href="/app" className="btn primary">Your sellers</Link>
    </Empty></section>
  )
  const hasData = ds.ledger.length + ds.txns.length + ds.inbound.length + ds.reimbursements.length > 0
  const t = a!.totals
  const recovered = Object.values(project.cases).reduce((s, c) => s + (c.status === 'reimbursed' ? c.recovered ?? 0 : 0), 0)
  const props: TabProps = { project, ds, a: a!, setCase: (fid, p) => void setCase(fid, p), setPolicy: p => void setPolicy(p), update: p => void update(p) }

  return (
    <section className="page project">
      <nav className="crumbs" aria-label="Breadcrumb"><Link href="/app">Sellers</Link><span aria-hidden="true">›</span><span>{project.name}</span></nav>
      <div className="proj-head">
        <div>
          <h1>{project.name} {project.sampleId && <SyntheticBadge />}</h1>
          <p className="muted small">As of {fmtDay(a!.asOf)} · {project.imports.length} report{project.imports.length === 1 ? '' : 's'} imported{defaults.table ? ` · fees: ${defaults.table.name}` : ''}</p>
        </div>
        <div className="row gap-sm wrap">
          <button type="button" className="btn outline sm" onClick={() => saveSnapshot(project, a!, update)} disabled={!hasData}>Save month snapshot</button>
          <button type="button" className="btn outline sm" onClick={exportCsv} disabled={!a!.findings.length}>Export CSV</button>
          <Link href={`/app/p/${id}/report`} className="btn primary sm">Monthly report</Link>
        </div>
      </div>

      {hasData && (
        <div className="kpis">
          <div className="kpi leak"><small>Claimable now</small><b>{fmtMoney(t.open)}</b><p>{t.count} findings open or opening soon</p></div>
          <div className="kpi"><small>Next window closes</small>{t.nextDeadline ? <><b className="kpi-cd"><Countdown deadline={t.nextDeadline} /></b><p>{fmtDay(t.nextDeadline)}</p></> : <><b>—</b><p>Nothing open</p></>}</div>
          <div className="kpi"><small>Opens later</small><b>{fmtMoney(t.upcoming)}</b><p>Refunds still inside Amazon&rsquo;s own window</p></div>
          <div className="kpi"><small>Recovered (logged)</small><b className="good-text">{fmtMoney(recovered)}</b><p>{fmtMoney(t.missed)} missed: window closed</p></div>
        </div>
      )}

      <nav className="tabs" aria-label="Seller sections">
        {TABS.map(([k, l], i) => <Link key={k} href={`/app/p/${id}${k === 'worklist' ? '' : '/' + k}`} aria-current={tab === k ? 'page' : undefined} title={`${l} (${i + 1})`}>{l}</Link>)}
      </nav>

      <Suspense fallback={<div className="boot" role="status"><span className="spinner" /> Loading</div>}>
        {!hasData && tab !== 'data' ? (
          <Empty title="No reports yet">
            <p className="muted">Import the Inventory Ledger and Reimbursements report to start. Settlement, returns, Fee Preview and Shipment items unlock the other checks.</p>
            <div className="row gap center-x"><button type="button" className="btn primary" onClick={() => setTab('data')}>Import reports</button><Link href="/docs" className="btn ghost">How to download them</Link></div>
          </Empty>
        ) : tab === 'data' ? <DataTab {...props} /> : tab === 'worklist' || tab === 'calendar' ? <Worklist {...props} view={tab} /> : <Tabs {...props} tab={tab} />}
      </Suspense>

      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>6</kbd></dt><dd>Switch sections</dd></div>
          <div><dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Next / previous finding</dd></div>
          <div><dt><kbd>C</kbd></dt><dd>Copy the case text of the focused finding</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save this month&rsquo;s snapshot</dd></div>
          <div><dt><kbd>E</kbd></dt><dd>Export findings as CSV</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable monthly report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
        </dl>
      </Modal>
    </section>
  )
}
