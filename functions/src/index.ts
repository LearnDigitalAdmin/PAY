import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import axios from "axios";
import * as crypto from "crypto";
import { hash } from "@node-rs/argon2";
import { onSchedule } from "firebase-functions/v2/scheduler";



// Initialize Firebase Admin only if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}



const db = admin.firestore();


const project2App = admin.initializeApp({
  credential: admin.credential.cert("./project2keys.json"),
}, "project2");

// ============= CONFIGURATION =============
const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const PAYSTACK_API_BASE = "https://api.paystack.co";

// Tier commission rates
const TIER_RATES = {
  ENTERPRISE: 1.0,
  PRO: 1.9,
  BUSINESS: 1.5,
  SOLO: 2.4,
} as const;


//declare const project2App: admin.app.App;
const db2 = project2App.firestore(); // project-2 Firestore
 
 
// ============= NEW: CHARGE SMS TOP-UP =============

interface ChargeSmsTopUpRequest {
  phone:      string;
  tokens:     number;
  amountKes:  number;            // ignored server-side either way — kept for the client's optimistic UI
  tier?:      'small' | 'medium' | 'large'; // myregister only — volume tier
  userId:     string;
  schoolId?:  string;             // myregister only
  schoolName?: string;            // myregister only
  targetApp?: 'pms' | 'myregister'; // NEW — which product this purchase is for. Defaults to 'myregister'.
}


/**
 * PMS token pricing — priced by the user's PMS subscription tier (users/{uid}.tier),
 * NOT by purchase volume. Non-listed tiers (free, low, starter) fall back to
 * PMS_DEFAULT_SMS_RATE. These credit the `tokens` field that whatsapp/src/index.ts
 * reads and decrements — separate from KES_RATE_PER_TOKEN, which is myregister-only.
 *
 * NOTE: business/pro are my interpolation between your two given endpoints
 * (solo 0.70, enterprise 0.45) — adjust freely, it's just this one object.
 */
const PMS_TIER_SMS_RATE: Record<string, number> = {
  solo:       0.70,
  business:   0.60,
  pro:        0.50,
  enterprise: 0.45,
};

const PMS_DEFAULT_SMS_RATE = 0.75; // free / low / starter / anything unrecognized
 
/**
 * KES rate per token (must mirror frontend types.ts)
 */
const KES_RATE_PER_TOKEN: Record<'small'|'medium'|'large', number> = {
  small:  0.7,
  medium: 0.5,
  large:  0.4,
};
 
export const chargeSmsTopUp = onCall({
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
  secrets: [PAYSTACK_SECRET_KEY],
}, async (request: CallableRequest<ChargeSmsTopUpRequest>) => {
  try {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const userId = request.auth.uid;
    const { phone, tokens, tier, schoolId, schoolName, targetApp = 'myregister' } = request.data;

    if (!phone || !tokens || tokens < 1 || !userId) {
      throw new HttpsError("invalid-argument", "phone, tokens, and userId are required");
    }

    let expectedKes: number;
    let extraMetadata: Record<string, any> = {};

    if (targetApp === 'pms') {
      // PMS: price by the account's real subscription tier — read it server-side,
      // never trust a client-supplied tier for pricing.
      const userSnap = await db.collection("users").doc(userId).get();
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "User not found");
      }
      const userTier = String(userSnap.data()?.tier || "free").toLowerCase();
      const ratePerToken = PMS_TIER_SMS_RATE[userTier] ?? PMS_DEFAULT_SMS_RATE;
      expectedKes = Math.round(tokens * ratePerToken * 100) / 100;
      extraMetadata = { userTier, ratePerToken };
    } else {
      // myregister: existing volume-tier pricing, unchanged.
      if (!tier || !schoolId) {
        throw new HttpsError("invalid-argument", "tier and schoolId are required for myregister top-ups");
      }
      expectedKes = Math.round(tokens * KES_RATE_PER_TOKEN[tier] * 100) / 100;
    }

    const amountKes = expectedKes; // ignore whatever the client sent

    // Normalise phone to +254XXXXXXXXX
    let formattedPhone = phone.replace(/[\s\-]/g, '');
    if (formattedPhone.startsWith('+254')) {
      // already good
    } else if (formattedPhone.startsWith('254')) {
      formattedPhone = '+' + formattedPhone;
    } else if (formattedPhone.startsWith('0')) {
      formattedPhone = '+254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
      formattedPhone = '+254' + formattedPhone;
    }

    const amountInCents = Math.round(amountKes * 100);
    const reference = `SMS_${userId}_${Date.now()}`;

    const chargePayload = {
      email: `${userId}@cogvana.co.ke`,
      amount: amountInCents,
      currency: "KES",
      mobile_money: {
        phone: formattedPhone,
        provider: "mpesa",
      },
      reference,
      metadata: {
        chargeType: "sms_topup",
        targetProject: targetApp === 'pms' ? 'pms' : 'project2', // ← tells webhook which Firestore/field to settle in
        userId,
        ...(targetApp !== 'pms' ? { schoolId, schoolName, tier } : {}),
        tokens,
        amountKes,
        phone: formattedPhone,
        ...extraMetadata,
      },
    };

    console.log("SMS top-up charge request:", JSON.stringify(chargePayload, null, 2));

    const paystackResponse = await axios.post(
      `${PAYSTACK_API_BASE}/charge`,
      chargePayload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!paystackResponse.data.status) {
      throw new HttpsError("internal", `Paystack error: ${paystackResponse.data.message}`);
    }

    const txData = paystackResponse.data.data;

    // Pending record goes into the same Firestore the settlement will use.
    const targetDb = targetApp === 'pms' ? db : db2;
    await targetDb.collection("sms-topup-transactions").doc(reference).set({
      reference,
      userId,
      ...(targetApp !== 'pms' ? { schoolId, schoolName, tier } : { userTier: extraMetadata.userTier }),
      tokens,
      amountKes,
      phone: formattedPhone,
      status: txData.status || "pending",
      displayText: txData.display_text || null,
      accountReference: txData.account_reference || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`SMS top-up initiated: ${reference}, status: ${txData.status}`);

    return {
      success: true,
      message: "M-Pesa STK push sent",
      data: {
        reference,
        status: txData.status,
        displayText: txData.display_text || "Check your phone for the M-Pesa prompt",
        accountReference: txData.account_reference,
      },
    };
  } catch (error: any) {
    console.error("Error in chargeSmsTopUp:", error);
    if (error.response) {
      console.error("Paystack error response:", error.response.data);
    }
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", `Failed to charge: ${error.response?.data?.message || error.message}`);
  }
});




// ============================================================================
// NEW HANDLER: handleSmsTopUp
// Settles entirely in project-2.  The existing project-1 Firestore (db) is
// NOT touched.  The MyRegister app's user tokens are updated in db2.
// ============================================================================
// ============================================================================
// REPLACE your handleSmsTopUp function in index.ts with this version.
//
// Root cause: Paystack webhook metadata values arrive as strings (or may be
// undefined if the field wasn't set). FieldValue.increment() requires a
// finite number — passing undefined/NaN throws the error you saw.
// Fix: parse every numeric field explicitly and guard against NaN/undefined.
// ============================================================================

