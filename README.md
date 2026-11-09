# FBA Recover

Reconciles an Amazon FBA seller's inventory and fees to find the money Amazon owes them, and drafts the case text before the claim windows close. Built for sellers doing $100k to a few million a year, or their bookkeeper, who would rather not hand 15 to 25% to a reimbursement service.

**Live:** https://fba-recover.vercel.app

## The pain

FBA reimbursement windows are short (60 days for units lost or damaged in a fulfilment centre), Amazon does not remind you, reimbursements sometimes pay well below the item's cost, and fees get charged on the wrong size tier or on units still in transit. The Inventory Ledger has the evidence, but reconciling it by hand never adds up.

## Features

- **Import** the Inventory Ledger (detailed view), Reimbursements, FBA customer returns, Fee Preview, Settlement (Flat File V2 or the date range transaction report), Shipment items, and an optional COGS file. Report detection, flexible column mapping and a validation report with line numbers. Overlapping exports do not double count.
- **Engine** (plain TypeScript, 29 tests): per-FNSKU ledger reconciliation by reason code with found adjustments offsetting the oldest losses; reimbursement matching by date proximity (cash and inventory, reversals); refunds never returned; inbound shortfalls; reimbursements paid below cost; a dated, editable US fee table (size tier from dimensions and weight, price bands, surcharge) that flags re-measurements and dates the change; fees charged on units not received.
- **Actions:** a case worklist ranked by dollars per day left, copy-ready case text with the FNSKU, dates, ledger references and policy reason, a status tracker (draft, filed, case ID, reimbursed, denied), a deadline calendar, a printable monthly recovery report and a CSV export.
- **History:** monthly snapshots with a compare view (found against recovered).
- **Hero:** a live per-SKU ledger Sankey (received to sold, on hand, lost; lost to found, reimbursed, unreimbursed) running on the real engine, with a deadline countdown.
- Local-first (IndexedDB). Optional email sign-in syncs sellers, case status and snapshots across devices.
- Two synthetic sample sellers, labelled as such.

Claim windows and fee rates are dated estimates (checked November 2026) and editable; confirm them in Seller Central before filing.

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # engine tests
npm run build
```

Cloud sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env` (see `.env.example`). Without them the app runs in local-only mode.

Built by Aryan Kansagara. Independent project, not affiliated with Amazon.
