// The ONE function that starts a rent STK push. processPayment (landlord / tenant initiated) calls it, and so will the
// desk-initiated batch runner. Extracted from processPayment — the Paystack call, the records and the payload are the
// same; what changed is the money: see ./rentFees — the tenant is charged rent + a capped surcharge, the landlord's
// subaccount receives EXACTLY rent - (its part of Paystack's fee + the 0.2% convenience fee), via a flat split.
import * as admin from "firebase-admin";
import axios from "axios";
import { HttpsError } from "firebase-functions/v2/https";
import { deskDb } from "./db";
import { getDeskConfig } from "./config";
import { resolveDeskOwner } from "./owner";
import { rentFees, RENT_FEE_RULES } from "./rentFees";
import { floorPct2, toBps } from "./money";
import { getOrCreateFlatSplit, type FlatSub } from "./split";
import { writeDeskAudit } from "./events";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "./paystack";
import type { DeskCommission } from "./types";

export interface RentChargeInput {
  email: string;
  /** KES the tenant pays now (what the STK prompt asks for). */
  amount: number;
  currency: string;
  phone: string;
  provider: string;
  metadata: { userId: string; userName: string; invoiceId: string; billingMonth: string; arrears: unknown; agentId: string };
  /** Set only for a desk-initiated charge. The 3-way split applies only if this desk is the landlord's owner. */
  desk?: { agentId: string; batchId: string };
}

export interface RentChargeResult { reference: string; status: string; displayText: string; accountReference?: string }

/** +254XXXXXXXXX for Paystack's Kenya M-Pesa charge (same normalisation processPayment always used). */
export function formatKenyaPhone(phone: string): string {
  let p = String(phone).replace(/[\s-]/g, "");
  if (p.startsWith("+254")) return p;
  if (p.startsWith("254")) return "+" + p;
  if (p.startsWith("0")) return "+254" + p.substring(1);
  if (p.startsWith("7") || p.startsWith("1")) return "+254" + p;
  if (p.startsWith("+")) return "+254" + p.substring(1);
  return p;
}