async function handleSmsTopUp(
  reference: string,
  data: any,
  metadata: any,
): Promise<void> {
  try {
    console.log(`Processing SMS top-up: ${reference}`);
    console.log(`Raw metadata:`, JSON.stringify(metadata, null, 2));

    // ── Parse metadata fields — Paystack sends everything as a string ──────
    const userId     = String(metadata.userId    || "");
    const schoolId   = String(metadata.schoolId  || "");
    const schoolName = String(metadata.schoolName || "");
    const tier       = String(metadata.tier      || "small");
    const phone      = String(metadata.phone     || "");

    // Critical: parse to Number and validate before any FieldValue.increment()
    const tokens    = Number(metadata.tokens);
    const amountKes = Number(metadata.amountKes);

    if (!userId) {
      console.error(`handleSmsTopUp: missing userId in metadata for ${reference}`);
      return;
    }
    if (!Number.isFinite(tokens) || tokens < 1) {
      console.error(`handleSmsTopUp: invalid tokens value "${metadata.tokens}" for ${reference}`);
      return;
    }
    if (!Number.isFinite(amountKes) || amountKes <= 0) {
      console.error(`handleSmsTopUp: invalid amountKes value "${metadata.amountKes}" for ${reference}`);
      return;
    }

    // ── Parse Paystack financial fields (also arrive as numbers but guard anyway)
    const grossAmount    = Number(data.amount) / 100;
    const paystackFees   = data.fees ? Number(data.fees) / 100 : 0;
    const amountReceived = data.amount_received
      ? Number(data.amount_received) / 100
      : grossAmount - paystackFees;

    // Validate financial values too
    const safeGross     = Number.isFinite(grossAmount)    ? grossAmount    : amountKes;
    const safeFees      = Number.isFinite(paystackFees)   ? paystackFees   : 0;
    const safeReceived  = Number.isFinite(amountReceived) ? amountReceived : safeGross - safeFees;

    console.log(
      `SMS top-up values — userId: ${userId}, tokens: ${tokens}, ` +
      `amountKes: ${amountKes}, gross: ${safeGross}, fees: ${safeFees}, received: ${safeReceived}`
    );

    // 1. Mark the pending transaction as success in project-2
    await db2.collection("sms-topup-transactions").doc(reference).set(
      {
        status:            "success",
        completedAt:       admin.firestore.FieldValue.serverTimestamp(),
        grossAmount:       safeGross,
        paystackFees:      safeFees,
        amountReceived:    safeReceived,
        paystackReference: data.reference,
      },
      { merge: true }   // use merge so a missing doc doesn't throw
    );

    // 2. Credit the user's token balance in project-2
    await db2.collection("users").doc(userId).set(
      {
        messageTokens:        admin.firestore.FieldValue.increment(tokens),
        lastTopUpAt:          admin.firestore.FieldValue.serverTimestamp(),
        lastTopUpTokens:      tokens,
        lastTopUpAmountKes:   amountKes,
        lastTopUpReference:   reference,
        totalTokensPurchased: admin.firestore.FieldValue.increment(tokens),
        totalAmountSpentKes:  admin.firestore.FieldValue.increment(amountKes),
      },
      { merge: true }
    );

    // 3. Append to user's top-up history in project-2
    await db2
      .collection("users")
      .doc(userId)
      .collection("topup-history")
      .doc(reference)
      .set({
        reference,
        userId,
        schoolId,
        schoolName,
        tokens,
        tier,
        amountKes,
        grossAmount:    safeGross,
        paystackFees:   safeFees,
        amountReceived: safeReceived,
        phone,
        status:    "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt:    admin.firestore.FieldValue.serverTimestamp(),
      });

    // 4. Platform revenue record in project-2
    await db2.collection("platform_revenue").doc(reference).set({
      reference,
      type:       "sms_topup",
      userId,
      schoolId,
      tokens,
      tier,
      grossAmount:    safeGross,
      paystackFees:   safeFees,
      netRevenue:     safeReceived,
      status:    "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      paidAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    // 5. Aggregate platform stats in project-2
    await db2.collection("platform_stats").doc("totals").set(
      {
        totalSmsTopUps:     admin.firestore.FieldValue.increment(1),
        totalSmsTokensSold: admin.firestore.FieldValue.increment(tokens),
        totalSmsRevenue:    admin.firestore.FieldValue.increment(safeReceived),
        lastSmsTopUpDate:   admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(
      `✅ SMS top-up settled (project-2):\n` +
      `   User:   ${userId}\n` +
      `   School: ${schoolId}\n` +
      `   Tokens: +${tokens} (${tier} tier)\n` +
      `   KES:    ${safeGross} gross / ${safeReceived} net\n` +
      `   Ref:    ${reference}`
    );
  } catch (error: any) {
    console.error(`Error handling SMS top-up ${reference}:`, error);
    throw error;
  }
}

// ============================================================================
// NEW HANDLER: handlePmsSmsTopUp
// Settles in the DEFAULT project (db), crediting the `tokens` field that
// whatsapp/src/index.ts decrements when it sends tenant SMS. Uses the same
// string-metadata parsing/guard pattern as handleSmsTopUp.
// ============================================================================
async function handlePmsSmsTopUp(
  reference: string,
  data: any,
  metadata: any,
): Promise<void> {
  try {
    console.log(`Processing PMS SMS top-up: ${reference}`);

    const userId = String(metadata.userId || "");
    const userTier = String(metadata.userTier || "free");
    const phone = String(metadata.phone || "");

    const tokens = Number(metadata.tokens);
    const amountKes = Number(metadata.amountKes);
    const ratePerToken = Number(metadata.ratePerToken);

    if (!userId) {
      console.error(`handlePmsSmsTopUp: missing userId in metadata for ${reference}`);
      return;
    }
    if (!Number.isFinite(tokens) || tokens < 1) {
      console.error(`handlePmsSmsTopUp: invalid tokens value "${metadata.tokens}" for ${reference}`);
      return;
    }
    if (!Number.isFinite(amountKes) || amountKes <= 0) {
      console.error(`handlePmsSmsTopUp: invalid amountKes value "${metadata.amountKes}" for ${reference}`);
      return;
    }

    const grossAmount = Number(data.amount) / 100;
    const paystackFees = data.fees ? Number(data.fees) / 100 : 0;
    const amountReceived = data.amount_received
      ? Number(data.amount_received) / 100
      : grossAmount - paystackFees;

    const safeGross = Number.isFinite(grossAmount) ? grossAmount : amountKes;
    const safeFees = Number.isFinite(paystackFees) ? paystackFees : 0;
    const safeReceived = Number.isFinite(amountReceived) ? amountReceived : safeGross - safeFees;

    // 1. Mark the pending transaction as success — default project
    await db.collection("sms-topup-transactions").doc(reference).set(
      {
        status: "success",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        grossAmount: safeGross,
        paystackFees: safeFees,
        amountReceived: safeReceived,
        paystackReference: data.reference,
      },
      { merge: true }
    );

    // 2. Credit the `tokens` field — the exact field whatsapp/src/index.ts reads
    await db.collection("users").doc(userId).set(
      {
        tokens: admin.firestore.FieldValue.increment(tokens),
        lastTopUpAt: admin.firestore.FieldValue.serverTimestamp(),
        lastTopUpTokens: tokens,
        lastTopUpAmountKes: amountKes,
        lastTopUpReference: reference,
        lastTopUpRatePerToken: ratePerToken,
        totalTokensPurchased: admin.firestore.FieldValue.increment(tokens),
        totalAmountSpentKes: admin.firestore.FieldValue.increment(amountKes),
      },
      { merge: true }
    );

    // 3. Top-up history
    await db
      .collection("users")
      .doc(userId)
      .collection("topup-history")
      .doc(reference)
      .set({
        reference,
        userId,
        userTier,
        tokens,
        ratePerToken,
        amountKes,
        grossAmount: safeGross,
        paystackFees: safeFees,
        amountReceived: safeReceived,
        phone,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // 4. Platform revenue record
    await db.collection("platform_revenue").doc(reference).set({
      reference,
      type: "pms_sms_topup",
      userId,
      userTier,
      tokens,
      ratePerToken,
      grossAmount: safeGross,
      paystackFees: safeFees,
      netRevenue: safeReceived,
      status: "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 5. Aggregate platform stats
    await db.collection("platform_stats").doc("totals").set(
      {
        totalPmsSmsTopUps: admin.firestore.FieldValue.increment(1),
        totalPmsSmsTokensSold: admin.firestore.FieldValue.increment(tokens),
        totalPmsSmsRevenue: admin.firestore.FieldValue.increment(safeReceived),
        lastPmsSmsTopUpDate: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(
      `✅ PMS SMS top-up settled:\n` +
      `   User:   ${userId} (${userTier} tier @ KES ${ratePerToken}/token)\n` +
      `   Tokens: +${tokens}\n` +
      `   KES:    ${safeGross} gross / ${safeReceived} net\n` +
      `   Ref:    ${reference}`
    );
  } catch (error: any) {
    console.error(`Error handling PMS SMS top-up ${reference}:`, error);
    throw error;
  }
}
 
 
// ── determineChargeType helper (add SMS_  prefix awareness) ─────────────────
// Replace your existing determineChargeType with this one:
function determineChargeType(reference: string): string {
  if (reference.startsWith("SMS_"))    return "sms_topup";
  if (reference.startsWith("REPORT_")) return "report_charge";
  if (reference.startsWith("SHOP_"))   return "shop_charge";
  if (reference.startsWith("CYBER_"))  return "cyber_service";
  if (reference.startsWith("SUB_"))    return "subscription";
  if (reference.startsWith("INV_"))    return "agent_payment";
  if (reference.startsWith("MOV_"))    return "movies_payment";
  if (reference.startsWith("BOOK_"))   return "pns_booking_payment";
  if (reference.startsWith("STORE_"))  return "pns_storage_purchase";
  return "unknown";
}


// ============================================================================
// UNIFIED NOTIFICATIONS — SMS (HostPinnacle)
// Generic, reusable across every charge handler in this file (PNS bookings,
// invoices, movies, cyber, subscriptions, etc). Handlers call notifyTransaction()
// with a templateKey + params; nothing here is PNS-specific.
// ============================================================================

const SMS_CONFIG = {
    API_URL:   "https://smsportal.hostpinnacle.co.ke/SMSApi/send",
    USERID:    process.env.HP_SMS_USERID    || "",   // set in .env / functions config
    PASSWORD:  process.env.HP_SMS_PASSWORD  || "",
    APIKEY:    process.env.HP_SMS_APIKEY    || "",
    SENDER_ID: process.env.HP_SMS_SENDERID  || "",   // your approved sender ID
    MAX_LENGTH: 400,
};

// Human-readable message type labels used inside SMS text bodies.
// No template IDs needed — HostPinnacle transactional sends are free-form text.
const SMS_TEMPLATES = {
    NEW_INVOICE:     "new_invoice",
    OVERDUE:         "overdue",
    PAYMENT_SUCCESS: "payment_success",
    BOOKING_PAYMENT: "booking_payment",
} as const;

type SmsTemplateKey = typeof SMS_TEMPLATES[keyof typeof SMS_TEMPLATES];

// ─── UTILITIES ───────────────────────────────────────────────────────────────

/**
 * Strip emoji / non-GSM characters and trim to max 300 chars.
 * GSM-7 safe: printable ASCII + common punctuation only.
 */
function sanitizeSmsText(text: string): string {
    // Remove emoji and non-Latin extended characters (outside GSM-7 basic charset)
    const stripped = text
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")   // emoji blocks
        .replace(/[\u{2600}-\u{27BF}]/gu, "")      // misc symbols / dingbats
        .replace(/[^\x20-\x7E\xA0-\xFF]/gu, "")   // keep printable Latin-1 only
        .replace(/\s+/g, " ")                       // collapse whitespace
        .trim();

    return stripped.length > SMS_CONFIG.MAX_LENGTH
        ? stripped.substring(0, SMS_CONFIG.MAX_LENGTH - 3) + "..."
        : stripped;
}

/**
 * Normalise a Kenyan phone number to 254XXXXXXXXX (no +, no spaces).
 * Identical logic to what you already use for WhatsApp.
 */
function normalizeSmsPhone(raw: string): string {
    const clean = raw.replace(/[\s\-\+]/g, "");
    if (clean.startsWith("254"))  return clean;
    if (clean.startsWith("0"))    return "254" + clean.substring(1);
    if (clean.startsWith("7") || clean.startsWith("1")) return "254" + clean;
    return clean;
}

/**
 * Walk forward `days` business days (Mon-Fri) from `start`.
 * Mirrors Paystack's own T+2 rule, which counts business days only —
 * no public-holiday calendar is applied.
 */
function addBusinessDays(start: Date, days: number): Date {
    const result = new Date(start.getTime());
    let remaining = days;
    while (remaining > 0) {
        result.setDate(result.getDate() + 1);
        const day = result.getDay(); // 0 = Sun, 6 = Sat
        if (day !== 0 && day !== 6) {
            remaining--;
        }
    }
    return result;
}

function formatKesAmount(amount: number): string {
    return `KES ${amount.toFixed(2)}`;
}

function formatDeliveryDay(date: Date): string {
    return date.toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short" });
}

// ─── TRANSACTIONAL SMS TEMPLATES ─────────────────────────────────────────────
// Plain-text, max 300 chars, no emoji.
// These mirror the 3 WhatsApp templates but adapted for SMS constraints.

function buildSmsMessage(
    type: SmsTemplateKey,
    params: Record<string, string>
): string {
    let msg = "";

    switch (type) {
        case SMS_TEMPLATES.NEW_INVOICE:
            // params: tenantName, billingMonth, propertyName, agentName, agentPhone, agentEmail
            msg = `Dear ${params.tenantName}, your invoice for ${params.billingMonth} at ${params.propertyName} is ready. TOTAL AMOUNT: ${params.totalAmount}` +
                  ` Contact ${params.agentName} on ${params.agentPhone} for queries.` +
                  ` PLOT YANGU`;
            break;

        case SMS_TEMPLATES.OVERDUE:
            // params: tenantName, outstandingAmount, daysOverdue, propertyName
            msg = `Dear ${params.tenantName}, your rent at ${params.propertyName} is overdue by ${params.daysOverdue} day(s). ` + 
                  ` Outstanding: ${params.outstandingAmount}. Please pay to avoid late fees.` + 
                  ` PLOT YANGU`;
            break;

        case SMS_TEMPLATES.PAYMENT_SUCCESS:
            // params: tenantName, amountPaid, propertyUnit
            msg = `Dear ${params.tenantName}, ${params.agentName} has received your payment of ${params.amountPaid} for ${params.propertyUnit}. Thank you!` + 
                   ` PLOT YANGU`;
            break;

        case SMS_TEMPLATES.BOOKING_PAYMENT:
            // params: bookingDateTime, baseAmount, platformCut, photographerNet, deliveryDay
            msg = `Booking payment received for ${params.bookingDateTime}. ` +
                  `Amount paid: ${params.baseAmount}. Platform fee (10%): ${params.platformCut}. ` +
                  `You receive: ${params.photographerNet}. Expected payout: ${params.deliveryDay}.` +
                  ` PNS`;
            break;

        default:
            msg = `Dear User, you have a new notification from your property manager.`+
                  ` PLOT YANGU`;
    }

    return sanitizeSmsText(msg);
}

// ─── CORE SENDER ─────────────────────────────────────────────────────────────

interface SmsSendOptions {
    /** Single number OR comma-separated list e.g. "254700000001,254700000002" */
    mobile: string;
    message: string;
    /** Optional: override default sender ID */
    senderId?: string;
    /** Skip duplicate suppression — useful for OTPs. Default: true (suppress) */
    duplicateCheck?: boolean;
}

interface SmsSendResult {
    success: boolean;
    /** Raw response from HostPinnacle */
    raw?: any;
    error?: string;
}

/**
 * Low-level HostPinnacle sender.
 * Returns { success: true } on HTTP 200 + non-error response code.
 * Never throws — callers decide what to do on failure.
 */
async function sendHostPinnacleSms(opts: SmsSendOptions): Promise<SmsSendResult> {
    try {
        if (!SMS_CONFIG.USERID || !SMS_CONFIG.APIKEY) {
            console.warn("HostPinnacle SMS credentials not configured — skipping SMS.");
            return { success: false, error: "SMS credentials not configured" };
        }

        const params = new URLSearchParams({
            userid:         SMS_CONFIG.USERID,
            password:       SMS_CONFIG.PASSWORD,
            sendMethod:     "quick",
            mobile:         opts.mobile,
            msg:            opts.message,
            senderid:       opts.senderId || SMS_CONFIG.SENDER_ID,
            msgType:        "text",
            duplicatecheck: opts.duplicateCheck === false ? "false" : "true",
            output:         "json",
        });

        const response = await axios.post(
            SMS_CONFIG.API_URL,
            params.toString(),
            {
                headers: {
                    "apikey":       SMS_CONFIG.APIKEY,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                timeout: 10_000,
            }
        );

        const data = response.data;
        console.log(`HostPinnacle SMS response for ${opts.mobile}:`, JSON.stringify(data));

        // HostPinnacle returns a top-level status field.
        // Treat anything other than explicit error codes as success.
        const isError =
            data?.status === "error" ||
            data?.ErrorCode !== undefined ||
            (typeof data?.status === "string" && data.status.toLowerCase().includes("fail"));

        if (isError) {
            return { success: false, raw: data, error: data?.message || "API error" };
        }

        return { success: true, raw: data };
    } catch (err: any) {
        const msg = err?.response?.data
            ? JSON.stringify(err.response.data)
            : err.message;
        console.error(`HostPinnacle SMS send error for ${opts.mobile}:`, msg);
        return { success: false, error: msg };
    }
}

/**
 * Unified entry point for transactional SMS notifications, reusable across
 * every charge handler in this file (PNS bookings, invoices, movies, cyber,
 * subscriptions, etc). Never throws — a notification failure must never
 * fail a webhook or block a payment settlement. Every attempt is logged to
 * the `notifications` collection for audit/debugging.
 */
async function notifyTransaction(opts: {
    templateKey: SmsTemplateKey;
    phone: string;
    params: Record<string, string>;
    refId: string;
}): Promise<void> {
    const { templateKey, phone, params, refId } = opts;

    if (!phone) {
        console.warn(`notifyTransaction: no phone number for ${templateKey} (ref: ${refId}) — skipping`);
        return;
    }

    const mobile = normalizeSmsPhone(phone);
    const message = buildSmsMessage(templateKey, params);

    let result: SmsSendResult;
    try {
        result = await sendHostPinnacleSms({ mobile, message });
    } catch (err: any) {
        result = { success: false, error: err?.message || String(err) };
    }

    try {
        await db.collection("notifications").doc().set({
            channel: "sms",
            templateKey,
            refId,
            phone: mobile,
            message,
            success: result.success,
            error: result.error || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (logErr: any) {
        console.error(`notifyTransaction: failed to log notification for ${refId}:`, logErr);
    }

    if (!result.success) {
        console.error(`notifyTransaction: SMS failed for ${templateKey} (ref: ${refId}):`, result.error);
    }
}


// ============================================================================
// PNS HANDLERS — photographer-booking marketplace (bookings, storage top-ups)
// Both use the same numeric-field safety pattern as handleSmsTopUp above:
// Paystack metadata arrives as strings, so every number is parsed and
// guarded before it ever reaches FieldValue.increment().
// ============================================================================

const PNS_PLATFORM_FEE_PERCENT = 10; // platform's cut, taken from the amount actually received
                                       // (i.e. AFTER Paystack's own ~2.9% transaction fee is
                                       // already removed) — not from the customer's gross charge.

function toKesAmount(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : fallback;
}

/**
 * Booking payment settles via Paystack subaccount split (photographer gets
 * their cut directly from Paystack); this just records the confirmed
 * amounts and flips the booking to "paid". Idempotent — a webhook retry on
 * an already-paid booking is a no-op.
 *
 * Split base: the customer is charged gross = base + 2.9% Paystack fee
 * (e.g. pays 103 for a 100 base). The 10% platform cut and the
 * photographer's net both come out of the 100 (amount_received), never out
 * of the 103 gross — so the split correctly excludes Paystack's own fee.
 */
async function handlePNSBookingPayment(reference: string, data: any, metadata: any): Promise<void> {
  const bookingId = String(metadata.bookingId || "");
  if (!bookingId) {
    console.error(`handlePNSBookingPayment: missing bookingId in metadata for ${reference}`);
    return;
  }

  const bookingRef = db.collection("bookings").doc(bookingId);

  // Populated inside the transaction only when this call is the one that
  // actually flips the booking to "paid" (i.e. not an idempotent retry) —
  // used to fire the photographer SMS after the transaction commits.
  let notifyPayload: {
    photographerId: string;
    baseAmount: number;
    platformFeeAmount: number;
    photographerNetAmount: number;
    proposedDate: string;
  } | null = null;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      if (!snap.exists) {
        console.error(`handlePNSBookingPayment: booking ${bookingId} not found for ${reference}`);
        return;
      }
      if (snap.data()?.status === "paid") return; // idempotency guard

      const bookingData = snap.data()!;

      const grossAmount = toKesAmount(data.amount, bookingData.amount ?? 0);
      const paystackFees = data.fees != null ? toKesAmount(data.fees) : 0;
      const amountReceived = data.amount_received != null ? toKesAmount(data.amount_received) : grossAmount - paystackFees;

      // Base amount for the split and the SMS — net of Paystack's fee, not the customer's gross.
      const baseAmount = Math.round(amountReceived * 100) / 100;
      const platformFeeAmount = Math.round(baseAmount * (PNS_PLATFORM_FEE_PERCENT / 100) * 100) / 100;
      const photographerNetAmount = Math.round((baseAmount - platformFeeAmount) * 100) / 100;

      // Lets the PNS income dashboard split totals by mpesa vs card —
      // Paystack's own channel field, straight off the webhook payload.
      const paymentChannel = String(data.channel || "unknown");

      tx.update(bookingRef, {
        status: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        grossAmount,
        paystackFees,
        amountReceived,
        baseAmount,
        platformFeeAmount,
        photographerNetAmount,
        paymentChannel,
        paystackReference: data.reference,
      });

      tx.set(
        db.collection("platform_stats").doc("totals"),
        {
          totalPNSBookingsPaid: admin.firestore.FieldValue.increment(1),
          totalPNSBookingRevenue: admin.firestore.FieldValue.increment(platformFeeAmount),
          lastPNSBookingPaidAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      notifyPayload = {
        photographerId: String(bookingData.photographerId || metadata.photographerId || ""),
        baseAmount,
        platformFeeAmount,
        photographerNetAmount,
        proposedDate: String(bookingData.proposedDate || ""),
      };
    });

    console.log(`✅ PNS booking payment settled: ${bookingId} (ref: ${reference})`);

    // Fire the photographer SMS outside the transaction, after commit —
    // an SMS failure must never roll back or fail the payment settlement.
    if (notifyPayload) {
      await notifyPnsPhotographerOfBookingPayment(reference, notifyPayload).catch((err) =>
        console.error(`handlePNSBookingPayment: notification failed for booking ${bookingId}:`, err)
      );
    }
  } catch (error: any) {
    console.error(`Error handling PNS booking payment ${reference}:`, error);
    throw error;
  }
}

/**
 * Looks up the photographer's SMS notifications number (photographers/{id}.SMSPhone)
 * and sends the booking-payment SMS via the unified notifyTransaction() helper.
 */
async function notifyPnsPhotographerOfBookingPayment(
  reference: string,
  payload: {
    photographerId: string;
    baseAmount: number;
    platformFeeAmount: number;
    photographerNetAmount: number;
    proposedDate: string;
  }
): Promise<void> {
  if (!payload.photographerId) {
    console.warn(`notifyPnsPhotographerOfBookingPayment: missing photographerId for ${reference} — skipping SMS`);
    return;
  }

  const photographerDoc = await db.collection("photographers").doc(payload.photographerId).get();
  if (!photographerDoc.exists) {
    console.warn(`notifyPnsPhotographerOfBookingPayment: photographer ${payload.photographerId} not found — skipping SMS`);
    return;
  }

  const smsPhone = String(photographerDoc.data()?.SMSPhone || "");
  if (!smsPhone) {
    console.warn(`notifyPnsPhotographerOfBookingPayment: photographer ${payload.photographerId} has no SMSPhone set — skipping SMS`);
    return;
  }

  const deliveryDate = addBusinessDays(new Date(), 2);
  // Bookings only ever carry a single free-text/ISO proposedDate — there is
  // no separate time field (see src/bookings/types.ts in the PNS repo).
  const bookingDateTime = payload.proposedDate || "your booking";

  await notifyTransaction({
    templateKey: SMS_TEMPLATES.BOOKING_PAYMENT,
    phone: smsPhone,
    refId: reference,
    params: {
      bookingDateTime,
      baseAmount: formatKesAmount(payload.baseAmount),
      platformCut: formatKesAmount(payload.platformFeeAmount),
      photographerNet: formatKesAmount(payload.photographerNetAmount),
      deliveryDay: formatDeliveryDay(deliveryDate),
    },
  });
}

/**
 * Storage purchase is a platform-only product (no split) — credit
 * storageCapBytes on the photographer/reader doc and mark the purchase
 * paid. Idempotent via the same transaction pattern as the booking handler,
 * since crediting storage twice for one purchase would be a real bug, not
 * just a display glitch.
 */
async function handlePNSStoragePurchase(reference: string, data: any, metadata: any): Promise<void> {
  const purchaseId = String(metadata.purchaseId || "");
  if (!purchaseId) {
    console.error(`handlePNSStoragePurchase: missing purchaseId in metadata for ${reference}`);
    return;
  }

  const purchaseRef = db.collection("storagePurchases").doc(purchaseId);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(purchaseRef);
      if (!snap.exists) {
        console.error(`handlePNSStoragePurchase: purchase ${purchaseId} not found for ${reference}`);
        return;
      }
      if (snap.data()?.status === "paid") return; // idempotency guard

      const { uid, accountType, gigabytes } = snap.data()!;
      if (!uid || !accountType || !Number.isFinite(Number(gigabytes))) {
        console.error(`handlePNSStoragePurchase: malformed purchase doc ${purchaseId}`, snap.data());
        return;
      }

      const collectionName = accountType === "photographer" ? "photographers" : "readers";
      const accountRef = db.collection(collectionName).doc(uid);
      const extraBytes = Math.round(Number(gigabytes) * 1024 * 1024 * 1024);

      const grossAmount = toKesAmount(data.amount, snap.data()?.amount ?? 0);
      const paystackFees = data.fees != null ? toKesAmount(data.fees) : 0;
      const amountReceived = data.amount_received != null ? toKesAmount(data.amount_received) : grossAmount - paystackFees;

      tx.update(accountRef, { storageCapBytes: admin.firestore.FieldValue.increment(extraBytes) });
      tx.update(purchaseRef, {
        status: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        grossAmount,
        paystackFees,
        amountReceived,
        paystackReference: data.reference,
      });

      tx.set(
        db.collection("platform_stats").doc("totals"),
        {
          totalPNSStoragePurchases: admin.firestore.FieldValue.increment(1),
          totalPNSStorageRevenue: admin.firestore.FieldValue.increment(amountReceived),
          lastPNSStoragePurchaseAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    console.log(`✅ PNS storage purchase settled: ${purchaseId} (ref: ${reference})`);
  } catch (error: any) {
    console.error(`Error handling PNS storage purchase ${reference}:`, error);
    throw error;
  }
}























// ============= HELPER FUNCTIONS =============
// const getPaystackHeaders = (secretValue: string) => ({
//   Authorization: `Bearer ${secretValue}`,
//   "Content-Type": "application/json",
// });

// Cache for bank list (to avoid repeated API calls)
let banksCache: any[] | null = null;

async function getPaystackBanks(secretValue: string, country = "kenya"): Promise<any[] | null> {
  if (banksCache) {
    return banksCache;
  }

  try {
    const response = await axios.get(
      `${PAYSTACK_API_BASE}/bank?country=${country}`,
      { headers: {
        'Authorization': `Bearer ${secretValue}`,
        'Content-Type': 'application/json'
      } }
    );

    if (response.data.status && response.data.data) {
      banksCache = response.data.data;
      return banksCache;
    }

    return [];
  } catch (error) {
    console.error("Error fetching banks:", error);
    return [];
  }
}

interface SetupAccountRequest {
  businessName: string;
  settlementBank: "mpesa" | "airtel-ke";
  accountNumber: string;
  email: string;
  name: string;
  phone: string;
  userId: string;
  pId?: string; 
}

interface ChargeCustomerRequest {
  amount: number;
  phone: string;
  pId: string;
  uid: string;
  id: string;
  service: string;
}

interface ProcessPaymentRequest {
  email: string;
  amount: number;
  currency: string;
  phone: string;
  provider: "mpesa" | "atl";
  metadata: {
    userId: string;
    userName: string;
    invoiceId: string;
    billingMonth: string;
    arrears: number;
    agentId: string;
  };
}

interface CreateUserRequest {
  email: string;
  password: string;
  userData: {
    localId?: string; // OPTIONAL - if provided, use as custom UID
    name: string;
    phone: string;
    tier?: string;
    type?: string;
    storage?: boolean;
    isPremium?: boolean;
    assetType?: 'landlord' | 'agent';
    cyberId?: string; // OPTIONAL - only for agent-created users
    company?: {
      name: string;
      address: string;
      phone: string;
      email: string;
    } | null;
  };
  creationType?: 'self' | 'agent'; // Identify who's creating the account
}

// ============= FUNCTION 1: SETUP SUBACCOUNT =============
export const setupAccount = onCall({
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
  secrets: [PAYSTACK_SECRET_KEY],
}, async (request: CallableRequest<SetupAccountRequest>) => {
  try {
    //const paystackHeaders = getPaystackHeaders(PAYSTACK_SECRET_KEY.value());
    
    // Validate authentication
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const { businessName, settlementBank, accountNumber, email, name, phone, userId, pId } = request.data;

    // Validate required fields
    if (!businessName || !settlementBank || !accountNumber || !email || !name || !phone || !userId) {
      throw new HttpsError(
        "invalid-argument",
        "All fields are required"
      );
    }

    // Validate and format account number
    let formattedAccountNumber = accountNumber.replace(/[\s-]/g, '');
    
    // For M-Pesa, convert to local format (0XXXXXXXXX)
    if (settlementBank.toLowerCase() === "mpesa" || settlementBank.toLowerCase() === "airtel-ke") {
      // Remove any + or spaces
      formattedAccountNumber = formattedAccountNumber.replace(/\+/g, '');
      
      // Convert from international format (254XXXXXXXXX) to local format (0XXXXXXXXX)
      if (formattedAccountNumber.startsWith('254')) {
        formattedAccountNumber = '0' + formattedAccountNumber.substring(3);
      } else if (!formattedAccountNumber.startsWith('0')) {
        // If it doesn't start with 254 or 0, assume it's missing the 0
        formattedAccountNumber = '0' + formattedAccountNumber;
      }
      
      console.log(`Formatted M-Pesa number: ${accountNumber} -> ${formattedAccountNumber}`);
    }
    
    console.log(`Account number: ${accountNumber} -> ${formattedAccountNumber}`);

    // Validate phone number format - Paystack Kenya prefers international format for contact phone
    let formattedPhone = phone.replace(/[\s+]/g, '');
    if (!formattedPhone.startsWith('254')) {
      if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
      } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
        formattedPhone = '254' + formattedPhone;
      }
    }
    
    console.log(`Formatted contact phone: ${phone} -> ${formattedPhone}`);

    // Get valid bank codes from Paystack
    const banks = await getPaystackBanks(PAYSTACK_SECRET_KEY.value(), "kenya");
    console.log(`Found ${banks?.length} banks for Kenya`);
    
    // Find the correct bank code
    let validBankCode = settlementBank.toLowerCase();
    
    // Search for M-Pesa or the provided bank name
    const bankMatch = banks?.find(bank => 
      bank.code?.toLowerCase() === settlementBank.toLowerCase() ||
      bank.name?.toLowerCase().includes(settlementBank.toLowerCase()) ||
      (settlementBank.toLowerCase() === 'mpesa' && bank.name?.toLowerCase().includes('m-pesa'))
    );

    if (bankMatch) {
      validBankCode = bankMatch.code;
      console.log(`Matched settlement bank: ${settlementBank} -> ${bankMatch.name} (${bankMatch.code})`);
    } else {
      console.warn(`No exact match found for ${settlementBank}, using as-is`);
      // Log available banks for debugging
      console.log('Available banks:', banks?.map(b => `${b.name} (${b.code})`).join(', '));
    }

    // Query Firestore for user
    let userDoc = null;

    if(pId) {
      userDoc = await db.collection("agents").doc(userId).get();
    } else {
      userDoc = await db.collection("users").doc(userId).get();
    }
    // const userDoc = await db.collection("users").doc(userId).get() ||
    //                 await db.collection("agents").doc(userId).get();

    if (!userDoc.exists) {
      throw new HttpsError(
        "not-found",
        "User not found in database"
      );
    }

    const userData = userDoc.data();
    const userTier = userData?.tier?.toUpperCase() || "SOLO";

    // Determine commission rate based on tier
    const commissionRate = TIER_RATES[userTier as keyof typeof TIER_RATES] || TIER_RATES.SOLO;

    console.log(`Setting up account for user ${userId} with tier ${userTier} at ${commissionRate}%`);

    // Create subaccount via Paystack API
    const requestBody = {
      business_name: businessName,
      settlement_bank: validBankCode,
      account_number: formattedAccountNumber,
      percentage_charge: commissionRate,
      primary_contact_email: email,
      primary_contact_name: name,
      primary_contact_phone: formattedPhone,
      metadata: {
        userId: userId,
        tier: userTier,
      },
    };

    console.log('Paystack request body:', JSON.stringify(requestBody, null, 2));

    const paystackResponse = await axios.post(
      `${PAYSTACK_API_BASE}/subaccount`,
      requestBody,
      { headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
        'Content-Type': 'application/json'
      } }
    );

    if (!paystackResponse.data.status) {
      throw new HttpsError(
        "internal",
        `Paystack API error: ${paystackResponse.data.message}`
      );
    }

    const subaccountData = paystackResponse.data.data;

    // Write to Firestore - Update user's paymentInfo
    if (pId) {
      await db.collection("agents").doc(userId).update({
      paymentInfo: {
        accountId: subaccountData.subaccount_code,
        split: 55,
        businessName: businessName,
        settlementBank: settlementBank,
        accountNumber: formattedAccountNumber,
        email: email,
        name: name,
        phone: formattedPhone,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        paystackIntegrationCode: subaccountData.integration,
        active: subaccountData.is_verified,
      },
    });
    } else {
    await db.collection("users").doc(userId).update({
      paymentInfo: {
        accountId: subaccountData.subaccount_code,
        split: commissionRate,
        businessName: businessName,
        settlementBank: settlementBank,
        accountNumber: formattedAccountNumber,
        email: email,
        name: name,
        phone: formattedPhone,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        paystackIntegrationCode: subaccountData.integration,
        active: subaccountData.is_verified,
      },
    });
  }

    // Also create a payment accounts collection entry
    await db.collection("paymentAccounts").doc(userId).set({
      userId: userId,
      subaccountCode: subaccountData.subaccount_code,
      businessName: businessName,
      settlementBank: settlementBank,
      accountNumber: formattedAccountNumber,
      commissionRate: commissionRate,
      tier: userTier,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Successfully created subaccount for user ${userId}: ${subaccountData.subaccount_code}`);

    return {
      success: true,
      message: "Subaccount created successfully",
      data: {
        subaccountCode: subaccountData.subaccount_code,
        commissionRate: commissionRate,
        tier: userTier,
      },
    };
  } catch (error: any) {
    console.error("Error in setupAccount:", error);
    
    // Log detailed Axios error info
    if (error.response) {
      console.error("Paystack error response:", {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    }

    if (error instanceof HttpsError) {
      throw error;
    }

    // Include Paystack's error message if available
    const errorMessage = error.response?.data?.message || error.message;
    throw new HttpsError(
      "internal",
      `Failed to setup account: ${errorMessage}`
    );
  }
});

// ============= HELPER: CREATE OR GET SPLIT CODE =============
async function getOrCreateSplitCode(
  subaccountCode: string,
  commissionRate: number,
  agentId: string
): Promise<string> {
  
  // Check if split code exists in Firestore cache
  const splitDoc = await db.collection("splitCodes").doc(agentId).get();
  
  if (splitDoc.exists) {
    const data = splitDoc.data();
    // Verify the split matches current commission rate
    if (data?.commissionRate === commissionRate) {
      console.log(`Using cached split code for agent ${agentId}: ${data.splitCode}`);
      return data.splitCode;
    }
  }
  
  // Create new split code
  try {
    const splitPayload = {
      name: `Agent ${agentId} Split`,
      type: "percentage",
      currency: "KES",
      subaccounts: [
        {
          subaccount: subaccountCode,
          share: 100 - commissionRate,
        },
      ],
      bearer_type: "all-proportional",
    };
    
    console.log('Creating split code:', JSON.stringify(splitPayload, null, 2));
    
    const response = await axios.post(
      `${PAYSTACK_API_BASE}/split`,
      splitPayload,
      { headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
        'Content-Type': 'application/json'
      } }
    );
    
    if (!response.data.status) {
      throw new Error(`Failed to create split: ${response.data.message}`);
    }
    
    const splitCode = response.data.data.split_code;
    
    // Cache the split code
    await db.collection("splitCodes").doc(agentId).set({
      splitCode: splitCode,
      subaccountCode: subaccountCode,
      commissionRate: commissionRate,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    console.log(`Created new split code for agent ${agentId}: ${splitCode}`);
    return splitCode;
    
  } catch (error: any) {
    console.error('Error creating split code:', error.response?.data || error.message);
    throw error;
  }
}

// ============= FUNCTION 2: PROCESS PAYMENT (WITH SPLIT CODE) =============
export const processPayment = onCall({
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
  secrets: [PAYSTACK_SECRET_KEY],
}, async (request: CallableRequest<ProcessPaymentRequest>) => {
  try {
    //const paystackHeaders = getPaystackHeaders(PAYSTACK_SECRET_KEY.value());
    
    const { email, amount, currency, phone, provider, metadata } = request.data;

    // Validate required fields
    if (!email || !amount || !currency || !phone || !provider || !metadata) {
      throw new HttpsError(
        "invalid-argument",
        "All fields including metadata are required"
      );
    }

    const { userId, userName, invoiceId, billingMonth, arrears, agentId } = metadata;

    // Get agent's payment info (subaccount)
    const agentDoc = await db.collection("users").doc(agentId).get();

    if (!agentDoc.exists) {
      throw new HttpsError(
        "not-found",
        "Agent not found in database"
      );
    }

    const agentData = agentDoc.data();
    const paymentInfo = agentData?.paymentInfo;

    if (!paymentInfo || !paymentInfo.accountId) {
      throw new HttpsError(
        "failed-precondition",
        "Agent has not set up payment account. Please configure payment details first."
      );
    }

    const subaccountCode = paymentInfo.accountId;
    const commissionRate = paymentInfo.split || 2.1;

    console.log(`Processing payment for user ${userId}, agent ${agentId}, amount ${amount}`);

    // Get or create split code
    const splitCode = await getOrCreateSplitCode(subaccountCode, commissionRate, agentId);

    // Format phone number for Paystack Kenya M-Pesa charge (+254XXXXXXXXX format)
    let formattedPhone = phone.replace(/[\s-]/g, ''); // Remove spaces and dashes, keep +
    
    // Ensure it has the + prefix and 254 country code
    if (formattedPhone.startsWith('+254')) {
      // Already correct format
      formattedPhone = formattedPhone;
    } else if (formattedPhone.startsWith('254')) {
      // Add the + prefix
      formattedPhone = '+' + formattedPhone;
    } else if (formattedPhone.startsWith('0')) {
      // Convert from local (0XXXXXXXXX) to international (+254XXXXXXXXX)
      formattedPhone = '+254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
      // Just the last 9 digits
      formattedPhone = '+254' + formattedPhone;
    } else if (formattedPhone.startsWith('+')) {
      // Has + but might not have 254
      if (!formattedPhone.startsWith('+254')) {
        formattedPhone = '+254' + formattedPhone.substring(1);
      }
    }
    
    console.log(`Formatted phone for M-Pesa charge (+254 format): ${phone} -> ${formattedPhone}`);

    // Convert amount to cents
    const amountInCents = Math.round(amount * 100);

    // Charge payload with split_code
    const chargePayload = {
      email: email,
      amount: amountInCents,
      currency: currency,
      mobile_money: {
        phone: formattedPhone,
        provider: provider,
      },
      reference: `INV_${userId}_${Date.now()}`,
      split_code: splitCode,  // Use split_code instead of split object
      metadata: {
        userId: userId,
        userName: userName,
        invoiceId: invoiceId,
        billingMonth: billingMonth,
        arrears: arrears,
        agentId: agentId,
        originalAmount: amount,
      },
    };

    console.log('Paystack charge request:', JSON.stringify(chargePayload, null, 2));

    const paystackResponse = await axios.post(
      `${PAYSTACK_API_BASE}/charge`,
      chargePayload,
      { headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
        'Content-Type': 'application/json'
      } }
    );

    console.log('Paystack response:', JSON.stringify(paystackResponse.data, null, 2));

    if (!paystackResponse.data.status) {
      throw new HttpsError(
        "internal",
        `Paystack API error: ${paystackResponse.data.message}`
      );
    }

    const transactionData = paystackResponse.data.data;

    console.log(`Payment charge initiated: ${transactionData.reference}, status: ${transactionData.status}`);

    // Create payment record
    const paymentRecord = {
      userName: userName,
      agentId: agentId,
      amount: amount,
      arrears: arrears,
      invoiceId: invoiceId,
      billingMonth: billingMonth,
      currency: currency,
      phone: formattedPhone,
      provider: provider,
      reference: transactionData.reference,
      status: transactionData.status || "pending",  // Can be "pay_offline", "pending", etc.
      displayText: transactionData.display_text,
      accountReference: transactionData.account_reference,  // M-Pesa specific reference
      initiatedAt: new Date().toISOString(),
      subaccountCode: subaccountCode,
      commissionRate: commissionRate,
      splitCode: splitCode,
    };

    // Write to payments collection
    await db
      .collection("payments")
      .doc(userId)
      .collection("billingMonths")
      .doc(billingMonth)
      .set(
        {
          payments: admin.firestore.FieldValue.arrayUnion(paymentRecord),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    // Create transaction record
    await db.collection("transactions").doc(transactionData.reference).set({
      userName: userName,
      email: email,
      phone: formattedPhone,
      provider: provider,
      currency: currency,
      userId: userId,
      agentId: agentId,
      invoiceId: invoiceId,
      billingMonth: billingMonth,
      amount: amount,
      arrears: arrears,
      status: transactionData.status || "pending",
      reference: transactionData.reference,
      displayText: transactionData.display_text,
      accountReference: transactionData.account_reference,
      splitCode: splitCode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      message: "Payment initialized successfully",
      data: {
        reference: transactionData.reference,
        status: transactionData.status,
        displayText: transactionData.display_text || "Check your phone for the M-Pesa prompt",
        accountReference: transactionData.account_reference,
      },
    };
  } catch (error: any) {
    console.error("Error in processPayment:", error);
    
    if (error.response) {
      console.error("Paystack error response:", {
        status: error.response.status,
        data: JSON.stringify(error.response.data, null, 2),
      });
    }

    if (error instanceof HttpsError) {
      throw error;
    }

    const errorMessage = error.response?.data?.message || error.message;
    throw new HttpsError(
      "internal",
      `Failed to process payment: ${errorMessage}`
    );
  }
});


// ============= FUNCTION: CHARGE CUSTOMER (CYBER SERVICES) =============
export const chargeCustomer = onCall({
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
  secrets: [PAYSTACK_SECRET_KEY],
}, async (request: CallableRequest<ChargeCustomerRequest>) => {
  try {
    const { amount, phone, pId, uid, id, service } = request.data;

    // Validate required fields
    if (!amount || !phone || !pId || !uid || !id || !service) {
      throw new HttpsError(
        "invalid-argument",
        "All fields (amount, phone, pId, uid, id, service) are required"
      );
    }

    // Get agent's payment info from agents collection
    const agentDoc = await db.collection("agents").doc(uid).get();

    if (!agentDoc.exists) {
      throw new HttpsError(
        "not-found",
        "Agent not found in database"
      );
    }

    const agentData = agentDoc.data();
    const paymentInfo = agentData?.paymentInfo;

    if (!paymentInfo || !paymentInfo.accountId) {
      throw new HttpsError(
        "failed-precondition",
        "Agent has not set up payment account. Please configure payment details first."
      );
    }

    const subaccountCode = paymentInfo.accountId;
    const commissionRate = 2.5; // Fixed 2.5% commission for cyber services

    console.log(`Processing cyber charge for agent ${id} (${pId}), amount ${amount}, service: ${service}`);

    // Get or create split code
    const splitCode = await getOrCreateSplitCode(
      subaccountCode, 
      commissionRate, 
      id
    );

    // Format phone number for Paystack Kenya M-Pesa charge (+254XXXXXXXXX format)
    let formattedPhone = phone.replace(/[\s-]/g, '');
    
    if (formattedPhone.startsWith('+254')) {
      formattedPhone = formattedPhone;
    } else if (formattedPhone.startsWith('254')) {
      formattedPhone = '+' + formattedPhone;
    } else if (formattedPhone.startsWith('0')) {
      formattedPhone = '+254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
      formattedPhone = '+254' + formattedPhone;
    } else if (formattedPhone.startsWith('+')) {
      if (!formattedPhone.startsWith('+254')) {
        formattedPhone = '+254' + formattedPhone.substring(1);
      }
    }
    
    console.log(`Formatted phone for M-Pesa charge: ${phone} -> ${formattedPhone}`);

    // Convert amount to cents
    const amountInCents = Math.round(amount * 100);

    // Generate unique reference with CYBER prefix
    const reference = `CYBER_${pId}_${Date.now()}`;

    // Charge payload with split_code
    const chargePayload = {
      email: agentData.email || `${pId}@cyber.local`,
      amount: amountInCents,
      currency: "KES",
      mobile_money: {
        phone: formattedPhone,
        provider: "mpesa",
      },
      reference: reference,
      split_code: splitCode,
      metadata: {
        pId: pId,
        uid: uid,
        agentId: id,
        service: service,
        originalAmount: amount,
        chargeType: "cyber_service",
        commissionRate: commissionRate,
      },
    };

    console.log('Paystack cyber charge request:', JSON.stringify(chargePayload, null, 2));

    const paystackResponse = await axios.post(
      `${PAYSTACK_API_BASE}/charge`,
      chargePayload,
      { 
        headers: {
          'Authorization': `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
          'Content-Type': 'application/json'
        } 
      }
    );

    console.log('Paystack cyber charge response:', JSON.stringify(paystackResponse.data, null, 2));

    if (!paystackResponse.data.status) {
      throw new HttpsError(
        "internal",
        `Paystack API error: ${paystackResponse.data.message}`
      );
    }

    const transactionData = paystackResponse.data.data;

    console.log(`Cyber charge initiated: ${transactionData.reference}, status: ${transactionData.status}`);

    // Create transaction record for cyber charges
    await db.collection("cyber-transactions").doc(transactionData.reference).set({
      pId: pId,
      uid: uid,
      agentId: id,
      service: service,
      phone: formattedPhone,
      amount: amount,
      currency: "KES",
      status: transactionData.status || "pending",
      reference: transactionData.reference,
      displayText: transactionData.display_text,
      accountReference: transactionData.account_reference,
      splitCode: splitCode,
      subaccountCode: subaccountCode,
      commissionRate: commissionRate,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      message: "Charge initiated successfully",
      data: {
        reference: transactionData.reference,
        status: transactionData.status,
        displayText: transactionData.display_text || "Check your phone for the M-Pesa prompt",
        accountReference: transactionData.account_reference,
      },
    };
  } catch (error: any) {
    console.error("Error in chargeCustomer:", error);
    
    if (error.response) {
      console.error("Paystack error response:", {
        status: error.response.status,
        data: JSON.stringify(error.response.data, null, 2),
      });
    }

    if (error instanceof HttpsError) {
      throw error;
    }

    const errorMessage = error.response?.data?.message || error.message;
    throw new HttpsError(
      "internal",
      `Failed to charge customer: ${errorMessage}`
    );
  }
});

interface PaystackWebhookData {
  event: string;
  data: {
    reference: string;
    amount: number;
    fees?: number;
    amount_received?: number;
    channel?: string; // e.g. "mobile_money" (M-Pesa) or "card" — used to split PNS booking income by channel
    gateway_response: string;
    status: string;
    metadata?: {
      [key: string]: any;
    };
    split?: {
      split_code: string;
    };
    accountReference?: string;
  };
}

export const paystackCallback = onRequest({
  timeoutSeconds: 60,
  memory: "512MiB",
  cors: false,
  maxInstances: 10,
  region: "africa-south1",
  secrets: [PAYSTACK_SECRET_KEY],
}, async (req, res) => {
  console.log(`Webhook request received: ${req.method}`);

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Verify Paystack signature
    const hash = req.headers["x-paystack-signature"]?.toString();
    const rawBody = Buffer.from(req.rawBody || JSON.stringify(req.body));
    const body = rawBody.toString();

    const expectedHash = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY.value())
      .update(body)
      .digest("hex");

    if (hash !== expectedHash) {
      console.error("Invalid signature");
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    const event: PaystackWebhookData = JSON.parse(body);
    console.log(`Received webhook event: ${event.event}`);

    // Handle charge.success event
    if (event.event === "charge.success") {
      const data = event.data;
      const reference = data.reference;
      const metadata = data.metadata || {};

      console.log(`Processing successful payment: ${reference}`);

      // === DETERMINE CHARGE TYPE ===
      const chargeType = metadata.chargeType || determineChargeType(reference);

      console.log(`Identified charge type: ${chargeType}`);

      // ── NEW: SMS top-up → settle in project 2 ────────────────────────────
      if (chargeType === "sms_topup" || reference.startsWith("SMS_")) {
        if (metadata.targetProject === "pms") {
          await handlePmsSmsTopUp(reference, data, metadata);
        } else {
          await handleSmsTopUp(reference, data, metadata);
        }
      }

      // ============================================
      // 1. REPORT CHARGE (Platform -> Platform Account)
      // ============================================
      else if (chargeType === 'report_charge' || reference.startsWith('REPORT_')) {
        await handleReportCharge(reference, data, metadata);
      }

      // ============================================
      // 2. SHOP CUSTOMER CHARGE (Shop -> Shop Account via Split)
      // ============================================
      else if (chargeType === 'shop_charge' || reference.startsWith('SHOP_')) {
        await handleShopCustomerCharge(reference, data, metadata);
      }

      // ============================================
      // 3. CYBER SERVICE CHARGE (existing)
      // ============================================
      else if (reference.startsWith('CYBER_')) {
        await handleCyberCharge(reference, data, metadata);
      }

      // ============================================
      // 4. SUBSCRIPTION CHARGE (existing)
      // ============================================
      else if (reference.startsWith('SUB_')) {
        await handlePlotYanguSubscriptionCharge(reference, data, metadata);
      }

      else if (reference.startsWith('MOV_')) {
        await handleMoviesSub(reference, data, metadata);
      }

      // ============================================
      // 5. AGENT/INVOICE PAYMENT (existing)
      // ============================================
      else if (reference.startsWith('INV_')) {
        await handleAgentPayment(reference, data, metadata);
      }

      // ============================================
      // 6. PNS BOOKING PAYMENT (photographer booking, via subaccount split)
      // ============================================
      else if (chargeType === 'pns_booking_payment' || metadata.chargeType === 'booking_payment' || reference.startsWith('BOOK_')) {
        await handlePNSBookingPayment(reference, data, metadata);
      }

      // ============================================
      // 7. PNS STORAGE PURCHASE (photographer/reader storage top-up)
      // ============================================
      else if (chargeType === 'pns_storage_purchase' || metadata.chargeType === 'storage_purchase' || reference.startsWith('STORE_')) {
        await handlePNSStoragePurchase(reference, data, metadata);
      }

      else {
        console.warn(`Unknown reference type: ${reference}`);
      }
    }

    // Handle failed payments
    if (event.event === "charge.failed") {
      const data = event.data;
      const reference = data.reference;
      const chargeType = data.metadata?.chargeType || determineChargeType(reference);

      console.warn(`Payment failed: ${reference} (type: ${chargeType})`);

      // Update appropriate collection based on charge type
      if (chargeType === "sms_topup" || reference.startsWith("SMS_")) {
        const targetDb = data.metadata?.targetProject === "pms" ? db : db2;
        await targetDb.collection("sms-topup-transactions").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        }).catch(e => console.error("Failed to update sms-topup failure:", e));
      }

      else if (chargeType === 'report_charge' || reference.startsWith('REPORT_')) {
        await db.collection("report_charges").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        });
      } else if (chargeType === 'shop_charge' || reference.startsWith('SHOP_')) {
        const shopId = data.metadata?.shopId;
        await db.collection("shops").doc(shopId || '').collection("transactions").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        });
      } else if (reference.startsWith('CYBER_')) {
        await db.collection("cyber-transactions").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        });
      } 
      else if (reference.startsWith('MOV_')) {
        // Extract agentId from reference
        const refParts = reference.split('_');
        const agentId = refParts[1];
        
        if (agentId) {
          await db
            .collection("agents")
            .doc(agentId)
            .collection("movies-income")
            .doc(reference)
            .update({
              status: "failed",
              failedAt: admin.firestore.FieldValue.serverTimestamp(),
              failureReason: data.gateway_response,
            });
          
          console.log(`Movie subscription payment failed: ${reference}`);
        }
      }
      else if (reference.startsWith('SUB_')) {
        await db.collection("subscriptions").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        });
      } 

      else if (reference.startsWith('BOOK_')) {
        const bookingId = data.metadata?.bookingId;
        if (bookingId) {
          await db.collection("bookings").doc(bookingId).update({
            status: "payment_failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(e => console.error("Failed to update booking failure:", e));
        }
      }

      else if (reference.startsWith('STORE_')) {
        const purchaseId = data.metadata?.purchaseId;
        if (purchaseId) {
          await db.collection("storagePurchases").doc(purchaseId).update({
            status: "failed",
          }).catch(e => console.error("Failed to update storage purchase failure:", e));
        }
      }

      else {
        await db.collection("transactions").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        });
      }
    }

    res.status(200).json({
      received: true,
      processed: true,
      eventType: event.event
    });
  } catch (error: any) {
    console.error("Error in paystackCallback:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message
    });
  }
});

