# CYBER: switch the MyChama payment flow to the new Paystack account (Track B)

**Applied by `track-B-cyber.patch`** (against CYBER `9a33e04`; `git apply --check` clean, `tsc --noEmit` 0 errors before and after). This document explains what the patch does and what to do around it. Apply with `git apply track-B-cyber.patch` from the CYBER repo root.

Files touched: `functions/src/config/paystack.config.ts`, `index.ts`, `services/mychama.payment.service.ts`, `handlers/mychama.handler.ts`, `types/mychama.types.ts`, `constants/mychama.messages.ts` (new `PAY_SPLIT_RELINK` message, en + sw). No `CYBER_`/`SHOP_`/`REPORT_`/`SUB_`/`INV_` code changes.

## What CYBER does today
`handlers/mychama.handler.ts` → `initiateMyChamaPayment()` in `services/mychama.payment.service.ts` creates the `MCW-{chamaId}-{CNT|LNR|MGR}-{ms}-{rand}`
intent in mychama1 and POSTs `https://api.paystack.co/charge` with **`PAYSTACK_SECRET_KEY.value()`** (the same secret CYBER's own shop/report/subscription flows use) and
`split_code: splitCode`, `splitCode = chama.settlementSplitCode`. Payment confirmation is **not** in CYBER: the Paystack webhook of whichever account was charged applies it
(now `mychamaPaystackCallback` for the new account).

## What the patch changes (and the manual steps it cannot do)
1. **New secret** — the patch declares `MYCHAMA_PAYSTACK_SECRET_KEY`; **you** must create its value in CYBER's Firebase project before deploying: `firebase functions:secrets:set MYCHAMA_PAYSTACK_SECRET_KEY` (the new account's key).
   Declare it **once**, e.g. in `config/paystack.config.ts`: `export const MYCHAMA_PAYSTACK_SECRET_KEY = defineSecret('MYCHAMA_PAYSTACK_SECRET_KEY');`
2. **`services/mychama.payment.service.ts`** — use it for the charge only: the guard at ≈ line 214 (`if (!PAYSTACK_SECRET_KEY.value())`) and the `Authorization` header at ≈ line 266 switch to `MYCHAMA_PAYSTACK_SECRET_KEY.value()`.
   Do **not** change `CYBER_`, `SHOP_`, `REPORT_`, `SUB_`, `INV_` flows: `payment.charge.service.ts`, `payment.split.service.ts`, `report.charge.service.ts`, `webhooks/paystack-callback.ts`
   keep `PAYSTACK_SECRET_KEY` (old account).
3. **Bind the secret** on every function that can reach `initiateMyChamaPayment`: today `whatsappWebhook` in `index.ts` (≈ line 1864, `secrets: [... PAYSTACK_SECRET_KEY]`) → add `MYCHAMA_PAYSTACK_SECRET_KEY`.
   `grep -rn "initiateMyChamaPayment\|mychama.handler" functions/src` and bind it on any other entry point found. An unbound secret reads as an empty string and the charge fails.
4. **Refuse un-migrated chamas.** In `handlers/mychama.handler.ts` where it checks `ctx.chama.settlementSplitCode` (≈ lines 2128 and the earlier `canCollectOnline` block ≈ 2120–2130), also require
   `ctx.chama.settlementSplitKeyVersion === 2` and answer with the same "ask the chair to re-link the settlement account" message. A split code without that marker belongs to the OLD account and will make Paystack reject the charge.
5. **Keep sending `split_code`** in the payload (CYBER already does — Chama's Python did not; fixed in `track-B-chama.patch`).
6. Optional hardening: it already stores `arrearId` on the intent; keep it.

## Not changed on purpose
Chama-side behaviour such as `getChama()` already spreads the whole chama document, so `settlementSplitKeyVersion` reaches the handler with only the type addition. CYBER's own Paystack webhook (`webhooks/paystack-callback.ts`) does not handle `MCW-` references and stays untouched; confirmation comes from `mychamaPaystackCallback` in the PAY project.

## Order (see `cutover.md` §6)
Split migration first → deploy Chama (new key + guard) → deploy CYBER with the above → write the cutover timestamp. If CYBER is deployed **before** the chama is migrated, its charge fails for that chama (no marker) — the guard in step 4 makes that a clean message instead of a Paystack error.

## Verify
WhatsApp "pay contribution" for a test chama → STK arrives → `paymentIntents/MCW-…` becomes `success` via `mychamaPaystackCallback` (logs show no signature errors) → funds appear under the chama's subaccount in the **new** Paystack dashboard. A `CYBER_` shop payment still lands in the **old** account.
