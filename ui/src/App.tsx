import React from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { BuildDetails } from './pages/BuildDetails';
import { Auth } from './pages/Auth';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};

const Header = () => {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10 shadow-sm">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-md flex items-center justify-center text-white font-bold text-sm">
            CBX
          </div>
          <span className="font-bold text-xl tracking-tight text-gray-900">
            CloudBuildX Dashboard
          </span>
        </Link>
        <div className="flex items-center gap-6 text-sm font-medium text-gray-500">
          <span className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            Node: Worker Cluster Active
          </span>
          {token && (
            <button 
              onClick={handleLogout}
              className="text-gray-600 hover:text-red-600 transition-colors"
            >
              Logout
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Header />

        {/* Main Content Body */}
        <main className="flex-grow py-8">
          <Routes>
            <Route path="/login" element={<Auth />} />
            <Route path="/" element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            } />
            <Route path="/builds/:buildId" element={
              <ProtectedRoute>
                <BuildDetails />
              </ProtectedRoute>
            } />
          </Routes>
        </main>

        {/* Footer */}
        <footer className="bg-white border-t border-gray-200 py-6 text-center text-sm text-gray-500">
          CloudBuildX CI Engine - Distributed Build Runner Platform
        </footer>
      </div>
    </BrowserRouter>
  );
};

export default App;
