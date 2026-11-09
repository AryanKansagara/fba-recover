// node scripts/qa-sync.mjs : signs up a throwaway account, round-trips a seller and a snapshot through the same tables the app syncs to, then deletes the account
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => l.split('=')))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
const email = `qa-fba-recover-${Date.now()}@example.com`, password = 'qa-' + Math.random().toString(36).slice(2) + 'X9!'
const ok = (label, r) => { if (r.error) { console.log('FAIL', label, r.error.message); process.exitCode = 1 } else console.log('ok  ', label) }
const up = await sb.auth.signUp({ email, password }); ok('sign up ' + email, up)
if (!up.data.session) ok('sign in', await sb.auth.signInWithPassword({ email, password }))
const id = crypto.randomUUID(), vid = crypto.randomUUID()
ok('upsert seller', await sb.from('projects').upsert({ id, app: 'fba-recover', name: 'QA seller', data: { project: { id, name: 'QA seller', policy: { warehouseDays: 60 }, cases: { 'lost:X1:2026-10-01:9': { status: 'filed', caseId: '123' } } } }, updated_at: new Date().toISOString() }))
ok('insert snapshot', await sb.from('project_versions').insert({ id: vid, project_id: id, label: 'November 2026', data: { id: vid, period: '2026-11', found: 2322, recovered: 87 } }))
const rows = await sb.from('projects').select('id,name,data').eq('app', 'fba-recover'); ok('read back', rows)
console.log(rows.data?.length === 1 && rows.data[0].data.project.cases['lost:X1:2026-10-01:9'].caseId === '123' ? 'ok   round trip matches' : 'FAIL round trip')
const vs = await sb.from('project_versions').select('id').in('project_id', [id]); console.log(vs.data?.length === 1 ? 'ok   snapshot round trip' : 'FAIL snapshot')
ok('delete account', await sb.rpc('delete_my_account'))
const after = await sb.auth.signInWithPassword({ email, password }); console.log(after.error ? 'ok   account gone (' + after.error.message + ')' : 'FAIL account still exists')
