import { useMemo, useRef, useState } from 'react'
import { autoMap, detect, FIELDS, KINDS, mergeData, ORDER_EXAMPLE, ORDER_NAME, parseCsv, reportCsv, validate, type DateColumn, type DateOrder, type Kind, type Mapping, type Table } from './engine/parse.ts'
import { DEFAULT_POLICY, POLICY_CHECKED, type Dataset, type Policy } from './engine/types.ts'
import type { TabProps } from './Project.tsx'
import { createBlankProject } from './projectData.ts'
import { putData, saveProject, uuid } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, fmtDay, go, Link, toast } from './ui.tsx'

/** `dateOrder` holds the user's day-first / month-first choices by column index. */
interface Pending { id: string; name: string; kind: Kind | null; table: Table; header: number; map: Mapping; dateOrder: Record<number, DateOrder> }


const KEY_OF: Record<Kind, keyof Dataset> = { ledger: 'ledger', reimbursements: 'reimbursements', returns: 'returns', fees: 'fees', txns: 'txns', inbound: 'inbound', costs: 'costs' }

export default function DataTab({ project, ds, update, setPolicy }: TabProps) {
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(ds).length, [ds, project.sampleId])

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    for (const f of [...files]) {
      if (f.size > 80_000_000) { toast(`${f.name} is over 80 MB. Export a shorter date range.`, { tone: 'error' }); continue }
      try {
        const table = parseCsv(await f.text())
        if (table.rows.length < 2) { toast(`${f.name} has no data rows.`, { tone: 'error' }); continue }
        const { kind, header } = detect(table)
        next.push({ id: uuid(), name: f.name, kind, table, header, map: kind ? autoMap(kind, table.rows[header]) : {}, dateOrder: {} })
      } catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : 'could not be read'}`, { tone: 'error' }) }
    }
    setPending(p => [...p, ...next])
    setBusy(false)
  }

  const commit = async (p: Pending, data: Partial<Dataset>, rows: number, skipped: number, range: [string, string] | null) => {
    // Samples are read-only: importing into one starts a new seller.
    const target = project.sampleId ? await createBlankProject('My store') : project
    const base = project.sampleId ? { ...ds, ...Object.fromEntries(Object.keys(ds).map(k => [k, []])) } as Dataset : ds
    await putData(target.id, mergeData(base, data))
    const meta = { id: uuid(), kind: p.kind!, fileName: p.name, rows, skipped, range, at: Date.now() }
    await saveProject({ ...target, imports: [...(project.sampleId ? [] : project.imports), meta], dataMissing: false })
    setPending(x => x.filter(y => y.id !== p.id))
    toast(`Imported ${rows.toLocaleString()} ${KINDS[p.kind!].noun}${skipped ? `, skipped ${skipped}` : ''}`, { tone: 'ok' })
    if (project.sampleId) go(`/app/p/${target.id}/data`)
  }

  const counts = (Object.keys(KINDS) as Kind[]).map(k => [k, (ds[KEY_OF[k]] as unknown[]).length] as const)

  return (
    <>
      {project.dataMissing && <div className="banner warn"><span><strong>The raw reports for this seller are on another device.</strong> Case status, settings and snapshots synced; reports over {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB stay where they were imported. Re-import here to recompute.</span></div>}
      <div className="panel">
        <div className="panel-head"><h2>Import Seller Central reports</h2><Link href="/docs" className="small">Where to download each report</Link></div>
        {project.sampleId && <p className="muted small">This is a synthetic sample, so its data is read-only. Importing here starts a new seller. To rehearse, download the sample&rsquo;s reports below and drop them back in.</p>}
        <div className={`drop${drag ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Choose report files to import"
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
          <h3>{busy ? 'Reading files' : 'Drop reports here, or click to choose'}</h3>
          <p className="muted small" style={{ margin: 0 }}>CSV or tab-delimited .txt, several at once. Each is detected and mapped. Overlapping date ranges do not double count.</p>
          <input ref={input} type="file" accept=".csv,.tsv,.txt" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
        </div>
        <div className="report-checklist">
          {counts.map(([k, n]) => <span key={k} className={n ? 'have' : ''}><i aria-hidden="true">{n ? '✓' : ''}</i>{KINDS[k].label}{n ? <small> · {n.toLocaleString()}</small> : k === 'costs' ? <small> · optional</small> : null}</span>)}
        </div>
      </div>

      {pending.map(p => <PendingFile key={p.id} p={p} onChange={n => setPending(x => x.map(y => y.id === p.id ? n : y))} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={commit} />)}

      <PolicyPanel policy={project.policy} setPolicy={setPolicy} />

      {(project.imports.length > 0) && (
        <div className="panel">
          <div className="panel-head"><h2>Imported reports</h2><span className="muted small">{rawSize ? `${(rawSize / 1e6).toFixed(2)} MB on this device` : 'Generated on the fly'}</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Report</th><th className="num">Rows</th><th className="num">Skipped</th><th>Dates</th><th>When</th></tr></thead>
              <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{KINDS[i.kind]?.label ?? i.kind}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.skipped}</td><td className="small">{i.range ? `${fmtDay(i.range[0])} – ${fmtDay(i.range[1])}` : '—'}</td><td className="small">{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="muted small">{sync.user
            ? rawSize > RAW_SYNC_LIMIT ? `These reports are over ${(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB, so they stay on this device. Case status, claim windows and snapshots still sync.` : 'Synced to your account with case status, claim windows and snapshots.'
            : 'Stored in this browser only. Sign in to sync across devices.'}</p>
          <div className="row gap-sm wrap">
            {(Object.keys(KINDS) as Kind[]).filter(k => (ds[KEY_OF[k]] as unknown[]).length).map(k => <button key={k} type="button" className="btn sm outline" onClick={() => download(`${project.name.replace(/\W+/g, '-').toLowerCase()}-${k}.csv`, reportCsv(k, ds))}>{KINDS[k].label.replace(/ \(.*\)/, '')} CSV</button>)}
            {!project.sampleId && <button type="button" className="btn sm danger-ghost" onClick={async () => {
              if (!(await ask('Clear imported reports?', 'Removes every imported report from this seller on this device. Case status, claim windows and snapshots stay. You can undo for a few seconds.', 'Clear reports'))) return
              const before = ds, imports = project.imports
              await putData(project.id, { ledger: [], reimbursements: [], returns: [], fees: [], txns: [], inbound: [], costs: [] })
              update({ imports: [] })
              toast('Cleared imported reports', { undo: async () => { await putData(project.id, before); update({ imports }) } })
            }}>Clear imported reports</button>}
          </div>
        </div>
      )}
    </>
  )
}

