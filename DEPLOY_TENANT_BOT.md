# Lipa Mdogo Mdogo: tenant web app (PAY) and WhatsApp bot (DESK)

Two patches, deployed separately. Neither needs PMS. Both follow `LMM_CONTRACT.md` (contract version 1).

| Patch | Repo | Base | Deploy |
|---|---|---|---|
| `lmmx-tenant-pay.patch` | PAY | `400c8744cdc471b56232cd82a1f56318185ebd49` | hosting only (`src/**`) |
| `lmmx-bot-desk.patch` | DESK | `42e28baa7cbfc0ad3597150501e3c29935f74659` | one function: `whatsappWebhook` |

The money, identity and fee logic is CORE's (PAY `functions/`). Until CORE's `lmmx_tenant_*` and `lmmx_bot_*` callables are deployed, the real screens cannot work; use mock mode (below) to try everything.

## 1. PAY tenant web app

```bash
git apply --check lmmx-tenant-pay.patch && git apply lmmx-tenant-pay.patch
npm ci && npm run build && firebase deploy --only hosting --project plot-9fd6e   # site: payments-1x
```

* `npm run build` must be run WITHOUT `VITE_LMMX_MOCK` for production. With `VITE_LMMX_MOCK=true` the `/lmmx/demo` page and fake data are included: never deploy that build.
* Contract drift check (after CORE's patch is applied): `npm run check:lmmx-contract`. Before CORE's copy exists it says so and exits 1.
* What changed for existing users: after a tenant signs in with the phone code they now pass through `/lmmx` first. A tenant who already has a rent-invoice profile is checked quietly and, unless they also have a Lipa Mdogo Mdogo account, lands on `/tenant` exactly as before. If that check fails for any reason they also land on `/tenant`. Landlord (agent) sign-in is untouched.
* The legacy plan screens only had their name changed to "Lipa Mdogo Mdogo" (`LipaMosMos.tsx`, `TenantView.tsx`, `AgentView.tsx`); code names are unchanged.

### Mock mode (web)

```bash
VITE_LMMX_MOCK=true npm run dev
# open http://localhost:5173/lmmx/demo
```

"Demo tools" on that page switch scenario (active, awaiting setup, frozen, cooling-off, deferred, waiting for a code, paid up) and can make the next call fail with any error code. Fake IDs on the link screen (needs a sign-in, so this is for `/lmmx`): `11111111` Lipa Mdogo Mdogo only, `22222222` invoice only, `33333333` both, `99999999` rate-limited, anything else "not found". Codes: `LMM4683` / `LMC7391` right, `LMM0000` expired, `LMM9999` locked, any other wrong (counts tries). Paying from `0700000000` ends as declined; any other number succeeds after about 6 seconds.

## 2. WhatsApp bot (DESK `functions/src`, codebase `default`)

```bash
git apply --check lmmx-bot-desk.patch && git apply lmmx-bot-desk.patch
cd functions && npm ci && npx tsc && node --test "lib/__tests__/**/*.test.js" && cd ..
bash deploy-lmmx.sh          # deploys functions:default:whatsappWebhook (the only function changed)
```

* `bash deploy-lmmx.sh <names...>` deploys other `default` functions the same careful way (3 per batch, retries, pauses). `DRY_RUN=1` prints the plan, `PROJECT=plot-9fd6e` picks the project.
* Only `whatsappWebhook` changed. `functions-desk/` (codebase `desk`) and `src/desk/**` are not touched.
* Baseline note: 2 House to Rent tests (`sendInquiry`, the inquire-once-per-day rule) already fail on the untouched base commit. They are unrelated and unchanged; everything else passes.

### The secret

The bot signs every call to PAY with `LMMX_BOT_KEY`, read from the shared secret bundle (`app-secrets-bundle`), exactly like the other bot secrets. CORE's instructions say how to create it; the same value must be in PAY's bundle so PAY can check the signature. Nothing new is bound to the function: `whatsappWebhook` already has the bundle.

Without it: no call to PAY is ever sent (the bot fails closed). Menu options 9 and 10 still open; Lipa Mdogo Mdogo says "Something went wrong on our side, please try again in a few minutes", Join shows the built-in text with the support number, and a `LMM1234` message gets "We could not check that code right now". Pay Rent, Invoice, My Chama, Landlord Watch, House to Rent and the legacy plan flow are unaffected.

### Mock mode (bot)

`LMMX_MOCK=1` answers every PAY call from fixtures (no network, no secret). The tests set it themselves. To try it in a real chat, put `LMMX_MOCK=1` in `functions/.env`, deploy, and REMOVE IT AGAIN afterwards: in mock mode nothing real is charged, but replies are fake.
Fake IDs: `11111111` active, `22222222` legacy, `33333333` frozen, `44444444` awaiting setup, anything else not found. Codes: `LMM4683` setup confirmed, `LMM5555` change confirmed, `LMC4683` change cancelled, `LMM0000` expired, `LMM9999` locked, `LMM2222` not found, other codes invalid. Paying from `0700000000` is refused; from `0711111111` it times out.

## 3. Manual test script (owner)

Use a real tenant set up by a desk (with the SMS code not yet used) and a second phone with no account.

**Web: sign in and link**
1. Open the PAY site, choose Tenant, sign in with the tenant's phone code. You should land on a "Find your Lipa Mdogo Mdogo account" screen.
2. Enter a wrong ID: one generic failure message (it must not say whether the phone or the ID was wrong). Enter the right ID: you reach the dashboard. If the same person is also a Plot Yangu tenant, a two-card chooser appears first.
3. Awaiting setup: the dashboard shows "One last step". Type `LMM####` from the SMS (or just the 4 digits): it turns active. A wrong code shows tries left; five wrong ones lock it.

**Web: pay, history, settings**
4. Pay tab: type an amount (try 5 = refused, 10 = accepted, a quick button). The three lines "Goes to your rent / Fees / You pay" appear (first as an estimate, then the exact price). Approve the M-PESA prompt: the screen says "Check your phone", then "Payment received" only after the balance on Home has gone down. Cancel the prompt on the phone: it should end as "did not go through" or, after two minutes, "We have not seen the payment yet" (do not claim success).
5. History lists it. Settings: change the due day once (works, says it starts next cycle), try again at once (refused with the lock rule explained). Change frequency and suggested amount.
6. If a desk has requested a change: it shows under "A change is waiting"; confirm it with `LMM####`, or cancel it with `LMC####` in "Cancel this change".

**Bot**
7. From a fresh chat, send `hi`, pick a language, open the main menu: you should see "Lipa Mdogo Mdogo" and "Join Lipa Mdogo Mdogo" (10 rows, Exit last). "Pay Rent" now says "Pay your rent invoice now with M-Pesa".
8. Lipa Mdogo Mdogo, tenant ID: status shows rent, still to pay, due date and pay-by date. Pay now: suggested amount button, then the quote (rent / fees / you pay), M-Pesa number (button for your own number), Confirm. You get "M-Pesa prompt sent" and, after PIN, your SMS. Check balance shows the new balance. `0` goes back, `#` main menu, `00` and `000` as in the other flows.
9. From the second phone (or a wrong ID): "We could not find an account", with Try again, Join Lipa Mdogo and Main menu. Join shows the support numbers.
10. Awaiting-setup tenant: the bot says to send the SMS code. Frozen tenant: "on hold, contact support".
11. **Code from a fresh chat**: with a brand-new chat (or mid-way through any other flow), send `LMM####` from the tenant's own phone. The reply confirms the setup or change; the chat stays where it was. Repeat with `LMC####` for a change you want to cancel, a wrong code, and the same code twice (expired or invalid).

**Legacy paths still working**
12. Pay Rent (menu 1): ID, tenant-found screen now lists Pay in full, Search again, Main menu (no Lipa Mdogo Mdogo button). Pay a small amount to confirm the STK still arrives.
13. Legacy plan: Lipa Mdogo Mdogo (menu 9) with the ID of a tenant whose landlord is on Plot Yangu: the existing plan screens appear (progress, Pay now, Change how often) and a small payment still works. Back from there goes to the Pay Rent tenant screen.
14. Landlord sign-in on the PAY site and a legacy-only tenant sign-in (they should land on their invoices after a moment's "Checking your account…", with no new questions).
