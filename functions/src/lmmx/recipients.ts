// The landlord's payout recipient (a sealed Paystack transfer recipient). Created only from a signed-in desk's request, sealed with LMM_SEAL_KEY,
// re-verified against Paystack right before every transfer. Names and contacts are stored hashed (matching) AND encrypted (reading back).
import axios from "axios";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "../desk/paystack";
import { fingerprint, LMM_SEAL_KEY, sameSeal, sealRecipient } from "../lmm/seal";
import { COL, X } from "./config";
import { LMMX, PAYSTACK_BANK_CODE, PAYSTACK_TYPE, maskName, normalizeKePhone } from "./contract";
import type { Channel, NameMatch, RecipientInput } from "./contract";
import { H, acctKey, enc, normName, randId, readToken, signToken, dec } from "./crypto";
import { fail } from "./errors";
import { alert, audit, col, now, rateOk } from "./store";
import type { RecipientDoc } from "./types";
import type { DeskCtx } from "./authz";

const hdr = () => ({ Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, "Content-Type": "application/json" });

export interface Spec { channel: Channel; bankCode: string; paystackBankCode: string; accountNumber: string; type: RecipientDoc["paystackType"] }
/** Validates and normalises the payout account. Paybill is not supported (it needs an account reference). */
export function specOf(i: Pick<RecipientInput, "channel" | "bankCode" | "accountNumber">): Spec {
  const channel = i.channel;
  if (channel === "phone") {
    const p = normalizeKePhone(i.accountNumber);
    if (!p) return fail("LMMX_E_VALIDATION", "Enter a valid M-PESA phone number.");
    return { channel, bankCode: "MPESA", paystackBankCode: PAYSTACK_BANK_CODE.phone!, accountNumber: "0" + p.slice(4), type: PAYSTACK_TYPE.phone };
  }
  const acct = String(i.accountNumber ?? "").replace(/\s+/g, "");
  if (channel === "till") {
    if (!/^\d{5,8}$/.test(acct)) return fail("LMMX_E_VALIDATION", "Enter a valid till number.");
    return { channel, bankCode: "MPTILL", paystackBankCode: PAYSTACK_BANK_CODE.till!, accountNumber: acct, type: PAYSTACK_TYPE.till };
  }
  if (channel === "bank") {
    const code = String(i.bankCode ?? "").trim();
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(code) || /paybill|airtel/i.test(code)) return fail("LMMX_E_VALIDATION", "Choose a bank from the list.");
    if (!/^[A-Za-z0-9-]{5,24}$/.test(acct)) return fail("LMMX_E_VALIDATION", "Enter a valid bank account number.");
    return { channel, bankCode: code, paystackBankCode: code, accountNumber: acct, type: PAYSTACK_TYPE.bank };
  }
  return fail("LMMX_E_VALIDATION", "Choose M-PESA phone, till or bank.");
}

/** Dice similarity over name words; passes with at least one shared full word and 0.6 overall. */
export function nameMatches(entered: string, resolved: string): boolean {
  const a = normName(entered).split(" ").filter(Boolean), b = normName(resolved).split(" ").filter(Boolean);
  if (!a.length || !b.length) return false;
  const common = a.filter((w) => b.includes(w)).length;
  return common >= 1 && (2 * common) / (a.length + b.length) >= 0.6;
}
/** The registered name Paystack knows for a BANK account (till and phone cannot be resolved). null when unavailable. */
async function resolveName(s: Spec): Promise<string | null> {
  if (s.channel !== "bank") return null;
  try {
    const r = await axios.get(`${PAYSTACK_API_BASE}/bank/resolve`, { params: { account_number: s.accountNumber, bank_code: s.paystackBankCode }, headers: hdr(), timeout: 15_000 });
    const n = r.data?.status ? String(r.data?.data?.account_name ?? "").trim() : "";
    return n || null;
  } catch { return null; }
}

export const sealOf = (r: Pick<RecipientDoc, "recipientId" | "recipientCode" | "paystackType" | "paystackBankCode" | "fp">): string =>
  sealRecipient(LMM_SEAL_KEY.value(), { landlordId: r.recipientId, recipientCode: r.recipientCode, type: r.paystackType, bankCode: r.paystackBankCode, fp: r.fp });

