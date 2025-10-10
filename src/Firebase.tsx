// Firebase.tsx - Firebase Configuration and Services
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  RecaptchaVerifier, 
  signInWithPhoneNumber,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
  signInWithEmailAndPassword
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  query, 
  where, 
  getDocs,
  collectionGroup,
  orderBy,
  serverTimestamp,
  onSnapshot,
  Timestamp,
  type Unsubscribe
} from 'firebase/firestore';

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyD1hg7YLv08vyR2kSWi2ymxSu2pYCRwPq8",
  authDomain: "plot-9fd6e.firebaseapp.com",
  projectId: "plot-9fd6e",
  storageBucket: "plot-9fd6e.firebasestorage.app",
  messagingSenderId: "1037620305589",
  appId: "1:1037620305589:web:2672a7dcaeca4c46b068fc",
  measurementId: "G-B90H3GJFPM"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Types
export interface TenantAccount {
  id: string;
  phone: string;
  email: string;
  fullName: string;
  idNumber: string;
  createdAt: Timestamp;
  role: 'tenant';
}

export interface AgentAccount {
  id: string;
  phone: string;
  email: string;
  name: string;
  role: 'agent';
  paymentInfo?: {
    paystackSubaccountId: string;
    splitPercentage: number;
    accountName: string;
    bankCode: string;
    accountNumber: string;
    createdAt: string;
  };
}

export interface Invoice {
  id: string;
  localId: number;
  tenantId: number;
  propertyId: number;
  agentUserId: string;
  billingMonth: string;
  rentAmount: number;
  waterCurrentReading: number;
  waterPreviousReading: number;
  waterStandingFee: number;
  waterUnitPrice: number;
  powerCurrentReading: number;
  powerPreviousReading: number;
  powerUnitPrice: number;
  otherCharges: number;
  otherChargesDescription: string;
  totalAmount: number;
  amountPaid: number;
  arrears: number;
  dueDate: string;
  isPaid: boolean;
  paidDate?: string;
  tenantName?: string;
  propertyName?: string;
}

export interface Payment {
  id: string;
  invoiceId: number;
  tenantId: number;
  agentUserId: string;
  amount: number;
  arrears: number;
  paystackReference: string;
  paymentMethod: 'mpesa' | 'airtel_money';
  phone: string;
  status: 'pending' | 'success' | 'failed';
  createdAt: Timestamp;
  paidAt?: Timestamp;
  platformFee: number;
  paystackFee: number;
  netAmount: number;
}

// Auth Service
export class AuthService {
  private static recaptchaVerifier: RecaptchaVerifier | null = null;

  static initRecaptcha(containerId: string): void {
    if (!this.recaptchaVerifier) {
      this.recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
        size: 'invisible',
        callback: () => {
          console.log('reCAPTCHA verified');
        }
      });
    }
  }

  static async sendVerificationCode(phoneNumber: string): Promise<any> {
    try {
      if (!this.recaptchaVerifier) {
        throw new Error('reCAPTCHA not initialized');
      }

      const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
      const confirmationResult = await signInWithPhoneNumber(auth, formattedPhone, this.recaptchaVerifier);
      return confirmationResult;
    } catch (error: any) {
      console.error('Error sending verification code:', error);
      throw new Error(error.message || 'Failed to send verification code');
    }
  }

  static async verifyCode(confirmationResult: any, code: string): Promise<FirebaseUser> {
    try {
      const result = await confirmationResult.confirm(code);
      return result.user;
    } catch (error: any) {
      console.error('Error verifying code:', error);
      throw new Error('Invalid verification code');
    }
  }

    static async signInWithEmailPassword(email: string, password: string): Promise<FirebaseUser> {
      try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        return userCredential.user;
      } catch (error: any) {
        console.error('Email/Password sign in error:', error);
        throw error;
      }
    }

  static async signOut(): Promise<void> {
    await signOut(auth);
  }

  static onAuthChange(callback: (user: FirebaseUser | null) => void): Unsubscribe {
    return onAuthStateChanged(auth, callback);
  }
}

