// AgentView.tsx - Agent Dashboard (Updated with Multiple Payment Modes)
import { checkSafaricomPhone, phoneHint, sanitizePhoneInput, PHONE_MAX_INPUT_LENGTH } from './utils/safaricom';
import React, { useState, useEffect } from 'react';
import SettlementFields, { type SettlementType } from './SettlementFields';
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
  HelpCircle,
  X,
  Building2,
  Smartphone,
  Banknote,
} from 'lucide-react';
import { AgentService, type Invoice, type Payment, type AgentAccount, AuthService, functions } from './Firebase';
import { httpsCallable } from 'firebase/functions';
import PaymentModal from './PaymentModal';
import BrandLogo from './theme/BrandLogo';
import ChamaSection from './mychama/ChamaSection';

type PaymentMode = 'mobile_money' | 'bank' | 'till';

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
  // Lipa Mos Mos (tenants pay rent a little at a time; the landlord is paid by transfer to this same account)
  const [lmm, setLmm] = useState<{ status: string; reason?: string | null; last4?: string } | null>(null);
  const [lmmBusy, setLmmBusy] = useState(false);
  const [lmmMsg, setLmmMsg] = useState('');
  const [tenantIdSearch, setTenantIdSearch] = useState('');
  const [searchError, setSearchError] = useState('');
  const [error, setError] = useState('');

  // Payment Mode Selection
  const [selectedPaymentMode, setSelectedPaymentMode] = useState<PaymentMode>('mobile_money');
  const settlementBank: SettlementType = selectedPaymentMode === 'bank' ? 'bank' : selectedPaymentMode === 'till' ? 'till' : 'mpesa';
    const [savingPaymentInfo, setSavingPaymentInfo] = useState(false);




  // Mobile Money State
  const [businessName, setBusinessName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');


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
          const st = (agent.paymentInfo as any).settlementType || agent.paymentInfo.settlementBank;
          setSelectedPaymentMode(st === 'bank' ? 'bank' : st === 'till' ? 'till' : 'mobile_money');
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

  const enableLmm = async () => {
    const info: any = agentData?.paymentInfo;
    if (!info) return;
    setLmmBusy(true); setLmmMsg('');
    try {
      await httpsCallable(functions, 'lmm_setupRecipient')({ settlementType: info.settlementType || '', bankCode: info.settlementBankCode || '', accountNumber: info.accountNumber || '', name: info.businessName || '' });
      const r: any = await httpsCallable(functions, 'lmm_recipientStatus')({});
      setLmm(r.data); setLmmMsg('Lipa Mos Mos is on for your payout account.');
    } catch (e: any) { setLmmMsg(e?.message || 'Could not turn on Lipa Mos Mos'); } finally { setLmmBusy(false); }
  };

  useEffect(() => {
    if (!agentData?.paymentInfo?.accountId) return;
    httpsCallable(functions, 'lmm_recipientStatus')({}).then((r: any) => setLmm(r.data)).catch(() => undefined);
  }, [agentData?.paymentInfo?.accountId]);

  const handleSignOut = async () => {
    try {
      AuthService.signOut();
      localStorage.removeItem('agentAuthUser');
      navigate('/');
    } catch (err) {
      navigate('/');
      console.error('Error logging out:', err);
    }
  };

  const handleHelp = () => {
    navigate('/faq');
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

    const contactCheck = checkSafaricomPhone(phone);
    if (!contactCheck.ok) {
      alert(`Contact phone: ${contactCheck.message}`);
      return;
    }
    if (settlementBank === 'mpesa') {
      const payoutCheck = checkSafaricomPhone(accountNumber);
      if (!payoutCheck.ok) {
        alert(`M-Pesa number: ${payoutCheck.message}`);
        return;
      }
    }

    try {
      setSavingPaymentInfo(true);
      
      await AgentService.setupPaymentAccount({
        businessName,
        settlementBank,
        bankCode: settlementBank === 'bank' ? bankCode : undefined,
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

  // Rent figures handed to the MyChama section (it never queries rental data itself).
  const rentPayments = payments.map((p) => ({
    amount: p.amount,
    status: p.status,
    date: (p.completedAt ?? p.initiatedAt)?.toDate ? (p.completedAt ?? p.initiatedAt).toDate() as Date : null,
  }));

  const totalRevenue = payments
    .filter(p => p.status === 'success')
    .reduce((sum, p) => sum + p.amount, 0);
  
  const successful = payments.filter(p => p.status === 'success');
  const totalFeesDeducted = successful.reduce((sum, p) => sum + (p.totalDeductions ?? 0), 0);
  const totalNetPayout = successful.reduce((sum, p) => sum + (p.netPayout ?? p.amount), 0);

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

  const paymentModes = [
    {
      id: 'mobile_money' as PaymentMode,
      name: 'M-Pesa',
      description: 'M-Pesa (Safaricom)',
      icon: Smartphone,
      color: 'bg-green-500',
      available: true
    },
    {
      id: 'bank' as PaymentMode,
      name: 'Bank Account',
      description: 'Direct bank transfer',
      icon: Building2,
      color: 'bg-blue-500',
      available: true
    },
    {
      id: 'till' as PaymentMode,
      name: 'Buy Goods (Till)',
      description: 'M-Pesa Till Number',
      icon: Banknote,
      color: 'bg-orange-500',
      available: true
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <BrandLogo variant="lockup" className="h-8 w-auto mb-2" />
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Agent Dashboard</h1>
              <p className="text-sm text-gray-600 mt-1">Welcome, {agentData?.name}</p>
              {agentData?.tier && (
                <span className="inline-block mt-1 px-2 py-1 text-xs font-semibold rounded-full bg-indigo-100 text-indigo-800">
                  {agentData.tier.toUpperCase()} Tier
                </span>
              )}
            </div>
            <div className="flex items-center space-x-2 sm:space-x-3">
              <button
                onClick={() => setShowTerminal(!showTerminal)}
                className="flex items-center space-x-2 px-3 sm:px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm"
              >
                <CreditCard className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline">Terminal</span>
              </button>
              <button
                onClick={() => setShowPaymentSettings(!showPaymentSettings)}
                className="flex items-center space-x-2 px-3 sm:px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Settings className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
              <button
                onClick={handleHelp}
                className="hidden sm:flex items-center space-x-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <HelpCircle className="w-5 h-5" />
                <span>Help</span>
              </button>
              <button
                onClick={handleSignOut}
                className="flex items-center space-x-2 px-3 sm:px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
        {showTerminal && (
          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 mb-6 sm:mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900">Payment Terminal</h2>
              <button
                onClick={() => setShowTerminal(false)}
                className="sm:hidden text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-gray-600 mb-4 text-sm sm:text-base">
              Enter tenant ID to process payment at the office
            </p>
            
            <div className="flex flex-col sm:flex-row items-stretch sm:items-end space-y-3 sm:space-y-0 sm:space-x-4">
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
                className="w-full sm:w-auto px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors flex items-center justify-center space-x-2"
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
          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 mb-6 sm:mb-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900">Payment Account Settings</h2>
              <button
                onClick={() => setShowPaymentSettings(false)}
                className="sm:hidden text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {agentData?.paymentInfo?.accountId ? (
              <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
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
                    <div className="mt-3 pt-3 border-t border-green-200">
                      <p className="text-green-900 font-semibold text-sm">Lipa Mos Mos</p>
                      {lmm?.status === 'active' ? (
                        <p className="text-green-700 text-sm">On. Tenants can pay rent a little at a time and you are paid by transfer to the account ending {lmm.last4}.</p>
                      ) : lmm?.status === 'unsupported' ? (
                        <p className="text-yellow-800 text-sm">Not available for this payout account{lmm.reason ? ` (${lmm.reason})` : ''}.</p>
                      ) : (
                        <p className="text-green-700 text-sm">Let tenants pay rent a little at a time. You are paid by transfer when it is covered, or on the 5th.</p>
                      )}
                      {lmm?.status !== 'active' && lmm?.status !== 'unsupported' && (
                        <button type="button" onClick={enableLmm} disabled={lmmBusy} className="mt-2 px-3 py-1.5 rounded-lg bg-green-600 text-white text-sm font-semibold disabled:opacity-50">{lmmBusy ? 'Please wait...' : 'Turn on Lipa Mos Mos'}</button>
                      )}
                      {lmmMsg && <p className="text-sm mt-1 text-green-800 break-words">{lmmMsg}</p>}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-yellow-800 text-sm">
                  No payment account configured. Setup your account details to receive payments via split settlement.
                </p>
              </div>
            )}

            <div className="mb-6">
              <h3 className="text-base font-semibold text-gray-900 mb-4">Select Payment Method</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {paymentModes.map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => setSelectedPaymentMode(mode.id)}
                    disabled={!mode.available}
                    className={`relative p-4 rounded-xl border-2 transition-all ${
                      selectedPaymentMode === mode.id
                        ? 'border-indigo-600 bg-indigo-50'
                        : 'border-gray-200 hover:border-gray-300 bg-white'
                    } ${!mode.available ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-start space-x-3">
                      <div className={`${mode.color} p-2 rounded-lg`}>
                        <mode.icon className="w-5 h-5 text-white" />
                      </div>
                      <div className="flex-1 text-left">
                        <p className="font-semibold text-gray-900 text-sm sm:text-base">{mode.name}</p>
                        <p className="text-xs sm:text-sm text-gray-600 mt-1">{mode.description}</p>
                      </div>
                      {selectedPaymentMode === mode.id && (
                        <CheckCircle className="w-5 h-5 text-indigo-600 flex-shrink-0" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Automatic setup: M-Pesa (Safaricom), Till or Bank */}
              <form onSubmit={handleSavePaymentInfo} className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                  <div className="flex items-start space-x-3">
                    <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-blue-900 font-semibold text-sm">Automated Setup Available</p>
                      <p className="text-blue-700 text-xs mt-1">
                        Your payout account is set up instantly. No WhatsApp or waiting needed.
                      </p>
                    </div>
                  </div>
                </div>

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

                <SettlementFields
                  settlementBank={settlementBank}
                  hideTypeSelect
                  bankCode={bankCode}
                  setBankCode={setBankCode}
                  accountNumber={accountNumber}
                  setAccountNumber={setAccountNumber}
                  loadBanks={AgentService.listKenyaBanks}
                />

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
                    inputMode="tel"
                    autoComplete="tel"
                    maxLength={PHONE_MAX_INPUT_LENGTH}
                    value={phone}
                    onChange={(e) => setPhone(sanitizePhoneInput(e.target.value))}
                    required
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                    placeholder="0712 345 678"
                  />
                  <p className="text-xs text-gray-500 mt-1">Safaricom numbers only (07xx or 01xx)</p>
                  {phoneHint(phone) && <p role="alert" className="mt-2 text-xs text-red-600 font-medium">{phoneHint(phone)}</p>}
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

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 mb-6 sm:mb-8">
          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs sm:text-sm font-medium text-gray-600">Total Revenue</h3>
              <DollarSign className="w-6 h-6 sm:w-8 sm:h-8 text-green-600" />
            </div>
            <p className="text-xl sm:text-2xl font-bold text-gray-900">{formatCurrency(totalRevenue)}</p>
            <p className="text-xs text-gray-500 mt-2">Collected from successful payments</p>
            <p className="text-xs text-gray-500">Fees deducted: {formatCurrency(totalFeesDeducted)}</p>
            <p className="text-xs font-semibold text-gray-700">Net payout: {formatCurrency(totalNetPayout)}</p>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs sm:text-sm font-medium text-gray-600">Outstanding</h3>
              <TrendingUp className="w-6 h-6 sm:w-8 sm:h-8 text-orange-600" />
            </div>
            <p className="text-xl sm:text-2xl font-bold text-gray-900">{formatCurrency(totalOutstanding)}</p>
            <p className="text-xs text-gray-500 mt-2">
              {invoices.filter(inv => !inv.isPaid).length} unpaid invoices
            </p>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs sm:text-sm font-medium text-gray-600">Total Invoices</h3>
              <Receipt className="w-6 h-6 sm:w-8 sm:h-8 text-indigo-600" />
            </div>
            <p className="text-xl sm:text-2xl font-bold text-gray-900">{invoices.length}</p>
            <p className="text-xs text-gray-500 mt-2">All time invoices</p>
          </div>
        </div>

        <ChamaSection role="landlord" rentPayments={rentPayments} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6 sm:mb-8">
          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6">
            <h3 className="text-base sm:text-lg font-bold text-gray-900 mb-4">Monthly Revenue</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" style={{ fontSize: '12px' }} />
                <YAxis style={{ fontSize: '12px' }} />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Bar dataKey="amount" fill="#4f46e5" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6">
            <h3 className="text-base sm:text-lg font-bold text-gray-900 mb-4">Invoice Status</h3>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={paymentStatusData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name}: ${value}`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {paymentStatusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: '12px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6">
          <h3 className="text-base sm:text-lg font-bold text-gray-900 mb-4">Recent Payments</h3>
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <div className="inline-block min-w-full align-middle">
              <table className="min-w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-700">Date</th>
                    <th className="text-left py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-700">Reference</th>
                    <th className="text-left py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-700 hidden sm:table-cell">Tenant</th>
                    <th className="text-left py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-700">Collected</th>
                    <th className="text-left py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-700">Fees</th>
                    <th className="text-left py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-700">Net payout</th>
                    <th className="text-left py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-700">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.slice(0, 10).map((payment) => (
                    <tr key={payment.reference} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-900">
                        {formatDate(payment.completedAt || payment.initiatedAt)}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-600 font-mono">
                        {payment.reference.substring(0, 8)}...
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-900 hidden sm:table-cell">
                        {payment.userName || 'N/A'}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-900">
                        {formatCurrency(payment.amount)}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-600">
                        {payment.totalDeductions != null ? `- ${formatCurrency(payment.totalDeductions)}` : '—'}
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-gray-900">
                        {payment.netPayout != null ? formatCurrency(payment.netPayout) : '—'}
                      </td>
                      <td className="py-3 px-3 sm:px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
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
            </div>
            
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