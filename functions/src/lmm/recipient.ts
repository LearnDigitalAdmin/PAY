// The landlord's TRANSFER recipient. Created only from a request the landlord themself signed in to make (never from whatever is in
// Firestore later), sealed with a secret, and re-checked against Paystack immediately before every transfer.
import * as admin from "firebase-admin";
import axios from "axios";
import { PAYSTACK_API_BASE } from "../desk/paystack";
import { alertOps } from "./alert";
import { fingerprint, sameSeal, sealRecipient } from "./seal";

export type RecipientType = "mobile_money" | "mobile_money_business" | "kepss";
export interface RecipientDoc {
  landlordId: string; recipientCode: string; type: RecipientType; bankCode: string; fp: string; last4: string; name: string;
  status: "active" | "unsupported"; reason?: string; seal: string; createdAt: admin.firestore.FieldValue | number;
}
const col = () => admin.firestore().collection("lmm_recipients");
const auth = (secret: string) => ({ Authorization: `Bearer ${secret}`, "Content-Type": "application/json" });

/** Which Paystack recipient type a landlord's settlement choice maps to. Airtel and Paybill cannot be sent to, so they get no plan. */
export function recipientSpec(i: { settlementType: string; bankCode: string; accountNumber: string }):
  { ok: true; type: RecipientType; bankCode: string; accountNumber: string } | { ok: false; reason: string } {
  const t = String(i.settlementType || "").toLowerCase();
  const code = String(i.bankCode || "").trim();
  const acct = String(i.accountNumber || "").replace(/\s+/g, "");
  if (!acct) return { ok: false, reason: "no account number" };
  if (t === "airtel-ke" || /airtel/i.test(code)) return { ok: false, reason: "Airtel Money cannot receive transfers" };
  if (t === "paybill" || /paybill/i.test(code)) return { ok: false, reason: "Paybill needs an account reference and is not supported" };
  if (t === "till") return { ok: true, type: "mobile_money_business", bankCode: "MPTILL", accountNumber: acct };
  if (t === "mpesa" || code.toUpperCase() === "MPESA") return { ok: true, type: "mobile_money", bankCode: "MPESA", accountNumber: acct };
  if (code) return { ok: true, type: "kepss", bankCode: code, accountNumber: acct };
  return { ok: false, reason: "unknown settlement type" };
}

/** Creates (or replaces) the landlord's sealed recipient. Safe to call again with the same details. Never throws: no recipient just means no Lipa Mos Mos. */
export async function createSealedRecipient(
  secrets: { paystack: string; seal: string },
  i: { landlordId: string; settlementType: string; bankCode: string; accountNumber: string; name: string },
): Promise<{ ok: boolean; reason?: string }> {
  const spec = recipientSpec(i);
  const fpOf = (bank: string, acct: string) => fingerprint(secrets.seal, bank, acct);
  if (!spec.ok) {
    const doc: RecipientDoc = { landlordId: i.landlordId, recipientCode: "", type: "mobile_money", bankCode: "", fp: "", last4: "", name: i.name, status: "unsupported", reason: spec.reason, seal: "", createdAt: Date.now() };
    await col().doc(i.landlordId).set(doc);
    return { ok: false, reason: spec.reason };
  }
  try {
    const res = await axios.post(`${PAYSTACK_API_BASE}/transferrecipient`, {
      type: spec.type, name: i.name.slice(0, 100), account_number: spec.accountNumber, bank_code: spec.bankCode, currency: "KES",
    }, { headers: auth(secrets.paystack), timeout: 20_000 });
    const code = String(res.data?.data?.recipient_code ?? "");
    if (!res.data?.status || !/^RCP_[A-Za-z0-9]+$/.test(code)) return { ok: false, reason: "Paystack did not create the recipient" };
    const fp = fpOf(spec.bankCode, spec.accountNumber);
    const doc: RecipientDoc = {
      landlordId: i.landlordId, recipientCode: code, type: spec.type, bankCode: spec.bankCode, fp, last4: spec.accountNumber.slice(-4), name: i.name, status: "active",
      seal: sealRecipient(secrets.seal, { landlordId: i.landlordId, recipientCode: code, type: spec.type, bankCode: spec.bankCode, fp }), createdAt: Date.now(),
    };
    await col().doc(i.landlordId).set(doc);
    return { ok: true };
  } catch (err) {
    const msg = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message || (err as Error)?.message || "error";
    console.error("LMM recipient creation failed:", msg);
    return { ok: false, reason: String(msg).slice(0, 120) };
  }
}

/**
 * The recipient to pay, verified two ways: (1) the stored seal still matches (nobody edited the document), and (2) Paystack itself says
 * this recipient code is active and still points at the account whose fingerprint we sealed. Any doubt -> alert + null.
 */
export async function getVerifiedRecipient(secrets: { paystack: string; seal: string }, landlordId: string): Promise<RecipientDoc | null> {
  const snap = await col().doc(landlordId).get();
  const r = snap.data() as RecipientDoc | undefined;
  if (!r || r.status !== "active") { await alertOps("RECIPIENT_MISSING", `landlord ${landlordId} has no active recipient`); return null; }
  const want = sealRecipient(secrets.seal, { landlordId, recipientCode: r.recipientCode, type: r.type, bankCode: r.bankCode, fp: r.fp });
  if (r.landlordId !== landlordId || !sameSeal(r.seal, want)) { await alertOps("SEAL_MISMATCH", `recipient record for ${landlordId} was altered`); return null; }
  try {
    const res = await axios.get(`${PAYSTACK_API_BASE}/transferrecipient/${encodeURIComponent(r.recipientCode)}`, { headers: auth(secrets.paystack), timeout: 20_000 });
    const d = res.data?.data;
    const acct = String(d?.details?.account_number ?? "");
    const bank = String(d?.details?.bank_code ?? "");
    const ok = res.data?.status === true && d?.recipient_code === r.recipientCode && d?.active !== false && d?.is_deleted !== true && d?.isDeleted !== true
      && d?.type === r.type && bank.toUpperCase() === r.bankCode.toUpperCase() && fingerprint(secrets.seal, bank, acct) === r.fp;
    if (!ok) { await alertOps("RECIPIENT_MISMATCH", `Paystack recipient ${r.recipientCode} does not match what was sealed for ${landlordId}`); return null; }
  } catch (err) {
    await alertOps("RECIPIENT_MISMATCH", `could not verify recipient for ${landlordId}: ${(err as Error)?.message}`);
    return null;
  }
  return r;
}
