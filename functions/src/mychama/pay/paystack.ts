// TRACK B — Paystack /charge for MyChama self-pay. Port of Chama shared/paystack.py::charge_mobile_money,
// with ONE deliberate difference (decision A): `split_code` is sent in the payload, exactly as CYBER's
// MCW charge does (Chama's Python only puts it in metadata, which does not route the money).
import axios from "axios";

export const PAYSTACK_API_BASE = "https://api.paystack.co";

export interface ChargeMobileMoneyParams {
  secretKey: string;                 // MYCHAMA_PAYSTACK_SECRET_KEY.value() — never logged
  email: string;
  amountKes: number;                 // GROSS, major units
  phoneE164: string;
  provider: "mpesa" | "airtel";
  reference: string;
  splitCode: string;
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
      split_code: p.splitCode,
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
