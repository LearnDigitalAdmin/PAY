#!/usr/bin/env python3
"""
Regenerates fee-vectors.json from the REAL Chama Python fee engine.
Usage:  python3 scripts/mychama/gen-fee-vectors.py /path/to/Chama
Run it again whenever Chama's functions/shared/money.py or constants.py change.
"""
import json, sys, os, random

if len(sys.argv) != 2:
    sys.exit("usage: gen-fee-vectors.py /path/to/Chama")
sys.path.insert(0, os.path.join(sys.argv[1], "functions"))
from shared.money import contribution_fees, loan_repayment_fees, mgr_contribution_fees  # noqa: E402
from shared.constants import LOAN_MARKUP_RATE, MGR_PAYOUT_MARKUP_RATE, PLANS  # noqa: E402
from shared.money import sms_credits_for_amount, main_account_charge_subunits  # noqa: E402

nets = [1, 5, 10, 49, 50, 99.99, 100, 100.125, 100.5, 250, 333.33, 500, 999, 1000, 1500.75,
        2500, 5000, 10000, 25000, 50000, 100000, 150000, 196000, 197000, 200000, 240000, 0.125, 0.5, 12.345]
random.seed(7)
nets += [round(random.uniform(1, 240000), 2) for _ in range(150)]
nets += [random.randint(1, 240000) for _ in range(50)]

rows = []
for n in nets:
    rows.append({"fn": "contribution", "net": n, "out": contribution_fees(n)})
    for plan in list(MGR_PAYOUT_MARKUP_RATE) + ["unknown_plan"]:
        rows.append({"fn": "mgr", "plan": plan, "net": n, "out": mgr_contribution_fees(n, plan)})
    for plan in list(LOAN_MARKUP_RATE) + ["unknown_plan"]:
        rows.append({"fn": "loan", "plan": plan, "net": n, "out": loan_repayment_fees(n, plan)})

sms = [{"amountKes": a, "plan": p, "credits": sms_credits_for_amount(a, p)}
       for a in [0.5, 0.9, 1, 10, 99, 100, 100.5, 250, 500, 999.99, 1000, 5000, 12345.67] for p in list(PLANS) + ["unknown_plan"]]

json.dump({"sms": sms, "plans_online": {k: v["onlineCollection"] for k, v in PLANS.items()}, "rows": rows},
          open(os.path.join(os.path.dirname(__file__), "fee-vectors.json"), "w"), indent=0)
print(f"wrote {len(rows)} vectors")
