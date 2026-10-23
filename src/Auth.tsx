// Auth.tsx - Sign In Component with Role-Based Authentication
import { checkSafaricomPhone, phoneHint, sanitizePhoneInput, PHONE_MAX_INPUT_LENGTH } from './utils/safaricom';
import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AuthService } from './Firebase';
import { useSession, setPortalPreference } from './session/session';
import BrandLogo from './theme/BrandLogo';
import { Loader2, Phone, Hash, ArrowLeft, Mail, Lock } from 'lucide-react';
// import { argon2Verify } from 'hash-wasm';

const Auth: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useSession();


//   const verifyHashedPass = async (password: string, hash: string): Promise<boolean> => {
//   try {
//       const result = await argon2Verify({
//         password: password,
//         hash: hash
//       });

//       return result === true;
//     } catch (error) {
//       console.error('Error verifying password:', error);
//       return false;
//     }
// };
  
  // Get userType from location state (passed from Welcome screen)
  const userType = (location.state as any)?.userType as 'agent' | 'tenant' | undefined;
  
  // Redirect back to welcome if no userType is provided
  useEffect(() => {
    if (!userType) {
      navigate('/', { replace: true });
    }
  }, [userType, navigate]);

  // Phone Authentication State (for Tenants)
  const [phone, setPhone] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<any>(null);
  const [phoneStep, setPhoneStep] = useState<'phone' | 'code'>('phone');

  // Agents (landlords) can sign in with email/password OR a phone code
  const [agentMethod, setAgentMethod] = useState<'email' | 'phone'>('email');
  const usesPhone = userType === 'tenant' || (userType === 'agent' && agentMethod === 'phone');

  // Email/Password Authentication State (for Agents)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Common State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Initialize reCAPTCHA only for tenant (phone) authentication
    if (usesPhone) {
      try {
        AuthService.initRecaptcha('recaptcha-container');
      } catch (error) {
        console.error('Failed to initialize reCAPTCHA:', error);
      }
    }
  }, [userType, usesPhone]);

  // Landlord sign-in is complete once Firebase Auth succeeded AND the server confirms (and claims) a
  // landlord account for this identity — the session layer asks the server, not localStorage.
  const finishAgentLogin = async () => {
    setPortalPreference('agent');
    const result = await refresh();
    if (result.role !== 'agent') {
      await AuthService.signOut();
      throw new Error(result.message || 'No landlord account is linked to this sign-in. Please contact your administrator.');
    }
    navigate('/agent');
  };

  // TENANT AUTHENTICATION - Phone Number
  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const phoneCheck = checkSafaricomPhone(phone);
      if (!phoneCheck.ok) throw new Error(phoneCheck.message);

      const formattedPhone = phoneCheck.e164;
      console.log('Sending verification code to:', formattedPhone);

      const result = await AuthService.sendVerificationCode(formattedPhone);
      setConfirmationResult(result);
      setPhoneStep('code');
      
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

      if (userType === 'agent') {
        await finishAgentLogin();
        return;
      }

      // Resolve the session BEFORE navigating (same as the landlord flow), so /tenant never renders
      // while the session still says "signedOut".
      setPortalPreference('tenant');
      const result = await refresh();
      if (result.role !== 'tenant') {
        throw new Error(result.message || 'We could not load your tenant profile. Please try again.');
      }
      const from = location.state?.from || '/tenant';
      navigate(from);

    } catch (err: any) {
      console.error('Error verifying code:', err);
      setError(err?.message && err.message !== 'Invalid verification code' ? err.message : 'Invalid verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // AGENT AUTHENTICATION - Email/Password - CHANGE TO USE THE HASH VERIFICATION METHOD
  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (!email || !password) {
        throw new Error('Please enter your email and password');
      }

      if (password.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }

      await AuthService.signInWithEmailPassword(email, password);
      await finishAgentLogin();
      
    } catch (err: any) {
      console.error('Error signing in:', err);
      
      // Provide user-friendly error messages
      let errorMessage = 'Failed to sign in. Please check your credentials.';
      
      if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        errorMessage = 'No account found with this email. Please contact your administrator.';
      } else if (err.code === 'auth/wrong-password') {
        errorMessage = 'Incorrect password. Please try again.';
      } else if (err.code === 'auth/invalid-email') {
        errorMessage = 'Invalid email address format.';
      } else if (err.code === 'auth/too-many-requests') {
        errorMessage = 'Too many failed attempts. Please try again later.';
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

//   const handleEmailPasswordLogin = async (e: React.FormEvent) => {
//   e.preventDefault();
//   setError('');
//   setLoading(true);

//   try {
//     if (!email || !password) {
//       throw new Error('Please enter your email and password');
//     }

//     // Find agent by email
//     const usersRef = collection(db, 'users');
//     const q = query(usersRef, where('email', '==', email.trim()));
//     const snapshot = await getDocs(q);

//     if (snapshot.empty) {
//       throw new Error('No account found with this email. Please contact your administrator.');
//     }

//     const userDoc = snapshot.docs[0];
//     const userData = userDoc.data();

//     // Verify hashed password
//     const passwordMatch = await verifyHashedPass(password, userData.passwordHash);

//     if (!passwordMatch) {
//       throw new Error('Incorrect password. Please try again.');
//     }

//     // Optional: Check access level / role
//     if (userData.type !== 'paid') {
//       throw new Error('Access restricted to agent accounts.');
//     }

//     // Save session
//     const agentUser = {
//       id: userDoc.id,
//       email: userData.email,
//       name: userData.name || '',
//       type: userData.type,
//       tier: userData.tier || '',
//     };

//     localStorage.setItem('agentAuthUser', JSON.stringify(agentUser));
//     //setIsAuthenticated(true);

//     // Navigate to agent dashboard
//     navigate('/agent');

//   } catch (err: any) {
//     console.error('Error signing in:', err);

//     let message = err.message || 'Failed to sign in. Please check your credentials.';

//     if (message.includes('user-not-found')) {
//       message = 'No account found with this email. Please contact your administrator.';
//     } else if (message.includes('password')) {
//       message = 'Incorrect password. Please try again.';
//     }

//     setError(message);
//   } finally {
//     setLoading(false);
//   }
// };

  const handleBack = () => {
    if (usesPhone && phoneStep === 'code') {
      setPhoneStep('phone');
      setVerificationCode('');
      setError('');
    } else {
      navigate('/');
    }
  };

  // Don't render if no userType
  if (!userType) {
    return null;
  }

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
            
            <BrandLogo variant="lockup" className="h-9 w-auto mb-4" />
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              Sign In as {userType === 'agent' ? 'Agent/Landlord' : 'Tenant'}
            </h1>
            <p className="text-gray-600">
              {userType === 'agent' && agentMethod === 'email'
                ? 'Enter your email and password to access your dashboard'
                : phoneStep === 'phone' 
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

          {userType === 'agent' && phoneStep === 'phone' && (
            <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-gray-100 p-1">
              {(['email', 'phone'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setAgentMethod(m); setError(''); }}
                  className={`rounded-md py-2 text-sm font-semibold transition-colors ${agentMethod === m ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  {m === 'email' ? 'Email & password' : 'Phone code'}
                </button>
              ))}
            </div>
          )}

          {/* AGENT LOGIN - Email/Password */}
          {userType === 'agent' && agentMethod === 'email' && (
            <form onSubmit={handleEmailPasswordLogin} className="space-y-6">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your.email@example.com"
                    className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={loading}
                    required
                    autoComplete="email"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={loading}
                    required
                    autoComplete="current-password"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !email || !password}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Signing In...
                  </>
                ) : (
                  'Sign In'
                )}
              </button>

              <div className="text-center">
                <p className="text-sm text-gray-600">
                  Agent/Landlord accounts are created by administrators.
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  Contact support if you need access.
                </p>
              </div>
            </form>
          )}

          {/* TENANT LOGIN - Phone Authentication */}
          {usesPhone && (
            <>
              {/* Phone Step */}
              {phoneStep === 'phone' && (
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
                        inputMode="tel"
                        autoComplete="tel"
                        maxLength={PHONE_MAX_INPUT_LENGTH}
                        value={phone}
                        onChange={(e) => setPhone(sanitizePhoneInput(e.target.value))}
                        placeholder="0712 345 678"
                        className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        disabled={loading}
                        required
                      />
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                      Safaricom numbers only — 07XX, 01XX, 254… or +254…
                    </p>
                    {phoneHint(phone) && <p role="alert" className="mt-2 text-xs text-red-600 font-medium">{phoneHint(phone)}</p>}
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !checkSafaricomPhone(phone).ok}
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
                </form>
              )}

              {/* Code Verification Step */}
              {phoneStep === 'code' && (
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
                      setPhoneStep('phone');
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
            </>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-600">
          <p>© 2026 Samuhia Payments. All rights reserved.</p>
          <div className="mt-2 space-x-4">
            <button
              onClick={() => navigate('/contact')}
              className="hover:text-gray-900 transition-colors"
            >
              Contact
            </button>
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