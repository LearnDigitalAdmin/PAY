// MyChama payment-application handlers (MCW-/MCA-/MCS-/MCP-/MCX-/MCR-).
// Moved VERBATIM out of index.ts by P0 so the legacy webhook (index.ts) and
// the new MyChama-only webhook (./index.ts, Track B) share ONE implementation.
// OWNED BY TRACK B after P0 (hardening allowed; keep exported signatures).
import * as admin from "firebase-admin";
import { mychamaDb } from "../config";
import { sendMyChamaSms } from "../sms";

// ============================================================================
// MYCHAMA — payment application, SMS top-up, plan billing
//
// This is the ONLY place any of these three things happen. mychama1's own
// Python functions (functions/mychama/{contributions,loans,mgr}.py) and
// CYBER's WhatsApp bot both only ever CREATE a paymentIntents doc and
// trigger a Paystack charge — neither one ever marks money as received.
// The spill-forward math below is a deliberate line-for-line port of
// functions/shared/money.py's counterparts in the Chama repo; if either
// side's formula changes, change both in the same commit (see that repo's
// docs/CONVENTIONS.md).
// ============================================================================

// ---------------------------------------------------------------------------
// Applying a confirmed payment
//
// EVERYTHING for one payment happens inside ONE Firestore transaction: the
// balance change, the transactions row, and flipping the intent to 'success'.
// Before, these were separate writes, so a crash or a Paystack retry landing
// between them could apply the money twice, or record it as received without
// applying it. Firestore requires all reads before any write in a
// transaction, so each purpose below has a `read*` half (gathers docs) and
// an `apply*` half (stages writes).
//
// Rules that never bend:
//   - Money received is NEVER dropped. If the target can no longer take the
//     payment (loan already completed by a cash entry, pot closed, etc.) the
//     whole amount becomes member credit and the intent says so in
//     `applyNote`, instead of being marked 'success' with nothing applied.
//   - The Paystack amount must equal the intent's grossAmount (contract in
//     the Chama repo's firestoreData.json → whatsappContract).
//   - Line-for-line parity with the app's recordCash* functions.
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * TRACK B — permanent-mismatch guard shared by every handler. Returns a reason string when the
 * Paystack payload must NOT be applied against the stored doc, else null.
 *   - currency (when supplied) must be KES
 *   - paidKobo (when supplied) must equal the stored KES amount * 100
 * A mismatch is PERMANENT (a retry can't fix it): callers write `applyNote`/`applyBlockedAt` on the doc,
 * log, apply nothing and let the webhook answer 200. Transient errors are NOT handled here — they throw,
 * the webhook answers 500 and Paystack retries.
 */
function paymentMismatch(expectedKes: unknown, paidKobo?: number, currency?: string): string | null {
  if (typeof currency === "string" && currency.toUpperCase() !== "KES") {
    return `Paystack currency ${currency} is not KES — nothing applied`;
  }
  if (typeof paidKobo === "number") {
    const expected = Math.round(Number(expectedKes) * 100);
    if (!Number.isFinite(expected) || expected <= 0) return "stored amount is invalid — nothing applied";
    if (paidKobo !== expected) return `amount mismatch (expected ${expected}, paid ${paidKobo} minor units) — nothing applied`;
  }
  return null;
}

type MyChamaTx = admin.firestore.Transaction;
type MyChamaDb = admin.firestore.Firestore;

interface ApplyOutcome {
  /** Extra fields for the intent document (e.g. why money became credit). */
  intentPatch: Record<string, unknown>;
  /** Extra fields for the transactions document. */
  txnPatch: Record<string, unknown>;
}

/** Contribution spill-forward, oldest period first from the paid one. */
async function applyContributionInTx(
  tx: MyChamaTx,
  db: MyChamaDb,
  chamaId: string,
  intent: admin.firestore.DocumentData,
  amount: number,
  now: number
): Promise<ApplyOutcome> {
  const memberRef = db.doc(`chamas/${chamaId}/members/${intent.memberId}`);
  const snap = await tx.get(
    db.collection(`chamas/${chamaId}/contributions`).where("memberId", "==", intent.memberId)
  );
  const memberSnap = await tx.get(memberRef);
  const member = memberSnap.data() || {};

  const all = snap.docs.sort((a, b) => (a.data().periodKey || "").localeCompare(b.data().periodKey || ""));
  const startIdx = Math.max(0, all.findIndex((d) => d.id === intent.contributionId));

  let remaining = amount;
  let appliedTotal = 0;
  for (const doc of all.slice(startIdx)) {
    if (remaining <= 0.009) break;
    const data = doc.data();
    const due = (data.amount || 0) - (data.paidAmount || 0);
    if (due <= 0.009) continue;
    const applied = Math.min(due, remaining);
    const newPaid = round2((data.paidAmount || 0) + applied);
    remaining = round2(remaining - applied);
    appliedTotal = round2(appliedTotal + applied);
    const newStatus = newPaid >= data.amount - 0.01 ? "paid" : "partial";
    const update: Record<string, unknown> = { paidAmount: newPaid, status: newStatus, updatedAt: now };
    if (newStatus === "paid" && !data.paidOn) update.paidOn = new Date().toISOString().slice(0, 10);
    tx.update(doc.ref, update);
  }

  const creditDelta = remaining > 0.009 ? round2(remaining) : 0;
  tx.update(memberRef, {
    creditBalance: round2((member.creditBalance || 0) + creditDelta),
    totalContributed: round2((member.totalContributed || 0) + appliedTotal),
    updatedAt: now,
  });

  return {
    intentPatch: creditDelta ? { applyNote: `KES ${creditDelta} exceeded what was due and was credited to the member` } : {},
    txnPatch: {},
  };
}

/** Loan schedule spill-forward; leftover after the last instalment → credit. */
async function applyLoanInTx(
  tx: MyChamaTx,
  db: MyChamaDb,
  chamaId: string,
  intent: admin.firestore.DocumentData,
  amount: number,
  now: number
): Promise<ApplyOutcome> {
  const memberRef = db.doc(`chamas/${chamaId}/members/${intent.memberId}`);
  const loanRef = intent.loanId ? db.doc(`chamas/${chamaId}/loans/${intent.loanId}`) : null;
  const loanSnap = loanRef ? await tx.get(loanRef) : null;
  const memberSnap = await tx.get(memberRef);
  const member = memberSnap.data() || {};
  const loan = loanSnap?.exists ? loanSnap.data()! : null;

  const creditAll = (why: string): ApplyOutcome => {
    tx.update(memberRef, { creditBalance: round2((member.creditBalance || 0) + amount), updatedAt: now });
    return { intentPatch: { applyNote: why }, txnPatch: {} };
  };

  if (!loan) return creditAll("loan not found — full amount credited to the member");
  if (loan.memberId !== intent.memberId) return creditAll("loan belongs to another member — full amount credited to the payer");
  if (!["active", "overdue"].includes(loan.status)) {
    return creditAll(`loan is ${loan.status} — full amount credited to the member`);
  }

  const schedule = (loan.schedule || []).map((s: any) => ({ ...s }));
  let remaining = amount;
  for (const inst of schedule) {
    if (remaining <= 0.009) break;
    const due = inst.due - (inst.paidAmount || 0);
    if (due <= 0.009) continue;
    const applied = Math.min(due, remaining);
    inst.paidAmount = round2((inst.paidAmount || 0) + applied);
    remaining = round2(remaining - applied);
    inst.paid = inst.paidAmount >= inst.due - 0.01;
  }

  const newStatus = schedule.every((s: any) => s.paid) ? "completed" : "active";
  tx.update(loanRef!, { schedule, status: newStatus, updatedAt: now });

  let note: string | undefined;
  if (remaining > 0.009) {
    const creditDelta = round2(remaining);
    tx.update(memberRef, { creditBalance: round2((member.creditBalance || 0) + creditDelta), updatedAt: now });
    note = `KES ${creditDelta} exceeded the loan balance and was credited to the member`;
  }
  return { intentPatch: note ? { applyNote: note } : {}, txnPatch: {} };
}

/**
 * MGR contribution — for the pot's CURRENT period, accumulating part
 * payments exactly like the app's recordCashMgrPayment — or, when the intent
 * carries an `arrearId`, a payment toward that member's open arrear.
 */
async function applyMgrInTx(
  tx: MyChamaTx,
  db: MyChamaDb,
  chamaId: string,
  intent: admin.firestore.DocumentData,
  amount: number,
  reference: string,
  now: number
): Promise<ApplyOutcome> {
  const memberRef = db.doc(`chamas/${chamaId}/members/${intent.memberId}`);
  const potRef = db.doc(`chamas/${chamaId}/mgrPots/${intent.potId}`);
  const today = new Date().toISOString().slice(0, 10);

  const potSnap = await tx.get(potRef);
  const memberSnap = await tx.get(memberRef);
  const member = memberSnap.data() || {};
  const pot = potSnap.exists ? potSnap.data()! : null;

  const creditAll = (why: string): ApplyOutcome => {
    tx.update(memberRef, { creditBalance: round2((member.creditBalance || 0) + amount), updatedAt: now });
    return { intentPatch: { applyNote: why }, txnPatch: {} };
  };
  const ledger = (kind: string, amt: number, note: string) => {
    tx.set(db.collection(`chamas/${chamaId}/mgrPots/${intent.potId}/ledger`).doc(), {
      kind, memberId: intent.memberId, amount: amt, note, createdAt: now,
    });
  };

  if (!pot) return creditAll("pot not found — full amount credited to the member");

  // ---------------------------------------------------------- arrear ----
  if (intent.arrearId) {
    const arrearRef = db.doc(`chamas/${chamaId}/mgrPots/${intent.potId}/arrears/${intent.arrearId}`);
    const arrearSnap = await tx.get(arrearRef);
    const arrear = arrearSnap.exists ? arrearSnap.data()! : null;

    if (!arrear || arrear.memberId !== intent.memberId || arrear.status !== "open") {
      return creditAll("arrear is no longer open — full amount credited to the member");
    }

    const payAmount = Math.min(amount, arrear.amount);
    const remaining = round2(arrear.amount - payAmount);
    tx.update(arrearRef, {
      amount: remaining,
      status: remaining <= 0 ? "settled" : "open",
      settledAmount: round2((arrear.settledAmount || 0) + payAmount),
      updatedAt: now,
    });
    ledger("arrear_settled", payAmount, "paystack");

    const excess = round2(amount - payAmount);
    if (excess > 0.009) {
      tx.update(memberRef, { creditBalance: round2((member.creditBalance || 0) + excess), updatedAt: now });
    }
    return {
      intentPatch: excess > 0.009 ? { applyNote: `KES ${excess} exceeded the arrear and was credited to the member` } : {},
      txnPatch: { potId: intent.potId, note: `${pot.name} arrear settlement` },
    };
  }

  // ------------------------------------------------- current period ----
  if (pot.status !== "active") {
    return creditAll("pot is not collecting — full amount credited to the member");
  }
  if (typeof intent.potPeriod === "number" && intent.potPeriod !== pot.period) {
    // The period rolled over between charge and confirmation. Do NOT pay the
    // new period with money meant for the old one — credit it instead.
    return creditAll(`period ${intent.potPeriod} closed before payment arrived — full amount credited to the member`);
  }

  const recQ = await tx.get(
    db.collection(`chamas/${chamaId}/mgrPots/${intent.potId}/records`)
      .where("memberId", "==", intent.memberId)
      .where("period", "==", pot.period)
      .limit(1)
  );
  const existing = recQ.empty ? null : recQ.docs[0];
  const ex = existing?.data();

  // Same accumulation rule as the app: only a 'partial' record's amount
  // counts as already paid. A 'paid' record means the period is done.
  if (ex?.status === "paid") {
    return creditAll("period was already fully paid — full amount credited to the member");
  }
  const alreadyPaid = ex?.status === "partial" ? ex.amount || 0 : 0;
  const room = Math.max(0, round2(pot.amount - alreadyPaid));
  const applied = Math.min(amount, room);
  const newTotal = round2(alreadyPaid + applied);
  const newStatus = newTotal >= pot.amount - 0.01 ? "paid" : "partial";

  const recPatch = { status: newStatus, amount: newTotal, date: today, method: "paystack", ref: reference, updatedAt: now };
  if (existing) {
    tx.update(existing.ref, recPatch);
  } else {
    tx.set(db.collection(`chamas/${chamaId}/mgrPots/${intent.potId}/records`).doc(), {
      period: pot.period, memberId: intent.memberId, createdAt: now, ...recPatch,
    });
  }
  ledger("contribution", applied, "paystack" + (newStatus === "partial" ? " (partial)" : ""));

  // Excess beyond the period: open arrear first (that's what the member
  // owes), otherwise member credit. Never silently dropped.
  const excess = round2(amount - applied);
  let note: string | undefined;
  if (excess > 0.009) {
    tx.update(memberRef, { creditBalance: round2((member.creditBalance || 0) + excess), updatedAt: now });
    note = `KES ${excess} exceeded what was due this period and was credited to the member`;
  }
  return {
    intentPatch: note ? { applyNote: note } : {},
    txnPatch: { potId: intent.potId, note: pot.name + (newStatus === "partial" ? " (partial)" : "") },
  };
}

/**
 * Applies an MCW-/MCA- payment once Paystack confirms it. `reference` is
 * both the Paystack reference and the mychama1 paymentIntents document ID.
 *
 * Idempotent: the 'success' check happens INSIDE the transaction, so two
 * concurrent deliveries of the same event (webhook retry + the reconcile
 * sweep below) cannot both apply.
 *
 * `paidKobo` is the amount Paystack reports (event.data.amount). When given,
 * it must equal the intent's grossAmount — a mismatch means a tampered or
 * stale reference and nothing is applied.
 * `currency` (Track B) is Paystack's event.data.currency; when given it must be "KES".
 * A mismatch is permanent: nothing is applied, the intent gets an `applyNote` +
 * `applyBlockedAt`, a whatsappAuditLog row is written, and the function RETURNS (the webhook
 * answers 200 — a retry cannot fix it). Thrown errors are transient (webhook 500 => retry).
 */
export async function handleMyChamaPayment(
  reference: string,
  chamaIdHint?: string,
  paidKobo?: number,
  currency?: string
): Promise<void> {
  const db2 = mychamaDb();

  const parts = reference.split("-");
  const chamaId = chamaIdHint || parts[1];
  if (!chamaId) {
    console.error("MyChama payment: could not determine chamaId from reference", reference);
    return;
  }

  const intentRef = db2.doc(`chamas/${chamaId}/paymentIntents/${reference}`);
  const txnRef = db2.doc(`chamas/${chamaId}/transactions/${reference}`);

  const outcome = await db2.runTransaction(async (tx) => {
    const intentSnap = await tx.get(intentRef);
    if (!intentSnap.exists) return { kind: "missing" as const };
    const intent = intentSnap.data()!;
    if (intent.status === "success") return { kind: "already" as const };

    const blocked = paymentMismatch(intent.grossAmount, paidKobo, currency);
    if (blocked) {
      const now0 = Date.now();
      tx.update(intentRef, { applyNote: blocked, applyBlockedAt: now0, updatedAt: now0 });
      return {
        kind: "mismatch" as const,
        reason: blocked,
        expected: Math.round((intent.grossAmount || 0) * 100),
        got: paidKobo,
        currency,
      };
    }

    const now = Date.now();
    const amount: number = intent.amount;
    let result: ApplyOutcome;

    if (intent.purpose === "contribution") {
      result = await applyContributionInTx(tx, db2, chamaId, intent, amount, now);
    } else if (intent.purpose === "loan_repayment") {
      result = await applyLoanInTx(tx, db2, chamaId, intent, amount, now);
    } else if (intent.purpose === "mgr_contribution" && intent.potId) {
      result = await applyMgrInTx(tx, db2, chamaId, intent, amount, reference, now);
    } else {
      // Unknown or untargeted purpose. Money WAS received, so credit it and
      // say so — never mark an untargeted payment as cleanly applied.
      const memberRef = db2.doc(`chamas/${chamaId}/members/${intent.memberId}`);
      const member = (await tx.get(memberRef)).data() || {};
      tx.update(memberRef, { creditBalance: round2((member.creditBalance || 0) + amount), updatedAt: now });
      result = { intentPatch: { applyNote: "payment had no valid target — full amount credited to the member" }, txnPatch: {} };
    }

    tx.set(txnRef, {
      type: intent.purpose,
      memberId: intent.memberId,
      amount,
      grossAmount: intent.grossAmount,
      paystackFee: intent.paystackFee,
      ourFee: intent.ourFee,
      method: "paystack",
      ref: reference,
      date: new Date().toISOString().slice(0, 10),
      settled: false,
      direction: "in",
      channel: intent.channel || "app",
      intentId: reference,
      createdAt: now,
      ...result.txnPatch,
    });
    tx.update(intentRef, { status: "success", updatedAt: now, ...result.intentPatch });

    return { kind: "applied" as const, memberId: intent.memberId as string, amount };
  });

  if (outcome.kind === "missing") {
    console.error("MyChama payment: no matching paymentIntent for reference", reference);
    return;
  }
  if (outcome.kind === "mismatch") {
    console.error("MyChama payment: amount mismatch — NOT applied", reference, outcome);
    try {
      await db2.collection("whatsappAuditLog").add({
        action: "payment.apply",
        outcome: "denied",
        chamaId,
        reference,
        detail: { reason: outcome.reason, expectedKobo: outcome.expected, paidKobo: outcome.got, currency: outcome.currency },
        createdAt: Date.now(),
      });
    } catch (e) {
      console.error("MyChama payment: audit write failed (non-fatal):", e);
    }
    return;
  }
  if (outcome.kind === "already") return; // replayed event or sweep — nothing to do

  // Best-effort confirmation SMS — never fail the webhook for this (the
  // payment is already applied above and Paystack would retry the event).
  try {
    const memberSnap = await db2.doc(`chamas/${chamaId}/members/${outcome.memberId}`).get();
    const phone = memberSnap.data()?.phoneNormalized;
    if (phone) {
      await sendMyChamaSms(phone, `My Chama: payment of KES ${Math.round(outcome.amount)} received. Thank you.`);
    }
  } catch (e) {
    console.error("MyChama payment confirmation SMS failed (non-fatal):", e);
  }
}

/** Stages an "apply blocked" note on a non-payment doc (call INSIDE a transaction, before returning). */
function blockApply(tx: MyChamaTx, ref: admin.firestore.DocumentReference, note: string): void {
  const now = Date.now();
  tx.update(ref, { applyNote: note, applyBlockedAt: now, updatedAt: now });
}

/**
 * SMS credit top-up (MCS-). Track B: runs in ONE transaction (the old read-then-update could double-credit
 * if two deliveries raced), uses the same crediting rule as before (+amountKes), and checks Paystack's
 * amount/currency against the stored `amountKes`.
 */
export async function handleMyChamaSmsTopup(
  reference: string,
  chamaIdHint?: string,
  paidKobo?: number,
  currency?: string
): Promise<void> {
  const db2 = mychamaDb();
  const chamaId = chamaIdHint || reference.split("-")[1];
  if (!chamaId) return;

  const topupRef = db2.doc(`chamas/${chamaId}/smsTopUps/${reference}`);
  const chamaRef = db2.doc(`chamas/${chamaId}`);

  const out = await db2.runTransaction(async (tx) => {
    const topupSnap = await tx.get(topupRef);
    if (!topupSnap.exists) return "missing" as const;
    const topup = topupSnap.data()!;
    if (topup.status === "success") return "already" as const;
    const blocked = paymentMismatch(topup.amountKes, paidKobo, currency);
    if (blocked) {
      blockApply(tx, topupRef, blocked);
      return blocked;
    }
    const chama = (await tx.get(chamaRef)).data() || {};
    const now = Date.now();
    tx.update(chamaRef, { smsCredits: (chama.smsCredits || 0) + topup.amountKes, updatedAt: now });
    tx.update(topupRef, { status: "success", updatedAt: now });
    return "applied" as const;
  });
  logOutcome("MyChama SMS top-up", reference, out);
}

/**
 * Plan billing (MCP-). Track B: transactional; the stored doc is REQUIRED (a reference with no billing doc
 * applies nothing); the plan is `plan` (metadata.plan) falling back to the doc's `toPlan` — Chama's billing.py
 * sends `toPlan`, never `plan`, so the old `if (!plan) return` meant paid upgrades were silently dropped; a
 * metadata plan that disagrees with the doc blocks the apply; the amount/currency are checked against `amountKes`.
 */
const PAID_PLANS = ["starter", "basic", "growth", "max"];
export async function handleMyChamaPlanBilling(
  reference: string,
  chamaIdHint?: string,
  plan?: string,
  paidKobo?: number,
  currency?: string
): Promise<void> {
  const db2 = mychamaDb();
  const chamaId = chamaIdHint || reference.split("-")[1];
  if (!chamaId) return;

  const billingRef = db2.doc(`chamas/${chamaId}/planBilling/${reference}`);
  const chamaRef = db2.doc(`chamas/${chamaId}`);

  const out = await db2.runTransaction(async (tx) => {
    const billingSnap = await tx.get(billingRef);
    if (!billingSnap.exists) return "missing" as const;
    const billing = billingSnap.data()!;
    if (billing.status === "success") return "already" as const;

    const docPlan: string | undefined = typeof billing.toPlan === "string" ? billing.toPlan : undefined;
    if (plan && docPlan && plan !== docPlan) {
      const note = `plan in the charge metadata (${plan}) does not match the billing doc (${docPlan}) — nothing applied`;
      blockApply(tx, billingRef, note);
      return note;
    }
    const finalPlan = docPlan || plan;
    if (!finalPlan || !PAID_PLANS.includes(finalPlan)) {
      const note = "billing doc has no valid target plan — nothing applied";
      blockApply(tx, billingRef, note);
      return note;
    }
    const blocked = paymentMismatch(billing.amountKes, paidKobo, currency);
    if (blocked) {
      blockApply(tx, billingRef, blocked);
      return blocked;
    }

    const now = Date.now();
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    tx.update(chamaRef, { plan: finalPlan, planExpiry: expiry.toISOString().slice(0, 10), updatedAt: now });
    tx.set(billingRef, { status: "success", plan: finalPlan, updatedAt: now }, { merge: true });
    return "applied" as const;
  });
  logOutcome("MyChama plan billing", reference, out);
}

/**
 * Reports-engine prepaid wallet top-up (MCX-). Unlike smsCredits, this
 * wallet is CREDIT-denominated, not KES-denominated — mychama1's own
 * functions/shared/reports_engine.py spends it in credits, so this must
 * increment `reportCreditsBalance` by `topup.credits`, never by
 * `topup.amountKes`. See that repo's functions/mychama/reports.py::
 * purchaseReportCredits, which is what creates this pending doc.
 * Track B: transactional + amount/currency check against `amountKes`.
 */
export async function handleMyChamaReportCreditTopup(
  reference: string,
  chamaIdHint?: string,
  paidKobo?: number,
  currency?: string
): Promise<void> {
  const db2 = mychamaDb();
  const chamaId = chamaIdHint || reference.split("-")[1];
  if (!chamaId) return;

  const topupRef = db2.doc(`chamas/${chamaId}/reportCreditTopUps/${reference}`);
  const chamaRef = db2.doc(`chamas/${chamaId}`);

  const out = await db2.runTransaction(async (tx) => {
    const topupSnap = await tx.get(topupRef);
    if (!topupSnap.exists) return "missing" as const;
    const topup = topupSnap.data()!;
    if (topup.status === "success") return "already" as const;

    const credits = Number(topup.credits);
    if (!Number.isFinite(credits) || credits <= 0) {
      const note = `invalid credits value "${topup.credits}" — nothing applied`;
      blockApply(tx, topupRef, note);
      return note;
    }
    const blocked = paymentMismatch(topup.amountKes, paidKobo, currency);
    if (blocked) {
      blockApply(tx, topupRef, blocked);
      return blocked;
    }

    const chama = (await tx.get(chamaRef)).data() || {};
    const now = Date.now();
    tx.update(chamaRef, { reportCreditsBalance: (chama.reportCreditsBalance || 0) + credits, updatedAt: now });
    tx.update(topupRef, { status: "success", updatedAt: now });
    return "applied" as const;
  });
  logOutcome("MyChama report-credit top-up", reference, out);
}

/**
 * Starter/Basic one-off premium-report purchase (MCR-). Deliberately does
 * NOT touch any balance on the chama doc — mychama1's own generateReport /
 * generateStatement callables consume this purchase directly by its
 * reference once its status flips to "success" (see that repo's
 * functions/shared/reports_engine.py::consume_alacarte_purchase), so all
 * this webhook needs to do is flip pending -> success, exactly like plan
 * billing's status-only branch. The monthly à la carte CAP was already
 * reserved when the purchase doc was created (mychama1's own
 * purchasePremiumReportAlaCarte), not here.
 * Track B: transactional + amount/currency check against `amountKes`.
 */
export async function handleMyChamaReportAlacarte(
  reference: string,
  chamaIdHint?: string,
  paidKobo?: number,
  currency?: string
): Promise<void> {
  const db2 = mychamaDb();
  const chamaId = chamaIdHint || reference.split("-")[1];
  if (!chamaId) return;

  const purchaseRef = db2.doc(`chamas/${chamaId}/reportAlacartePurchases/${reference}`);

  const out = await db2.runTransaction(async (tx) => {
    const snap = await tx.get(purchaseRef);
    if (!snap.exists) return "missing" as const;
    const purchase = snap.data()!;
    if (purchase.status === "success") return "already" as const;
    const blocked = paymentMismatch(purchase.amountKes, paidKobo, currency);
    if (blocked) {
      blockApply(tx, purchaseRef, blocked);
      return blocked;
    }
    tx.update(purchaseRef, { status: "success", updatedAt: Date.now() });
    return "applied" as const;
  });
  logOutcome("MyChama report à-la-carte", reference, out);
}

/** "missing" / a block reason are logged (no phones, no secrets); "applied"/"already" are quiet. */
function logOutcome(what: string, reference: string, out: string): void {
  if (out === "missing") console.error(`${what}: no matching document for reference`, reference);
  else if (out !== "applied" && out !== "already") console.error(`${what}: NOT applied — ${out}`, reference);
}