/** What the desk learns about an existing account: only the number and flags. Counted against a daily limit so account numbers cannot be probed. */
export async function checkRecipient(desk: DeskCtx, i: { channel: Channel; bankCode?: string; accountNumber: string; enteredName: string }) {
  if (!(await rateOk(`chk|${desk.uid}`, LMMX.DESK_RECIPIENT_CHECKS_PER_DAY, 86_400_000))) return fail("LMMX_E_RATE", "Too many account checks today.");
  const s = specOf(i);
  const key = acctKey(s.channel, s.channel === "bank" ? s.bankCode : "", s.accountNumber);
  const snap = await col(COL.recipients).where("acctKey", "==", key).limit(5).get();
  const live = snap.docs.map((d) => d.data() as RecipientDoc).filter((r) => r.status === "verified" || r.status === "needs_review" || r.status === "pending");
  await audit({ action: "recipient_checked", actor: { type: desk.isTop ? "top" : "desk", deskCode: desk.deskCode, uid: desk.uid }, summary: `check ${s.channel} ...${s.accountNumber.slice(-3)} -> ${live.length ? "exists" : "new"}` });
  const hit = live.find((r) => r.status === "verified");
  if (!live.length) return { exists: false, accountNumber: s.accountNumber, nameMatchesEntered: false, reusable: false };
  const nameKey = H("name", normName(i.enteredName));
  const sameName = live.some((r) => r.nameKey === nameKey);
  return {
    exists: true, accountNumber: s.accountNumber, nameMatchesEntered: sameName, reusable: !!hit,
    ...(hit ? { reuseToken: signToken("reuse", { rid: hit.recipientId, desk: desk.uid, exp: now() + 15 * 60_000 }) } : {}),
  };
}

async function blockedByGuards(desk: DeskCtx, tenantPhone: string, contactPhone: string, s: Spec): Promise<void> {
  const acctPhone = s.channel === "phone" ? normalizeKePhone(s.accountNumber) : null;
  const phones = [contactPhone, acctPhone].filter((p): p is string => !!p);
  if (phones.some((p) => p === tenantPhone)) return fail("LMMX_E_RECIPIENT_BLOCKED", "The landlord's phone cannot be the tenant's own phone.");
  if (!desk.isTop) {
    if (phones.some((p) => p === desk.phone)) return fail("LMMX_E_RECIPIENT_BLOCKED", "A desk cannot register its own phone as the landlord.");
    for (const p of phones) {
      const d = await col("desk_agents").where("phone", "==", p).limit(1).get();
      if (!d.empty) { await alert("UNEXPECTED", `LMMX recipient equals a desk phone (desk ${desk.deskCode})`); return fail("LMMX_E_RECIPIENT_BLOCKED", "This number belongs to a desk agent and cannot be a landlord."); }
    }
    const own = (await col("agents").doc(desk.uid).get()).data()?.paymentInfo as { accountNumber?: unknown } | undefined;
    if (own?.accountNumber && String(own.accountNumber).replace(/\D/g, "") === s.accountNumber.replace(/\D/g, "")) return fail("LMMX_E_RECIPIENT_BLOCKED", "A desk cannot use its own payout account as the landlord's.");
  }
}