// ============================================================================
// CHARGE TYPE HANDLERS
// ============================================================================

/**
 * Handle Report Charge (Platform charges user for report access)
 * Money goes directly to platform account (no split code)
 */
async function handleReportCharge(
  reference: string,
  data: any,
  metadata: any
): Promise<void> {
  try {
    console.log(`Processing report charge: ${reference}`);

    const shopId = metadata.shopId;
    const reportPeriod = metadata.reportPeriod || 'unknown';
    const dateRange = metadata.dateRange || 'unknown';
    const userPhone = metadata.userPhone;
    const chargeAmount = metadata.chargeAmount || 0;

    // Update report charge status to success
    await db.collection("report_charges").doc(reference).update({
      status: "success",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      paystackReference: data.reference,
      paystackResponse: {
        amount: data.amount / 100,
        fees: data.fees ? data.fees / 100 : 0,
        amountReceived: data.amount_received ? data.amount_received / 100 : 0,
      },
    });

    // Also update shop-level report_charges
    if (shopId) {
      await db
        .collection("shops")
        .doc(shopId)
        .collection("report_charges")
        .doc(reference)
        .update({
          status: "success",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          paystackReference: data.reference,
        });
    }

    // Record platform revenue
    const grossAmount = data.amount / 100;
    const paystackFees = data.fees ? data.fees / 100 : 0;
    const platformRevenue = grossAmount - paystackFees;

    const revenueRecord = {
      reference,
      shopId,
      userPhone,
      reportPeriod,
      dateRange,
      chargeAmount,
      grossAmount,
      paystackFees,
      platformRevenue,
      currency: "KES",
      status: "success",
      type: "report_charge",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db
      .collection("platform_revenue")
      .doc(reference)
      .set(revenueRecord);

    // Update platform totals
    await db.collection("platform_stats").doc("totals").set({
      totalReportCharges: admin.firestore.FieldValue.increment(1),
      totalReportRevenue: admin.firestore.FieldValue.increment(platformRevenue),
      lastReportChargeDate: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(
      `✅ Report charge processed: ${reference}\n` +
      `   Period: ${reportPeriod} (${dateRange})\n` +
      `   Amount: KES ${chargeAmount}\n` +
      `   Platform Revenue: KES ${platformRevenue}\n` +
      `   Shop: ${shopId}`
    );

    // Send WhatsApp feedback to user
    await sendReportChargeSuccessMessage(shopId, userPhone, reportPeriod, chargeAmount);

  } catch (error: any) {
    console.error(`Error processing report charge ${reference}:`, error);
    throw error;
  }
}

/**
 * Handle Shop Customer Charge (Shop charges customer, funds routed via split code)
 * Money goes to shop account via Paystack split
 */
async function handleShopCustomerCharge(
  reference: string,
  data: any,
  metadata: any
): Promise<void> {
  try {
    console.log(`Processing shop customer charge: ${reference}`);

    const shopId = metadata.shopId;
    const customerPhone = metadata.customerPhone;
    const chargeAmount = data.amount / 100;

    // Update transaction status
    await db
      .collection("shops")
      .doc(shopId || '')
      .collection("transactions")
      .doc(reference)
      .update({
        status: "success",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        paystackReference: data.reference,
        paystackResponse: {
          amount: data.amount / 100,
          fees: data.fees ? data.fees / 100 : 0,
          amountReceived: data.amount_received ? data.amount_received / 100 : 0,
        },
      });

    // Calculate split
    const grossAmount = data.amount / 100;
    const paystackFees = data.fees ? data.fees / 100 : 0;
    const netToShop = grossAmount - paystackFees;

    // Update shop income
    await db.collection("shops").doc(shopId || '').set({
      totalChargeRevenue: admin.firestore.FieldValue.increment(netToShop),
      totalChargesCollected: admin.firestore.FieldValue.increment(1),
      lastChargeAmount: netToShop,
      lastChargeDate: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(
      `✅ Shop charge processed: ${reference}\n` +
      `   Customer: ${customerPhone}\n` +
      `   Amount: KES ${chargeAmount}\n` +
      `   Net to Shop: KES ${netToShop}\n` +
      `   Shop: ${shopId}`
    );

    // Send WhatsApp feedback to shop owner
    await sendShopChargeSuccessMessage(shopId, customerPhone, chargeAmount);

  } catch (error: any) {
    console.error(`Error processing shop charge ${reference}:`, error);
    throw error;
  }
}

/**
 * Handle Cyber Service Charge (existing logic)
 */
async function handleCyberCharge(
  reference: string,
  data: any,
  metadata: any
): Promise<void> {
  try {
    console.log(`Processing cyber service charge: ${reference}`);

    const transactionRef = db.collection("cyber-transactions").doc(reference);
    const transactionDoc = await transactionRef.get();

    if (!transactionDoc.exists) {
      console.error(`Cyber transaction not found: ${reference}`);
      return;
    }

    const transactionData = transactionDoc.data();
    const uid = metadata.uid || transactionData?.uid;
    const pId = metadata.pId || transactionData?.pId;
    const service = metadata.service || transactionData?.service;

    // Update transaction status
    await transactionRef.update({
      status: "success",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      paystackResponse: data,
    });

    const grossAmount = data.amount / 100;
    const paystackFees = data.fees ? data.fees / 100 : 0;
    const netAfterPaystack = grossAmount - paystackFees;
    const platformCommission = (netAfterPaystack * 2.5) / 100;
    const agentNetIncome = netAfterPaystack - platformCommission;

    console.log(
      `Cyber income calculation: Gross: ${grossAmount}, Paystack Fees: ${paystackFees}, ` +
      `Net after Paystack: ${netAfterPaystack}, Platform Commission: ${platformCommission}, ` +
      `Agent Net: ${agentNetIncome}`
    );

    const incomeRecord: any = {
      reference,
      pId,
      service,
      grossAmount,
      paystackFees,
      netAfterPaystack,
      platformCommission,
      agentNetIncome,
      commissionRate: 2.5,
      currency: "KES",
      status: "success",
      type: "cyber_service",
      phone: transactionData?.phone,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      splitCode: data.split?.split_code || transactionData?.splitCode,
      accountReference: data.accountReference || transactionData?.accountReference || null,
    };

    Object.keys(incomeRecord).forEach((key) => {
      if (incomeRecord[key] === undefined) {
        delete incomeRecord[key];
      }
    });

    await db
      .collection("agents")
      .doc(uid)
      .collection("cyber-income")
      .doc(reference)
      .set(incomeRecord);

    await db
      .collection("agents")
      .doc(uid)
      .set({
        totalCyberIncome: admin.firestore.FieldValue.increment(agentNetIncome),
        totalCyberTransactions: admin.firestore.FieldValue.increment(1),
        lastCyberIncomeDate: admin.firestore.FieldValue.serverTimestamp(),
        lastCyberIncomeAmount: agentNetIncome,
      }, { merge: true });

    console.log(`Successfully recorded cyber income for agent ${uid}: ${agentNetIncome} KES`);

  } catch (error: any) {
    console.error(`Error processing cyber charge ${reference}:`, error);
    throw error;
  }
}

/**
 * Handle Subscription Charge (existing logic)
 */
async function handlePlotYanguSubscriptionCharge(
  reference: string,
  data: any,
  metadata: any
): Promise<void> {
  try {
    console.log(`Processing subscription charge: ${reference}`);

    const subscriptionRef = db.collection("subscriptions").doc(reference);
    const subscriptionDoc = await subscriptionRef.get();

    if (!subscriptionDoc.exists) {
      console.error(`Subscription not found: ${reference}`);
      return;
    }

    const subscriptionData = subscriptionDoc.data();
    const userId = metadata.userId || subscriptionData?.userId;
    const planId = metadata.planId || subscriptionData?.planId;
    const planName = metadata.planName || subscriptionData?.planName;
    const daysToAdd = metadata.daysToAdd || subscriptionData?.daysToAdd || 30;
    const agentId = metadata.agentId || subscriptionData?.agentId;

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + daysToAdd);

    await subscriptionRef.update({
      status: "success",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
      paystackResponse: data,
    });

    const userRef = db.collection("users").doc(userId);
    await userRef.set({
      type: "paid",
      tier: planId,
      storage: true,
      subscriptionExpiry: admin.firestore.Timestamp.fromDate(expiryDate),
      lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
      lastPaymentReference: reference,
      lastPaymentAmount: data.amount / 100,
      planName: planName,
      isTrial: false
    }, { merge: true });

    console.log(`Successfully activated subscription for user ${userId}`);

    if (agentId) {
      try {
        const grossAmount = data.amount / 100;
        const paystackFees = data.fees ? data.fees / 100 : 0;
        const netAmount = grossAmount - paystackFees;
        const commissionRate = 45;
        const agentCommission = (netAmount * commissionRate) / 100;
        const platformRevenue = netAmount - agentCommission;

        const incomeRecord = {
          reference: reference,
          userId: userId,
          userName: metadata.userName || subscriptionData?.userName || "Unknown",
          planId: planId,
          planName: planName,
          grossAmount: grossAmount,
          netAmount: netAmount,
          agentCommission: agentCommission,
          platformRevenue: platformRevenue,
          paystackFees: paystackFees,
          commissionRate: commissionRate,
          currency: "KES",
          status: "success",
          type: "subscription",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
          splitCode: data.split?.split_code || null,
        };

        await db
          .collection("agents")
          .doc(agentId)
          .collection("plot-income")
          .doc(reference)
          .set(incomeRecord);

        const agentRef = db.collection("agents").doc(agentId);
        await agentRef.set({
          totalIncome: admin.firestore.FieldValue.increment(agentCommission),
          totalSubscriptions: admin.firestore.FieldValue.increment(1),
          lastIncomeDate: admin.firestore.FieldValue.serverTimestamp(),
          lastIncomeAmount: agentCommission,
        }, { merge: true });

        console.log(`Successfully recorded subscription income for agent ${agentId}`);
      } catch (agentError: any) {
        console.error(`Error recording agent commission:`, agentError);
      }
    }

  } catch (error: any) {
    console.error(`Error processing subscription charge ${reference}:`, error);
    throw error;
  }
}

/**
 * Handle Agent Payment (existing logic)
 */
async function handleAgentPayment(
  reference: string,
  data: any,
  metadata: any
): Promise<void> {
  try {
    console.log(`Processing agent payment: ${reference}`);

    const transactionRef = db.collection("transactions").doc(reference);
    const transactionDoc = await transactionRef.get();

    if (!transactionDoc.exists) {
      console.error(`Transaction not found: ${reference}`);
      return;
    }

    const transactionData = transactionDoc.data();

    await transactionRef.update({
      status: "success",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      paystackResponse: data,
    });

    const userId = metadata.userId || transactionData?.userId;
    const billingMonth = metadata.billingMonth || transactionData?.billingMonth;

    if (userId && billingMonth) {
      const paymentDoc = await db
        .collection("payments")
        .doc(userId)
        .collection("billingMonths")
        .doc(billingMonth)
        .get();

      if (paymentDoc.exists) {
        const paymentData = paymentDoc.data();
        const payments = paymentData?.payments || [];

        const updatedPayments = payments.map((payment: any) => {
          if (payment.reference === reference) {
            return {
              ...payment,
              status: "success",
              completedAt: new Date().toISOString(),
              paidAmount: data.amount / 100,
              fees: data.fees / 100,
            };
          }
          return payment;
        });

        await db
          .collection("payments")
          .doc(userId)
          .collection("billingMonths")
          .doc(billingMonth)
          .update({
            payments: updatedPayments,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
          });
      }

      const invoiceId = metadata.invoiceId || transactionData?.invoiceId;
      if (invoiceId) {
        await db.collection("invoices").doc(invoiceId).update({
          status: "paid",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentReference: reference,
        });
      }
    }

    console.log(`Successfully processed agent payment: ${reference}`);

  } catch (error: any) {
    console.error(`Error processing agent payment ${reference}:`, error);
    throw error;
  }
}

async function handleMoviesSub(
  reference: string,
  data: any,
  metadata: any
): Promise<void> {
  try {
    console.log(`Processing movie subscription charge: ${reference}`);

    // Extract agentId from reference: MOV_{agentId}_{timestamp}
    const refParts = reference.split('_');
    const agentId = refParts[1];

    if (!agentId) {
      console.error(`Invalid movie subscription reference format: ${reference}`);
      return;
    }

    // Get payment document from agents/{agentId}/movies-income/{reference}
    const paymentRef = db.collection("agents").doc(agentId).collection("movies-income").doc(reference);
    const paymentDoc = await paymentRef.get();

    if (!paymentDoc.exists) {
      console.error(`Movie payment document not found: ${reference}`);
      return;
    }

    const paymentData = paymentDoc.data();
    const userId = metadata.userId || paymentData?.userId;
    const plan = metadata.plan || paymentData?.plan;
    const billingCycle = metadata.billingCycle || paymentData?.billingCycle;
    const userPlanId = metadata.userPlanId || paymentData?.userPlanId;

    console.log(`Movie subscription details - User: ${userId}, Plan: ${plan}, Cycle: ${billingCycle}`);

    // Calculate amounts
    const grossAmount = data.amount / 100;
    const paystackFees = data.fees ? data.fees / 100 : 0;
    const amountReceived = data.amount_received ? data.amount_received / 100 : (grossAmount - paystackFees);

    // Update payment document status
    await paymentRef.update({
      status: "success",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      paystackReference: data.reference,
      paystackResponse: {
        amount: grossAmount,
        fees: paystackFees,
        amountReceived: amountReceived,
      },
    });

    console.log(`✅ Movie payment document updated: ${reference}`);

    // Calculate subscription expiry date based on billing cycle
    const expiryDate = new Date();
    if (billingCycle === 'monthly') {
      expiryDate.setMonth(expiryDate.getMonth() + 1);
    } else if (billingCycle === 'weekly') {
      expiryDate.setDate(expiryDate.getDate() + 7);
    } else {
      // Default to monthly if cycle is not specified
      expiryDate.setMonth(expiryDate.getMonth() + 1);
    }

    // Get plan limits
    const planLimits: Record<string, { movies: number; series: number; music: number }> = {
      hustler: { movies: 10, series: 5, music: 0 },
      jeshi: { movies: 15, series: 15, music: 10 },
      legend: { movies: 20, series: 20, music: 15 },
      bazuu: { movies: 9999, series: 9999, music: 9999 },
    };

    const limits = planLimits[plan] || planLimits.hustler;

    // Update user's subscription in users collection
    const userRef = db.collection("users").doc(userId);
    await userRef.set({
      plan: plan,
      billingCycle: billingCycle,
      subscriptionStartDate: admin.firestore.FieldValue.serverTimestamp(),
      subscriptionExpiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
      stats: {
        moviesWatched: 0,
        seriesWatched: 0,
        musicPlayed: 0,
        moviesRemaining: limits.movies,
        seriesRemaining: limits.series,
        musicRemaining: limits.music,
      },
      lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
      lastPaymentReference: reference,
      lastPaymentAmount: grossAmount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(
      `✅ Movie subscription activated:\n` +
      `   User: ${userPlanId} (${userId})\n` +
      `   Plan: ${plan} (${billingCycle})\n` +
      `   Amount: KES ${grossAmount}\n` +
      `   Expires: ${expiryDate.toISOString()}\n` +
      `   Limits: ${limits.movies} movies, ${limits.series} series, ${limits.music} music\n` +
      `   Agent: ${agentId}`
    );

    // Update agent's movie subscription stats
    await db.collection("agents").doc(agentId).set({
      totalMovieSubscriptions: admin.firestore.FieldValue.increment(1),
      totalMovieRevenue: admin.firestore.FieldValue.increment(amountReceived),
      lastMovieSubscriptionDate: admin.firestore.FieldValue.serverTimestamp(),
      lastMovieSubscriptionAmount: amountReceived,
    }, { merge: true });

  } catch (error: any) {
    console.error(`Error processing movie subscription ${reference}:`, error);
    throw error;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================


/**
 * Send WhatsApp message for successful report charge
 */
async function sendReportChargeSuccessMessage(
  shopId: string,
  userPhone: string,
  reportPeriod: string,
  chargeAmount: number
): Promise<void> {
  try {
    // Get shop name
    const shopDoc = await db.collection("shops").doc(shopId).get();
    const shopName = shopDoc.data()?.shopName || 'Your Shop';

    const message =
      `✅ *Report Payment Successful*\n\n` +
      `Thank you for your payment!\n\n` +
      `📊 Report Type: ${reportPeriod.charAt(0).toUpperCase() + reportPeriod.slice(1)}\n` +
      `💰 Amount Paid: KES ${chargeAmount}\n` +
      `🏪 Shop: ${shopName}\n\n` +
      `Your report is now being generated. You will receive it shortly.\n\n` +
      `Ref: ${shopId}`;

    console.log(`Would send WhatsApp message to ${userPhone}: ${message}`);
    // TODO: Implement actual WhatsApp message sending here
    // await sendWhatsAppMessage(userPhone, message);

  } catch (error: any) {
    console.error(`Error sending report charge success message:`, error);
    // Don't throw - message sending failure shouldn't block payment processing
  }
}

/**
 * Send WhatsApp message for successful shop charge
 */
async function sendShopChargeSuccessMessage(
  shopId: string,
  customerPhone: string,
  chargeAmount: number
): Promise<void> {
  try {
    // Get shop owner phone
    const shopDoc = await db.collection("shops").doc(shopId).get();
    const shopData = shopDoc.data();
    const shopOwnerPhone = shopData?.phoneNumber || shopData?.contactPhone;
    const shopName = shopData?.shopName || 'Your Shop';

    const message =
      `✅ *Payment Received*\n\n` +
      `Customer payment successful!\n\n` +
      `👤 Customer: ${customerPhone}\n` +
      `💰 Amount: KES ${chargeAmount}\n` +
      `🏪 Shop: ${shopName}\n\n` +
      `The amount has been transferred to your account.`;

    console.log(`Would send WhatsApp message to ${shopOwnerPhone}: ${message}`);
    // TODO: Implement actual WhatsApp message sending here
    // await sendWhatsAppMessage(shopOwnerPhone, message);

  } catch (error: any) {
    console.error(`Error sending shop charge success message:`, error);
    // Don't throw - message sending failure shouldn't block payment processing
  }
}

// ============= UTILITY FUNCTION: GET USER PAYMENTS =============
export const getUserPayments = onCall({
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
}, async (request: CallableRequest<{ userId: string; billingMonth?: string }>) => {
  try {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const { userId, billingMonth } = request.data;

    if (billingMonth) {
      // Get specific month
      const doc = await db
        .collection("payments")
        .doc(userId)
        .collection("billingMonths")
        .doc(billingMonth)
        .get();

      if (!doc.exists) {
        return { success: true, data: [] };
      }

      return { success: true, data: doc.data()?.payments || [] };
    } else {
      // Get all months
      const snapshot = await db
        .collection("payments")
        .doc(userId)
        .collection("billingMonths")
        .get();

      const allPayments: any[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.payments) {
          allPayments.push(...data.payments);
        }
      });

      return { success: true, data: allPayments };
    }
  } catch (error: any) {
    console.error("Error in getUserPayments:", error);
    throw new HttpsError(
      "internal",
      `Failed to get payments: ${error.message}`
    );
  }
});

// ============= UTILITY FUNCTION: VERIFY TRANSACTION =============
export const verifyTransaction = onCall({
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
  secrets: [PAYSTACK_SECRET_KEY],
}, async (request: CallableRequest<{ reference: string }>) => {
  try {
    //const paystackHeaders = getPaystackHeaders(PAYSTACK_SECRET_KEY.value());
    
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const { reference } = request.data;

    const response = await axios.get(
      `${PAYSTACK_API_BASE}/transaction/verify/${reference}`,
      { headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
        'Content-Type': 'application/json'
      } }
    );

    if (!response.data.status) {
      throw new HttpsError(
        "internal",
        "Failed to verify transaction"
      );
    }

    return {
      success: true,
      data: response.data.data,
    };
  } catch (error: any) {
    console.error("Error in verifyTransaction:", error);
    throw new HttpsError(
      "internal",
      `Failed to verify transaction: ${error.message}`
    );
  }
});

// ============= UTILITY FUNCTION: LIST BANKS =============
export const listBanks = onCall({
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
  secrets: [PAYSTACK_SECRET_KEY],
}, async (request: CallableRequest<{ country?: string }>) => {
  try {
    const country = request.data?.country || "kenya";
    const banks = await getPaystackBanks(PAYSTACK_SECRET_KEY.value(), country);

    // Filter out personal M-Pesa and provide helpful categorization
    const bankCategories = {
      traditional: banks?.filter(b => 
        !b.name?.toLowerCase().includes('m-pesa') && 
        !b.name?.toLowerCase().includes('airtel')
      ),
      mobileMoney: banks?.filter(b => 
        b.name?.toLowerCase().includes('m-pesa') || 
        b.name?.toLowerCase().includes('airtel')
      ),
    };

    return {
      success: true,
      data: banks,
      categories: bankCategories,
      count: banks?.length,
      message: "Note: For subaccount settlements, use traditional bank accounts or registered M-Pesa Paybill/Till numbers, not personal M-Pesa accounts."
    };
  } catch (error: any) {
    console.error("Error in listBanks:", error);
    throw new HttpsError(
      "internal",
      `Failed to list banks: ${error.message}`
    );
  }
});



/**
 * Hash password using argon2id (server-side)
 */
async function hashPassword(password: string): Promise<string> {
  try {
    const passwordHash = await hash(password, {
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
    });
    return passwordHash;
  } catch (error) {
    console.error("Error hashing password:", error);
    throw new Error("Failed to hash password");
  }
}

export const createUserWithFirebaseAuth = onCall({
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
}, async (request: CallableRequest<CreateUserRequest>) => {
  try {
    // Validate authentication
    // For self sign-up, user might not be authenticated
    // For agent creation, user must be authenticated
    const { email, password, userData, creationType } = request.data;

    // For agent-created accounts, require authentication
    if (creationType === 'agent' && !request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Authentication required to create accounts on behalf of users"
      );
    }

    // Validate required fields
    if (!email || !password || !userData) {
      throw new HttpsError(
        "invalid-argument",
        "Email, password, and userData are required"
      );
    }

    if (!userData.name || !userData.phone) {
      throw new HttpsError(
        "invalid-argument",
        "Name and phone are required in userData"
      );
    }

    // For agent-created accounts, require localId and cyberId
    if (creationType === 'agent' && (!userData.localId || !userData.cyberId)) {
      throw new HttpsError(
        "invalid-argument",
        "localId and cyberId are required for agent-created accounts"
      );
    }

    // Format phone number to E.164 format
    let formattedPhone = userData.phone.replace(/[\s-]/g, '');
    
    if (!formattedPhone.startsWith('+')) {
      if (formattedPhone.startsWith('254')) {
        formattedPhone = '+' + formattedPhone;
      } else if (formattedPhone.startsWith('0')) {
        formattedPhone = '+254' + formattedPhone.substring(1);
      } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
        formattedPhone = '+254' + formattedPhone;
      } else {
        formattedPhone = '+' + formattedPhone;
      }
    }

    console.log(`Creating user - Type: ${creationType}, Email: ${email}, Phone: ${formattedPhone}`);

    // Hash the password on the server
    const passwordHash = await hashPassword(password);
    console.log(`Password hashed successfully`);

    // Prepare Firebase Auth creation options
    const authUserOptions: any = {
      email: email,
      password: password,
      phoneNumber: formattedPhone,
      displayName: userData.name,
      emailVerified: false,
      disabled: false,
    };

    // If custom UID provided (agent-created), use it
    if (userData.localId) {
      authUserOptions.uid = userData.localId;
      console.log(`Using custom UID: ${userData.localId}`);
    }

    // Create user in Firebase Auth
    const userRecord = await admin.auth().createUser(authUserOptions);
    console.log(`✅ Firebase Auth user created with UID: ${userRecord.uid}`);

    // ... unchanged code above stays the same until the expiry/tier section ...

    // Determine document ID: use localId if provided, otherwise use generated UID
    const documentId = userData.localId || userRecord.uid;

    const db = admin.firestore();
    const userDocRef = db.collection('users').doc(documentId);

    const firestoreUserData: any = {
      id: documentId,
      localId: documentId,
      name: userData.name,
      email: email,
      phone: formattedPhone,
      passwordHash: passwordHash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: documentId,
      status: 'active',
      firebaseAuthUid: userRecord.uid,
      creationType: creationType || 'self',
    };

    // Set user properties based on creationType
    if (creationType === 'self') {
      // Self sign-ups get a free 3-month Business tier trial + signup bonus tokens
      const trialEnd = new Date();
      trialEnd.setMonth(trialEnd.getMonth() + 3);

      firestoreUserData.tier = 'business';
      firestoreUserData.type = 'paid';
      firestoreUserData.storage = true;
      firestoreUserData.isPremium = true;
      firestoreUserData.isTrial = true; // marks this as an unpaid trial grant, not a real subscription
      firestoreUserData.subscriptionExpiry = admin.firestore.Timestamp.fromDate(trialEnd);
      firestoreUserData.trialStartedAt = admin.firestore.FieldValue.serverTimestamp();
      firestoreUserData.tokens = 100; // signup bonus
    } else {
      // Agent-created accounts use provided values or defaults
      firestoreUserData.tier = userData.tier || 'free';
      firestoreUserData.type = userData.type || 'free';
      firestoreUserData.storage = userData.storage || false;
      firestoreUserData.isPremium = userData.isPremium || false;
      firestoreUserData.isTrial = false;
      firestoreUserData.tokens = 0;
    }

    // Add cyberId for agent-created accounts
    if (userData.cyberId) {
      firestoreUserData.cyberId = userData.cyberId;
    }

    // Add assetType for agent-created accounts
    if (userData.assetType) {
      firestoreUserData.assetType = userData.assetType;
    }

    // Add company info if provided
    if (userData.company) {
      firestoreUserData.company = userData.company;
    }

    // Write to Firestore
    await userDocRef.set(firestoreUserData, { merge: true });
    console.log(`✅ Firestore user document created: ${documentId}`);

    // Return appropriate response
    return {
      success: true,
      message: creationType === 'agent'
        ? "User account created successfully by agent"
        : "Account created successfully",
      data: {
        uid: userRecord.uid,
        documentId: documentId,
        email: userRecord.email,
        phone: userRecord.phoneNumber,
        displayName: userRecord.displayName,
        tier: firestoreUserData.tier,
        type: firestoreUserData.type,
        isPremium: firestoreUserData.isPremium,
        isTrial: firestoreUserData.isTrial,
        tokens: firestoreUserData.tokens,
        assetType: userData.assetType,
        isCustomUid: !!userData.localId,
        subscriptionExpiry: firestoreUserData.subscriptionExpiry?.toDate() ?? null,
      },
    };

  } catch (error: any) {
    console.error("Error in createUserWithFirebaseAuth:", error);

    // Handle specific Firebase Auth errors
    if (error.code === 'auth/email-already-in-use') {
      throw new HttpsError(
        "already-exists",
        "A user with this email already exists"
      );
    }

    if (error.code === 'auth/phone-number-already-exists') {
      throw new HttpsError(
        "already-exists",
        "A user with this phone number already exists"
      );
    }

    if (error.code === 'auth/invalid-email') {
      throw new HttpsError(
        "invalid-argument",
        "Invalid email address"
      );
    }

    if (error.code === 'auth/invalid-password') {
      throw new HttpsError(
        "invalid-argument",
        "Password must be at least 6 characters"
      );
    }

    if (error.code === 'auth/invalid-phone-number') {
      throw new HttpsError(
        "invalid-argument",
        "Invalid phone number format"
      );
    }

    if (error.code === 'auth/uid-already-exists') {
      throw new HttpsError(
        "already-exists",
        "A user with this ID already exists"
      );
    }

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      `Failed to create user: ${error.message}`
    );
  }
});



export const expireBusinessTrials = onSchedule({
  schedule: "0 8 * * 1",
  timeZone: "Africa/Nairobi",
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 300,
}, async () => {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  const PAGE_SIZE = 400; // headroom under Firestore's 500-write batch limit

  let totalExpired = 0;

  // Loop in case there are more expired trials than one batch can hold
  while (true) {
    const snapshot = await db.collection('users')
      .where('isTrial', '==', true)
      .where('subscriptionExpiry', '<=', now)
      .limit(PAGE_SIZE)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach((docSnap) => {
      batch.update(docSnap.ref, {
        tier: 'free',
        type: 'free',
        storage: false,
        isPremium: false,
        isTrial: false,
        trialEndedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    totalExpired += snapshot.size;
    console.log(`Downgraded ${snapshot.size} expired trial(s), running total: ${totalExpired}`);

    if (snapshot.size < PAGE_SIZE) break; // no more pages
  }

  console.log(`✅ expireBusinessTrials done — ${totalExpired} account(s) downgraded to free.`);
});




