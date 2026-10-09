# TRACK C — Experience (Samuhia Payments UI, landlord Firebase Auth, chama connector UI) — PROMPT

You are **Track C** of three AIs building the MyChama⇄PAY connector in parallel (A = data plane, B = money plane). A foundation patch **P0** fixed all shared contracts; your patch must drop in next to theirs without conflicts.

## Repos & base
**PAY** at `1aef012` + **P0 applied** (rebased `mychama-connector-P0-foundation.v2.patch`): React 19 + TypeScript + Vite + Tailwind v4 (`@tailwindcss/vite`), Firebase (hosting site `payments-1x`, functions region `africa-south1`). No other repo is needed.
**Read first:** `docs/mychama/CONNECTOR_CONTRACT.md`, `src/mychama/contract.ts`, `src/mychama/api.ts`. Frozen: `src/mychama/{contract,api,index}.ts` (use `mychamaApi`, never raw `httpsCallable`). Contract changes via §10.
**You need from the user (ask if missing):** the Samuhia brand HTML (logos/colours/typography — it is attached in the user's chat, not in the repo).

## Deliverable
`track-C-pay-experience.patch` (PAY) — touching ONLY `src/**` (except the frozen files), `functions/src/auth/**`, `index.html`, `public/**`, plus `docs/mychama/track-C-notes.md`. Do not touch `functions/src/index.ts` or `functions/src/mychama/**`.

## C1. Samuhia Payments rebrand
Rename the product everywhere user-visible to **Samuhia Payments** (Welcome, Auth, Signup, headers, titles, `index.html`, manifest/meta, receipts shown in UI) and apply the logos/colours from the HTML. Put tokens in `src/theme/` (CSS variables + Tailwind v4 `@theme`), then restyle shared components via tokens rather than per-screen colour edits. The UI may be refined later — keep tokens central. No rental logic changes.

## C2. Landlord login → Firebase Auth
* Today landlords use a custom login (`Auth.tsx`, `localStorage` key `agentAuthUser`, profile `agents/{agentId}`, password hash verified with `hash-wasm`/argon2); tenants use Firebase **phone** auth. Target: landlords sign in with Firebase Auth **phone OR email/password**; tenants stay phone-only.
* Backend (you own `functions/src/auth/index.ts`, wired already by P0): a **lazy migration** callable (e.g. `agentMigrateLogin`) — verify legacy credentials server-side against the agent doc (determine the exact hash type first; Firebase `importUsers` can't import argon2), create/link the Firebase Auth user, set custom claims **`{ role: "landlord", agentId }`** (Track A depends on these), return a custom token. Also support phone-linking for landlords. Rate-limit and never reveal which part of the credentials failed.
* Frontend: auth guard on `onAuthStateChanged` + claims; provide a compatibility hook (e.g. `useAgentSession()`) so `AgentView` keeps working with the same `agentId` it uses today; stop treating `localStorage` as the source of truth. **Do not change existing rent callables** (they still receive `agentId` from the client — server-side hardening is a separate later patch). No regression in rent collection flows.

## C3. Connector UI (landlord + tenant)
* On the first authenticated session call `mychamaApi.sync({reason:"login"})`; on reload `reason:"reload"`; a Refresh button uses `"manual"`. The server throttles — the UI **always renders from `onSnapshot(chamaSnapshots/{uid})`** (`mychamaSnapshotPath(uid)`), never from callable return values.
* States to design: `never_linked` (explain linking is automatic by ID), **`pending[]`** cards (masked phone, "Send code" → `requestCode` → code entry → `verifyCode`, show `remainingAttempts`, resend countdown from `resendAfter`, handle `send_limit_reached`/`code_*` errors via `mychamaErrorCode`), `ok`, `stale` (banner with "as of" time), `unavailable` (never blank-screen; explain, offer manual refresh), `needs_reverify`, per-chama `dataStatus: partial|unavailable` (a `null` section means "unavailable", NOT zero — render it as unavailable).
* Pay: new `MyChamaPayModal` (don't modify the rent `PaymentModal`) for contributions, loan instalments and MGR (incl. arrears) → `mychamaApi.payInitiate` with a fresh `clientRequestId`, show the STK-push waiting state, then a "Check status" action that triggers a manual sync (the webhook updates mychama1, the snapshot catches up on sync). Only offer pay when `onlineCollectionEnabled`.
* **Calculations — `src/mychama/calc.ts` (pure, unit-tested):** `landlordPeriodSummary({rentCollected, from, to}, chamas)` → deductions for contributions, loan repayments and MGR contributions with due dates inside the period, plus expected MGR wins (`wins`, `expectedInflowThisMonth`) and net; `tenantMonthSummary({rentDue, billsDue, …}, chamas)` → "this month I need KES X: rent, bills, chama (contributions, loans, MGR)" minus expected wins. Components pass in rent totals they ALREADY load; **calc.ts and the connector code never query rental collections**. Rent screens stay unchanged; chama figures appear in a separate, clearly labelled MyChama section/tab (routes such as `/agent/chama`, `/tenant/chama` or embedded tabs — your choice).
* Money formatting KES, EAT dates, accessible, mobile-first.

## Hard rules
* Do not edit frozen files, `functions/src/index.ts`, or anything under `functions/src/mychama/**`.
* No direct Firestore reads of rental collections from the new code; no writes to chama* collections (rules forbid it).
* Keep the build green: `npm run build` (tsc -b + vite) and `npm run check:mychama-contract`.
## Acceptance
Build passes · `git apply --check` (P0-only tree, and with A and B applied) · screenshots/notes for each state above · unit tests (or documented worked examples if no runner is added) for `calc.ts` · confirmation that no rental query/collection is referenced from `src/mychama/**`.
