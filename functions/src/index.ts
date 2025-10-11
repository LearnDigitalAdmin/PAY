

import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import axios from "axios";
import * as crypto from "crypto";

// Initialize Firebase Admin only if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// ============= CONFIGURATION =============
const PAYSTACK_SECRET_KEY = "sk_live_85e131b71617b25498db9283081a5ba17fef296c";
const PAYSTACK_API_BASE = "https://api.paystack.co";
//const CALLBACK_URL = "https://paystackcallback-pwbsdm2yxa-bq.a.run.app";

// Tier commission rates
const TIER_RATES = {
  ENTERPRISE: 1.4,
  PRO: 2.4,
  BUSINESS: 2,
  SOLO: 2.7,
} as const;

// ============= HELPER FUNCTIONS =============
const getPaystackHeaders = () => ({
  Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
  "Content-Type": "application/json",
});

// Cache for bank list (to avoid repeated API calls)
let banksCache: any[] | null = null;

async function getPaystackBanks(country = "kenya"): Promise<any[] | null> {
  if (banksCache) {
    return banksCache;
  }

  try {
    const response = await axios.get(
      `${PAYSTACK_API_BASE}/bank?country=${country}`,
      { headers: getPaystackHeaders() }
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

// ============= FUNCTION 1: SETUP SUBACCOUNT =============
export const setupAccount = onCall({
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 10,
  region: "africa-south1",
  cors: true,
}, async (request: CallableRequest<SetupAccountRequest>) => {
  try {
    const paystackHeaders = getPaystackHeaders();
    
    // Validate authentication
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const { businessName, settlementBank, accountNumber, email, name, phone, userId } = request.data;

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
    const banks = await getPaystackBanks("kenya");
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
    const userDoc = await db.collection("users").doc(userId).get();

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
      { headers: paystackHeaders }
    );

    if (!paystackResponse.data.status) {
      throw new HttpsError(
        "internal",
        `Paystack API error: ${paystackResponse.data.message}`
      );
    }

    const subaccountData = paystackResponse.data.data;

    // Write to Firestore - Update user's paymentInfo
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
  const paystackHeaders = getPaystackHeaders();
  
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
      { headers: paystackHeaders }
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
}, async (request: CallableRequest<ProcessPaymentRequest>) => {
  try {
    const paystackHeaders = getPaystackHeaders();
    
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
      { headers: paystackHeaders }
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


// ============= FUNCTION 3: PAYSTACK CALLBACK =============
export const paystackCallback = onRequest({
  timeoutSeconds: 60,
  memory: "512MiB",
  cors: false,
  maxInstances: 10,
  region: "africa-south1",
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

    // Verify the webhook signature
    const expectedHash = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(body)
      .digest("hex");
      
    if (hash !== expectedHash) {
      console.error("Invalid signature");
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    const event = JSON.parse(body);

    console.log(`Received webhook event: ${event.event}`);

    // Handle charge.success event
    if (event.event === "charge.success") {
      const data = event.data;
      const reference = data.reference;
      const metadata = data.metadata;

      console.log(`Processing successful payment: ${reference}`);

      // Get transaction document
      const transactionRef = db.collection("transactions").doc(reference);
      const transactionDoc = await transactionRef.get();

      if (!transactionDoc.exists) {
        console.error(`Transaction not found: ${reference}`);
        res.status(404).json({ error: "Transaction not found" });
        return;
      }

      const transactionData = transactionDoc.data();

      // Update transaction status
      await transactionRef.update({
        status: "success",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        paystackResponse: data,
      });

      // Update payment record in user's billing month
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

          // Find and update the specific payment
          const updatedPayments = payments.map((payment: any) => {
            if (payment.reference === reference) {
              return {
                ...payment,
                status: "success",
                completedAt: new Date().toISOString(), // Use ISO string instead of Date object
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

        // Update invoice status if needed
        const invoiceId = metadata.invoiceId || transactionData?.invoiceId;
        if (invoiceId) {
          await db.collection("invoices").doc(invoiceId).update({
            status: "paid",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentReference: reference,
          });
        }
      }

      console.log(`Successfully processed payment: ${reference}`);
    }

    // Handle failed payments
    if (event.event === "charge.failed") {
      const data = event.data;
      const reference = data.reference;

      console.warn(`Payment failed: ${reference}`);

      await db.collection("transactions").doc(reference).update({
        status: "failed",
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        failureReason: data.gateway_response,
      });
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
}, async (request: CallableRequest<{ reference: string }>) => {
  try {
    const paystackHeaders = getPaystackHeaders();
    
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const { reference } = request.data;

    const response = await axios.get(
      `${PAYSTACK_API_BASE}/transaction/verify/${reference}`,
      { headers: paystackHeaders }
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
}, async (request: CallableRequest<{ country?: string }>) => {
  try {
    const country = request.data?.country || "kenya";
    const banks = await getPaystackBanks(country);

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