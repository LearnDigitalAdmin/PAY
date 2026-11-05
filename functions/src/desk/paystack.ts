import { bundleSecret } from "../secretsBundle";
// The Paystack secret shared by index.ts and the desk module. Declared ONCE (index.ts imports it from here) so the
// deploy manifest lists the parameter a single time. Bind it with `secrets: [PAYSTACK_SECRET_KEY]` on every function
// that reaches Paystack or runs the desk code paths.

export const PAYSTACK_SECRET_KEY = bundleSecret("PAYSTACK_SECRET_KEY");
export const PAYSTACK_API_BASE = "https://api.paystack.co";
