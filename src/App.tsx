// App.tsx - Main Application Component with Routing
import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SessionProvider } from './session/SessionProvider';
import { useSession } from './session/session';
import { ChamaConnectorProvider } from './mychama/ChamaConnectorProvider';
import Auth from './Auth';
import Signup from './Signup';
import AgentView from './AgentView';
import TenantView from './TenantView';
import Contact from './Contact';
import { Loader2 } from 'lucide-react';
import Welcome from './Welcome';
import FAQPage from './Faq';

// Protected Route Component — role comes from the verified session (Firebase Auth + server claims),
// not from localStorage.
interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: 'agent' | 'tenant';
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requiredRole }) => {
  const session = useSession();

  if (session.status === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (session.status === 'signedOut' || !session.role) {
    return <Navigate to="/" replace />;
  }

  // If a specific role is required, check it
  if (requiredRole && session.role !== requiredRole) {
    // Redirect to correct dashboard based on actual role
    return <Navigate to={session.role === 'agent' ? '/agent' : '/tenant'} replace />;
  }

  return <>{children}</>;
};

// Main App Component
const App: React.FC = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <SessionProvider>
    <ChamaConnectorProvider>
    <Router>
      {/* Offline Indicator */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 bg-yellow-500 text-white text-center py-2 z-50 text-sm font-medium">
          You are currently offline. Some features may not be available.
        </div>
      )}

      <Routes>
        {/* Public Routes */}
        <Route path="/" element={<Welcome />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/faq" element={<FAQPage />} />
        <Route path="/contact" element={<Contact />} />

        {/* Protected Routes */}
        <Route
          path="/agent"
          element={
            <ProtectedRoute requiredRole="agent">
              <AgentView />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tenant"
          element={
            <ProtectedRoute requiredRole="tenant">
              <TenantView />
            </ProtectedRoute>
          }
        />

        {/* 404 Route */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
    </ChamaConnectorProvider>
    </SessionProvider>
  );
};


export default App;

