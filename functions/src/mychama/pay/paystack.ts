// TRACK B — Paystack /charge for MyChama self-pay. Port of Chama shared/paystack.py::charge_mobile_money,
// with ONE deliberate difference (decision A): the money is ROUTED in the payload (Chama's Python only puts the
// split code in metadata, which does not route the money). Routing is by SUBACCOUNT + a flat `transaction_charge`
// (not the chama's 100% percentage split), so the chama receives exactly the net amount: Paystack keeps
// `transaction_charge` in the main account (which also bears Paystack's fee) and pays the subaccount the rest.
import axios from "axios";

export const PAYSTACK_API_BASE = "https://api.paystack.co";

export interface ChargeMobileMoneyParams {
  secretKey: string;                 // MYCHAMA_PAYSTACK_SECRET_KEY.value() — never logged
  email: string;
  amountKes: number;                 // GROSS, major units
  phoneE164: string;
  provider: "mpesa" | "airtel";
  reference: string;
  subaccountCode: string;            // chamas/{id}.settlementSubaccountCode
  transactionChargeSubunits: number; // gross - net, in kobo (fees.mainAccountChargeSubunits)
  metadata: Record<string, unknown>;
}

export interface ChargeResult {
  /** Paystack's STK prompt text (data.display_text), falling back to the top-level message. */
  message: string | null;
}

/** Throws on any transport/HTTP error or when Paystack reports the charge as not started. */
export async function chargeMobileMoney(p: ChargeMobileMoneyParams): Promise<ChargeResult> {
  const res = await axios.post(
    `${PAYSTACK_API_BASE}/charge`,
    {
      email: p.email,
      amount: Math.round(p.amountKes * 100),   // smallest currency unit
      currency: "KES",
      mobile_money: { phone: p.phoneE164, provider: p.provider },
      reference: p.reference,
      subaccount: p.subaccountCode,
      transaction_charge: p.transactionChargeSubunits,
      bearer: "account",
      metadata: p.metadata,
    },
    {
      headers: { Authorization: `Bearer ${p.secretKey}`, "Content-Type": "application/json" },
      timeout: 20000,
    }
  );

  const body = res.data || {};
  const data = body.data || {};
  if (body.status === false || data.status === "failed") {
    throw new Error(`paystack_charge_rejected:${data.gateway_response || body.message || "unknown"}`);
  }
  return { message: (data.display_text || body.message || null) as string | null };
}
