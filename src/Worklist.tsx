import { useEffect, useMemo, useState } from 'react'
import { caseText } from './engine/cases.ts'
import { addDays, daysBetween, findingState } from './engine/recon.ts'
import { KIND_LABEL, type CaseStatus, type Finding, type FindingKind } from './engine/types.ts'
import type { TabProps } from './Project.tsx'
import { useDefaults } from './projectData.ts'
import { CopyButton, Empty, fmtDay, fmtMoney, isTyping, toast } from './ui.tsx'

const STATUSES: [CaseStatus, string][] = [['open', 'Not started'], ['draft', 'Draft'], ['filed', 'Filed'], ['reimbursed', 'Reimbursed'], ['denied', 'Denied']]
type StateFilter = 'open' | 'upcoming' | 'expired' | 'all'

export function DaysLeft({ f, asOf }: { f: Finding; asOf: string }) {
  const st = findingState(f, asOf)
  if (st === 'upcoming') return <span className="due later">Opens {fmtDay(f.opens)}</span>
  const d = daysBetween(asOf, f.deadline)
  if (st === 'expired') return <span className="due gone">Closed {fmtDay(f.deadline)}</span>
  return <span className={`due${d <= 7 ? ' urgent' : d <= 21 ? ' soon' : ''}`}>{d === 0 ? 'Closes today' : `${d} day${d === 1 ? '' : 's'} left`}<small>{fmtDay(f.deadline)}</small></span>
}

export const KindChip = ({ k }: { k: FindingKind }) => <span className={`kind k-${k}`}>{KIND_LABEL[k]}</span>

