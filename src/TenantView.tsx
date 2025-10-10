// TenantView.tsx - Tenant Dashboard
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Receipt, 
  History, 
  LogOut, 
  Loader2, 
  AlertCircle, 
  CheckCircle,
  FileText
} from 'lucide-react';
import { AuthService, TenantService, type Invoice, type Payment } from './Firebase';
import PaymentModal from './PaymentModal';

const TenantView: React.FC = () => {
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [tenantData, setTenantData] = useState<any>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
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
        
        // Get tenant account
        const tenant = await TenantService.getTenant(user.uid);
        if (!tenant) {
          // Redirect to signup completion if account not found
          navigate('/signup', { state: { fromAuth: true } });
          return;
        }
        
        setTenantData(tenant);

        // Fetch invoices using tenant ID
        const fetchedInvoices = await TenantService.findTenantInvoices(tenant.id);
        setInvoices(fetchedInvoices);

        // Fetch payment history
        const fetchedPayments = await TenantService.getPaymentHistory(tenant.id);
        setPayments(fetchedPayments);
        
      } catch (err: any) {
        console.error('Error loading tenant data:', err);
        setError(err.message || 'Failed to load data');
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [navigate]);

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
    // Refresh invoices and payments
    if (tenantData) {
      const fetchedInvoices = await TenantService.findTenantInvoices(tenantData.id);
      setInvoices(fetchedInvoices);
      
      const fetchedPayments = await TenantService.getPaymentHistory(tenantData.id);
      setPayments(fetchedPayments);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-KE', {
      style: 'currency',
      currency: 'KES',
      minimumFractionDigits: 2
    }).format(value);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-KE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
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

  const totalPaid = payments.reduce((sum, payment) => sum + payment.amount, 0);

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
              onClick={handleSignOut}
              className="flex items-center space-x-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <LogOut className="w-5 h-5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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

                          {/* Breakdown */}
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

                        {/* Pay Now Button */}
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
                  {payments.map((payment) => (
                    <div
                      key={payment.id}
                      className="border border-gray-200 rounded-lg p-4 bg-white hover:shadow-md transition-all"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <h3 className="font-semibold text-gray-900">
                              Payment #{payment.id.substring(0, 8)}
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
                              <p className="text-gray-600">Payment Method</p>
                              <p className="font-semibold text-gray-900">
                                {payment.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Airtel Money'}
                              </p>
                            </div>
                            <div>
                              <p className="text-gray-600">Date</p>
                              <p className="font-semibold text-gray-900">
                                {payment.paidAt ? formatDate(payment.paidAt.toDate().toISOString()) : 'Pending'}
                              </p>
                            </div>
                            <div>
                              <p className="text-gray-600">Reference</p>
                              <p className="font-mono text-xs text-gray-700">
                                {payment.paystackReference}
                              </p>
                            </div>
                          </div>
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