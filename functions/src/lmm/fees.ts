// Lipa Mos Mos money maths. Pure, integer minor units (KES x 100). No imports but config.
import { LMM, type PayoutKind } from "./config";

/** Tenant surcharge in basis points: 5% for an instalment under KES 100, otherwise 2.5%. */
export function surchargeBps(creditMinor: number): number {
  return creditMinor < LMM.SMALL_BELOW_MINOR ? LMM.SMALL_SURCHARGE_BPS : LMM.SURCHARGE_BPS;
}

export function isValidCredit(creditMinor: unknown): creditMinor is number {
  return typeof creditMinor === "number" && Number.isSafeInteger(creditMinor) && creditMinor % 100 === 0
    && creditMinor >= LMM.MIN_CREDIT_MINOR && creditMinor <= LMM.MAX_CREDIT_MINOR;
}

export interface Charge { creditMinor: number; chargeMinor: number; surchargeMinor: number; surchargeBps: number }
/**
 * The tenant picks what should reach their rent (`creditMinor`, whole shillings). They are charged that plus the surcharge, rounded UP
 * to a whole shilling (an M-PESA prompt is whole shillings). The rent is credited EXACTLY `creditMinor`, never the surcharge.
 * Paystack takes 1.5% of the larger charge, so Samuhia keeps a little under 1% of the credited rent (never below 0.9%).
 */
export function chargeFor(creditMinor: number): Charge {
  if (!isValidCredit(creditMinor)) throw new RangeError("credit must be whole shillings between the minimum and maximum instalment");
  const bps = surchargeBps(creditMinor);
  const raw = Math.ceil((creditMinor * (10_000 + bps)) / 10_000);
  const chargeMinor = Math.ceil(raw / 100) * 100;
  return { creditMinor, chargeMinor, surchargeMinor: chargeMinor - creditMinor, surchargeBps: bps };
}

/** What Samuhia keeps from one instalment, given the fee Paystack really took. Can be negative only if Paystack's fee exceeds the surcharge. */
export const keptMinor = (c: Pick<Charge, "chargeMinor" | "creditMinor">, paystackFeeMinor: number): number => c.chargeMinor - c.creditMinor - paystackFeeMinor;

const wholeShilling = (minor: number): number => Math.ceil(minor / 100) * 100;

/** What Paystack charges US to send `amountMinor` to this kind of recipient (see LMM.PAYSTACK_TRANSFER_COST). */
export function paystackCostMinor(amountMinor: number, type: PayoutKind): number {
  const tier = LMM.PAYSTACK_TRANSFER_COST[type].find((t) => amountMinor <= t.upToMinor);
  if (!tier) throw new RangeError("amount is above the automatic transfer limit");
  return tier.costMinor;
}

/**
 * Transfer fee for sending `amountMinor` to a `type` recipient. Whole shillings, and NEVER below Paystack's cost + our KES 10 mark-up.
 *  - up to KES 300: cost + mark-up only (KES 30 to an M-PESA wallet; KES 50 to a till; KES 90 to a bank).
 *  - KES 301 to 10,000: 0.95% of the amount, but not below KES 36 (up to 1,500) or KES 60 (from 1,501). KES 95 at KES 10,000.
 *  - KES 10,001 to 39,999: rises evenly from KES 120 to KES 183.   - KES 40,000 to 900,000: KES 257.
 * Throws above the top of the table: nothing that large goes out automatically.
 */
export function transferFeeMinor(amountMinor: number, type: PayoutKind = "mobile_money"): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError("amount must be a positive integer");
  const floor = paystackCostMinor(amountMinor, type) + LMM.MARGIN_MINOR;
  if (amountMinor <= LMM.MIN_SETTLEMENT_MINOR) return wholeShilling(floor);
  const b1 = LMM.FEE_BAND1, b2 = LMM.FEE_BAND2;
  let scaled: number;
  if (amountMinor <= b1.topMinor) {
    const band = b1.floors.find((f) => amountMinor <= f.upToMinor)!;
    scaled = Math.max(band.feeMinor, Math.ceil((amountMinor * b1.pctBps) / 10_000));
  } else if (amountMinor < b2.toMinor) {
    scaled = b2.lowMinor + Math.ceil(((amountMinor - b2.fromMinor) * (b2.highMinor - b2.lowMinor)) / (b2.toMinor - b2.fromMinor));
    scaled = Math.min(b2.highMinor, Math.max(b2.lowMinor, scaled));
  } else if (amountMinor <= LMM.MAX_SETTLEMENT_MINOR) scaled = LMM.FEE_BAND3_MINOR;
  else throw new RangeError("amount is above the automatic transfer limit");
  return wholeShilling(Math.max(scaled, floor));
}

