// Auth.tsx - Sign In Component
import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AuthService } from './Firebase';
import { Loader2, Phone, Hash, ArrowLeft } from 'lucide-react';

interface AuthProps {
  userType: 'agent' | 'tenant';
  onBack: () => void;
}

const Auth: React.FC<AuthProps> = ({ userType, onBack }) => {
  const navigate = useNavigate();
  const location = useLocation();
  
  const [phone, setPhone] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');

  useEffect(() => {
    // Initialize reCAPTCHA
    try {
      AuthService.initRecaptcha('recaptcha-container');
    } catch (error) {
      console.error('Failed to initialize reCAPTCHA:', error);
    }
  }, []);

  const formatPhoneNumber = (input: string): string => {
    // Remove all non-digit characters
    const digits = input.replace(/\D/g, '');
    
    // Handle Kenyan numbers
    if (digits.startsWith('254')) {
      return `+${digits}`;
    } else if (digits.startsWith('0')) {
      return `+254${digits.substring(1)}`;
    } else if (digits.startsWith('7') || digits.startsWith('1')) {
      return `+254${digits}`;
    }
    
    return `+${digits}`;
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (!phone || phone.length < 9) {
        throw new Error('Please enter a valid phone number');
      }

      const formattedPhone = formatPhoneNumber(phone);
      console.log('Sending verification code to:', formattedPhone);

      const result = await AuthService.sendVerificationCode(formattedPhone);
      setConfirmationResult(result);
      setStep('code');
      
    } catch (err: any) {
      console.error('Error sending code:', err);
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
      if (!verificationCode || verificationCode.length !== 6) {
        throw new Error('Please enter a valid 6-digit code');
      }

      if (!confirmationResult) {
        throw new Error('Please request a verification code first');
      }

      await AuthService.verifyCode(confirmationResult, verificationCode);
      
      // Navigate based on user type
      if (userType === 'agent') {
        navigate('/agent');
      } else {
        // Check if tenant account exists, if not redirect to signup completion
        const from = location.state?.from || '/tenant';
        navigate(from);
      }
      
    } catch (err: any) {
      console.error('Error verifying code:', err);
      setError('Invalid verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (step === 'code') {
      setStep('phone');
      setVerificationCode('');
      setError('');
    } else {
      onBack();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Header */}
          <div className="mb-8">
            <button
              onClick={handleBack}
              className="flex items-center text-gray-600 hover:text-gray-900 mb-4 transition-colors"
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              Back
            </button>
            
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              Sign In as {userType === 'agent' ? 'Agent' : 'Tenant'}
            </h1>
            <p className="text-gray-600">
              {step === 'phone' 
                ? 'Enter your phone number to receive a verification code' 
                : 'Enter the 6-digit code sent to your phone'}
            </p>
          </div>

          {/* Error Alert */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}

          {/* Phone Step */}
          {step === 'phone' && (
            <form onSubmit={handleSendCode} className="space-y-6">
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
                    placeholder="0712345678 or 254712345678"
                    className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={loading}
                    required
                  />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Enter your phone number in any format (07XX, 254, or +254)
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || !phone}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Sending Code...
                  </>
                ) : (
                  'Send Verification Code'
                )}
              </button>

              {userType === 'tenant' && (
                <div className="text-center mt-4">
                  <p className="text-sm text-gray-600">
                    Don't have an account?{' '}
                    <button
                      type="button"
                      onClick={() => navigate('/signup')}
                      className="text-blue-600 font-semibold hover:underline"
                    >
                      Sign Up
                    </button>
                  </p>
                </div>
              )}
            </form>
          )}

          {/* Code Verification Step */}
          {step === 'code' && (
            <form onSubmit={handleVerifyCode} className="space-y-6">
              <div>
                <label htmlFor="code" className="block text-sm font-medium text-gray-700 mb-2">
                  Verification Code
                </label>
                <div className="relative">
                  <Hash className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    id="code"
                    type="text"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center text-2xl tracking-widest"
                    disabled={loading}
                    required
                    autoFocus
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || verificationCode.length !== 6}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Verify & Sign In'
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setStep('phone');
                  setVerificationCode('');
                  setError('');
                }}
                className="w-full text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                Didn't receive code? Try again
              </button>
            </form>
          )}

          {/* reCAPTCHA Container */}
          <div id="recaptcha-container" className="mt-4"></div>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-600">
          <p>© 2024 Cogvana Payments. All rights reserved.</p>
          <div className="mt-2 space-x-4">
            <a href="/contact" className="hover:text-gray-900 transition-colors">Contact</a>
            <span>•</span>
            <a href="/terms" className="hover:text-gray-900 transition-colors">Terms</a>
            <span>•</span>
            <a href="/privacy" className="hover:text-gray-900 transition-colors">Privacy</a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Auth;