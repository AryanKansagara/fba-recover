import { useState } from 'react'
import { checkTable, US_2026 } from './engine/fees.ts'
import { DEFAULT_POLICY } from './engine/types.ts'
import { deleteProject, getDefaults, getProjects, setDefaults, type Defaults } from './store.ts'
import { exportAll, RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, setTheme, toast, useDark } from './ui.tsx'

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const [json, setJson] = useState(() => JSON.stringify(getDefaults().table, null, 1))
  const [jsonErr, setJsonErr] = useState<string | null>(null)
  const dark = useDark()
  const sync = useSync()
  const save = (p: Partial<Defaults>, msg = 'Saved') => { const next = { ...d, ...p }; setD(next); setDefaults(next); toast(msg, { tone: 'ok', ttl: 1500 }) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Case text</h2>
        <label className="field"><span>Sign cases as</span><input value={d.sellerName} placeholder="Your name, store name" onChange={e => setD({ ...d, sellerName: e.target.value })} onBlur={() => save({ sellerName: d.sellerName.trim() })} /></label>
        <p className="muted small">Used at the end of every drafted case and on the monthly report. Defaults to the seller&rsquo;s name.</p>
      </div>

      <div className="panel">
        <h2>Claim windows for new sellers</h2>
        <p className="muted small">Each seller keeps its own copy; change an existing seller on its Reports &amp; settings tab.</p>
        <div className="inline-fields">
          <label className="field"><span>Lost / damaged (days)</span><input type="number" min="1" value={d.policy.warehouseDays} onChange={e => save({ policy: { ...d.policy, warehouseDays: Math.max(1, Number(e.target.value)) } })} /></label>
          <label className="field"><span>Returns open (days)</span><input type="number" min="0" value={d.policy.returnOpenDays} onChange={e => save({ policy: { ...d.policy, returnOpenDays: Math.max(0, Number(e.target.value)) } })} /></label>
          <label className="field"><span>Returns close (days)</span><input type="number" min="1" value={d.policy.returnCloseDays} onChange={e => save({ policy: { ...d.policy, returnCloseDays: Math.max(1, Number(e.target.value)) } })} /></label>
          <label className="field"><span>Inbound (days)</span><input type="number" min="1" value={d.policy.inboundDays} onChange={e => save({ policy: { ...d.policy, inboundDays: Math.max(1, Number(e.target.value)) } })} /></label>
          <label className="field"><span>Fees (days)</span><input type="number" min="1" value={d.policy.feeDays} onChange={e => save({ policy: { ...d.policy, feeDays: Math.max(1, Number(e.target.value)) } })} /></label>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => save({ policy: { ...DEFAULT_POLICY } }, 'Reset to defaults')}>Reset to defaults</button>
      </div>

      <div className="panel" id="fees">
        <h2>Fulfilment fee table</h2>
        <p className="muted small">Brackets are in pounds (2 oz = 0.125 lb). Base fees are for items priced $10 to $50; <code>lowPriceAdj</code> and <code>highPriceAdj</code> apply under $10 and over $50. <code>overage</code> adds <code>perStep</code> for every <code>stepLb</code> above <code>fromLb</code>. Applies to every seller.</p>
        <label className="field"><span className="sr-only">Fee table JSON</span><textarea className="mono json" rows={14} value={json} spellCheck={false} onChange={e => { setJson(e.target.value); setJsonErr(null) }} /></label>
        {jsonErr && <p className="error small" role="alert">{jsonErr}</p>}
        <div className="row gap-sm wrap">
          <button type="button" className="btn primary sm" onClick={() => {
            try { const t = checkTable(JSON.parse(json)); const prev = d.table; save({ table: t }, 'Fee table saved'); toast('Fee table saved. Every seller re-audited.', { undo: () => { save({ table: prev }); setJson(JSON.stringify(prev, null, 1)) } }) } catch (e) { setJsonErr(e instanceof Error ? e.message : String(e)) }
          }}>Save table</button>
          <button type="button" className="btn ghost sm" onClick={() => { setJson(JSON.stringify(US_2026, null, 1)); save({ table: US_2026 }, 'Fee table reset to the built-in 2026 estimate') }}>Reset to built-in</button>
        </div>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Sellers live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: case status, claim windows, snapshots and reports under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per seller sync to your account.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`fba-recover-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local sellers?', `Removes ${list.length} seller${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} sellers`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all sellers</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>6</kbd></dt><dd>Switch seller sections</dd></div>
          <div><dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Next / previous finding</dd></div>
          <div><dt><kbd>C</kbd></dt><dd>Copy the focused finding&rsquo;s case text</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save this month&rsquo;s snapshot</dd></div>
          <div><dt><kbd>E</kbd></dt><dd>Export findings CSV</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable monthly report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete or status change</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts on a seller page</dd></div>
        </dl>
      </div>
    </section>
  )
}