export async function initiateRentCharge(input: RentChargeInput): Promise<RentChargeResult> {
  const db = deskDb();
  const { email, amount, currency, phone, provider, metadata } = input;
  const { userId, userName, invoiceId, billingMonth, arrears, agentId } = metadata;

  const rentMinor = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(rentMinor) || rentMinor <= 0) throw new HttpsError("invalid-argument", "Amount must be greater than zero");

  // The landlord (PAY/PMS call the landlord `agent`: users/{uid}); paymentInfo.accountId = the landlord's rent subaccount.
  const landlordDoc = await db.collection("users").doc(agentId).get();
  if (!landlordDoc.exists) throw new HttpsError("not-found", "Agent not found in database");
  const landlord = landlordDoc.data() as { paymentInfo?: { accountId?: string }; tier?: string; landlordCode?: string };
  const landlordSub = landlord.paymentInfo?.accountId;
  if (!landlordSub) throw new HttpsError("failed-precondition", "Agent has not set up payment account. Please configure payment details first.");

  // Desk part: only a desk that OWNS this landlord earns on rent. Any failure degrades to the normal two-way split.
  let ownerDesk: { agentId: string; agentCode: string; subaccountCode: string } | null = null;
  const entityKey = landlord.landlordCode ? `pms:${landlord.landlordCode}` : "";
  if (input.desk && entityKey) {
    try {
      const owner = await resolveDeskOwner(entityKey);
      if (owner && owner.agentId === input.desk.agentId) ownerDesk = owner;
    } catch (err) {
      console.error("Desk rent resolution failed — charging with the normal two-way split:", (err as Error)?.message);
      await writeDeskAudit({ action: "desk_rent_resolution_failed", agentId: input.desk.agentId, entityKey, meta: { batchId: input.desk.batchId, error: String((err as Error)?.message ?? err).slice(0, 300) } });
    }
  }

  const cfg = await getDeskConfig();
  const fees = rentFees(rentMinor);
  // An owning desk earns rentDeskSharePct of the convenience fee (a flat amount, paid out by the split).
  const agentMinor = ownerDesk ? Math.floor((fees.convenienceMinor * toBps(cfg.rentDeskSharePct)) / 10000) : 0;
  const subs: FlatSub[] = [{ subaccount: landlordSub, amountMinor: fees.netPayoutMinor }];
  if (ownerDesk && agentMinor > 0) subs.push({ subaccount: ownerDesk.subaccountCode, amountMinor: agentMinor });
  const splitCode = await getOrCreateFlatSplit(subs, "rent", fees.chargeMinor);

  const formattedPhone = formatKenyaPhone(phone);
  const reference = `INV_${userId}_${Date.now()}`;
  // The desk ledger works in % of what settles (gross - real fee); express the flat agent amount that way, rounded DOWN.
  const expectedSettled = fees.chargeMinor - Math.min(Math.round(fees.chargeMinor * RENT_FEE_RULES.paystackPct / 100), RENT_FEE_RULES.paystackCapMinor);
  const agentSharePct = agentMinor > 0 ? floorPct2((agentMinor * 100) / expectedSettled) : 0;
  const deskCommission: DeskCommission | null = ownerDesk && agentSharePct > 0
    ? { agentCode: ownerDesk.agentCode, agentId: ownerDesk.agentId, sharePct: agentSharePct, rule: "rent", entityKey }
    : null;

  const chargePayload = {
    email,
    amount: fees.chargeMinor,   // the tenant pays rent + surcharge; the invoice is still credited the rent
    currency,
    mobile_money: { phone: formattedPhone, provider },
    reference,
    split_code: splitCode,
    metadata: {
      userId, userName, invoiceId, billingMonth, arrears, agentId, originalAmount: amount,
      rentMinor: fees.rentMinor, tenantFeeMinor: fees.tenantFeeMinor, chargeMinor: fees.chargeMinor, netPayoutMinor: fees.netPayoutMinor,
      ...(input.desk ? { deskBatchId: input.desk.batchId, deskAgentId: input.desk.agentId } : {}),
    },
  };

  const paystackResponse = await axios.post(`${PAYSTACK_API_BASE}/charge`, chargePayload, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, "Content-Type": "application/json" },
  });
  if (!paystackResponse.data.status) {
    throw new HttpsError("internal", `Paystack API error: ${paystackResponse.data.message}`);
  }
  const tx = paystackResponse.data.data;
  const status = tx.status || "pending";   // can be "pay_offline", "pending", etc.

  const paymentRecord = {
    userName, agentId, amount, arrears, invoiceId, billingMonth, currency, phone: formattedPhone, provider,
    reference: tx.reference, status, displayText: tx.display_text, accountReference: tx.account_reference,
    initiatedAt: new Date().toISOString(), subaccountCode: landlordSub, commissionRate: RENT_FEE_RULES.conveniencePct, splitCode,
    // collected = `amount` (the rent); the landlord is deducted, the tenant paid the surcharge on top
    tenantFee: fees.tenantFeeMinor / 100, chargedAmount: fees.chargeMinor / 100, landlordPaystackFee: fees.landlordPaystackMinor / 100,
    convenienceFee: fees.convenienceMinor / 100, totalDeductions: fees.deductionsMinor / 100, netPayout: fees.netPayoutMinor / 100,
  };
  await db.collection("payments").doc(userId).collection("billingMonths").doc(billingMonth).set(
    { payments: admin.firestore.FieldValue.arrayUnion(paymentRecord), lastUpdated: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true },
  );

  const txnDoc: Record<string, unknown> = {
    userName, email, phone: formattedPhone, provider, currency, userId, agentId, invoiceId, billingMonth, amount, arrears,
    status, reference: tx.reference, displayText: tx.display_text, accountReference: tx.account_reference, splitCode,
    // the money, so the books can be audited from the document alone
    tier: String(landlord.tier ?? "").toLowerCase() || null,
    rentMinor: fees.rentMinor, tenantFeeMinor: fees.tenantFeeMinor, chargeMinor: fees.chargeMinor,
    paystackEstimateMinor: fees.paystackEstimateMinor, landlordPaystackMinor: fees.landlordPaystackMinor,
    convenienceMinor: fees.convenienceMinor, deductionsMinor: fees.deductionsMinor, netPayoutMinor: fees.netPayoutMinor, agentMinor,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (deskCommission) txnDoc.deskCommission = deskCommission;
  if (input.desk) { txnDoc.deskBatchId = input.desk.batchId; txnDoc.deskAgentId = input.desk.agentId; }
  await db.collection("transactions").doc(tx.reference).set(txnDoc);

  return { reference: tx.reference, status: tx.status, displayText: tx.display_text || "Check your phone for the M-Pesa prompt", accountReference: tx.account_reference };
}

