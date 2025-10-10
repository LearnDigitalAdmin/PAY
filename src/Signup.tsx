// Signup.tsx - Tenant Signup Component
import React, { useState, useEffect } from 'react';
import { Phone, Mail, User, CreditCard, Lock, AlertCircle, Loader2, CheckCircle } from 'lucide-react';
import { AuthService, TenantService } from './Firebase';
import { useNavigate } from 'react-router-dom';

const Signup: React.FC = () => {
  const [step, setStep] = useState<'info' | 'phone' | 'code'>('info');
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    idNumber: '',
    acceptedTerms: false
  });
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [, setConfirmationResult] = useState<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    AuthService.initRecaptcha('recaptcha-container');
  }, []);

  const formatPhoneNumber = (input: string): string => {
    const digits = input.replace(/\D/g, '');
    
    if (digits.startsWith('254')) {
      return `+${digits}`;
    } else if (digits.startsWith('0')) {
      return `+254${digits.slice(1)}`;
    } else if (digits.length === 9) {
      return `+254${digits}`;
    }
    
    return `+${digits}`;
  };

  const handleInfoSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!formData.acceptedTerms) {
      setError('Please accept the Terms and Conditions');
      return;
    }

    setStep('phone');
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const formattedPhone = formatPhoneNumber(formData.phone);
      const result = await AuthService.sendVerificationCode(formattedPhone);
      setConfirmationResult(result);
      setStep('code');
    } catch (err: any) {
      setError(err.message || 'Failed to send verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      //const user = await AuthService.verifyCode(confirmationResult, code);
      
      // Create tenant account
      await TenantService.createTenant({
        phone: formatPhoneNumber(formData.phone),
        email: formData.email,
        fullName: formData.fullName,
        idNumber: formData.idNumber
      });

      navigate('/tenant');
    } catch (err: any) {
      setError(err.message || 'Failed to create account. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Create Tenant Account</h1>
          <p className="text-gray-600">Sign up to manage your rent payments</p>
        </div>

        {/* Progress Indicator */}
        <div className="flex items-center justify-center mb-8 gap-2">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step === 'info' ? 'bg-blue-600 text-white' : 'bg-green-600 text-white'}`}>
            {step === 'info' ? '1' : <CheckCircle className="w-5 h-5" />}
          </div>
          <div className={`w-12 h-1 ${step !== 'info' ? 'bg-blue-600' : 'bg-gray-300'}`}></div>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step === 'phone' ? 'bg-blue-600 text-white' : step === 'code' ? 'bg-green-600 text-white' : 'bg-gray-300 text-gray-600'}`}>
            {step === 'code' ? <CheckCircle className="w-5 h-5" /> : '2'}
          </div>
          <div className={`w-12 h-1 ${step === 'code' ? 'bg-blue-600' : 'bg-gray-300'}`}></div>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step === 'code' ? 'bg-blue-600 text-white' : 'bg-gray-300 text-gray-600'}`}>
            3
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {step === 'info' && (
          <form onSubmit={handleInfoSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Full Name</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  value={formData.fullName}
                  onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                  placeholder="John Doe"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@example.com"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">ID Number</label>
              <div className="relative">
                <CreditCard className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  value={formData.idNumber}
                  onChange={(e) => setFormData({ ...formData, idNumber: e.target.value })}
                  placeholder="12345678"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
            </div>

            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="terms"
                checked={formData.acceptedTerms}
                onChange={(e) => setFormData({ ...formData, acceptedTerms: e.target.checked })}
                className="mt-1 w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                required
              />
              <label htmlFor="terms" className="text-sm text-gray-600">
                I accept the{' '}
                <a href="/terms" className="text-blue-600 hover:text-blue-800">Terms and Conditions</a>
                {' '}and{' '}
                <a href="/privacy" className="text-blue-600 hover:text-blue-800">Privacy Policy</a>
              </label>
            </div>

            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors"
            >
              Continue
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => navigate('/auth?type=tenant')}
                className="text-blue-600 hover:text-blue-800 text-sm font-medium"
              >
                Already have an account? Sign in
              </button>
            </div>
          </form>
        )}

        {step === 'phone' && (
          <form onSubmit={handleSendCode} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Phone Number</label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="0712345678 or 254712345678"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
              <p className="mt-2 text-xs text-gray-500">Enter your Kenyan phone number</p>
            </div>

            <button
              type="submit"
              disabled={loading || !formData.phone}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Sending Code...
                </>
              ) : (
                'Send Verification Code'
              )}
            </button>

            <button
              type="button"
              onClick={() => setStep('info')}
              className="w-full text-gray-600 hover:text-gray-800 text-sm"
            >
              Back
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleVerifyCode} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Verification Code</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="Enter 6-digit code"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center text-2xl tracking-widest"
                  maxLength={6}
                  required
                />
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Enter the 6-digit code sent to {formData.phone}
              </p>
            </div>

            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Creating Account...
                </>
              ) : (
                'Verify & Create Account'
              )}
            </button>

            <button
              type="button"
              onClick={() => setStep('phone')}
              className="w-full text-gray-600 hover:text-gray-800 text-sm"
            >
              Back
            </button>
          </form>
        )}

        <div id="recaptcha-container"></div>
      </div>
    </div>
  );
};

export default Signup;