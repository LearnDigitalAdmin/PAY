// AgentView.tsx - Agent Dashboard (Updated)
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
import { AgentService, type Invoice, type Payment, type AgentAccount } from './Firebase';
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
  const [businessName, setBusinessName] = useState('');
  const [settlementBank, setSettlementBank] = useState<'mpesa' | 'airtel-ke'>('mpesa');
  const [accountNumber, setAccountNumber] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [savingPaymentInfo, setSavingPaymentInfo] = useState(false);

  useEffect(() => {
    const loadAgentData = async () => {
      try {
        setLoading(true);
        
        const agentUserStr = localStorage.getItem('agentAuthUser');
        
        if (!agentUserStr) {
          navigate('/');
          return;
        }

        let agentUser;
        try {
          agentUser = JSON.parse(agentUserStr);
        } catch (parseError) {
          console.error('Error parsing agent user:', parseError);
          localStorage.removeItem('agentAuthUser');
          navigate('/');
          return;
        }

        if (!agentUser.id || !agentUser.email) {
          console.error('Invalid agent user data');
          localStorage.removeItem('agentAuthUser');
          navigate('/');
          return;
        }

        const agent = await AgentService.getAgent(agentUser.id);
        
        if (!agent) {
          setError('Agent account not found. Please contact support.');
          localStorage.removeItem('agentAuthUser');
          setTimeout(() => navigate('/'), 3000);
          return;
        }
        
        setAgentData(agent);

        const fetchedInvoices = await AgentService.getInvoicesByAgent(agentUser.id);
        setInvoices(fetchedInvoices);

        const fetchedPayments = await AgentService.getPaymentsByAgent(agentUser.id);
        setPayments(fetchedPayments);
        
        // Load payment info if available
        if (agent.paymentInfo) {
          setBusinessName(agent.paymentInfo.businessName || '');
          setSettlementBank(agent.paymentInfo.settlementBank as 'mpesa' | 'airtel-ke' || 'mpesa');
          setAccountNumber(agent.paymentInfo.accountNumber || '');
          setEmail(agent.paymentInfo.email || agent.email);
          setName(agent.paymentInfo.name || agent.name);
          setPhone(agent.paymentInfo.phone || agent.phone);
        } else {
          // Set defaults from agent data
          setEmail(agent.email);
          setName(agent.name);
          setPhone(agent.phone);
        }
        
      } catch (err: any) {
        console.error('Error loading agent data:', err);
        setError(err.message || 'Failed to load data');
        
        if (err.message?.includes('permission') || err.message?.includes('unauthorized')) {
          localStorage.removeItem('agentAuthUser');
          navigate('/');
        }
      } finally {
        setLoading(false);
      }
    };

    loadAgentData();

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'agentAuthUser' && !e.newValue) {
        navigate('/');
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [navigate]);

  const handleSignOut = async () => {
    try {
      localStorage.removeItem('agentAuthUser');
      navigate('/');
    } catch (err) {
      console.error('Error logging out:', err);
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
    if (agentData) {
      const agentUserStr = localStorage.getItem('agentAuthUser');
      if (!agentUserStr) return;
      
      const agentUser = JSON.parse(agentUserStr);
      const fetchedInvoices = await AgentService.getInvoicesByAgent(agentUser.id);
      setInvoices(fetchedInvoices);
      
      const fetchedPayments = await AgentService.getPaymentsByAgent(agentUser.id);
      setPayments(fetchedPayments);
    }
  };

  const handleSavePaymentInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!agentData) return;

    try {
      setSavingPaymentInfo(true);
      
      await AgentService.setupPaymentAccount({
        businessName,
        settlementBank,
        accountNumber,
        email,
        name,
        phone,
        userId: agentData.id
      });

      // Refresh agent data
      const updated = await AgentService.getAgent(agentData.id);
      if (updated) {
        setAgentData(updated);
      }
      
      setShowPaymentSettings(false);
      alert('Payment account setup successfully!');
      
    } catch (err: any) {
      alert(err.message || 'Failed to setup payment account');
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

  const paymentStatusData = [
    { name: 'Paid', value: invoices.filter(inv => inv.isPaid).length, color: '#10b981' },
    { name: 'Unpaid', value: invoices.filter(inv => !inv.isPaid).length, color: '#ef4444' }
  ];

  const monthlyData = payments
    .filter(p => p.status === 'success')
    .reduce((acc, payment) => {
      let month: string;
      try {
        if (payment.initiatedAt?.toDate) {
          month = payment.initiatedAt.toDate().toLocaleDateString('en-KE', { month: 'short' });
        } else {
          month = 'Unknown';
        }
      } catch {
        month = 'Unknown';
      }
      
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
              {agentData?.tier && (
                <span className="inline-block mt-1 px-2 py-1 text-xs font-semibold rounded-full bg-indigo-100 text-indigo-800">
                  {agentData.tier.toUpperCase()} Tier
                </span>
              )}
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
            
            {agentData?.paymentInfo?.accountId ? (
              <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-start space-x-3">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-green-900 font-semibold">Payment Account Active</p>
                    <p className="text-green-700 text-sm mt-1">
                      Subaccount Code: {agentData.paymentInfo.accountId}
                    </p>
                    <p className="text-green-700 text-sm">
                      Commission Rate: {agentData.paymentInfo.split}%
                    </p>
                    <p className="text-green-700 text-sm">
                      Settlement Bank: {agentData.paymentInfo.settlementBank.toUpperCase()}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-yellow-800 text-sm">
                  No payment account configured. Setup your account details to receive payments via split settlement.
                </p>
              </div>
            )}

            <form onSubmit={handleSavePaymentInfo} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Business Name
                </label>
                <input
                  type="text"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="Your Business Name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Settlement Bank
                </label>
                <select
                  value={settlementBank}
                  onChange={(e) => setSettlementBank(e.target.value as 'mpesa' | 'airtel-ke')}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="mpesa">M-Pesa</option>
                  <option value="airtel-ke">Airtel Money (Kenya)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Account Number / Phone Number
                </label>
                <input
                  type="text"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="254712345678"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Enter your M-Pesa/Airtel Money registered phone number
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Contact Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="email@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Contact Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="John Doe"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Contact Phone
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="254712345678"
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
                    Setting up account...
                  </span>
                ) : (
                  agentData?.paymentInfo?.accountId ? 'Update Payment Account' : 'Setup Payment Account'
                )}
              </button>
            </form>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-600">Total Revenue</h3>
              <DollarSign className="w-8 h-8 text-green-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{formatCurrency(totalRevenue)}</p>
            <p className="text-xs text-gray-500 mt-2">From successful payments</p>
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
              <h3 className="text-sm font-medium text-gray-600">Total Invoices</h3>
              <Receipt className="w-8 h-8 text-indigo-600" />
            </div>
            <p className="text-2xl font-bold text-gray-900">{invoices.length}</p>
            <p className="text-xs text-gray-500 mt-2">All time invoices</p>
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
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Reference</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Tenant</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Amount</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.slice(0, 10).map((payment) => (
                  <tr key={payment.reference} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-3 px-4 text-sm text-gray-900">
                      {formatDate(payment.completedAt || payment.initiatedAt)}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600 font-mono">
                      {payment.reference.substring(0, 12)}...
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-900">{payment.userName || 'N/A'}</td>
                    <td className="py-3 px-4 text-sm font-semibold text-gray-900">
                      {formatCurrency(payment.amount)}
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
          initiatorRole="agent"
        />
      )}
    </div>
  );
};

export default AgentView;