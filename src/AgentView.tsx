// AgentView.tsx - Agent Dashboard (Complete)
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts';
import {
  DollarSign,
  Receipt,
  TrendingUp,
  Search,
  Settings,
  LogOut,
  Loader2,
  AlertCircle,
  CheckCircle,
  CreditCard,
} from 'lucide-react';
import { auth, AuthService, AgentService, type Invoice, type Payment, type AgentAccount } from './Firebase';
import PaymentModal from './PaymentModal';

const AgentView: React.FC = () => {
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [agentData, setAgentData] = useState<AgentAccount | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showPaymentSettings, setShowPaymentSettings] = useState(false);
  const [tenantIdSearch, setTenantIdSearch] = useState('');
  const [searchError, setSearchError] = useState('');
  const [error, setError] = useState('');

  // Payment Settings State
  const [accountName, setAccountName] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [savingPaymentInfo, setSavingPaymentInfo] = useState(false);

  useEffect(() => {
    const unsubscribe = AuthService.onAuthChange(async (user) => {
      if (!user) {
        navigate('/');
        return;
      }

      try {
        setLoading(true);
        
        const agent = await AgentService.getAgent(user.uid);
        if (!agent) {
          setError('Agent account not found. Please use your PMS credentials.');
          setTimeout(() => navigate('/'), 3000);
          return;
        }
        
        setAgentData(agent);

        const fetchedInvoices = await AgentService.getInvoicesByAgent(user.uid);
        setInvoices(fetchedInvoices);

        const fetchedPayments = await AgentService.getPaymentsByAgent(user.uid);
        setPayments(fetchedPayments);
        
        if (agent.paymentInfo) {
          setAccountName(agent.paymentInfo.accountName);
          setBankCode(agent.paymentInfo.bankCode);
          setAccountNumber(agent.paymentInfo.accountNumber);
        }
        
      } catch (err: any) {
        console.error('Error loading agent data:', err);
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

  const handleTerminalSearch = async () => {
    setSearchError('');
    
    if (!tenantIdSearch) {
      setSearchError('Please enter a tenant ID');
      return;
    }

    try {
      const tenantInvoices = invoices.filter(
        inv => inv.tenantId.toString() === tenantIdSearch && !inv.isPaid
      );

      if (tenantInvoices.length === 0) {
        setSearchError('No unpaid invoices found for this tenant');
        return;
      }

      const latestInvoice = tenantInvoices.sort((a, b) => 
        new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime()
      )[0];

      setSelectedInvoice(latestInvoice);
      setShowPaymentModal(true);
      setTenantIdSearch('');
      
    } catch (err: any) {
      setSearchError(err.message || 'Error finding tenant');
    }
  };

  const handlePaymentSuccess = async () => {
    if (agentData && auth.currentUser) {
      const fetchedInvoices = await AgentService.getInvoicesByAgent(auth.currentUser.uid);
      setInvoices(fetchedInvoices);
      
      const fetchedPayments = await AgentService.getPaymentsByAgent(auth.currentUser.uid);
      setPayments(fetchedPayments);
    }
  };

  const handleSavePaymentInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!agentData || !auth.currentUser) return;

    try {
      setSavingPaymentInfo(true);
      
      await AgentService.updatePaymentInfo(auth.currentUser.uid, {
        accountName,
        bankCode,
        accountNumber
      });

      const updated = await AgentService.getAgent(auth.currentUser.uid);
      setAgentData(updated);
      setShowPaymentSettings(false);
      
      alert('Payment information updated successfully!');
      
    } catch (err: any) {
      alert(err.message || 'Failed to update payment information');
    } finally {
      setSavingPaymentInfo(false);
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
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
          <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 text-center mb-2">Error</h2>
          <p className="text-gray-600 text-center mb-6">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  const totalRevenue = payments
    .filter(p => p.status === 'success')
    .reduce((sum, p) => sum + p.amount, 0);
  
  const totalOutstanding = invoices
    .filter(inv => !inv.isPaid)
    .reduce((sum, inv) => sum + (inv.totalAmount - inv.amountPaid), 0);

  const platformFeesTotal = payments
    .filter(p => p.status === 'success')
    .reduce((sum, p) => sum + p.platformFee, 0);

  const paystackFeesTotal = payments
    .filter(p => p.status === 'success')
    .reduce((sum, p) => sum + p.paystackFee, 0);

  const netRevenue = totalRevenue - platformFeesTotal - paystackFeesTotal;

  const paymentStatusData = [
    { name: 'Paid', value: invoices.filter(inv => inv.isPaid).length, color: '#10b981' },
    { name: 'Unpaid', value: invoices.filter(inv => !inv.isPaid).length, color: '#ef4444' }
  ];

  const monthlyData = payments
    .filter(p => p.status === 'success')
    .reduce((acc, payment) => {
      const month = new Date(payment.createdAt.toDate()).toLocaleDateString('en-KE', { month: 'short' });
      const existing = acc.find(item => item.month === month);
      if (existing) {
        existing.amount += payment.amount;
      } else {
        acc.push({ month, amount: payment.amount });
      }
      return acc;
    }, [] as Array<{ month: string; amount: number }>);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Agent Dashboard</h1>
              <p className="text-sm text-gray-600 mt-1">Welcome, {agentData?.name}</p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setShowTerminal(!showTerminal)}
                className="flex items-center space-x-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
              >
                <CreditCard className="w-5 h-5" />
                <span>Terminal</span>
              </button>
              <button
                onClick={() => setShowPaymentSettings(!showPaymentSettings)}
                className="flex items-center space-x-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Settings className="w-5 h-5" />
              </button>
              <button
                onClick={handleSignOut}
                className="flex items-center space-x-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <LogOut className="w-5 h-5" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {showTerminal && (
          <div className="bg-white rounded-xl shadow-lg p-6 mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Payment Terminal</h2>
            <p className="text-gray-600 mb-4">
              Enter tenant ID to process payment at the office
            </p>
            
            <div className="flex items-end space-x-4">
              <div className="flex-1">
                <label htmlFor="tenantId" className="block text-sm font-medium text-gray-700 mb-2">
                  Tenant ID
                </label>
                <input
                  id="tenantId"
                  type="text"
                  value={tenantIdSearch}
                  onChange={(e) => setTenantIdSearch(e.target.value)}
                  placeholder="Enter tenant ID"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  onKeyPress={(e) => e.key === 'Enter' && handleTerminalSearch()}
                />
              </div>
              <button
                onClick={handleTerminalSearch}
                className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors flex items-center space-x-2"
              >
                <Search className="w-5 h-5" />
                <span>Search</span>
              </button>
            </div>
            
            {searchError && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-red-800 text-sm">{searchError}</p>
              </div>
            )}
          </div>
        )}

        {showPaymentSettings && (
          <div className="bg-white rounded-xl shadow-lg p-6 mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Payment Account Settings</h2>
            
            {agentData?.paymentInfo ? (
              <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-start space-x-3">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-green-900 font-semibold">Payment Account Active</p>
                    <p className="text-green-700 text-sm mt-1">
                      Subaccount ID: {agentData.paymentInfo.paystackSubaccountId}
                    </p>
                    <p className="text-green-700 text-sm">
                      Split: {agentData.paymentInfo.splitPercentage}%
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-yellow-800 text-sm">
                  No payment account configured. Add your bank details to receive payments.
                </p>
              </div>
            )}

            <form onSubmit={handleSavePaymentInfo} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Account Name
                </label>
                <input
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="John Doe"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Bank Code
                </label>
                <input
                  type="text"
                  value={bankCode}
                  onChange={(e) => setBankCode(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g., 063 for Diamond Trust Bank"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Account Number
                </label>
                <input
                  type="text"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="1234567890"
                />
              </div>

              <button
                type="submit"
                disabled={savingPaymentInfo}
                className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingPaymentInfo ? (
                  <span className="flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                    Saving...
                  </span>
                ) : (
                  'Save Payment Information'
                )}
              </button>
            </form>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-600">Total Revenue</h3>
              <DollarSign className="w-8 h-8 text-green-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{formatCurrency(totalRevenue)}</p>
            <p className="text-xs text-gray-500 mt-2">Net: {formatCurrency(netRevenue)}</p>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-600">Outstanding</h3>
              <TrendingUp className="w-8 h-8 text-orange-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{formatCurrency(totalOutstanding)}</p>
            <p className="text-xs text-gray-500 mt-2">
              {invoices.filter(inv => !inv.isPaid).length} unpaid invoices
            </p>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-600">Platform Fees</h3>
              <Receipt className="w-8 h-8 text-indigo-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{formatCurrency(platformFeesTotal)}</p>
            <p className="text-xs text-gray-500 mt-2">1.5% of revenue</p>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-600">Paystack Fees</h3>
              <CreditCard className="w-8 h-8 text-purple-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{formatCurrency(paystackFeesTotal)}</p>
            <p className="text-xs text-gray-500 mt-2">Transaction fees</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-lg p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Monthly Revenue</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Bar dataKey="amount" fill="#4f46e5" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Invoice Status</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={paymentStatusData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name}: ${value}`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {paymentStatusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-4">Recent Payments</h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Date</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Tenant ID</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Amount</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Method</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.slice(0, 10).map((payment) => (
                  <tr key={payment.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-3 px-4 text-sm text-gray-900">
                      {formatDate(payment.createdAt.toDate().toISOString())}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-900">{payment.tenantId}</td>
                    <td className="py-3 px-4 text-sm font-semibold text-gray-900">
                      {formatCurrency(payment.amount)}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">
                      {payment.paymentMethod === 'mpesa' ? 'M-PESA' : 'Airtel Money'}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          payment.status === 'success'
                            ? 'bg-green-100 text-green-800'
                            : payment.status === 'pending'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {payment.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            
            {payments.length === 0 && (
              <div className="text-center py-12">
                <Receipt className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">No payments yet</p>
              </div>
            )}
          </div>
        </div>
      </main>

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

export default AgentView;