/** Creates a new sealed recipient, or returns the one named by a valid reuse token. Never returns a recipient that is frozen or retired. */
export async function createOrReuseRecipient(desk: DeskCtx, tenantPhone: string, i: RecipientInput): Promise<RecipientDoc> {
  const contactPhone = normalizeKePhone(i.contactPhone);
  if (!contactPhone) return fail("LMMX_E_VALIDATION", "Enter a valid landlord contact phone.");
  const name = String(i.accountName ?? "").trim(), cname = String(i.contactName ?? "").trim();
  if (name.length < 2 || name.length > 80 || cname.length < 2 || cname.length > 80) return fail("LMMX_E_VALIDATION", "Enter the account name and the contact name.");
  const s = specOf(i);
  await blockedByGuards(desk, tenantPhone, contactPhone, s);

  if (i.reuseToken) {
    const t = readToken<{ rid: string; desk: string; exp: number }>("reuse", i.reuseToken);
    if (!t || t.exp < now() || t.desk !== desk.uid) return fail("LMMX_E_VALIDATION", "That reuse code expired. Check the account again.");
    const r = (await col(COL.recipients).doc(t.rid).get()).data() as RecipientDoc | undefined;
    if (!r || r.status === "frozen" || r.status === "retired") return fail("LMMX_E_RECIPIENT_BLOCKED", "This landlord account cannot be reused.");
    if (r.acctKey !== acctKey(s.channel, s.channel === "bank" ? s.bankCode : "", s.accountNumber)) return fail("LMMX_E_VALIDATION", "That reuse code is for a different account.");
    if (r.status === "verified" && r.activeTenantCount >= LMMX.RECIPIENT_TENANTS_BEFORE_REVIEW && !r.deskCodes.every((d) => d === desk.deskCode)) {
      await col(COL.recipients).doc(r.recipientId).update({ status: "needs_review", reviewReason: "shared_recipient" });
      await audit({ action: "recipient_reused", actor: { type: "desk", deskCode: desk.deskCode, uid: desk.uid }, summary: `shared recipient ${r.recipientId} sent to review` });
      await alert("UNEXPECTED", `LMMX shared recipient ${r.recipientId} across desks`);
      return { ...r, status: "needs_review", reviewReason: "shared_recipient" };
    }
    await audit({ action: "recipient_reused", actor: { type: desk.isTop ? "top" : "desk", deskCode: desk.deskCode, uid: desk.uid }, summary: `reused ${r.recipientId}` });
    return r;
  }

  const resolved = await resolveName(s);
  const match: NameMatch = resolved === null ? "unavailable" : nameMatches(name, resolved) ? "matched" : "mismatch";
  const recipientId = randId("RCP");
  let code = "";
  try {
    const res = await axios.post(`${PAYSTACK_API_BASE}/transferrecipient`, { type: s.type, name: name.slice(0, 100), account_number: s.accountNumber, bank_code: s.paystackBankCode, currency: "KES" }, { headers: hdr(), timeout: 20_000 });
    code = String(res.data?.data?.recipient_code ?? "");
    if (!res.data?.status || !/^RCP_[A-Za-z0-9]+$/.test(code)) return fail("LMMX_E_VALIDATION", "Paystack could not accept this payout account.");
  } catch (err) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
    return fail("LMMX_E_VALIDATION", `Paystack could not accept this payout account${msg ? `: ${String(msg).slice(0, 80)}` : "."}`);
  }
  const fp = fingerprint(LMM_SEAL_KEY.value(), s.paystackBankCode, s.accountNumber);
  const base = { recipientId, paystackType: s.type, paystackBankCode: s.paystackBankCode, fp, recipientCode: code };
  const needsReview = match === "mismatch";
  const doc: RecipientDoc = {
    recipientId, channel: s.channel, bankCode: s.bankCode, paystackType: s.type, paystackBankCode: s.paystackBankCode, accountNumber: s.accountNumber,
    acctKey: acctKey(s.channel, s.channel === "bank" ? s.bankCode : "", s.accountNumber), fp, recipientCode: code, seal: sealOf(base),
    resolvedNameEnc: enc(resolved ?? name), enteredNameEnc: enc(name), nameKey: H("name", normName(name)), resolvedNameMasked: maskName(resolved ?? name), nameMatch: match,
    contactNameEnc: enc(cname), contactKey: H("contact", contactPhone), contactPhoneEnc: enc(contactPhone), contactPhoneHash: H("phone", contactPhone),
    status: needsReview ? "needs_review" : "verified", ...(needsReview ? { reviewReason: "name_mismatch" as const } : { verifiedAt: now() }), createdAt: now(), createdByDesk: desk.deskCode,
    activeTenantCount: 0, deskCodes: [],
  };
  await col(COL.recipients).doc(recipientId).create(JSON.parse(JSON.stringify(doc)));
  await audit({ action: "recipient_created", actor: { type: desk.isTop ? "top" : "desk", deskCode: desk.deskCode, uid: desk.uid }, summary: `recipient ${recipientId} ${s.channel} ...${s.accountNumber.slice(-3)} name:${match}` });
  if (needsReview) await alert("UNEXPECTED", `LMMX recipient ${recipientId} name mismatch, needs top desk review`);
  return doc;
}

/** The recipient to pay, verified two ways: the stored seal still matches AND Paystack still says it is this active account. Any doubt: alert and null. */
export async function verifiedRecipientForPayout(recipientId: string): Promise<RecipientDoc | null> {
  const r = (await col(COL.recipients).doc(recipientId).get()).data() as RecipientDoc | undefined;
  if (!r || r.status !== "verified") { await alert("RECIPIENT_MISSING", `LMMX recipient ${recipientId} is not verified`); return null; }
  if (!sameSeal(r.seal, sealOf(r))) { await alert("SEAL_MISMATCH", `LMMX recipient ${recipientId} was altered`); return null; }
  try {
    const res = await axios.get(`${PAYSTACK_API_BASE}/transferrecipient/${encodeURIComponent(r.recipientCode)}`, { headers: hdr(), timeout: 20_000 });
    const d = res.data?.data;
    const ok = res.data?.status === true && d?.recipient_code === r.recipientCode && d?.active !== false && d?.is_deleted !== true && d?.isDeleted !== true && d?.type === r.paystackType
      && String(d?.details?.bank_code ?? "").toUpperCase() === r.paystackBankCode.toUpperCase() && fingerprint(LMM_SEAL_KEY.value(), String(d?.details?.bank_code ?? ""), String(d?.details?.account_number ?? "")) === r.fp;
    if (!ok) { await alert("RECIPIENT_MISMATCH", `Paystack recipient ${r.recipientCode} does not match the seal`); return null; }
  } catch (e) { await alert("RECIPIENT_MISMATCH", `could not verify recipient ${recipientId}: ${(e as Error)?.message}`); return null; }
  return r;
}
export const recipientView = (r: RecipientDoc) => ({ channel: r.channel, accountNumber: r.accountNumber, resolvedNameMasked: r.resolvedNameMasked, nameMatch: r.nameMatch, status: r.status });
export const contactOf = (r: RecipientDoc): { name: string; phone: string } => ({ name: dec(r.contactNameEnc), phone: dec(r.contactPhoneEnc) });
void X;