function FindingRow({ f, i, p, open, onToggle, seller }: { f: Finding; i: number; p: TabProps; open: boolean; onToggle(): void; seller: string }) {
  const c = p.project.cases[f.id]
  const status = c?.status ?? 'open'
  const text = useMemo(() => open ? caseText(f, seller || p.project.name) : '', [open, f, seller, p.project.name])
  return (
    <article className={`finding s-${status}${open ? ' open' : ''}`} data-fid={f.id} tabIndex={-1}>
      <div className="finding-main">
        <span className="finding-rank" aria-hidden="true">{i + 1}</span>
        <div className="finding-what">
          <div className="row gap-sm wrap"><KindChip k={f.kind} />{f.confidence !== 'high' && <span className={`conf ${f.confidence}`} title="How sure the engine is">{f.confidence} confidence</span>}</div>
          <h3><span className="mono">{f.sku}</span>{f.title && <span className="muted"> · {f.title}</span>}</h3>
          <p>{f.detail}</p>
        </div>
        <div className="finding-money">
          <b>{fmtMoney(f.amount, 2)}</b>
          <small>{f.units} unit{f.units === 1 ? '' : 's'} × {fmtMoney(f.unitValue, 2)}</small>
          <DaysLeft f={f} asOf={p.a.asOf} />
        </div>
        <div className="finding-actions">
          <label className="sr-only" htmlFor={`st-${f.id}`}>Case status</label>
          <select id={`st-${f.id}`} className={`status-select st-${status}`} value={status} onChange={e => {
            const s = e.target.value as CaseStatus
            const prev = c
            p.setCase(f.id, { status: s, ...(s === 'reimbursed' && c?.recovered === undefined ? { recovered: f.amount } : {}) })
            toast(`Marked ${STATUSES.find(x => x[0] === s)![1].toLowerCase()}`, { undo: () => p.update({ cases: prev ? { ...p.project.cases, [f.id]: prev } : Object.fromEntries(Object.entries(p.project.cases).filter(([k]) => k !== f.id)) }) })
          }}>
            {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button type="button" className="btn ghost sm" aria-expanded={open} onClick={onToggle}>{open ? 'Hide case' : 'Case text'}</button>
        </div>
      </div>
      {open && (
        <div className="finding-case">
          <div className="case-text">
            <div className="code-head"><span>Seller Central › Help › Get support › FBA inventory issue</span><CopyButton text={text} label="Copy case text" /></div>
            <pre>{text}</pre>
          </div>
          <div className="case-side">
            <label className="field"><span>Case ID</span><input defaultValue={c?.caseId ?? ''} placeholder="e.g. 17384920561" inputMode="numeric" onBlur={e => { const v = e.target.value.trim(); if (v !== (c?.caseId ?? '')) p.setCase(f.id, { caseId: v || undefined, ...(v && status === 'open' ? { status: 'filed' } : {}) }) }} /></label>
            {(status === 'reimbursed' || status === 'denied') && <label className="field"><span>Amount recovered ($)</span><input type="number" min="0" step="0.01" defaultValue={c?.recovered ?? ''} onBlur={e => p.setCase(f.id, { recovered: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>}
            <label className="field"><span>Note</span><textarea rows={3} defaultValue={c?.note ?? ''} placeholder="What support said, follow-up date" onBlur={e => { if (e.target.value !== (c?.note ?? '')) p.setCase(f.id, { note: e.target.value || undefined }) }} /></label>
            <p className="muted tiny">Policy: {f.policy}</p>
            <p className="muted tiny">Evidence: source rows {f.lines.slice(0, 10).join(', ')}{f.lines.length > 10 ? '…' : ''}{f.refs.length ? ` · refs ${f.refs.join(', ')}` : ''}</p>
          </div>
        </div>
      )}
    </article>
  )
}

export default function Worklist(p: TabProps & { view: 'worklist' | 'calendar' }) {
  const { a, project } = p
  const seller = useDefaults().sellerName
  const [state, setState] = useState<StateFilter>('open')
  const [kind, setKind] = useState<FindingKind | ''>('')
  const [status, setStatus] = useState<CaseStatus | ''>('')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [day, setDay] = useState<string | null>(null)

  const list = useMemo(() => a.findings.filter(f =>
    (state === 'all' || findingState(f, a.asOf) === state)
    && (!kind || f.kind === kind)
    && (!status || (project.cases[f.id]?.status ?? 'open') === status)
    && (!q || `${f.sku} ${f.fnsku} ${f.title} ${f.refs.join(' ')}`.toLowerCase().includes(q.toLowerCase()))
    && (p.view !== 'calendar' || !day || f.deadline === day)), [a, state, kind, status, q, project.cases, day, p.view])
  const counts = useMemo(() => ({ open: 0, upcoming: 0, expired: 0, all: a.findings.length, ...Object.fromEntries((['open', 'upcoming', 'expired'] as const).map(s => [s, a.findings.filter(f => findingState(f, a.asOf) === s).length])) }), [a])
  const sum = list.reduce((s, f) => s + f.amount, 0)

  // j / k move between findings, c copies the focused finding's case text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const els = [...document.querySelectorAll<HTMLElement>('.finding')]
      const cur = els.findIndex(el => el.contains(document.activeElement))
      if (e.key === 'j' || e.key === 'k') {
        const next = els[Math.min(els.length - 1, Math.max(0, cur + (e.key === 'j' ? 1 : -1)))]
        next?.focus(); next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      } else if (e.key === 'c' && cur >= 0) {
        const f = list.find(x => x.id === els[cur].dataset.fid)
        if (f) void navigator.clipboard.writeText(caseText(f, seller || project.name)).then(() => toast('Case text copied', { tone: 'ok' }), () => toast('Copy failed', { tone: 'error' }))
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [list, seller, project.name])

  return (
    <>
      {a.notes.map(n => <div key={n} className="banner"><span>{n}</span></div>)}
      {p.view === 'calendar' && <Calendar {...p} day={day} setDay={d => { setDay(d); setState(d ? 'all' : 'open') }} />}
      <div className="toolbar worklist-tools">
        <div className="seg-control" role="radiogroup" aria-label="Claim window">
          {([['open', 'Open now'], ['upcoming', 'Opens later'], ['expired', 'Window closed'], ['all', 'All']] as const).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={state === k} className={state === k ? 'on' : ''} onClick={() => setState(k)}>{l} <span className="muted">{counts[k]}</span></button>
          ))}
        </div>
        <select value={kind} onChange={e => setKind(e.target.value as FindingKind | '')} aria-label="Finding type">
          <option value="">All types</option>
          {(Object.keys(KIND_LABEL) as FindingKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value as CaseStatus | '')} aria-label="Case status">
          <option value="">Any status</option>
          {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input type="search" placeholder="SKU, FNSKU, order or shipment" value={q} onChange={e => setQ(e.target.value)} aria-label="Search findings" className="grow" />
      </div>
      <p className="muted small list-sum">{list.length} finding{list.length === 1 ? '' : 's'} · {fmtMoney(sum, 2)}{day ? <> due {fmtDay(day)} <button type="button" className="linkish" onClick={() => { setDay(null); setState('open') }}>clear</button></> : ''}. Ranked by dollars per day left.</p>
      {list.length === 0 ? (
        <Empty title={state === 'open' && !kind && !q ? 'Nothing to claim right now' : 'No findings match'}>
          <p className="muted">{state === 'open' ? 'Check “Opens later” for refunds still inside Amazon’s own window.' : 'Try another filter.'}</p>
        </Empty>
      ) : (
        <div className="finding-list">
          {list.map((f, i) => <FindingRow key={f.id} f={f} i={i} p={p} seller={seller} open={openId === f.id} onToggle={() => setOpenId(openId === f.id ? null : f.id)} />)}
        </div>
      )}
    </>
  )
}

function Calendar({ a, project, day, setDay }: TabProps & { day: string | null; setDay(d: string | null): void }) {
  const byDay = useMemo(() => {
    const m = new Map<string, { amount: number; n: number; filed: number }>()
    for (const f of a.findings) {
      if (findingState(f, a.asOf) === 'expired') continue
      const x = m.get(f.deadline) ?? { amount: 0, n: 0, filed: 0 }
      x.amount += f.amount; x.n++
      if (['filed', 'reimbursed', 'denied'].includes(project.cases[f.id]?.status ?? '')) x.filed++
      m.set(f.deadline, x)
    }
    return m
  }, [a, project.cases])
  const max = Math.max(1, ...[...byDay.values()].map(x => x.amount))
  const months = [0, 1, 2].map(k => { const d = new Date(Date.parse(a.asOf.slice(0, 8) + '01T00:00:00Z')); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7) })
  const buckets = [[0, 7, 'This week'], [8, 30, 'Next 30 days'], [31, 90, 'Within 90 days']] as const
  return (
    <div className="panel">
      <div className="panel-head"><h2>Claim deadlines</h2><span className="muted small">Each day shows the dollars whose window closes that day. Click a day to list them.</span></div>
      <div className="due-buckets">
        {buckets.map(([lo, hi, l]) => {
          const xs = [...byDay.entries()].filter(([d]) => { const n = daysBetween(a.asOf, d); return n >= lo && n <= hi })
          return <div key={l}><small>{l}</small><b>{fmtMoney(xs.reduce((s, [, x]) => s + x.amount, 0))}</b><span className="muted tiny">{xs.reduce((s, [, x]) => s + x.n, 0)} claims</span></div>
        })}
      </div>
      <div className="cal-months">
        {months.map(m => {
          const first = new Date(m + '-01T00:00:00Z')
          const pad = first.getUTCDay()
          const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
          return (
            <div key={m} className="cal">
              <h3>{first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3>
              <div className="cal-grid" role="grid">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="cal-dow" aria-hidden="true">{d}</span>)}
                {Array.from({ length: pad }, (_, i) => <span key={'p' + i} />)}
                {Array.from({ length: days }, (_, i) => {
                  const d = addDays(m + '-01', i)
                  const x = byDay.get(d)
                  const past = d < a.asOf
                  return (
                    <button key={d} type="button" disabled={!x} className={`cal-day${x ? ' has' : ''}${d === a.asOf ? ' today' : ''}${past ? ' past' : ''}${day === d ? ' sel' : ''}${x && x.filed === x.n ? ' done' : ''}`}
                      style={x ? { '--i': `${Math.round(18 + 70 * Math.sqrt(x.amount / max))}%` } as React.CSSProperties : undefined}
                      aria-label={x ? `${fmtDay(d)}: ${x.n} claims, ${fmtMoney(x.amount)}` : fmtDay(d)} onClick={() => setDay(day === d ? null : d)}>
                      <span>{i + 1}</span>{x && <small>{fmtMoney(x.amount)}</small>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