// Tenant Service
export class TenantService {
  static async createTenant(data: {
    phone: string;
    email: string;
    fullName: string;
    idNumber: string;
  }): Promise<string> {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not authenticated');

      const tenantDoc = doc(db, 'tenants', user.uid);
      await setDoc(tenantDoc, {
        ...data,
        id: user.uid,
        role: 'tenant',
        createdAt: serverTimestamp()
      });

      return user.uid;
    } catch (error: any) {
      console.error('Error creating tenant:', error);
      throw new Error(error.message || 'Failed to create tenant account');
    }
  }

  static async getTenant(uid: string): Promise<TenantAccount | null> {
    try {
      const tenantDoc = await getDoc(doc(db, 'tenants', uid));
      if (!tenantDoc.exists()) return null;
      return tenantDoc.data() as TenantAccount;
    } catch (error) {
      console.error('Error fetching tenant:', error);
      return null;
    }
  }

  static async findTenantInvoices(tenantId: string): Promise<Invoice[]> {
    try {
      const invoices: Invoice[] = [];
      
      // Search across all users using collectionGroup
      const q = query(
        collectionGroup(db, 'tenants'),
        where('localId', '==', parseInt(tenantId))
      );
      
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        return [];
      }

      // Get the tenant document to extract userId
      const tenantDoc = querySnapshot.docs[0];
      const tenantPath = tenantDoc.ref.path; // e.g., "users/123/tenants/456"
      const userId = tenantPath.split('/')[1]; // Extract userId

      // Now fetch invoices for this user and tenant
      const invoicesQuery = query(
        collection(db, 'users', userId, 'invoices'),
        where('tenantId', '==', parseInt(tenantId)),
        orderBy('dueDate', 'desc')
      );

      const invoicesSnapshot = await getDocs(invoicesQuery);
      
      for (const doc of invoicesSnapshot.docs) {
        const data = doc.data();
        invoices.push({
          id: doc.id,
          localId: data.localId,
          tenantId: data.tenantId,
          propertyId: data.propertyId,
          agentUserId: userId,
          billingMonth: data.billingMonth,
          rentAmount: data.rentAmount,
          waterCurrentReading: data.waterCurrentReading || 0,
          waterPreviousReading: data.waterPreviousReading || 0,
          waterStandingFee: data.waterStandingFee || 0,
          waterUnitPrice: data.waterUnitPrice || 0,
          powerCurrentReading: data.powerCurrentReading || 0,
          powerPreviousReading: data.powerPreviousReading || 0,
          powerUnitPrice: data.powerUnitPrice || 0,
          otherCharges: data.otherCharges || 0,
          otherChargesDescription: data.otherChargesDescription || '',
          totalAmount: data.totalAmount,
          amountPaid: data.amountPaid || 0,
          arrears: data.arrears || 0,
          dueDate: data.dueDate,
          isPaid: data.isPaid || false,
          paidDate: data.paidDate,
          tenantName: tenantDoc.data()?.name,
          propertyName: data.propertyName
        });
      }

      return invoices;
    } catch (error) {
      console.error('Error finding tenant invoices:', error);
      throw new Error('Failed to fetch invoices');
    }
  }

  static async getPaymentHistory(tenantId: string): Promise<Payment[]> {
    try {
      const paymentsQuery = query(
        collection(db, 'payments'),
        where('tenantId', '==', parseInt(tenantId)),
        orderBy('createdAt', 'desc')
      );

      const snapshot = await getDocs(paymentsQuery);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Payment));
    } catch (error) {
      console.error('Error fetching payment history:', error);
      return [];
    }
  }
}

// Agent Service
export class AgentService {
  static async getAgent(userId: string): Promise<AgentAccount | null> {
    try {
      const userDoc = await getDoc(doc(db, 'users', userId));
      if (!userDoc.exists()) return null;
      
      const data = userDoc.data();
      return {
        id: userId,
        phone: data.phone || '',
        email: data.email || '',
        name: data.name || '',
        role: 'agent',
        paymentInfo: data.paymentInfo
      };
    } catch (error) {
      console.error('Error fetching agent:', error);
      return null;
    }
  }

