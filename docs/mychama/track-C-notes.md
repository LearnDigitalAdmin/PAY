# Track C — experience: notes for the integrator

Patch: `track-C-pay-experience.patch` (PAY, base `e1dd2b2` = P0 + Track A as pushed). Compatible with the Track A side patch (`track-A-id-landlord-userid.patch`): they touch disjoint files.
Touched: `src/**` (except the frozen `src/mychama/{contract,api,index}.ts`), `functions/src/auth/**`, `index.html`, `public/**`, `tests/mychama/`, this note. Not touched: `functions/src/index.ts`, `functions/src/mychama/**`, `package.json`.

## Finding that changed the plan (landlord auth)
The prompt assumed landlords log in with a custom hashed-password flow. They don't: `Auth.tsx` already called `signInWithEmailPassword` (Firebase Auth) and the hash check is commented out. What was wrong is **role resolution**: `ProtectedRoute` trusted a `localStorage` record for agents, and treated any other Firebase user as a tenant. So there is **no lazy password migration** (nothing to migrate); instead:
* `functions/src/auth/index.ts` → `agentSyncClaims` (callable): the one trusted place that decides a signed-in uid is a landlord (users doc id = uid, or `firebaseAuthUid`, or a verified phone matching exactly one landlord's phone; `type` must be `paid`, as the old client check required) and stamps claims `{ role: "landlord", agentId }` (agentId = `users/{userId}` = the landlord's ID number — what Track A reads).
* `src/session/` → `SessionProvider` / `useSession()`: role from claims → profile docs → `agentSyncClaims`, honouring the portal chosen on the welcome screen (matters for people who are both landlord and tenant). `localStorage.agentAuthUser` is now only a **derived cache** (rewritten from the verified session, cleared on sign-out) so `AgentView` works unchanged.
* `Auth.tsx`: landlords can sign in with **email & password** (as before, minus the client-side `users` query) **or a phone code**; `auth/invalid-credential` now maps to a friendly message.

## Brand — Samuhia Payments
* Source: `samuhia-site-logo-studio.html` ("Samuhia PAYMENTS": amber-brown `#B8741A`, deep `#96600F`, green `#0F6B54`, font Schibsted Grotesk). Logo SVGs → `public/brand/`; `BrandLogo` component; favicon/PWA/Apple icons and all 40 iOS launch screens regenerated; manifest, `index.html`, theme colours, service-worker cache names renamed.
* **One-file restyle:** `src/theme/tokens.css` re-points the Tailwind ramps the screens already use — `indigo`→Payments amber, `blue`/`purple`→Samuhia green, `gray`→warm neutrals; red/green/yellow/orange keep their meaning. Retune the brand by editing that file only.
* Rebranded in W3-A: company contact emails, the FAQ link, the server-generated Paystack customer address (`@samuhia.co.ke`) and the web manifest now say Samuhia. The footer reads "© 2026 Samuhia Payments" — adjust if the legal entity should be named.

## Connector UI (`src/mychama/`)
`ChamaConnectorProvider` listens to `chamaSnapshots/{uid}` (UI always renders from it) and calls `mychamaSync` once per user per page load (`login` for a fresh sign-in, else `reload`; manual Refresh = `manual`; the server throttles). `ChamaSection` is dropped into `AgentView` (after the stat cards) and `TenantView` (above the tabs); it receives rent figures as props and never reads rental data (verified: nothing under `src/mychama` queries Firestore except the snapshot document).
States covered: loading, never linked, error with no data, `ok`, `stale` (server status **or** older than `SNAPSHOT_STALE_AFTER_SECONDS`), `unavailable`, per-chama `partial`/`unavailable` (a `null` section renders "Unavailable", never 0), pending verification (masked phone → Send code → 6-digit entry, resend countdown, lockout/limit messages; remaining attempts read from `err.details.remainingAttempts`), `needs_reverify` (appears as a pending card). Pay buttons only when `onlineCollectionEnabled`; `MyChamaPayModal` (separate from the rent `PaymentModal`) → `mychamaPayInitiate` with a stable `clientRequestId`, STK-wait screen, "Check status" = manual sync.
**Calculations** — `calc.ts` (pure; 8 tests): landlord = rent collected in the chosen period (successful payments, EAT) − contributions − loan repayments − MGR (+ MGR won in the period); tenant = rent + bills + chama (overdue + due this month, from the server totals) − expected MGR this month. Limits to know: loans count the **next instalment only** (the snapshot has no full schedule); MGR "due now" has no date so it counts as this month; scheduled MGR wins have no dates (mychama1 stores none), so they are listed, not netted; undated items are counted but flag the figures "may be incomplete".

## Verified here
`npx tsc -b` and `npm run build` pass; `functions` `tsc` passes; `node --experimental-strip-types --test tests/mychama/calc.test.mts` → 8/8; contract drift check passes; eslint clean on all new code (the remaining `Auth.tsx` `any` errors pre-date this patch); every connector state server-rendered with fixtures (dates checked in UTC and America/Los_Angeles). **Not verified:** no real browser, Firebase project, phone auth or Paystack here — please do a visual pass on phone and desktop, and a live landlord login (email and phone) before release.

## Deploy / config checklist
1. Deploy `agentSyncClaims` (functions) before the hosting build that depends on it.
2. Firebase Auth: phone sign-in must be enabled for the project (already used by tenants) and the reCAPTCHA container exists in `index.html`.
3. Firestore rules (plot): clients need read on `chamaSnapshots/{uid}` (own doc) — `docs/mychama/firestore.rules.fragment`; existing reads of `users/{id}` and `tenants/{uid}` are unchanged.
4. Phone matching in `agentSyncClaims` needs `users.phone` stored as E.164 (accounts made by `createUserWithFirebaseAuth` already are; uid/`firebaseAuthUid` matches don't depend on it).
5. Brand font loads from Google Fonts with a system-font fallback (offline PWA safe).
6. Hard-refresh/clear the old service worker once: its cache names changed (old caches are deleted on activate).

## Follow-ups (not in this patch)
* Hardening the existing rent callables to use the verified identity instead of a client-supplied `agentId` (separate later patch, as planned).
* A visual design pass if the "Samuhia" look should go beyond the palette/logo remap.