/** Least that can be settled to this kind of recipient at all: the small-settlement fee plus the KES 10 Paystack will not go below. KES 40 to a wallet. */
export const minSendableMinor = (type: PayoutKind): number => transferFeeMinor(LMM.MIN_SETTLEMENT_MINOR, type) + LMM.MIN_SEND_MINOR;

export interface TransferChunk { grossMinor: number; feeMinor: number; sendMinor: number }
/** Thrown when what the plan holds is too small to send even after the fee (the money stays on the plan). */
export class BelowFloor extends RangeError { constructor(public readonly floorMinor: number) { super("settlement is below the least that can be sent"); } }

/**
 * Splits one settlement of KES 300 or more into the transfers to make. An M-PESA wallet takes at most KES 150,000 per transfer, so a larger
 * settlement is split, each part carrying its own fee. Banks and tills take the whole amount in one transfer. Every part must clear its own fee.
 */
export function planTransfers(grossMinor: number, recipientType: PayoutKind): TransferChunk[] {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < LMM.MIN_SETTLEMENT_MINOR) throw new RangeError("settlement is below the minimum");
  if (grossMinor > LMM.MAX_SETTLEMENT_MINOR) throw new RangeError("settlement is above the automatic transfer limit");
  // Wallet: as few transfers as the KES 150,000 limit allows, shared evenly so no part is a crumb. Bank / till: one transfer.
  const n = recipientType === "mobile_money" ? Math.ceil(grossMinor / LMM.WALLET_MAX_TRANSFER_MINOR) : 1;
  const base = Math.floor(grossMinor / n), extra = grossMinor - base * n;
  const parts = Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
  return parts.map((g) => {
    const feeMinor = transferFeeMinor(g, recipientType);
    if (g <= feeMinor) throw new RangeError("settlement does not cover its transfer fee");
    return { grossMinor: g, feeMinor, sendMinor: g - feeMinor };
  });
}

export interface SettlementPlan { chunks: TransferChunk[]; feeBearer: "landlord" | "tenant"; invoiceMinor: number }
/**
 * Who pays the transfer fee, and what the invoice is credited.
 *  - KES 300 or more: the LANDLORD bears it (as before). The invoice is credited the full amount.
 *  - KES 40 (wallet) to 299: the TENANT bears a flat Paystack cost + KES 10 (KES 30 to a wallet). The landlord receives, and the invoice is
 *    credited, only amount - fee; the tenant still owes that fee on the invoice. The landlord never pays for a tenant who did not clear.
 *  - below the least that can be sent: nothing is sent (BelowFloor); the money stays on the plan.
 */
export function planSettlement(grossMinor: number, type: PayoutKind): SettlementPlan {
  if (!Number.isSafeInteger(grossMinor) || grossMinor <= 0) throw new RangeError("settlement must be a positive integer");
  if (grossMinor >= LMM.MIN_SETTLEMENT_MINOR) return { chunks: planTransfers(grossMinor, type), feeBearer: "landlord", invoiceMinor: grossMinor };
  const feeMinor = transferFeeMinor(grossMinor, type);
  if (grossMinor < feeMinor + LMM.MIN_SEND_MINOR) throw new BelowFloor(feeMinor + LMM.MIN_SEND_MINOR);
  return { chunks: [{ grossMinor, feeMinor, sendMinor: grossMinor - feeMinor }], feeBearer: "tenant", invoiceMinor: grossMinor - feeMinor };
}

export type SmallPayoutNotice =
  | { kind: "fee_from_rent"; creditedMinor: number; feeMinor: number; netMinor: number; thresholdMinor: number }
  | { kind: "too_small"; creditedMinor: number; minMinor: number; thresholdMinor: number };
/**
 * What a tenant holding under KES 300 should be told: the fee that will come off what reaches their rent (and how much does reach it), or that what they
 * hold is too small to send at all. null when nothing is held or the amount is KES 300 or more (the landlord bears the fee then). One source for SMS and screens.
 */
export function smallPayoutNotice(creditedMinor: number, type: PayoutKind): SmallPayoutNotice | null {
  if (!Number.isSafeInteger(creditedMinor) || creditedMinor <= 0 || creditedMinor >= LMM.MIN_SETTLEMENT_MINOR) return null;
  const thresholdMinor = LMM.MIN_SETTLEMENT_MINOR, feeMinor = transferFeeMinor(creditedMinor, type), minMinor = feeMinor + LMM.MIN_SEND_MINOR;
  return creditedMinor < minMinor
    ? { kind: "too_small", creditedMinor, minMinor, thresholdMinor }
    : { kind: "fee_from_rent", creditedMinor, feeMinor, netMinor: creditedMinor - feeMinor, thresholdMinor };
}
