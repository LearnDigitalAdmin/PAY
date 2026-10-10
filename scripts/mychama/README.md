# scripts/mychama (Track B)

| Script | Purpose | Needs |
|---|---|---|
| `test-fees.mjs` | `pay/fees.ts` vs `fee-vectors.json` (1,832 outputs of the real Chama Python engine) | Node ≥ 22.18 |
| `gen-fee-vectors.py` | Regenerate `fee-vectors.json` after any change to Chama `shared/money.py`/`constants.py` | `python3`, Chama checkout |
| `test-money-plane.mjs` | Signature (valid/invalid/replayed), references, handlers, dispatcher, HTTP webhook, `mychamaPayInitiate` | `cd functions && npm run build` first. In-memory Firestore by default; `--emulator` + `FIRESTORE_EMULATOR_HOST` for the real emulator |
| `test-migrate.mjs` | `migrate-splits.mjs` with a stubbed Admin SDK and Paystack | build not needed |
| `migrate-splits.mjs` | Re-create subaccount+split per chama under the NEW key; `--dry-run` (default) / `--apply` / `--rollback` | ADC for mychama1, `MYCHAMA_PAYSTACK_NEW_KEY` for `--apply` |
| `set-cutover.mjs` | Write/clear `mychamaConfig/cutover` in the plot project | ADC for the plot project |

`_fake-firestore.mjs` is the in-memory Firestore shared by the tests. See `docs/mychama/cutover.md` for the order of operations.