function PendingFile({ p, onChange, onCancel, onCommit }: { p: Pending; onChange(p: Pending): void; onCancel(): void; onCommit(p: Pending, data: Partial<Dataset>, rows: number, skipped: number, range: [string, string] | null): Promise<void> }) {
  const v = useMemo(() => p.kind ? validate(p.kind, p.table, p.map, p.header, { dateOrder: p.dateOrder }) : null, [p])
  const [busy, setBusy] = useState(false)
  const headers = p.table.rows[p.header] ?? []
  const errors = v?.issues.filter(i => i.level === 'error') ?? []
  const waiting = !!v?.dates.some(c => c.order === null)
  return (
    <div className="panel pending">
      <div className="panel-head">
        <h2 className="break">{p.name}</h2>
        <label className="row gap-sm small">Report
          <select value={p.kind ?? ''} style={{ width: 'auto' }} onChange={e => { const k = (e.target.value || null) as Kind | null; onChange({ ...p, kind: k, map: k ? autoMap(k, headers) : {}, dateOrder: {} }) }}>
            <option value="">Choose…</option>
            {(Object.keys(KINDS) as Kind[]).map(k => <option key={k} value={k}>{KINDS[k].label}</option>)}
          </select>
        </label>
      </div>
      {!p.kind ? <p className="warn-text small">Could not tell which report this is from its header row ({headers.slice(0, 6).join(', ')}…). Choose it above.</p> : (
        <>
          <p className="muted small">Detected <b>{KINDS[p.kind].label}</b>{p.header ? `, header on line ${p.table.lines[p.header]} (preamble skipped)` : ''}. Check the mapping; required fields are starred.</p>
          <details className="mapping" open={errors.length > 0 && v!.count === 0 && !waiting}>
            <summary className="small strong">Column mapping</summary>
            <div className="map-grid">
              {FIELDS[p.kind].map(f => (
                <label key={f.key} className="field"><span>{f.label}{f.required ? ' *' : ''}</span>
                  <select value={p.map[f.key] ?? ''} onChange={e => { const map = { ...p.map }; if (e.target.value === '') delete map[f.key]; else map[f.key] = Number(e.target.value); onChange({ ...p, map }) }}>
                    <option value="">Not mapped</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </details>
          {v!.dates.map(c => <DateOrderBox key={c.col} c={c} onPick={o => onChange({ ...p, dateOrder: { ...p.dateOrder, [c.col]: o } })} onClear={() => onChange({ ...p, dateOrder: Object.fromEntries(Object.entries(p.dateOrder).filter(([k]) => Number(k) !== c.col)) })} />)}
          <h3 className="small strong" style={{ marginTop: 10 }}>Validation</h3>
          {waiting ? <p className="small"><strong className="warn-text">Waiting for the date order</strong> before reading {v!.total.toLocaleString()} rows.</p> : <p className="small">
            <strong className="good-text">{v!.count.toLocaleString()} {KINDS[p.kind].noun} ready</strong> from {v!.total.toLocaleString()} rows
            {v!.skipped > 0 && <>, <strong className="error">{v!.skipped} skipped</strong></>}
            {v!.issues.length > errors.length && <>, {v!.issues.length - errors.length} warnings</>}
            {v!.range && <>. Dates {fmtDay(v!.range[0])} to {fmtDay(v!.range[1])}</>}.
          </p>}
          {v!.issues.length > 0 && (
            <div className="issues" role="log" aria-label="Validation issues">
              {v!.issues.slice(0, 200).map((i, k) => <div key={k} className={i.level === 'error' ? 'error-row' : ''}><span className="ln">line {i.line}</span><span>{i.message}</span></div>)}
              {v!.issues.length > 200 && <div><span className="ln" /><span className="muted">and {v!.issues.length - 200} more</span></div>}
            </div>
          )}
        </>
      )}
      <div className="row gap" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" disabled={!v?.count || busy} onClick={async () => { setBusy(true); await onCommit(p, v!.data, v!.count, v!.skipped, v!.range); setBusy(false) }}>Import {v?.count.toLocaleString() ?? ''} {p.kind ? KINDS[p.kind].noun : 'rows'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** Shows which order a column's slash dates were read in, why, and lets the user override it. Blocks the import while none is chosen. */
function DateOrderBox({ c, onPick, onClear }: { c: DateColumn; onPick(o: DateOrder): void; onClear(): void }) {
  const name = c.header || c.label
  const x = c.samples.either[0] ?? c.samples.dmy[0] ?? c.samples.mdy[0]
  const orders: DateOrder[] = ['dmy', 'mdy']
  const why = c.chosen
    ? <>You chose {ORDER_NAME[c.order!]}. {c.detected ? <>The file reads {ORDER_NAME[c.detected]}{c.basis === 'evidence' ? <>, matching the &ldquo;{c.evidence}&rdquo; column</> : <>: {c.samples[c.detected][0] ? `${c.samples[c.detected][0].raw} on line ${c.samples[c.detected][0].line} fits only that order` : ''}</>}.</> : c.conflict ? <>The file mixes both orders.</> : <>Nothing in the file decides it.</>} Any rows that do not fit are skipped and listed below.</>
    : c.order === null
      ? c.conflict
        ? <><strong>The dates in &ldquo;{name}&rdquo; use both orders.</strong> {c.counts.dmy} value{c.counts.dmy === 1 ? '' : 's'} only make sense day first (line {c.samples.dmy[0].line}: {c.samples.dmy[0].raw}) and {c.counts.mdy} only month first (line {c.samples.mdy[0].line}: {c.samples.mdy[0].raw}). Nothing is mixed: pick one order, and the rows that do not fit it are skipped with their line numbers.</>
        : <><strong>The dates in &ldquo;{name}&rdquo; can be read two ways.</strong> Every slash date fits both orders, and nothing else in the file says which. {x.raw} on line {x.line} is {fmtDay(x.dmy)} day first or {fmtDay(x.mdy)} month first. Pick how this file writes dates before importing.</>
      : c.basis === 'evidence'
        ? <>Dates in &ldquo;{name}&rdquo; are read {ORDER_NAME[c.order]} ({ORDER_EXAMPLE[c.order]}): on every row that could go either way, that is the reading that matches the &ldquo;{c.evidence}&rdquo; column.</>
        : <>Dates in &ldquo;{name}&rdquo; are read {ORDER_NAME[c.order]} ({ORDER_EXAMPLE[c.order]}): {c.samples[c.order][0].raw} on line {c.samples[c.order][0].line} can only be read that way{c.counts[c.order] > 1 ? `, and so can ${(c.counts[c.order] - 1).toLocaleString()} more` : ''}.</>
  return (
    <div className={`banner${c.order === null ? ' warn' : ''}`} role={c.order === null ? 'alert' : undefined} style={{ marginTop: 10, marginBottom: 6 }}>
      <span className="small" style={{ flex: '1 1 320px' }}>{why}</span>
      <span className="row gap-sm wrap">
        <span className="seg-control" role="radiogroup" aria-label={`Date order for ${name}`}>
          {orders.map(o => <button key={o} type="button" role="radio" aria-checked={c.order === o} className={c.order === o ? 'on' : ''} onClick={() => onPick(o)}>{ORDER_NAME[o][0].toUpperCase() + ORDER_NAME[o].slice(1)} ({ORDER_EXAMPLE[o]})</button>)}
        </span>
        {c.chosen && c.detected && <button type="button" className="linkish small" onClick={onClear}>Use detected</button>}
        {c.chosen && !c.detected && <button type="button" className="linkish small" onClick={onClear}>Clear choice</button>}
      </span>
    </div>
  )
}

const POLICY_FIELDS: [keyof Policy, string, string][] = [
  ['warehouseDays', 'Lost / damaged in warehouse', 'days after the ledger adjustment'],
  ['returnOpenDays', 'Customer return claim opens', 'days after the refund'],
  ['returnCloseDays', 'Customer return claim closes', 'days after the refund'],
  ['inboundDays', 'Inbound shortfall', 'days after the shipment closes'],
  ['inboundSettleDays', 'Treat shipment as still receiving for', 'days'],
  ['feeDays', 'Fee disputes', 'days after the charge'],
  ['underpaidDays', 'Reimbursement value review', 'days after the reimbursement'],
  ['matchDays', 'Match reimbursements within', 'days of the loss'],
]

function PolicyPanel({ policy, setPolicy }: { policy: Policy; setPolicy(p: Partial<Policy>): void }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>Claim windows for this seller</h2><span className="muted small">Defaults checked {fmtDay(POLICY_CHECKED)}. <Link href="/docs#windows">Sources</Link></span></div>
      <div className="inline-fields policy-fields">
        {POLICY_FIELDS.map(([k, l, u]) => (
          <label key={k} className="field"><span>{l}</span>
            <span className="unit-input"><input type="number" min="0" max="730" value={policy[k]} onChange={e => setPolicy({ [k]: Math.max(0, Number(e.target.value) || 0) })} /><small>{u}</small></span>
          </label>
        ))}
        <label className="field"><span>Flag reimbursements paying under</span><span className="unit-input"><input type="number" min="10" max="100" value={Math.round(policy.underpaidRatio * 100)} onChange={e => setPolicy({ underpaidRatio: Math.min(1, Math.max(0.1, Number(e.target.value) / 100)) })} /><small>% of unit cost</small></span></label>
        <label className="field"><span>Ignore fee differences under</span><span className="unit-input"><input type="number" min="0" step="0.01" value={policy.feeTolerance} onChange={e => setPolicy({ feeTolerance: Math.max(0, Number(e.target.value)) })} /><small>$ per unit</small></span></label>
      </div>
      <button type="button" className="btn ghost sm" onClick={() => { setPolicy({ ...DEFAULT_POLICY }); toast('Claim windows reset to defaults', { tone: 'ok' }) }}>Reset to defaults</button>
    </div>
  )
}
