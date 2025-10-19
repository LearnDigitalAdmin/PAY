import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import axios from "axios";
import * as crypto from "crypto";
import { hash } from "@node-rs/argon2";


// Initialize Firebase Admin only if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// ============= CONFIGURATION =============
const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const PAYSTACK_API_BASE = "https://api.paystack.co";

// Tier commission rates
const TIER_RATES = {
  ENTERPRISE: 1.4,
  PRO: 2.4,
  BUSINESS: 2,
  SOLO: 2.7,
} as const;

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
  secretValue: string,
  subaccountCode: string,
  commissionRate: number,
  agentId: string
): Promise<string> {
  //const paystackHeaders = getPaystackHeaders(secretValue);
  
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
    const splitCode = await getOrCreateSplitCode(PAYSTACK_SECRET_KEY.value(), subaccountCode, commissionRate, agentId);

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
      PAYSTACK_SECRET_KEY.value(), 
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

// ============= UPDATED UNIFIED PAYSTACK WEBHOOK =============
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

    const event = JSON.parse(body);
    console.log(`Received webhook event: ${event.event}`);

    // Handle charge.success event
    if (event.event === "charge.success") {
      const data = event.data;
      const reference = data.reference;
      const metadata = data.metadata;

      console.log(`Processing successful payment: ${reference}`);

      // Determine payment type based on reference prefix
      const isSubscription = reference.startsWith('SUB_');
      const isCyberCharge = reference.startsWith('CYBER_');
      const isAgentPayment = reference.startsWith('INV_');

      if (isCyberCharge) {
        // ===== HANDLE CYBER SERVICE CHARGE =====
        console.log(`Processing as cyber service charge`);

        const transactionRef = db.collection("cyber-transactions").doc(reference);
        const transactionDoc = await transactionRef.get();

        if (!transactionDoc.exists) {
          console.error(`Cyber transaction not found: ${reference}`);
          res.status(404).json({ error: "Cyber transaction not found" });
          return;
        }

        const transactionData = transactionDoc.data();
        const uid = metadata.uid || transactionData?.uid;
        const pId = metadata.pId || transactionData?.pId;
        //const agentId = metadata.agentId || transactionData?.agentId;
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
          `Cyber income calculation: Gross: ${grossAmount}, Paystack Fees: ${paystackFees}, Net after Paystack: ${netAfterPaystack}, Platform Commission: ${platformCommission}, Agent Net: ${agentNetIncome}`
        );

        // === Build income record safely ===
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

        // 🧹 Remove undefined values
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

        console.log(`Successfully recorded cyber income for agent ${uid}: ${agentNetIncome} KES (after ${platformCommission} KES platform commission)`);

      } else if (isSubscription) {
        // ===== HANDLE SUBSCRIPTION PAYMENT (EXISTING LOGIC) =====
        console.log(`Processing as subscription payment`);

        const subscriptionRef = db.collection("subscriptions").doc(reference);
        const subscriptionDoc = await subscriptionRef.get();

        if (!subscriptionDoc.exists) {
          console.error(`Subscription not found: ${reference}`);
          res.status(404).json({ error: "Subscription not found" });
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
          planName: planName
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

      } else if (isAgentPayment) {
        // ===== HANDLE AGENT PAYMENT (EXISTING LOGIC) =====
        console.log(`Processing as agent payment`);

        const transactionRef = db.collection("transactions").doc(reference);
        const transactionDoc = await transactionRef.get();

        if (!transactionDoc.exists) {
          console.error(`Transaction not found: ${reference}`);
          res.status(404).json({ error: "Transaction not found" });
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
      }
    }

    // Handle failed payments
    if (event.event === "charge.failed") {
      const data = event.data;
      const reference = data.reference;

      console.warn(`Payment failed: ${reference}`);

      const isCyberCharge = reference.startsWith('CYBER_');
      const isSubscription = reference.startsWith('SUB_');

      if (isCyberCharge) {
        await db.collection("cyber-transactions").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        });
      } else if (isSubscription) {
        await db.collection("subscriptions").doc(reference).update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: data.gateway_response,
        });
      } else {
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

// ============= TYPE DEFINITIONS =============



// ============= UNIFIED PAYSTACK WEBHOOK =============
// export const paystackCallback = onRequest({
//   timeoutSeconds: 60,
//   memory: "512MiB",
//   cors: false,
//   maxInstances: 10,
//   region: "africa-south1",
//   secrets: [PAYSTACK_SECRET_KEY],
// }, async (req, res) => {
//   console.log(`Webhook request received: ${req.method}`);
  
//   if (req.method !== 'POST') {
//     res.status(405).json({ error: 'Method not allowed' });
//     return;
//   }

//   try {
//     // Verify Paystack signature
//     const hash = req.headers["x-paystack-signature"]?.toString();
//     const rawBody = Buffer.from(req.rawBody || JSON.stringify(req.body));
//     const body = rawBody.toString();

//     // Verify the webhook signature
//     const expectedHash = crypto
//       .createHmac("sha512", PAYSTACK_SECRET_KEY.value())
//       .update(body)
//       .digest("hex");
      
//     if (hash !== expectedHash) {
//       console.error("Invalid signature");
//       res.status(400).json({ error: "Invalid signature" });
//       return;
//     }

//     const event = JSON.parse(body);

//     console.log(`Received webhook event: ${event.event}`);

//     // Handle charge.success event
//     if (event.event === "charge.success") {
//       const data = event.data;
//       const reference = data.reference;
//       const metadata = data.metadata;

//       console.log(`Processing successful payment: ${reference}`);

//       // Determine if this is a subscription or agent payment based on reference prefix or metadata
//       const isSubscription = reference.startsWith('SUB_') || metadata?.subscriptionType === 'web';

//       if (isSubscription) {
//         // ===== HANDLE SUBSCRIPTION PAYMENT =====
//         console.log(`Processing as subscription payment`);

//         const subscriptionRef = db.collection("subscriptions").doc(reference);
//         const subscriptionDoc = await subscriptionRef.get();

//         if (!subscriptionDoc.exists) {
//           console.error(`Subscription not found: ${reference}`);
//           res.status(404).json({ error: "Subscription not found" });
//           return;
//         }

//         const subscriptionData = subscriptionDoc.data();
//         const userId = metadata.userId || subscriptionData?.userId;
//         const planId = metadata.planId || subscriptionData?.planId;
//         const planName = metadata.planName || subscriptionData?.planName;
//         const daysToAdd = metadata.daysToAdd || subscriptionData?.daysToAdd || 30;
//         const agentId = metadata.agentId || subscriptionData?.agentId;

//         // Calculate expiry date
//         const expiryDate = new Date();
//         expiryDate.setDate(expiryDate.getDate() + daysToAdd);

//         // Update subscription record
//         await subscriptionRef.update({
//           status: "success",
//           completedAt: admin.firestore.FieldValue.serverTimestamp(),
//           expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
//           paystackResponse: data,
//         });

//         // Update user subscription status
//         const userRef = db.collection("users").doc(userId);
//         await userRef.set({
//           type: "paid",
//           tier: planId,
//           storage: true,
//           subscriptionExpiry: admin.firestore.Timestamp.fromDate(expiryDate),
//           lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
//           lastPaymentReference: reference,
//           lastPaymentAmount: data.amount / 100,
//           planName: planName
//         }, { merge: true });

//         console.log(`Successfully activated subscription for user ${userId}, expires: ${expiryDate.toISOString()}`);

//         // ===== RECORD AGENT COMMISSION IF AGENT IS INVOLVED =====
//         if (agentId) {
//           try {
//             const grossAmount = data.amount / 100; // Convert from cents to main currency
//             const paystackFees = data.fees ? data.fees / 100 : 0;
//             const netAmount = grossAmount - paystackFees; // Amount after Paystack deduction
//             const commissionRate = 45; // 45% commission for agent
//             const agentCommission = (netAmount * commissionRate) / 100;
//             const platformRevenue = netAmount - agentCommission;

//             console.log(`Recording commission for agent ${agentId}: ${agentCommission} KES (${commissionRate}% of ${netAmount} KES net amount, gross: ${grossAmount} KES, fees: ${paystackFees} KES)`);

//             // Create income record for agent
//             const incomeRecord = {
//               reference: reference,
//               userId: userId,
//               userName: metadata.userName || subscriptionData?.userName || "Unknown",
//               planId: planId,
//               planName: planName,
//               grossAmount: grossAmount, // Original payment amount
//               netAmount: netAmount, // Amount after Paystack fees
//               agentCommission: agentCommission, // 55% of net amount
//               platformRevenue: platformRevenue, // 45% of net amount
//               paystackFees: paystackFees, // Fees deducted by Paystack
//               commissionRate: commissionRate,
//               currency: "KES",
//               status: "success",
//               type: "subscription",
//               createdAt: admin.firestore.FieldValue.serverTimestamp(),
//               paidAt: admin.firestore.FieldValue.serverTimestamp(),
//               expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
//               // Paystack split details if available
//               splitCode: data.split?.split_code || null,
//             };

//             // Add to agent's plot-income subcollection
//             await db
//               .collection("agents")
//               .doc(agentId)
//               .collection("plot-income")
//               .doc(reference)
//               .set(incomeRecord);

//             // Update agent's total income summary (optional but recommended)
//             const agentRef = db.collection("agents").doc(agentId);
//             await agentRef.set({
//               totalIncome: admin.firestore.FieldValue.increment(agentCommission),
//               totalSubscriptions: admin.firestore.FieldValue.increment(1),
//               lastIncomeDate: admin.firestore.FieldValue.serverTimestamp(),
//               lastIncomeAmount: agentCommission,
//             }, { merge: true });

//             console.log(`Successfully recorded income for agent ${agentId}: ${agentCommission} KES`);

//           } catch (agentError: any) {
//             console.error(`Error recording agent commission for ${agentId}:`, agentError);
//             // Don't fail the entire webhook if agent recording fails
//             // The subscription is still successful
//           }
//         }

//       } else {
//         // ===== HANDLE AGENT PAYMENT (EXISTING LOGIC) =====
//         console.log(`Processing as agent payment`);

//         // Get transaction document
//         const transactionRef = db.collection("transactions").doc(reference);
//         const transactionDoc = await transactionRef.get();

//         if (!transactionDoc.exists) {
//           console.error(`Transaction not found: ${reference}`);
//           res.status(404).json({ error: "Transaction not found" });
//           return;
//         }

//         const transactionData = transactionDoc.data();

//         // Update transaction status
//         await transactionRef.update({
//           status: "success",
//           completedAt: admin.firestore.FieldValue.serverTimestamp(),
//           paystackResponse: data,
//         });

//         // Update payment record in user's billing month
//         const userId = metadata.userId || transactionData?.userId;
//         const billingMonth = metadata.billingMonth || transactionData?.billingMonth;

//         if (userId && billingMonth) {
//           const paymentDoc = await db
//             .collection("payments")
//             .doc(userId)
//             .collection("billingMonths")
//             .doc(billingMonth)
//             .get();

//           if (paymentDoc.exists) {
//             const paymentData = paymentDoc.data();
//             const payments = paymentData?.payments || [];

//             // Find and update the specific payment
//             const updatedPayments = payments.map((payment: any) => {
//               if (payment.reference === reference) {
//                 return {
//                   ...payment,
//                   status: "success",
//                   completedAt: new Date().toISOString(),
//                   paidAmount: data.amount / 100,
//                   fees: data.fees / 100,
//                 };
//               }
//               return payment;
//             });

//             await db
//               .collection("payments")
//               .doc(userId)
//               .collection("billingMonths")
//               .doc(billingMonth)
//               .update({
//                 payments: updatedPayments,
//                 lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
//               });
//           }

//           // Update invoice status if needed
//           const invoiceId = metadata.invoiceId || transactionData?.invoiceId;
//           if (invoiceId) {
//             await db.collection("invoices").doc(invoiceId).update({
//               status: "paid",
//               paidAt: admin.firestore.FieldValue.serverTimestamp(),
//               paymentReference: reference,
//             });
//           }
//         }

//         console.log(`Successfully processed agent payment: ${reference}`);
//       }
//     }

//     // Handle failed payments (works for both types)
//     if (event.event === "charge.failed") {
//       const data = event.data;
//       const reference = data.reference;

//       console.warn(`Payment failed: ${reference}`);

//       const isSubscription = reference.startsWith('SUB_') || data.metadata?.subscriptionType === 'web';

//       if (isSubscription) {
//         // Update subscription record
//         await db.collection("subscriptions").doc(reference).update({
//           status: "failed",
//           failedAt: admin.firestore.FieldValue.serverTimestamp(),
//           failureReason: data.gateway_response,
//         });
//       } else {
//         // Update transaction record
//         await db.collection("transactions").doc(reference).update({
//           status: "failed",
//           failedAt: admin.firestore.FieldValue.serverTimestamp(),
//           failureReason: data.gateway_response,
//         });
//       }
//     }

//     res.status(200).json({ 
//       received: true,
//       processed: true,
//       eventType: event.event 
//     });
//   } catch (error: any) {
//     console.error("Error in paystackCallback:", error);
//     res.status(500).json({ 
//       error: "Internal server error",
//       message: error.message 
//     });
//   }
// });

// export const paystackCallback = onRequest({
//   timeoutSeconds: 60,
//   memory: "512MiB",
//   cors: false,
//   maxInstances: 10,
//   region: "africa-south1",
//   secrets: [PAYSTACK_SECRET_KEY],
// }, async (req, res) => {
//   console.log(`Webhook request received: ${req.method}`);
  
//   if (req.method !== 'POST') {
//     res.status(405).json({ error: 'Method not allowed' });
//     return;
//   }

//   try {
//     // Verify Paystack signature
//     const hash = req.headers["x-paystack-signature"]?.toString();
//     const rawBody = Buffer.from(req.rawBody || JSON.stringify(req.body));
//     const body = rawBody.toString();

//     // Verify the webhook signature
//     const expectedHash = crypto
//       .createHmac("sha512", PAYSTACK_SECRET_KEY.value())
//       .update(body)
//       .digest("hex");
      
//     if (hash !== expectedHash) {
//       console.error("Invalid signature");
//       res.status(400).json({ error: "Invalid signature" });
//       return;
//     }

//     const event = JSON.parse(body);

//     console.log(`Received webhook event: ${event.event}`);

//     // Handle charge.success event
//     if (event.event === "charge.success") {
//       const data = event.data;
//       const reference = data.reference;
//       const metadata = data.metadata;

//       console.log(`Processing successful payment: ${reference}`);

//       // Determine if this is a subscription or agent payment based on reference prefix or metadata
//       const isSubscription = reference.startsWith('SUB_') || metadata?.subscriptionType === 'web';

//       if (isSubscription) {
//         // ===== HANDLE SUBSCRIPTION PAYMENT =====
//         console.log(`Processing as subscription payment`);

//         const subscriptionRef = db.collection("subscriptions").doc(reference);
//         const subscriptionDoc = await subscriptionRef.get();

//         if (!subscriptionDoc.exists) {
//           console.error(`Subscription not found: ${reference}`);
//           res.status(404).json({ error: "Subscription not found" });
//           return;
//         }

//         const subscriptionData = subscriptionDoc.data();
//         const userId = metadata.userId || subscriptionData?.userId;
//         const planId = metadata.planId || subscriptionData?.planId;
//         const planName = metadata.planName || subscriptionData?.planName;
//         const daysToAdd = metadata.daysToAdd || subscriptionData?.daysToAdd || 30;

//         // Calculate expiry date
//         const expiryDate = new Date();
//         expiryDate.setDate(expiryDate.getDate() + daysToAdd);

//         // Update subscription record
//         await subscriptionRef.update({
//           status: "success",
//           completedAt: admin.firestore.FieldValue.serverTimestamp(),
//           expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
//           paystackResponse: data,
//         });

//         // Update user subscription status
//         const userRef = db.collection("users").doc(userId);
//         await userRef.set({
//           type: "paid",
//           tier: planId,
//           storage: true,
//           subscriptionExpiry: admin.firestore.Timestamp.fromDate(expiryDate),
//           lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
//           lastPaymentReference: reference,
//           lastPaymentAmount: data.amount / 100,
//           planName: planName
//         }, { merge: true });

//         console.log(`Successfully activated subscription for user ${userId}, expires: ${expiryDate.toISOString()}`);

//       } else {
//         // ===== HANDLE AGENT PAYMENT (EXISTING LOGIC) =====
//         console.log(`Processing as agent payment`);

//         // Get transaction document
//         const transactionRef = db.collection("transactions").doc(reference);
//         const transactionDoc = await transactionRef.get();

//         if (!transactionDoc.exists) {
//           console.error(`Transaction not found: ${reference}`);
//           res.status(404).json({ error: "Transaction not found" });
//           return;
//         }

//         const transactionData = transactionDoc.data();

//         // Update transaction status
//         await transactionRef.update({
//           status: "success",
//           completedAt: admin.firestore.FieldValue.serverTimestamp(),
//           paystackResponse: data,
//         });

//         // Update payment record in user's billing month
//         const userId = metadata.userId || transactionData?.userId;
//         const billingMonth = metadata.billingMonth || transactionData?.billingMonth;

//         if (userId && billingMonth) {
//           const paymentDoc = await db
//             .collection("payments")
//             .doc(userId)
//             .collection("billingMonths")
//             .doc(billingMonth)
//             .get();

//           if (paymentDoc.exists) {
//             const paymentData = paymentDoc.data();
//             const payments = paymentData?.payments || [];

//             // Find and update the specific payment
//             const updatedPayments = payments.map((payment: any) => {
//               if (payment.reference === reference) {
//                 return {
//                   ...payment,
//                   status: "success",
//                   completedAt: new Date().toISOString(), // Use ISO string instead of Date object
//                   paidAmount: data.amount / 100,
//                   fees: data.fees / 100,
//                 };
//               }
//               return payment;
//             });

//             await db
//               .collection("payments")
//               .doc(userId)
//               .collection("billingMonths")
//               .doc(billingMonth)
//               .update({
//                 payments: updatedPayments,
//                 lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
//               });
//           }

//           // Update invoice status if needed
//           const invoiceId = metadata.invoiceId || transactionData?.invoiceId;
//           if (invoiceId) {
//             await db.collection("invoices").doc(invoiceId).update({
//               status: "paid",
//               paidAt: admin.firestore.FieldValue.serverTimestamp(),
//               paymentReference: reference,
//             });
//           }
//         }

//         console.log(`Successfully processed agent payment: ${reference}`);
//       }
//     }

//     // Handle failed payments (works for both types)
//     if (event.event === "charge.failed") {
//       const data = event.data;
//       const reference = data.reference;

//       console.warn(`Payment failed: ${reference}`);

//       const isSubscription = reference.startsWith('SUB_') || data.metadata?.subscriptionType === 'web';

//       if (isSubscription) {
//         // Update subscription record
//         await db.collection("subscriptions").doc(reference).update({
//           status: "failed",
//           failedAt: admin.firestore.FieldValue.serverTimestamp(),
//           failureReason: data.gateway_response,
//         });
//       } else {
//         // Update transaction record
//         await db.collection("transactions").doc(reference).update({
//           status: "failed",
//           failedAt: admin.firestore.FieldValue.serverTimestamp(),
//           failureReason: data.gateway_response,
//         });
//       }
//     }

//     res.status(200).json({ 
//       received: true,
//       processed: true,
//       eventType: event.event 
//     });
//   } catch (error: any) {
//     console.error("Error in paystackCallback:", error);
//     res.status(500).json({ 
//       error: "Internal server error",
//       message: error.message 
//     });
//   }
// });

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

/**
 * UNIFIED Cloud Function for creating Firebase Auth users
 * Works for BOTH:
 * 1. Self sign-up (Firebase generates UID)
 * 2. Agent-created accounts (Custom UID = National ID)
 */
// export const createUserWithFirebaseAuth = onCall({
//   timeoutSeconds: 60,
//   memory: "512MiB",
//   maxInstances: 10,
//   region: "africa-south1",
//   cors: true,
// }, async (request: CallableRequest<CreateUserRequest>) => {
//   try {
//     // Validate authentication
//     // For self sign-up, user might not be authenticated
//     // For agent creation, user must be authenticated
//     const { email, password, userData, creationType } = request.data;

//     // For agent-created accounts, require authentication
//     if (creationType === 'agent' && !request.auth) {
//       throw new HttpsError(
//         "unauthenticated",
//         "Authentication required to create accounts on behalf of users"
//       );
//     }

//     // Validate required fields
//     if (!email || !password || !userData) {
//       throw new HttpsError(
//         "invalid-argument",
//         "Email, password, and userData are required"
//       );
//     }

//     if (!userData.name || !userData.phone) {
//       throw new HttpsError(
//         "invalid-argument",
//         "Name and phone are required in userData"
//       );
//     }

//     // For agent-created accounts, require localId and cyberId
//     if (creationType === 'agent' && (!userData.localId || !userData.cyberId)) {
//       throw new HttpsError(
//         "invalid-argument",
//         "localId and cyberId are required for agent-created accounts"
//       );
//     }

//     // Format phone number to E.164 format
//     let formattedPhone = userData.phone.replace(/[\s-]/g, '');
    
//     if (!formattedPhone.startsWith('+')) {
//       if (formattedPhone.startsWith('254')) {
//         formattedPhone = '+' + formattedPhone;
//       } else if (formattedPhone.startsWith('0')) {
//         formattedPhone = '+254' + formattedPhone.substring(1);
//       } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
//         formattedPhone = '+254' + formattedPhone;
//       } else {
//         formattedPhone = '+' + formattedPhone;
//       }
//     }

//     console.log(`Creating user - Type: ${creationType}, Email: ${email}, Phone: ${formattedPhone}`);

//     // Hash the password on the server
//     const passwordHash = await hashPassword(password);
//     console.log(`Password hashed successfully`);

//     // Prepare Firebase Auth creation options
//     const authUserOptions: any = {
//       email: email,
//       password: password,
//       phoneNumber: formattedPhone,
//       displayName: userData.name,
//       emailVerified: false,
//       disabled: false,
//     };

//     // If custom UID provided (agent-created), use it
//     if (userData.localId) {
//       authUserOptions.uid = userData.localId;
//       console.log(`Using custom UID: ${userData.localId}`);
//     }

//     // Create user in Firebase Auth
//     const userRecord = await admin.auth().createUser(authUserOptions);
//     console.log(`✅ Firebase Auth user created with UID: ${userRecord.uid}`);

//     // Determine document ID: use localId if provided, otherwise use generated UID
//     const documentId = userData.localId || userRecord.uid;

//     // Create Firestore document
//     const db = admin.firestore();
//     const userDocRef = db.collection('users').doc(documentId);
    
//     const firestoreUserData: any = {
//       id: documentId,
//       localId: documentId,
//       name: userData.name,
//       email: email,
//       phone: formattedPhone,
//       passwordHash: passwordHash,
//       tier: userData.tier || 'free',
//       type: userData.type || 'free',
//       storage: userData.storage || false,
//       isPremium: userData.isPremium || false,
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//       userId: documentId,
//       status: 'active',
//       firebaseAuthUid: userRecord.uid,
//       creationType: creationType || 'self',
//     };

//     // Add cyberId for agent-created accounts
//     if (userData.cyberId) {
//       firestoreUserData.cyberId = userData.cyberId;
//     }

//     // Add assetType for agent-created accounts
//     if (userData.assetType) {
//       firestoreUserData.assetType = userData.assetType;
//     }

//     // Add company info if provided
//     if (userData.company) {
//       firestoreUserData.company = userData.company;
//     }

//     // Write to Firestore
//     await userDocRef.set(firestoreUserData, { merge: true });
//     console.log(`✅ Firestore user document created: ${documentId}`);

//     // Return appropriate response
//     return {
//       success: true,
//       message: creationType === 'agent' 
//         ? "User account created successfully by agent"
//         : "Account created successfully",
//       data: {
//         uid: userRecord.uid,
//         documentId: documentId,
//         email: userRecord.email,
//         phone: userRecord.phoneNumber,
//         displayName: userRecord.displayName,
//         tier: userData.tier || 'free',
//         assetType: userData.assetType,
//         isCustomUid: !!userData.localId,
//       },
//     };

//   } catch (error: any) {
//     console.error("Error in createUserWithFirebaseAuth:", error);

//     // Handle specific Firebase Auth errors
//     if (error.code === 'auth/email-already-in-use') {
//       throw new HttpsError(
//         "already-exists",
//         "A user with this email already exists"
//       );
//     }

//     if (error.code === 'auth/phone-number-already-exists') {
//       throw new HttpsError(
//         "already-exists",
//         "A user with this phone number already exists"
//       );
//     }

//     if (error.code === 'auth/invalid-email') {
//       throw new HttpsError(
//         "invalid-argument",
//         "Invalid email address"
//       );
//     }

//     if (error.code === 'auth/invalid-password') {
//       throw new HttpsError(
//         "invalid-argument",
//         "Password must be at least 6 characters"
//       );
//     }

//     if (error.code === 'auth/invalid-phone-number') {
//       throw new HttpsError(
//         "invalid-argument",
//         "Invalid phone number format"
//       );
//     }

//     if (error.code === 'auth/uid-already-exists') {
//       throw new HttpsError(
//         "already-exists",
//         "A user with this ID already exists"
//       );
//     }

//     if (error instanceof HttpsError) {
//       throw error;
//     }

//     throw new HttpsError(
//       "internal",
//       `Failed to create user: ${error.message}`
//     );
//   }
// });

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

    // Determine document ID: use localId if provided, otherwise use generated UID
    const documentId = userData.localId || userRecord.uid;

    // Calculate subscription expiry (30 days from now)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    const subscriptionExpiry = admin.firestore.Timestamp.fromDate(expiryDate);

    // Create Firestore document
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
      subscriptionExpiry: subscriptionExpiry,
    };

    // Set user properties based on creationType
    if (creationType === 'self') {
      // Self sign-ups get premium features
      firestoreUserData.tier = 'pro';
      firestoreUserData.type = 'paid';
      firestoreUserData.storage = true;
      firestoreUserData.isPremium = true;
    } else {
      // Agent-created accounts use provided values or defaults
      firestoreUserData.tier = userData.tier || 'free';
      firestoreUserData.type = userData.type || 'free';
      firestoreUserData.storage = userData.storage || false;
      firestoreUserData.isPremium = userData.isPremium || false;
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
        assetType: userData.assetType,
        isCustomUid: !!userData.localId,
        subscriptionExpiry: subscriptionExpiry.toDate(),
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