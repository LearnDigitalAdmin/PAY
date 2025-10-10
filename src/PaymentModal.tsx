// PaymentModal.tsx - Payment Initiation Modal
import React, { useState, useEffect } from 'react';
import { X, Phone, DollarSign, AlertCircle, CheckCircle, Loader2, Info } from 'lucide-react';
import { PaymentService, type Invoice } from './Firebase';

interface PaymentModalProps {
  invoice: Invoice;
  onClose: () => void;
  onSuccess: () => void;
  initiatorRole: 'agent' | 'tenant';
}

const PaymentModal: React.FC<PaymentModalProps> = ({ 
  invoice, 
  onClose, 
  onSuccess}) => {
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState(invoice.totalAmount - invoice.amountPaid);
  const [paymentMethod, setPaymentMethod] = useState<'mpesa' | 'airtel_money'>('mpesa');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'idle' | 'processing' | 'success' | 'failed'>('idle');
  const [, setPaymentReference] = useState('');

  const fees = PaymentService.calculateFees(amount);

  useEffect(() => {
    // Pre-fill phone if available from invoice
    if (invoice.tenantName) {
      // You might want to store tenant phone in invoice or fetch it
      setPhone('');
    }
  }, [invoice]);

  const formatPhoneNumber = (input: string): string => {
    const digits = input.replace(/\D/g, '');
    
    if (digits.startsWith('254')) {
      return `+${digits}`;
    } else if (digits.startsWith('0')) {
      return `+254${digits.substring(1)}`;
    } else if (digits.startsWith('7') || digits.startsWith('1')) {
      return `+254${digits}`;
    }
    
    return `+${digits}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setStatus('processing');

    try {
      if (!phone || phone.length < 9) {
        throw new Error('Please enter a valid phone number');
      }

      if (amount <= 0) {
        throw new Error('Amount must be greater than zero');
      }

      if (amount > (invoice.totalAmount - invoice.amountPaid)) {
        throw new Error('Amount cannot exceed outstanding balance');
      }

      const formattedPhone = formatPhoneNumber(phone);

      const result = await PaymentService.initiatePayment({
        invoiceId: invoice.localId,
        tenantId: invoice.tenantId,
        agentUserId: invoice.agentUserId,
        amount,
        arrears: invoice.arrears,
        phone: formattedPhone,
        paymentMethod
      });

      setPaymentReference(result.reference);

      // Listen for payment status updates
      const unsubscribe = PaymentService.listenToPaymentStatus(
        result.reference,
        (payment) => {
          if (payment.status === 'success') {
            setStatus('success');
            setTimeout(() => {
              onSuccess();
              onClose();
            }, 2000);
          } else if (payment.status === 'failed') {
            setStatus('failed');
            setError(payment.paystackReference || 'Payment failed. Please try again.');
          }
        }
      );

      // Cleanup listener after 5 minutes
      setTimeout(() => {
        unsubscribe();
        if (status === 'processing') {
          setStatus('failed');
          setError('Payment timeout. Please check your payment history.');
        }
      }, 5 * 60 * 1000);

    } catch (err: any) {
      console.error('Payment error:', err);
      setError(err.message || 'Failed to initiate payment');
      setStatus('failed');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-KE', {
      style: 'currency',
      currency: 'KES',
      minimumFractionDigits: 2
    }).format(value);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900">Process Payment</h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Invoice Details */}
          <div className="bg-blue-50 rounded-lg p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Tenant:</span>
              <span className="font-semibold text-gray-900">{invoice.tenantName || 'N/A'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Property:</span>
              <span className="font-semibold text-gray-900">{invoice.propertyName || 'N/A'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Billing Month:</span>
              <span className="font-semibold text-gray-900">{invoice.billingMonth}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Total Amount:</span>
              <span className="font-bold text-gray-900">{formatCurrency(invoice.totalAmount)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Amount Paid:</span>
              <span className="font-semibold text-green-600">{formatCurrency(invoice.amountPaid)}</span>
            </div>
            <div className="flex justify-between text-sm border-t border-blue-200 pt-2">
              <span className="text-gray-900 font-semibold">Outstanding:</span>
              <span className="font-bold text-red-600">
                {formatCurrency(invoice.totalAmount - invoice.amountPaid)}
              </span>
            </div>
          </div>

          {/* Status Messages */}
          {status === 'processing' && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start space-x-3">
              <Loader2 className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-blue-900 font-semibold">Processing Payment</p>
                <p className="text-blue-700 text-sm mt-1">
                  Please check your phone and enter your M-Pesa PIN to complete the payment.
                </p>
              </div>
            </div>
          )}

          {status === 'success' && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start space-x-3">
              <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-green-900 font-semibold">Payment Successful!</p>
                <p className="text-green-700 text-sm mt-1">
                  Your payment has been processed successfully.
                </p>
              </div>
            </div>
          )}

          {error && status === 'failed' && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start space-x-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-red-900 font-semibold">Payment Failed</p>
                <p className="text-red-700 text-sm mt-1">{error}</p>
              </div>
            </div>
          )}

          {/* Payment Form */}
          {status === 'idle' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Payment Method */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Payment Method
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('mpesa')}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      paymentMethod === 'mpesa'
                        ? 'border-green-500 bg-green-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="text-center">
                      <div className="font-bold text-green-600">M-Pesa</div>
                      <div className="text-xs text-gray-600 mt-1">Safaricom</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('airtel_money')}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      paymentMethod === 'airtel_money'
                        ? 'border-red-500 bg-red-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="text-center">
                      <div className="font-bold text-red-600">Airtel Money</div>
                      <div className="text-xs text-gray-600 mt-1">Airtel</div>
                    </div>
                  </button>
                </div>
              </div>

              {/* Phone Number */}
              <div>
                <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-2">
                  Phone Number
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="0712345678"
                    className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>
              </div>

              {/* Amount */}
              <div>
                <label htmlFor="amount" className="block text-sm font-medium text-gray-700 mb-2">
                  Amount to Pay
                </label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    id="amount"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
                    min="1"
                    max={invoice.totalAmount - invoice.amountPaid}
                    step="0.01"
                    className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>
              </div>

              {/* Fee Breakdown */}
              <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex items-start space-x-2">
                  <Info className="w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-semibold text-gray-700 mb-2">Fee Breakdown:</div>
                    <div className="space-y-1 text-gray-600">
                      <div className="flex justify-between">
                        <span>Payment Amount:</span>
                        <span className="font-semibold">{formatCurrency(amount)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Paystack Fee (1.5% + KES 100):</span>
                        <span className="font-semibold">{formatCurrency(fees.paystackFee)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Platform Fee (1.5%):</span>
                        <span className="font-semibold">{formatCurrency(fees.platformFee)}</span>
                      </div>
                      <div className="flex justify-between border-t border-gray-300 pt-2 text-gray-900 font-bold">
                        <span>Total to Debit:</span>
                        <span>{formatCurrency(fees.total)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={loading || !phone || amount <= 0}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  `Pay ${formatCurrency(fees.total)}`
                )}
              </button>
            </form>
          )}

          {/* Close Button for Success/Failed States */}
          {(status === 'success' || status === 'failed') && (
            <button
              onClick={onClose}
              className="w-full bg-gray-600 text-white py-3 rounded-lg font-semibold hover:bg-gray-700 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PaymentModal;