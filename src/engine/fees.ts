// Dated, editable US FBA fulfilment fee engine: size tier from dimensions and weight, then the fee for that tier.

export type Tier = 'small-standard' | 'large-standard' | 'small-bulky' | 'large-bulky' | 'extra-large'

export const TIER_LABEL: Record<Tier, string> = {
  'small-standard': 'Small standard',
  'large-standard': 'Large standard',
  'small-bulky': 'Small bulky',
  'large-bulky': 'Large bulky',
  'extra-large': 'Extra-large',
}

export interface Bracket { upToLb: number; fee: number }
/** Brackets in ascending order; past the last bracket, add `perStep` for every `stepLb` above `fromLb`. */
export interface TierFees { brackets: Bracket[]; overage?: { fromLb: number; stepLb: number; perStep: number } }

export interface FeeTable {
  name: string
  /** First day these rates apply */
  effective: string
  /** Base rates are for items priced $10 to $50 */
  tiers: Record<Tier, TierFees>
  /** Added per unit when the item price is under $10 (negative = discount) */
  lowPriceAdj: number
  /** Added per unit when the item price is over $50 */
  highPriceAdj: number
  /** Percentage surcharge applied on top of the fulfilment fee from `surchargeFrom` */
  surchargePct: number
  surchargeFrom: string
  source: string
}

const oz = (n: number) => n / 16

/**
 * Non-peak US rates for 2026 (effective 2026-01-15) as published in third-party summaries of the Seller Central
 * rate card, plus the 3.5% fuel and logistics surcharge from 2026-04-17. Treat as an estimate and edit it in Settings
 * to match the Revenue Calculator for your own SKUs.
 */
export const US_2026: FeeTable = {
  name: 'US FBA fulfilment fees, 2026 non-peak (estimate)',
  effective: '2026-01-15',
  tiers: {
    'small-standard': { brackets: [[2, 3.32], [4, 3.40], [6, 3.47], [8, 3.54], [10, 3.64], [12, 3.74], [14, 3.82], [16, 3.88]].map(([o, fee]) => ({ upToLb: oz(o), fee })) },
    'large-standard': {
      brackets: [
        [oz(4), 3.91], [oz(8), 4.13], [oz(12), 4.38], [oz(16), 4.79], [1.25, 5.23], [1.5, 5.61], [1.75, 5.77], [2, 6.02],
        [2.25, 6.12], [2.5, 6.30], [2.75, 6.46], [3, 6.87], [20, 7.17],
      ].map(([upToLb, fee]) => ({ upToLb, fee })),
      overage: { fromLb: 3, stepLb: 0.25, perStep: 0.08 },
    },
    'small-bulky': { brackets: [{ upToLb: 1, fee: 9.86 }, { upToLb: 50, fee: 9.86 }], overage: { fromLb: 1, stepLb: 1, perStep: 0.38 } },
    'large-bulky': { brackets: [{ upToLb: 1, fee: 26.58 }, { upToLb: 50, fee: 26.58 }], overage: { fromLb: 1, stepLb: 1, perStep: 0.38 } },
    'extra-large': { brackets: [{ upToLb: 1, fee: 40.37 }, { upToLb: 50, fee: 40.37 }], overage: { fromLb: 1, stepLb: 1, perStep: 0.38 } },
  },
  lowPriceAdj: -0.77,
  highPriceAdj: 0.26,
  surchargePct: 3.5,
  surchargeFrom: '2026-04-17',
  source: 'Seller Central "FBA fulfillment fees" rate card, as summarised by public 2026 fee guides; checked 2026-11-08',
}

export interface Dims { longest: number; median: number; shortest: number; weightLb: number }

/** Dimensional weight in lb: L x W x H / 139, with width and height floored at 2 inches. */
export const dimWeight = (d: Dims) => (d.longest * Math.max(2, d.median) * Math.max(2, d.shortest)) / 139

export function sizeTier(d: Dims): Tier {
  const [l, m, s] = [d.longest, d.median, d.shortest].sort((a, b) => b - a)
  const girth = l + 2 * (m + s)
  if (d.weightLb <= 1 && l <= 15 && m <= 12 && s <= 0.75) return 'small-standard'
  if (d.weightLb <= 20 && l <= 18 && m <= 14 && s <= 8) return 'large-standard'
  if (d.weightLb <= 50 && l <= 37 && m <= 28 && s <= 20 && girth <= 130) return 'small-bulky'
  if (d.weightLb <= 50 && l <= 59 && m <= 33 && s <= 33 && girth <= 130) return 'large-bulky'
  return 'extra-large'
}

/** Small standard bills on unit weight; everything else on the greater of unit and dimensional weight. */
export const shippingWeight = (d: Dims, tier: Tier = sizeTier(d)) => tier === 'small-standard' ? d.weightLb : Math.max(d.weightLb, dimWeight(d))

export interface FeeQuote { tier: Tier; shippingLb: number; base: number; fee: number }

export function fulfilmentFee(d: Dims, price: number, date: string, table: FeeTable = US_2026): FeeQuote {
  const tier = sizeTier(d)
  const w = shippingWeight(d, tier)
  const t = table.tiers[tier]
  const b = t.brackets.find(x => w <= x.upToLb + 1e-9) ?? t.brackets[t.brackets.length - 1]
  let base = b.fee
  if (t.overage && w > t.overage.fromLb) base += Math.ceil((w - t.overage.fromLb) / t.overage.stepLb - 1e-9) * t.overage.perStep
  if (tier === 'small-standard' || tier === 'large-standard') base += price < 10 ? table.lowPriceAdj : price > 50 ? table.highPriceAdj : 0
  const fee = date >= table.surchargeFrom ? base * (1 + table.surchargePct / 100) : base
  return { tier, shippingLb: w, base: round2(base), fee: round2(fee) }
}

export const round2 = (n: number) => Math.round(n * 100) / 100

/** Throws with a readable message when a user-edited table is malformed. */
export function checkTable(t: unknown): FeeTable {
  const x = t as FeeTable
  if (!x || typeof x !== 'object') throw new Error('Fee table must be a JSON object.')
  for (const tier of Object.keys(TIER_LABEL) as Tier[]) {
    const tf = x.tiers?.[tier]
    if (!tf || !Array.isArray(tf.brackets) || !tf.brackets.length) throw new Error(`Missing brackets for ${tier}.`)
    let prev = 0
    for (const b of tf.brackets) {
      if (!(b.upToLb > 0) || !(b.fee >= 0) || b.upToLb < prev) throw new Error(`Brackets for ${tier} must have ascending upToLb and non-negative fees.`)
      prev = b.upToLb
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.surchargeFrom ?? '')) throw new Error('surchargeFrom must be a YYYY-MM-DD date.')
  if (typeof x.surchargePct !== 'number' || typeof x.lowPriceAdj !== 'number' || typeof x.highPriceAdj !== 'number') throw new Error('surchargePct, lowPriceAdj and highPriceAdj must be numbers.')
  return x
}
