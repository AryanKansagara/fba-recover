import { useEffect, useMemo, useState } from 'react'
import { snapshot } from './engine/cases.ts'
import { addDays, analyze, today } from './engine/recon.ts'
import { generate, SAMPLES } from './engine/sample.ts'
import { emptyDataset, type CaseState, type Policy } from './engine/types.ts'
import { getData, getDefaults, getProjects, saveProject, useProjects, uuid, type Dataset, type Project } from './store.ts'

const sampleCache = new Map<string, Dataset>()
export function sampleData(id: string): Dataset | null {
  if (!SAMPLES.some(s => s.id === id)) return null
  const key = `${id}:${today()}`
  if (!sampleCache.has(key)) sampleCache.set(key, generate(id, today()))
  return sampleCache.get(key)!
}

export const monthLabel = (p: string) => new Date(p + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export async function createSampleProject(sampleId: string): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === sampleId)
  if (existing) return existing
  const def = SAMPLES.find(s => s.id === sampleId)!
  const ds = sampleData(sampleId)!
  const policy = getDefaults().policy
  // Two earlier month-end snapshots so History has something to compare: last month found more, recovered less.
  const t = today()
  const snaps = [-2, -1].map(k => {
    const asOf = addDays(t.slice(0, 8) + '01', k === -1 ? -1 : -32)
    const a = analyze(ds, { policy, asOf })
    const fake: Record<string, CaseState> = {}
    a.findings.filter((_, i) => i % (k === -2 ? 5 : 3) === 0).forEach(f => { fake[f.id] = { status: 'reimbursed', recovered: f.amount, updatedAt: 0 } })
    return snapshot(a, fake, uuid(), asOf.slice(0, 7), monthLabel(asOf.slice(0, 7)))
  })
  // A few cases already in flight, so the tracker shows every state.
  const a = analyze(ds, { policy })
  const cases: Record<string, CaseState> = {}
  const open = a.findings.filter(f => f.deadline >= t && f.opens <= t)
  if (open[2]) cases[open[2].id] = { status: 'filed', caseId: '17384920561', updatedAt: Date.now() }
  if (open[4]) cases[open[4].id] = { status: 'draft', updatedAt: Date.now() }
  const old = a.findings.filter(f => f.deadline < t)
  if (old[0]) cases[old[0].id] = { status: 'reimbursed', caseId: '17299104418', recovered: old[0].amount, updatedAt: Date.now() }
  const now = Date.now()
  const kinds = Object.entries(ds).filter(([, v]) => (v as unknown[]).length)
  return saveProject({
    id: uuid(), name: def.name, createdAt: now, updatedAt: now, policy, cases, snapshots: snaps, sampleId,
    imports: kinds.map(([k, v]) => ({ id: uuid(), kind: k as never, fileName: `synthetic ${k} (generated)`, rows: (v as unknown[]).length, skipped: 0, range: null, at: now })),
  })
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, policy: getDefaults().policy, cases: {}, snapshots: [], imports: [] })
}

/** Re-render when the global defaults (fee table, seller name) change. */
export function useDefaults() {
  const [d, setD] = useState(getDefaults)
  useEffect(() => {
    const on = () => setD(getDefaults())
    addEventListener('fba-defaults', on)
    return () => removeEventListener('fba-defaults', on)
  }, [])
  return d
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(sampleData(project.sampleId) ?? emptyDataset()); return }
    void getData(project.id).then(d => { if (live) setDs({ ...emptyDataset(), ...d }) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, importsKey])
  const update = (patch: Partial<Project>) => project && saveProject({ ...project, ...patch })
  const setPolicy = (patch: Partial<Policy>) => project && saveProject({ ...project, policy: { ...project.policy, ...patch } })
  const setCase = (fid: string, patch: Partial<CaseState>) => {
    if (!project) return
    const cur = project.cases[fid] ?? { status: 'open', updatedAt: 0 }
    return saveProject({ ...project, cases: { ...project.cases, [fid]: { ...cur, ...patch, updatedAt: Date.now() } } })
  }
  return { loading: list === null || (project !== null && ds === null), project, ds, update, setPolicy, setCase }
}

export function useAnalysis(ds: Dataset | null, policy: Policy | undefined) {
  const d = useDefaults()
  return useMemo(() => ds && policy ? analyze(ds, { policy, table: d.table }) : null, [ds, policy, d.table])
}
