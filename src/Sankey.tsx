import { useId } from 'react'
import type { SkuFlow } from './engine/recon.ts'
import { fmtN } from './ui.tsx'

interface Node { key: string; label: string; v: number; x: number; y: number; h: number; tone: string }
interface Link { from: Node; to: Node; v: number; sy: number; sh: number; ty: number; th: number; tone: string; glow?: boolean }

/** A ribbon between two vertical segments, as a closed path with two cubic curves. */
const ribbon = (x0: number, y0: number, h0: number, x1: number, y1: number, h1: number) => {
  const mx = (x0 + x1) / 2
  return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1 + h1} C${mx},${y1 + h1} ${mx},${y0 + h0} ${x0},${y0 + h0} Z`
}
const centre = (x0: number, y0: number, x1: number, y1: number) => { const mx = (x0 + x1) / 2; return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}` }

/**
 * Received -> sold / on hand / lost & damaged, then a zoomed fan of the lost & damaged units into found, reimbursed
 * and unreimbursed. The unreimbursed stream glows: that is the money still on the table.
 */
export function Sankey({ f, width = 640, height = 300, compact = false }: { f: SkuFlow; width?: number; height?: number; compact?: boolean }) {
  const uid = useId().replace(/:/g, '')
  const W = width, H = height, NW = 10, PAD = 14
  const inflow = f.received + f.returned
  const lostDam = f.lost + f.damaged
  const sold = Math.min(f.sold, inflow)
  const hand = Math.max(0, inflow - sold - lostDam)
  const found = Math.min(f.found, lostDam)
  const unre = Math.min(f.unreimbursed, lostDam - found)
  const expired = Math.min(f.expiredUnits, unre)
  const paid = Math.max(0, lostDam - found - unre)
  const total = Math.max(1, inflow)

  const x0 = 0, x1 = W * 0.42, x2 = W - NW - (compact ? 92 : 130)
  const gap = 10
  const minH = 5
  // Column 1 and 2 share a linear scale; lost & damaged gets a minimum thickness so it is always visible.
  const avail = H - PAD * 2 - gap * 2
  const k = (avail - minH) / total
  const lostH = Math.max(minH, lostDam * k)
  const mid = [
    { key: 'sold', label: 'Sold', v: sold, tone: 'var(--flow-sold)' },
    { key: 'hand', label: 'On hand', v: hand, tone: 'var(--flow-hand)' },
    { key: 'lost', label: 'Lost & damaged', v: lostDam, tone: 'var(--leak)' },
  ]
  let y = PAD
  const midNodes: Node[] = mid.map(m => {
    const h = m.key === 'lost' ? lostH : Math.max(m.v ? 2 : 0, m.v * k)
    const n = { ...m, x: x1, y, h }
    y += h + gap
    return n
  })
  const leftTotalH = midNodes.reduce((s, n) => s + n.h, 0)
  const recvH = leftTotalH * (f.received / total), retH = leftTotalH - recvH
  const recv: Node = { key: 'recv', label: 'Received', v: f.received, x: x0, y: PAD, h: recvH, tone: 'var(--flow-recv)' }
  const ret: Node = { key: 'ret', label: 'Returned', v: f.returned, x: x0, y: PAD + recvH + gap, h: retH, tone: 'var(--flow-ret)' }

  // Zoomed right column for the fate of lost & damaged units.
  const lostNode = midNodes[2]
  const zoomH = Math.min(H - PAD * 2, Math.max(90, H * 0.62))
  const zTop = Math.min(Math.max(PAD, lostNode.y + lostNode.h / 2 - zoomH / 2), H - PAD - zoomH)
  const right = [
    { key: 'found', label: 'Found', v: found, tone: 'var(--flow-hand)' },
    { key: 'paid', label: 'Reimbursed', v: paid, tone: 'var(--flow-paid)' },
    { key: 'expired', label: 'Window closed', v: expired, tone: 'color-mix(in srgb, var(--leak) 45%, var(--flow-hand))' },
    { key: 'unre', label: 'Unreimbursed', v: unre - expired, tone: 'var(--leak)' },
  ].filter(r => r.v > 0)
  const rGap = 8
  const kz = right.length ? (zoomH - rGap * (right.length - 1)) / Math.max(1, lostDam - 0) : 0
  let ry = zTop
  const rightNodes: Node[] = right.map(r => { const h = Math.max(3, r.v * kz); const n = { ...r, x: x2, y: ry, h }; ry += h + rGap; return n })

  // Links
  const links: Link[] = []
  const outY = new Map<string, number>(), inY = new Map<string, number>()
  const link = (from: Node, to: Node, v: number, sh: number, th: number, glow = false) => {
    const sy = outY.get(from.key) ?? from.y, ty = inY.get(to.key) ?? to.y
    outY.set(from.key, sy + sh); inY.set(to.key, ty + th)
    links.push({ from, to, v, sy, sh, ty, th, tone: to.key === 'lost' ? 'var(--leak)' : glow ? 'var(--leak)' : to.tone, glow })
  }
  for (const src of [recv, ret]) {
    const share = src.v / total
    for (const m of midNodes) {
      if (!m.v || !src.v) continue
      const part = m.v * share
      link(src, m, part, src.h * (part / Math.max(1, src.v)), m.h * share)
    }
  }
  for (const r of rightNodes) link(lostNode, r, r.v, lostNode.h * (r.v / Math.max(1, lostDam)), r.h, r.key === 'unre')

  const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  const label = (n: Node, side: 'left' | 'right' | 'mid') => {
    // Lost & damaged sits under "On hand", so its label goes on the left of the node.
    const before = side === 'mid' && n.key === 'lost'
    const tx = before ? n.x - 6 : side === 'right' ? n.x + NW + 8 : n.x + NW + 6
    const ty = n.y + n.h / 2
    const isUnre = n.key === 'unre'
    return (
      <g key={'l' + n.key} className={`sk-label${isUnre || before ? ' leak' : ''}`} textAnchor={before ? 'end' : 'start'}>
        <text x={tx} y={ty - (compact ? 1 : 3)} dominantBaseline="auto">{n.label}</text>
        <text x={tx} y={ty + (compact ? 11 : 13)} className="sk-v">{fmtN(n.v)}{isUnre && f.unitValue ? ` · ${money(n.v * f.unitValue)}` : ''}</text>
      </g>
    )
  }

  return (
    <svg className="sankey" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${f.sku}: ${fmtN(f.received)} received, ${fmtN(sold)} sold, ${fmtN(lostDam)} lost or damaged, ${fmtN(found)} found, ${fmtN(paid)} reimbursed, ${fmtN(unre)} unreimbursed`}>
      <defs>
        <filter id={`g${uid}`} x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="6" /></filter>
        <linearGradient id={`z${uid}`} x1="0" x2="1"><stop offset="0" stopColor="var(--leak)" stopOpacity=".9" /><stop offset="1" stopColor="var(--leak)" stopOpacity=".25" /></linearGradient>
      </defs>
      <rect className="sk-zoom" x={x1 + NW + 4} y={zTop - 6} width={x2 - x1 - NW - 8} height={zoomH + 12} rx="10" />
      <text className="sk-zoom-label" x={x2 - 6} y={zTop - 12} textAnchor="end">zoomed {lostDam ? `${Math.max(1, Math.round(kz / k))}x` : ''}</text>
      {links.map((l, i) => {
        const d = ribbon(l.from.x + NW, l.sy, l.sh, l.to.x, l.ty, l.th)
        const c = centre(l.from.x + NW, l.sy + l.sh / 2, l.to.x, l.ty + l.th / 2)
        return (
          <g key={i} className={`sk-link${l.glow ? ' glow' : ''}`}>
            {l.glow && <path d={d} fill="var(--leak-glow)" filter={`url(#g${uid})`} className="sk-halo" />}
            <path d={d} fill={l.from.key === 'lost' && !l.glow ? l.tone : l.tone} opacity={l.glow ? 0.92 : l.to.key === 'lost' ? 0.85 : 0.42} />
            <path d={c} className="sk-flow" style={{ strokeWidth: Math.max(1, Math.min(3, l.th / 6)), animationDuration: `${l.glow ? 1.4 : 3 + (i % 3)}s` }} />
          </g>
        )
      })}
      {[recv, ret, ...midNodes, ...rightNodes].filter(n => n.h > 0).map(n => <rect key={n.key} x={n.x} y={n.y} width={NW} height={n.h} rx="2" fill={n.tone} className={n.key === 'unre' ? 'sk-node leak' : 'sk-node'} />)}
      {[recv, ret].filter(n => n.v > 0 && n.h > 14).map(n => label(n, 'left'))}
      {midNodes.filter(n => n.v > 0 && (n.h > 14 || n.key === 'lost')).map(n => label(n, 'mid'))}
      {rightNodes.map(n => label(n, 'right'))}
    </svg>
  )
}
