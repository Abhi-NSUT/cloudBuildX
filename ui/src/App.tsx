import React from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { BuildDetails } from './pages/BuildDetails';

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-gray-50">
        {/* Navigation Header */}
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
            <div className="flex items-center gap-4 text-sm font-medium text-gray-500">
              <span className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                Node: Worker Cluster Active
              </span>
            </div>
          </div>
        </header>

        {/* Main Content Body */}
        <main className="flex-grow py-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/builds/:buildId" element={<BuildDetails />} />
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
