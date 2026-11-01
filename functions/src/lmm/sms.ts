// Lipa Mos Mos SMS: sender, message texts (each under 144 characters, each starting "Dear {first name},") and send-once logging.
import * as admin from "firebase-admin";
import { dearLine } from "./dear";
import { sendHpSms } from "../hpSms";

const MAX = 144;

/** Plain GSM-safe text, hard-capped at 144 characters (the texts below are written shorter; this is the safety net). */
export function fit144(text: string): string {
  const clean = text.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  return clean.length <= MAX ? clean : clean.slice(0, MAX).trimEnd();
}

export const kes = (minor: number): string => {
  const v = minor / 100;
  return `KES ${Number.isInteger(v) ? v.toLocaleString("en-KE") : v.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const lmmText = {
  started: (p: { name: string; targetMinor: number }) =>
    fit144(`${dearLine(p.name)} your Lipa Mos Mos plan for ${kes(p.targetMinor)} rent is on. Pay a little at a time. Landlord is paid on the 5th. Samuhia Payments.`),
  missed: (p: { name: string; days: number; balanceMinor: number }) =>
    fit144(`${dearLine(p.name)} no Lipa Mos Mos payment for ${p.days} days. Balance ${kes(p.balanceMinor)}. Pay any amount on WhatsApp or Samuhia Payments.`),
  milestone: (p: { name: string; pct: number; paidMinor: number; leftMinor: number }) =>
    p.pct >= 100
      ? fit144(`${dearLine(p.name)} well done! Your rent is fully paid (${kes(p.paidMinor)}). Your landlord will be paid shortly.`)
      : fit144(`${dearLine(p.name)} well done! You have paid ${p.pct}% of your rent (${kes(p.paidMinor)}). ${kes(p.leftMinor)} to go. Keep going.`),
  landlordPaid: (p: { name: string; paidMinor: number; leftMinor: number }) =>
    p.leftMinor > 0
      ? fit144(`${dearLine(p.name)} ${kes(p.paidMinor)} was sent to your landlord today. Balance ${kes(p.leftMinor)} stays on your plan.`)
      : fit144(`${dearLine(p.name)} your landlord has been paid ${kes(p.paidMinor)} for rent. Thank you for using Lipa Mos Mos.`),
};

/** Low-level HostPinnacle send via the shared secret-based sender (functions/src/hpSms.ts). Never throws. */
export async function sendSms(mobile: string, message: string): Promise<boolean> {
  return (await sendHpSms({ mobile, message })).success;
}

/** Sends at most once per `key` (a webhook repeat or a re-run of the sweep never texts the tenant twice). */
export async function sendOnce(key: string, mobile: string, message: string): Promise<boolean> {
  const ref = admin.firestore().collection("lmm_sms_log").doc(key.slice(0, 200));
  try { await ref.create({ mobile: mobile.slice(-4), createdAt: admin.firestore.FieldValue.serverTimestamp(), status: "sending" }); }
  catch (e) { if ((e as { code?: number }).code === 6) return false; throw e; }
  const ok = await sendSms(mobile, message);
  if (ok) await ref.update({ status: "sent" }); else await ref.delete();
  return ok;
}
