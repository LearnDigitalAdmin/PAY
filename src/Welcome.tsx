// Welcome.tsx - Welcome Screen with Role Selection
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, User, CheckCircle, Phone, Mail } from 'lucide-react';

const Welcome: React.FC = () => {
  const navigate = useNavigate();
  const [selectedRole, setSelectedRole] = useState<'agent' | 'tenant' | null>(null);

  const handleContinue = () => {
    if (selectedRole) {
      navigate('/auth', { state: { userType: selectedRole } });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-100 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Welcome Card */}
        <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
          {/* Header Section */}
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-8 py-12 text-center">
            <div className="mb-6">
              <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mx-auto mb-4">
                <Building2 className="w-10 h-10 text-blue-600" />
              </div>
              <h1 className="text-4xl font-bold text-white mb-2">
                Welcome to Plot Yangu
              </h1>
              <p className="text-xl text-blue-100">
                Payments Portal
              </p>
            </div>
            
            {/* Payment Methods Info */}
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4 max-w-md mx-auto">
              <p className="text-white text-sm font-medium mb-3">
                We currently support mobile money payments:
              </p>
              <div className="flex items-center justify-center space-x-6">
                <div className="flex items-center space-x-2">
                  <Phone className="w-5 h-5 text-green-300" />
                  <span className="text-white font-semibold">M-PESA</span>
                </div>
                <div className="w-px h-6 bg-white/30"></div>
                <div className="flex items-center space-x-2">
                  <Phone className="w-5 h-5 text-red-300" />
                  <span className="text-white font-semibold">Airtel Money</span>
                </div>
              </div>
            </div>
          </div>

          {/* Role Selection Section */}
          <div className="px-8 py-12">
            <h2 className="text-2xl font-bold text-gray-900 text-center mb-3">
              Please Select Your Role
            </h2>
            <p className="text-gray-600 text-center mb-8">
              Choose your role to access the appropriate portal
            </p>

            {/* Role Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              {/* Agent/Landlord Card */}
              <button
                onClick={() => setSelectedRole('agent')}
                className={`relative p-8 rounded-2xl border-2 transition-all duration-300 hover:shadow-lg ${
                  selectedRole === 'agent'
                    ? 'border-blue-600 bg-blue-50 shadow-lg scale-105'
                    : 'border-gray-200 bg-white hover:border-blue-300'
                }`}
              >
                {selectedRole === 'agent' && (
                  <div className="absolute top-4 right-4">
                    <CheckCircle className="w-6 h-6 text-blue-600 fill-current" />
                  </div>
                )}
                
                <div className="text-center">
                  <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
                    selectedRole === 'agent' ? 'bg-blue-600' : 'bg-gray-100'
                  }`}>
                    <Building2 className={`w-8 h-8 ${
                      selectedRole === 'agent' ? 'text-white' : 'text-gray-600'
                    }`} />
                  </div>
                  
                  <h3 className={`text-xl font-bold mb-2 ${
                    selectedRole === 'agent' ? 'text-blue-900' : 'text-gray-900'
                  }`}>
                    Agent / Landlord
                  </h3>
                  
                  <p className="text-sm text-gray-600 mb-4">
                    Manage properties, tenants, and collect payments
                  </p>

                  <div className="flex items-center justify-center space-x-2 text-xs text-gray-500">
                    <Mail className="w-4 h-4" />
                    <span>Login with Email & Password</span>
                  </div>
                </div>
              </button>

              {/* Tenant Card */}
              <button
                onClick={() => setSelectedRole('tenant')}
                className={`relative p-8 rounded-2xl border-2 transition-all duration-300 hover:shadow-lg ${
                  selectedRole === 'tenant'
                    ? 'border-green-600 bg-green-50 shadow-lg scale-105'
                    : 'border-gray-200 bg-white hover:border-green-300'
                }`}
              >
                {selectedRole === 'tenant' && (
                  <div className="absolute top-4 right-4">
                    <CheckCircle className="w-6 h-6 text-green-600 fill-current" />
                  </div>
                )}
                
                <div className="text-center">
                  <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
                    selectedRole === 'tenant' ? 'bg-green-600' : 'bg-gray-100'
                  }`}>
                    <User className={`w-8 h-8 ${
                      selectedRole === 'tenant' ? 'text-white' : 'text-gray-600'
                    }`} />
                  </div>
                  
                  <h3 className={`text-xl font-bold mb-2 ${
                    selectedRole === 'tenant' ? 'text-green-900' : 'text-gray-900'
                  }`}>
                    Tenant
                  </h3>
                  
                  <p className="text-sm text-gray-600 mb-4">
                    View invoices, make payments, and track history
                  </p>

                  <div className="flex items-center justify-center space-x-2 text-xs text-gray-500">
                    <Phone className="w-4 h-4" />
                    <span>Login with Phone Number</span>
                  </div>
                </div>
              </button>
            </div>

            {/* Continue Button */}
            <button
              onClick={handleContinue}
              disabled={!selectedRole}
              className={`w-full py-4 rounded-xl font-semibold text-lg transition-all duration-300 ${
                selectedRole
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {selectedRole ? 'Continue to Login' : 'Please Select a Role'}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-600">
          <p>© 2024 Plot Yangu Payments. All rights reserved.</p>
          <div className="mt-3 space-x-4">
            <button
              onClick={() => navigate('/contact')}
              className="hover:text-gray-900 transition-colors"
            >
              Contact
            </button>
            <span>•</span>
            <a href="/terms" className="hover:text-gray-900 transition-colors">
              Terms
            </a>
            <span>•</span>
            <a href="/privacy" className="hover:text-gray-900 transition-colors">
              Privacy
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Welcome;