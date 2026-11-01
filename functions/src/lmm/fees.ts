// Lipa Mos Mos money maths. Pure, integer minor units (KES x 100). No imports but config.
import { LMM } from "./config";

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

/** Transfer fee charged to the landlord/agency for sending `amountMinor`. Throws above the top of the table: nothing that large goes out automatically. */
export function transferFeeMinor(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError("amount must be a positive integer");
  const tier = LMM.FEE_TIERS.find((t) => amountMinor <= t.upToMinor);
  if (!tier) throw new RangeError("amount is above the automatic transfer limit");
  return tier.feeMinor;
}

export interface TransferChunk { grossMinor: number; feeMinor: number; sendMinor: number }
/**
 * Splits one settlement into the transfers to make. An M-PESA wallet takes at most KES 150,000 per transfer, so a larger settlement is
 * split, each part carrying its own fee. Banks and tills take the whole amount in one transfer. Every part must clear its own fee.
 */
export function planTransfers(grossMinor: number, recipientType: "mobile_money" | "mobile_money_business" | "kepss"): TransferChunk[] {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < LMM.MIN_SETTLEMENT_MINOR) throw new RangeError("settlement is below the minimum");
  if (grossMinor > LMM.MAX_SETTLEMENT_MINOR) throw new RangeError("settlement is above the automatic transfer limit");
  // Wallet: as few transfers as the KES 150,000 limit allows, shared evenly so no part is a crumb. Bank / till: one transfer.
  const n = recipientType === "mobile_money" ? Math.ceil(grossMinor / LMM.WALLET_MAX_TRANSFER_MINOR) : 1;
  const base = Math.floor(grossMinor / n), extra = grossMinor - base * n;
  const parts = Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
  return parts.map((g) => {
    const feeMinor = transferFeeMinor(g);
    if (g <= feeMinor) throw new RangeError("settlement does not cover its transfer fee");
    return { grossMinor: g, feeMinor, sendMinor: g - feeMinor };
  });
}
