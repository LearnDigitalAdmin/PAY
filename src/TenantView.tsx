// TenantView.tsx - Tenant Dashboard with Screening Profile
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Receipt, 
  History, 
  LogOut, 
  Loader2, 
  AlertCircle, 
  CheckCircle,
  FileText,
  User,
  TrendingUp,
  TrendingDown,
  Award,
  Calendar,
  Clock,
  DollarSign,
  X
} from 'lucide-react';
import { AuthService, db, TenantService, type Invoice, type Payment } from './Firebase';
import PaymentModal from './PaymentModal';
import { doc, getDoc } from 'firebase/firestore';

interface ScreeningMetrics {
  screeningScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  onTimePaymentRate: number;
  averageDaysLate: number;
  totalArrearsAccumulated: number;
  paymentCompletionRate: number;
  improvingTrend: boolean;
  paymentConsistencyScore?: number;
  preferredPaymentDay?: number;
  paymentReliabilityTrend?: 'improving' | 'stable' | 'declining';
}

interface ScreeningData {
  calculatedMetrics: ScreeningMetrics;
  paymentHistory: {
    totalMonthsTracked: number;
  };
  earlyWarningFlags?: {
    flagsRaised: string[];
  };
}

const TenantView: React.FC = () => {
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [tenantData, setTenantData] = useState<any>(null);
  const [screeningData, setScreeningData] = useState<ScreeningData | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'invoices' | 'payments'>('invoices');
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubscribe = AuthService.onAuthChange(async (user) => {
      if (!user) {
        navigate('/');
        return;
      }

      try {
        setLoading(true);
        
        const tenant = await TenantService.getTenant(user.uid);
        if (!tenant) {
          navigate('/signup', { state: { fromAuth: true } });
          return;
        }
        
        setTenantData(tenant);

        // Fetch screening data from Firestore
        try {
          const screeningRef = doc(db, 'screening', tenant.id.toString());
          const screeningSnap = await getDoc(screeningRef);
          
          if (screeningSnap.exists()) {
            setScreeningData(screeningSnap.data() as ScreeningData);
          }
        } catch (err) {
          console.log('No screening data available yet');
        }

        const fetchedInvoices = await TenantService.findTenantInvoices(tenant.id);
        setInvoices(fetchedInvoices);

        const agentUserId = fetchedInvoices.length > 0 ? fetchedInvoices[0].agentUserId : undefined;
        const fetchedPayments = await TenantService.getPaymentHistory(tenant.id, agentUserId);
        setPayments(fetchedPayments);
        
      } catch (err: any) {
        console.error('Error loading tenant data:', err);
        setError(err.message || 'Failed to load data');
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [navigate, db]);

  const handleSignOut = async () => {
    try {
      await AuthService.signOut();
      navigate('/');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  const handlePayNow = (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    setShowPaymentModal(true);
  };

  const handlePaymentSuccess = async () => {
    if (tenantData) {
      const fetchedInvoices = await TenantService.findTenantInvoices(tenantData.id);
      setInvoices(fetchedInvoices);
      
      const agentUserId = fetchedInvoices.length > 0 ? fetchedInvoices[0].agentUserId : undefined;
      const fetchedPayments = await TenantService.getPaymentHistory(tenantData.id, agentUserId);
      setPayments(fetchedPayments);
      
      // Refresh screening data after payment
      try {
        const screeningRef = doc(db, 'screening', tenantData.id.toString());
        const screeningSnap = await getDoc(screeningRef);
        if (screeningSnap.exists()) {
          setScreeningData(screeningSnap.data() as ScreeningData);
        }
      } catch (err) {
        console.log('Could not refresh screening data');
      }
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-KE', {
      style: 'currency',
      currency: 'KES',
      minimumFractionDigits: 2
    }).format(value);
  };

  const formatDate = (dateString: string | any) => {
    try {
      let date: Date;
      if (typeof dateString === 'string') {
        date = new Date(dateString);
      } else if (dateString?.toDate) {
        date = dateString.toDate();
      } else {
        return 'N/A';
      }
      
      return date.toLocaleDateString('en-KE', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return 'N/A';
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 75) return 'text-green-600';
    if (score >= 50) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getScoreBgColor = (score: number) => {
    if (score >= 75) return 'bg-green-100';
    if (score >= 50) return 'bg-yellow-100';
    return 'bg-red-100';
  };

  const getRiskBadgeColor = (riskLevel: string) => {
    if (riskLevel === 'low') return 'bg-green-100 text-green-800';
    if (riskLevel === 'medium') return 'bg-yellow-100 text-yellow-800';
    return 'bg-red-100 text-red-800';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
          <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 text-center mb-2">Error Loading Data</h2>
          <p className="text-gray-600 text-center mb-6">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const totalOutstanding = invoices
    .filter(inv => !inv.isPaid)
    .reduce((sum, inv) => sum + (inv.totalAmount - inv.amountPaid), 0);

  const totalPaid = payments
    .filter(p => p.status === 'success')
    .reduce((sum, payment) => sum + payment.amount, 0);

  const metrics = screeningData?.calculatedMetrics;
  const paymentHistory = screeningData?.paymentHistory;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Tenant Portal</h1>
              <p className="text-sm text-gray-600 mt-1">Welcome, {tenantData?.fullName}</p>
            </div>
            <button
              onClick={() => setShowProfileModal(true)}
              className="flex items-center space-x-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <User className="w-5 h-5" />
              <span>Profile</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Payment Score Banner */}
        {screeningData && metrics && (
          <div className={`${getScoreBgColor(metrics.screeningScore)} rounded-xl p-6 mb-8 border-2 ${
            metrics.screeningScore >= 75 ? 'border-green-300' : 
            metrics.screeningScore >= 50 ? 'border-yellow-300' : 'border-red-300'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center space-x-3 mb-2">
                  <Award className={`w-8 h-8 ${getScoreColor(metrics.screeningScore)}`} />
                  <div>
                    <h3 className="text-lg font-bold text-gray-900">Your Payment Score</h3>
                    <p className="text-sm text-gray-600">
                      {metrics.screeningScore >= 75 ? '🎉 Excellent! Keep up the great work!' :
                       metrics.screeningScore >= 50 ? '👍 Good! A few improvements will boost your score.' :
                       '⚠️ Needs attention. Timely payments will improve your score significantly.'}
                    </p>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className={`text-5xl font-bold ${getScoreColor(metrics.screeningScore)}`}>
                  {Math.round(metrics.screeningScore)}
                </div>
                <p className="text-sm text-gray-600 mt-1">out of 100</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 mt-6">
              <div className="bg-white/70 rounded-lg p-3">
                <p className="text-xs text-gray-600 mb-1">On-Time Rate</p>
                <p className="text-xl font-bold text-gray-900">
                  {Math.round(metrics.onTimePaymentRate * 100)}%
                </p>
              </div>
              <div className="bg-white/70 rounded-lg p-3">
                <p className="text-xs text-gray-600 mb-1">Months Tracked</p>
                <p className="text-xl font-bold text-gray-900">
                  {paymentHistory?.totalMonthsTracked || 0}
                </p>
              </div>
              <div className="bg-white/70 rounded-lg p-3">
                <p className="text-xs text-gray-600 mb-1">Risk Level</p>
                <span className={`inline-block px-2 py-1 text-xs font-semibold rounded-full ${getRiskBadgeColor(metrics.riskLevel)}`}>
                  {metrics.riskLevel.toUpperCase()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-md p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Outstanding</p>
                <p className="text-2xl font-bold text-red-600 mt-1">
                  {formatCurrency(totalOutstanding)}
                </p>
              </div>
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                <Receipt className="w-6 h-6 text-red-600" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-md p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Paid</p>
                <p className="text-2xl font-bold text-green-600 mt-1">
                  {formatCurrency(totalPaid)}
                </p>
              </div>
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-green-600" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-md p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Unpaid Invoices</p>
                <p className="text-2xl font-bold text-orange-600 mt-1">
                  {invoices.filter(inv => !inv.isPaid).length}
                </p>
              </div>
              <div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center">
                <FileText className="w-6 h-6 text-orange-600" />
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-xl shadow-md overflow-hidden">
          <div className="border-b border-gray-200">
            <div className="flex">
              <button
                onClick={() => setActiveTab('invoices')}
                className={`flex-1 px-6 py-4 text-sm font-semibold transition-colors ${
                  activeTab === 'invoices'
                    ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <Receipt className="w-5 h-5 inline-block mr-2" />
                Invoices ({invoices.length})
              </button>
              <button
                onClick={() => setActiveTab('payments')}
                className={`flex-1 px-6 py-4 text-sm font-semibold transition-colors ${
                  activeTab === 'payments'
                    ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <History className="w-5 h-5 inline-block mr-2" />
                Payment History ({payments.length})
              </button>
            </div>
          </div>

          {/* Invoices Tab */}
          {activeTab === 'invoices' && (
            <div className="p-6">
              {invoices.length === 0 ? (
                <div className="text-center py-12">
                  <Receipt className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-600">No invoices found</p>
                  <p className="text-sm text-gray-500 mt-2">
                    Your invoices will appear here once generated by your property manager
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {invoices.map((invoice) => (
                    <div
                      key={invoice.id}
                      className={`border rounded-lg p-4 transition-all hover:shadow-md ${
                        invoice.isPaid ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <h3 className="font-semibold text-gray-900">
                              Invoice #{invoice.localId}
                            </h3>
                            <span
                              className={`px-2 py-1 text-xs font-semibold rounded-full ${
                                invoice.isPaid
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {invoice.isPaid ? 'Paid' : 'Unpaid'}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="text-gray-600">Billing Month</p>
                              <p className="font-semibold text-gray-900">{invoice.billingMonth}</p>
                            </div>
                            <div>
                              <p className="text-gray-600">Due Date</p>
                              <p className="font-semibold text-gray-900">
                                {formatDate(invoice.dueDate)}
                              </p>
                            </div>
                            <div>
                              <p className="text-gray-600">Total Amount</p>
                              <p className="font-semibold text-gray-900">
                                {formatCurrency(invoice.totalAmount)}
                              </p>
                            </div>
                            <div>
                              <p className="text-gray-600">Outstanding</p>
                              <p className={`font-semibold ${
                                invoice.isPaid ? 'text-green-600' : 'text-red-600'
                              }`}>
                                {formatCurrency(invoice.totalAmount - invoice.amountPaid)}
                              </p>
                            </div>
                          </div>

                          <details className="mt-3">
                            <summary className="text-sm text-blue-600 cursor-pointer hover:underline">
                              View Breakdown
                            </summary>
                            <div className="mt-2 pl-4 border-l-2 border-gray-200 space-y-1 text-sm">
                              <div className="flex justify-between">
                                <span className="text-gray-600">Rent:</span>
                                <span className="font-semibold">{formatCurrency(invoice.rentAmount)}</span>
                              </div>
                              {invoice.waterCurrentReading > 0 && (
                                <div className="flex justify-between">
                                  <span className="text-gray-600">
                                    Water ({invoice.waterCurrentReading - invoice.waterPreviousReading} units):
                                  </span>
                                  <span className="font-semibold">
                                    {formatCurrency(
                                      (invoice.waterCurrentReading - invoice.waterPreviousReading) * 
                                      invoice.waterUnitPrice + invoice.waterStandingFee
                                    )}
                                  </span>
                                </div>
                              )}
                              {invoice.powerCurrentReading > 0 && (
                                <div className="flex justify-between">
                                  <span className="text-gray-600">
                                    Power ({invoice.powerCurrentReading - invoice.powerPreviousReading} units):
                                  </span>
                                  <span className="font-semibold">
                                    {formatCurrency(
                                      (invoice.powerCurrentReading - invoice.powerPreviousReading) * 
                                      invoice.powerUnitPrice
                                    )}
                                  </span>
                                </div>
                              )}
                              {invoice.otherCharges > 0 && (
                                <div className="flex justify-between">
                                  <span className="text-gray-600">
                                    {invoice.otherChargesDescription || 'Other'}:
                                  </span>
                                  <span className="font-semibold">{formatCurrency(invoice.otherCharges)}</span>
                                </div>
                              )}
                            </div>
                          </details>
                        </div>

                        {!invoice.isPaid && (
                          <button
                            onClick={() => handlePayNow(invoice)}
                            className="ml-4 px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors whitespace-nowrap"
                          >
                            Pay Now
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Payments Tab */}
          {activeTab === 'payments' && (
            <div className="p-6">
              {payments.length === 0 ? (
                <div className="text-center py-12">
                  <History className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-600">No payment history</p>
                  <p className="text-sm text-gray-500 mt-2">
                    Your payment records will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {payments.map((payment, index) => (
                    <div
                      key={payment.reference || index}
                      className="border border-gray-200 rounded-lg p-4 bg-white hover:shadow-md transition-all"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <h3 className="font-semibold text-gray-900">
                              Payment {payment.reference ? `#${payment.reference.substring(0, 8)}` : `#${index + 1}`}
                            </h3>
                            <span
                              className={`px-2 py-1 text-xs font-semibold rounded-full ${
                                payment.status === 'success'
                                  ? 'bg-green-100 text-green-800'
                                  : payment.status === 'pending'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {payment.status.charAt(0).toUpperCase() + payment.status.slice(1)}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="text-gray-600">Amount Paid</p>
                              <p className="font-bold text-green-600">
                                {formatCurrency(payment.amount)}
                              </p>
                            </div>
                            <div>
                              <p className="text-gray-600">Billing Month</p>
                              <p className="font-semibold text-gray-900">
                                {payment.billingMonth || 'N/A'}
                              </p>
                            </div>
                            <div>
                              <p className="text-gray-600">Date</p>
                              <p className="font-semibold text-gray-900">
                                {formatDate(payment.completedAt || payment.initiatedAt)}
                              </p>
                            </div>
                            <div>
                              <p className="text-gray-600">Reference</p>
                              <p className="font-mono text-xs text-gray-700">
                                {payment.reference || 'N/A'}
                              </p>
                            </div>
                          </div>

                          {payment.arrears > 0 && (
                            <div className="mt-2 p-2 bg-orange-50 border border-orange-200 rounded text-sm">
                              <p className="text-orange-800">
                                <strong>Note:</strong> Partial payment. Arrears: {formatCurrency(payment.arrears)}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Profile Modal */}
      {showProfileModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
              <h2 className="text-2xl font-bold text-gray-900">Your Payment Profile</h2>
              <button
                onClick={() => setShowProfileModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Tenant Info */}
              <div className="bg-blue-50 rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 mb-3">Personal Information</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-600">Name</p>
                    <p className="font-semibold">{tenantData?.fullName}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Phone</p>
                    <p className="font-semibold">{tenantData?.phone || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Email</p>
                    <p className="font-semibold text-xs">{tenantData?.email || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Unit</p>
                    <p className="font-semibold">{tenantData?.unitNumber || 'N/A'}</p>
                  </div>
                </div>
              </div>

              {/* Screening Score */}
              {screeningData && metrics ? (
                <>
                  <div className={`${getScoreBgColor(metrics.screeningScore)} rounded-xl p-6 border-2 ${
                    metrics.screeningScore >= 75 ? 'border-green-300' : 
                    metrics.screeningScore >= 50 ? 'border-yellow-300' : 'border-red-300'
                  }`}>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-lg font-bold text-gray-900">Payment Score</h3>
                        <p className="text-sm text-gray-600">Based on {paymentHistory?.totalMonthsTracked || 0} months of history</p>
                      </div>
                      <div className={`text-5xl font-bold ${getScoreColor(metrics.screeningScore)}`}>
                        {Math.round(metrics.screeningScore)}
                      </div>
                    </div>
                    
                    <div className="flex items-center justify-between text-sm">
                      <span className={`px-3 py-1 rounded-full font-semibold ${getRiskBadgeColor(metrics.riskLevel)}`}>
                        {metrics.riskLevel.toUpperCase()} RISK
                      </span>
                      {metrics.improvingTrend ? (
                        <span className="flex items-center text-green-600">
                          <TrendingUp className="w-4 h-4 mr-1" />
                          Improving
                        </span>
                      ) : (
                        <span className="flex items-center text-orange-600">
                          <TrendingDown className="w-4 h-4 mr-1" />
                          Needs Attention
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Performance Metrics */}
                  <div className="bg-white border border-gray-200 rounded-xl p-6">
                    <h3 className="font-semibold text-gray-900 mb-4 flex items-center">
                      <Award className="w-5 h-5 mr-2 text-blue-600" />
                      Performance Metrics
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-600 mb-1">On-Time Payments</p>
                        <p className="text-2xl font-bold text-green-600">
                          {Math.round(metrics.onTimePaymentRate * 100)}%
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          {metrics.onTimePaymentRate >= 0.9 ? 'Excellent!' : 
                           metrics.onTimePaymentRate >= 0.7 ? 'Good' : 'Can improve'}
                        </p>
                      </div>
                      
                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-600 mb-1">Avg Days Late</p>
                        <p className="text-2xl font-bold text-gray-900">
                          {Math.round(metrics.averageDaysLate)}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          {metrics.averageDaysLate < 5 ? 'Great!' : 
                           metrics.averageDaysLate < 15 ? 'Acceptable' : 'Needs improvement'}
                        </p>
                      </div>

                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-600 mb-1">Total Arrears</p>
                        <p className="text-2xl font-bold text-red-600">
                          {formatCurrency(metrics.totalArrearsAccumulated)}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          {metrics.totalArrearsAccumulated === 0 ? 'Perfect!' : 'Pay to reduce'}
                        </p>
                      </div>

                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs text-gray-600 mb-1">Payment Completion</p>
                        <p className="text-2xl font-bold text-blue-600">
                          {Math.round(metrics.paymentCompletionRate * 100)}%
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          {metrics.paymentCompletionRate >= 0.95 ? 'Outstanding!' : 
                           metrics.paymentCompletionRate >= 0.8 ? 'Good' : 'Partial payments'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Early Warnings */}
                  {screeningData.earlyWarningFlags && screeningData.earlyWarningFlags.flagsRaised && screeningData.earlyWarningFlags.flagsRaised.length > 0 && (
                    <div className="bg-orange-50 border-2 border-orange-200 rounded-xl p-6">
                      <h3 className="font-semibold text-orange-900 mb-3 flex items-center">
                        <AlertCircle className="w-5 h-5 mr-2" />
                        Payment Alerts
                      </h3>
                      <ul className="space-y-2">
                        {screeningData.earlyWarningFlags.flagsRaised.map((flag: string, idx: number) => (
                          <li key={idx} className="flex items-start text-sm text-orange-800">
                            <span className="w-2 h-2 bg-orange-600 rounded-full mt-1.5 mr-2 flex-shrink-0"></span>
                            <span>
                              {flag === 'missed_last_payment' && 'You missed your last payment - pay now to improve your score'}
                              {flag === 'arrears_increasing_rapidly' && 'Your arrears are increasing - make full payments to avoid penalties'}
                              {flag === 'payment_delays_worsening' && 'Your payment delays are increasing - pay earlier to boost your score'}
                              {flag === 'frequent_partial_payments' && 'Make full payments to demonstrate financial stability'}
                              {flag === 'three_consecutive_late_payments' && '⚠️ Critical: Three consecutive late payments - immediate action needed'}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-4 pt-4 border-t border-orange-200">
                        <p className="text-sm font-semibold text-orange-900">
                          💡 Tip: Paying on time for the next 3 months can significantly improve your score!
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Payment Patterns */}
                  {metrics.paymentConsistencyScore !== undefined && (
                    <div className="bg-white border border-gray-200 rounded-xl p-6">
                      <h3 className="font-semibold text-gray-900 mb-4 flex items-center">
                        <Calendar className="w-5 h-5 mr-2 text-purple-600" />
                        Payment Patterns
                      </h3>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-600">Consistency Score</span>
                          <span className="font-bold text-purple-600">
                            {metrics.paymentConsistencyScore}%
                          </span>
                        </div>
                        {metrics.preferredPaymentDay && metrics.preferredPaymentDay > 0 && (
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Preferred Payment Day</span>
                            <span className="font-semibold text-gray-900">
                              {metrics.preferredPaymentDay}th of month
                            </span>
                          </div>
                        )}
                        {metrics.paymentReliabilityTrend && (
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Reliability Trend</span>
                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                              metrics.paymentReliabilityTrend === 'improving' ? 'bg-green-100 text-green-800' :
                              metrics.paymentReliabilityTrend === 'declining' ? 'bg-red-100 text-red-800' :
                              'bg-gray-100 text-gray-800'
                            }`}>
                              {metrics.paymentReliabilityTrend.toUpperCase()}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* How to Improve */}
                  <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-200">
                    <h3 className="font-semibold text-gray-900 mb-3 flex items-center">
                      <TrendingUp className="w-5 h-5 mr-2 text-blue-600" />
                      How to Improve Your Score
                    </h3>
                    <ul className="space-y-2">
                      {metrics.screeningScore < 75 && (
                        <>
                          <li className="flex items-start text-sm text-gray-700">
                            <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 mr-2 flex-shrink-0" />
                            <span>Pay all invoices on or before the due date</span>
                          </li>
                          {metrics.totalArrearsAccumulated > 0 && (
                            <li className="flex items-start text-sm text-gray-700">
                              <DollarSign className="w-4 h-4 text-green-600 mt-0.5 mr-2 flex-shrink-0" />
                              <span>Clear all outstanding arrears to boost your score by up to 15 points</span>
                            </li>
                          )}
                          {metrics.averageDaysLate > 10 && (
                            <li className="flex items-start text-sm text-gray-700">
                              <Clock className="w-4 h-4 text-green-600 mt-0.5 mr-2 flex-shrink-0" />
                              <span>Pay within 5 days of due date to improve your timing score</span>
                            </li>
                          )}
                          {metrics.paymentCompletionRate < 0.95 && (
                            <li className="flex items-start text-sm text-gray-700">
                              <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 mr-2 flex-shrink-0" />
                              <span>Make full payments instead of partial payments</span>
                            </li>
                          )}
                        </>
                      )}
                      {metrics.screeningScore >= 75 && (
                        <li className="flex items-start text-sm text-gray-700">
                          <Award className="w-4 h-4 text-yellow-600 mt-0.5 mr-2 flex-shrink-0" />
                          <span>Excellent work! Keep maintaining your on-time payment record</span>
                        </li>
                      )}
                      <li className="flex items-start text-sm text-gray-700">
                        <TrendingUp className="w-4 h-4 text-blue-600 mt-0.5 mr-2 flex-shrink-0" />
                        <span>A good payment history can help you when applying for new rentals</span>
                      </li>
                    </ul>
                  </div>

                  {/* Benefits of Good Score */}
                  <div className="bg-green-50 rounded-xl p-6 border border-green-200">
                    <h3 className="font-semibold text-gray-900 mb-3 flex items-center">
                      <Award className="w-5 h-5 mr-2 text-green-600" />
                      Benefits of a High Payment Score
                    </h3>
                    <ul className="space-y-2 text-sm text-gray-700">
                      <li className="flex items-start">
                        <span className="w-2 h-2 bg-green-600 rounded-full mt-1.5 mr-2 flex-shrink-0"></span>
                        <span>Easier approval for future rental applications</span>
                      </li>
                      <li className="flex items-start">
                        <span className="w-2 h-2 bg-green-600 rounded-full mt-1.5 mr-2 flex-shrink-0"></span>
                        <span>Lower security deposits may be required</span>
                      </li>
                      <li className="flex items-start">
                        <span className="w-2 h-2 bg-green-600 rounded-full mt-1.5 mr-2 flex-shrink-0"></span>
                        <span>Priority consideration for property upgrades</span>
                      </li>
                      <li className="flex items-start">
                        <span className="w-2 h-2 bg-green-600 rounded-full mt-1.5 mr-2 flex-shrink-0"></span>
                        <span>Positive rental reference from your landlord</span>
                      </li>
                      <li className="flex items-start">
                        <span className="w-2 h-2 bg-green-600 rounded-full mt-1.5 mr-2 flex-shrink-0"></span>
                        <span>Potential for flexible payment terms in emergencies</span>
                      </li>
                    </ul>
                  </div>
                </>
              ) : (
                <div className="bg-gray-50 rounded-xl p-8 text-center">
                  <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                  <h3 className="font-semibold text-gray-900 mb-2">No Screening Data Available</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Your payment history is being tracked. Keep making timely payments to build your score!
                  </p>
                  <p className="text-xs text-gray-500">
                    Data typically becomes available after 3+ months of payment history.
                  </p>
                </div>
              )}

              {/* Sign Out Button */}
              <button
                onClick={handleSignOut}
                className="w-full flex items-center justify-center space-x-2 px-6 py-3 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition-colors"
              >
                <LogOut className="w-5 h-5" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {showPaymentModal && selectedInvoice && (
        <PaymentModal
          invoice={selectedInvoice}
          onClose={() => {
            setShowPaymentModal(false);
            setSelectedInvoice(null);
          }}
          onSuccess={handlePaymentSuccess}
          initiatorRole="tenant"
        />
      )}
    </div>
  );
};

export default TenantView;