  static async getInvoicesByAgent(userId: string): Promise<Invoice[]> {
    try {
      const invoices: Invoice[] = [];
      const invoicesQuery = query(
        collection(db, 'users', userId, 'invoices'),
        orderBy('dueDate', 'desc')
      );

      const snapshot = await getDocs(invoicesQuery);
      
      for (const docSnapshot of snapshot.docs) {
        const data = docSnapshot.data();
        
        // Fetch tenant name
        let tenantName = 'Unknown';
        try {
          const tenantDocRef = doc(
            collection(db, 'users', userId, 'tenants'),
            data.tenantId.toString()
          );
          const tenantDoc = await getDoc(tenantDocRef);
          if (tenantDoc.exists()) {
            const tenantData = tenantDoc.data() as { name?: string };
            tenantName = tenantData.name || 'Unknown';
          }
        } catch {}

        invoices.push({
          id: docSnapshot.id,
          localId: data.localId,
          tenantId: data.tenantId,
          propertyId: data.propertyId,
          agentUserId: userId,
          billingMonth: data.billingMonth,
          rentAmount: data.rentAmount,
          waterCurrentReading: data.waterCurrentReading || 0,
          waterPreviousReading: data.waterPreviousReading || 0,
          waterStandingFee: data.waterStandingFee || 0,
          waterUnitPrice: data.waterUnitPrice || 0,
          powerCurrentReading: data.powerCurrentReading || 0,
          powerPreviousReading: data.powerPreviousReading || 0,
          powerUnitPrice: data.powerUnitPrice || 0,
          otherCharges: data.otherCharges || 0,
          otherChargesDescription: data.otherChargesDescription || '',
          totalAmount: data.totalAmount,
          amountPaid: data.amountPaid || 0,
          arrears: data.arrears || 0,
          dueDate: data.dueDate,
          isPaid: data.isPaid || false,
          paidDate: data.paidDate,
          tenantName
        });
      }

      return invoices;
    } catch (error) {
      console.error('Error fetching agent invoices:', error);
      return [];
    }
  }

  static async getPaymentsByAgent(userId: string): Promise<Payment[]> {
    try {
      const paymentsQuery = query(
        collection(db, 'payments'),
        where('agentUserId', '==', userId),
        orderBy('createdAt', 'desc')
      );

      const snapshot = await getDocs(paymentsQuery);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Payment));
    } catch (error) {
      console.error('Error fetching agent payments:', error);
      return [];
    }
  }

  static async updatePaymentInfo(userId: string, paymentData: {
    accountName: string;
    bankCode: string;
    accountNumber: string;
  }): Promise<void> {
    try {
      // Call Cloud Run function to create/update subaccount
      const response = await fetch('https://YOUR_CLOUD_RUN_URL/createOrUpdatePaymentInfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...paymentData })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update payment info');
      }

      const result = await response.json();
      
      // Update Firestore
      await setDoc(doc(db, 'users', userId), {
        paymentInfo: {
          paystackSubaccountId: result.subaccountId,
          splitPercentage: result.splitPercentage,
          accountName: paymentData.accountName,
          bankCode: paymentData.bankCode,
          accountNumber: paymentData.accountNumber,
          createdAt: new Date().toISOString()
        }
      }, { merge: true });
    } catch (error: any) {
      console.error('Error updating payment info:', error);
      throw new Error(error.message || 'Failed to update payment information');
    }
  }
}

// Payment Service
export class PaymentService {
  private static readonly PLATFORM_FEE_PERCENTAGE = 1.5;

  static calculateFees(amount: number): {
    platformFee: number;
    paystackFee: number;
    total: number;
    netAmount: number;
  } {
    // Paystack fee: 1.5% + KES 100 (capped at KES 2500)
    const paystackFee = Math.min((amount * 0.015) + 100, 2500);
    const platformFee = amount * (this.PLATFORM_FEE_PERCENTAGE / 100);
    const total = amount + paystackFee + platformFee;
    const netAmount = amount - platformFee;

    return {
      platformFee: Math.round(platformFee * 100) / 100,
      paystackFee: Math.round(paystackFee * 100) / 100,
      total: Math.round(total * 100) / 100,
      netAmount: Math.round(netAmount * 100) / 100
    };
  }

  static async initiatePayment(data: {
    invoiceId: number;
    tenantId: number;
    agentUserId: string;
    amount: number;
    arrears: number;
    phone: string;
    paymentMethod: 'mpesa' | 'airtel_money';
  }): Promise<{ reference: string; message: string }> {
    try {
      const fees = this.calculateFees(data.amount);

      const response = await fetch('https://YOUR_CLOUD_RUN_URL/processPayment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          ...fees
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Payment initiation failed');
      }

      const result = await response.json();
      return result;
    } catch (error: any) {
      console.error('Error initiating payment:', error);
      throw new Error(error.message || 'Failed to initiate payment');
    }
  }

  static listenToPaymentStatus(
    reference: string, 
    callback: (payment: Payment) => void
  ): Unsubscribe {
    const paymentRef = doc(db, 'payments', reference);
    return onSnapshot(paymentRef, (doc) => {
      if (doc.exists()) {
        callback({ id: doc.id, ...doc.data() } as Payment);
      }
    });
  }
}

export default {
  auth,
  db,
  AuthService,
  TenantService,
  AgentService,
  PaymentService
};