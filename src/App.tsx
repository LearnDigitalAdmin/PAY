// App.tsx - Main Application Component with Routing
import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthService } from './Firebase';
import Auth from './Auth';
import Signup from './Signup';
import AgentView from './AgentView';
import TenantView from './TenantView';
import Contact from './Contact';
import { Loader2 } from 'lucide-react';
import Welcome from './Welcome';
import FAQPage from './Faq';

// Protected Route Component
interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: 'agent' | 'tenant';
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requiredRole }) => {
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState<'agent' | 'tenant' | null>(null);

  useEffect(() => {
    // Check both Firebase Auth (for tenants) and localStorage (for agents)
    const checkAuth = () => {
      // Check for agent authentication in localStorage
      const agentUser = localStorage.getItem('agentAuthUser');
      if (agentUser) {
        try {
          const parsed = JSON.parse(agentUser);
          if (parsed.id && parsed.email) {
            setIsAuthenticated(true);
            setUserRole('agent');
            setLoading(false);
            return;
          }
        } catch (e) {
          console.error('Error parsing agent user:', e);
          localStorage.removeItem('agentAuthUser');
        }
      }

      // Check Firebase Auth for tenant authentication
      const unsubscribe = AuthService.onAuthChange((firebaseUser) => {
        if (firebaseUser) {
          setIsAuthenticated(true);
          setUserRole('tenant');
        } else {
          setIsAuthenticated(false);
          setUserRole(null);
        }
        setLoading(false);
      });

      return unsubscribe;
    };

    const unsubscribe = checkAuth();

    // Also listen for storage changes (in case user logs out in another tab)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'agentAuthUser') {
        if (!e.newValue) {
          // Agent logged out
          setIsAuthenticated(false);
          setUserRole(null);
        } else {
          // Agent logged in
          try {
            const parsed = JSON.parse(e.newValue);
            if (parsed.id && parsed.email) {
              setIsAuthenticated(true);
              setUserRole('agent');
            }
          } catch (err) {
            console.error('Error parsing storage change:', err);
          }
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      if (unsubscribe) unsubscribe();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  // If a specific role is required, check it
  if (requiredRole && userRole !== requiredRole) {
    // Redirect to correct dashboard based on actual role
    const redirectPath = userRole === 'agent' ? '/agent' : '/tenant';
    return <Navigate to={redirectPath} replace />;
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
  );
};


export default App;

