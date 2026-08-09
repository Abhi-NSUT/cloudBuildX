import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { TerminalViewer } from '../components/TerminalViewer';

interface BuildDetail {
  id: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  workerNode?: string;
  repository: {
    name: string;
    githubUrl: string;
  };
}

export const BuildDetails: React.FC = () => {
  const { buildId } = useParams<{ buildId: string }>();
  const [build, setBuild] = useState<BuildDetail | null>(null);
  const [streamStatus, setStreamStatus] = useState('CONNECTING');
  const [isCancelable, setIsCancelable] = useState(true);

  // Disable cancellation after 15 seconds
  useEffect(() => {
    if (!build?.createdAt) return;
    
    const checkCancelable = () => {
      const createdTime = new Date(build.createdAt).getTime();
      if (Date.now() - createdTime > 15000) {
        setIsCancelable(false);
      } else {
        setIsCancelable(true);
      }
    };

    checkCancelable();
    const interval = setInterval(checkCancelable, 1000);
    return () => clearInterval(interval);
  }, [build?.createdAt]);

  const handleDownloadArtifact = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:3000/api/builds/${buildId}/artifact`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      window.location.href = res.data.url;
    } catch (err) {
      alert('Artifact not found or expired.');
    }
  };

  const handleCancelBuild = async () => {
    try {
      const token = localStorage.getItem('token');
      await axios.post(`http://localhost:3000/api/builds/${buildId}/cancel`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      // We don't need to manually update state here because the WebSocket will 
      // broadcast the cancellation and the UI will update dynamically!
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to cancel build.');
      console.error(err);
    }
  };

  useEffect(() => {
    const fetchDetails = async () => {
      if (!buildId) return;
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get(`http://localhost:3000/api/builds/${buildId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setBuild(res.data);
      } catch (err) {
        console.error('Failed to fetch build details:', err);
      }
    };

    fetchDetails();
  }, [buildId]);

  if (!buildId) return <div className="p-8 text-center text-red-500">Invalid Build Identifier.</div>;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <Link to="/" className="text-gray-500 hover:text-gray-800 font-medium flex items-center gap-2">
          ← Back to History
        </Link>
        <div className="text-sm font-mono bg-gray-100 px-3 py-1 rounded text-gray-700">
          Pipeline Stream State: <span className={streamStatus === 'STREAMING' ? 'text-green-600' : 'text-orange-500'}>{streamStatus}</span>
        </div>
      </div>

      {/* Details Bar */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 grid grid-cols-6 gap-6">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Build ID</div>
          <div className="font-mono text-sm text-gray-800">{buildId}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Repository</div>
          <div className="font-medium text-gray-800">{build?.repository.name || 'Loading...'}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Source URL</div>
          <div className="text-sm text-blue-600 truncate">
            <a href={build?.repository.githubUrl} target="_blank" rel="noreferrer">
              {build?.repository.githubUrl || 'N/A'}
            </a>
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Status</div>
          <div className="font-medium">
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              build?.status === 'SUCCESS' ? 'bg-green-100 text-green-800' :
              build?.status === 'FAILED' ? 'bg-red-100 text-red-800' :
              build?.status === 'RUNNING' ? 'bg-blue-100 text-blue-800' :
              'bg-gray-100 text-gray-800'
            }`}>
              {build?.status || 'UNKNOWN'}
            </span>
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Execution Node</div>
          <div className="font-mono text-sm text-gray-800">
            {build?.workerNode || 'Queued...'}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Actions</div>
          <div className="font-medium">
            {build?.status === 'SUCCESS' ? (
              <button onClick={handleDownloadArtifact} className="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded shadow">
                Download .ZIP
              </button>
            ) : build?.status === 'RUNNING' || build?.status === 'QUEUED' ? (
              <button 
                onClick={handleCancelBuild} 
                disabled={!isCancelable}
                title={!isCancelable ? "Cancellation is only allowed within the first 15 seconds" : "Cancel Build"}
                className={`text-sm px-3 py-1 rounded shadow flex items-center gap-1 transition-colors text-white ${
                  isCancelable 
                    ? 'bg-red-500 hover:bg-red-600' 
                    : 'bg-gray-400 cursor-not-allowed opacity-70'
                }`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
                </svg>
                Stop Build
              </button>
            ) : (
              <span className="text-sm text-gray-400">No actions available</span>
            )}
          </div>
        </div>
      </div>

      {/* Terminal Console Component Container */}
      <div className="bg-[#0d1117] rounded-xl shadow-2xl border border-gray-800 overflow-hidden flex flex-col" style={{ height: '600px' }}>
        <div className="bg-gray-900 px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
          </div>
          <div className="text-gray-400 text-xs font-mono ml-4 flex-grow text-center">console output - bash</div>
        </div>
        <div className="flex-grow relative p-2">
          {build && (
            <TerminalViewer 
              buildId={buildId} 
              initialStatus={build.status} 
              onStatusChange={setStreamStatus}
              onBuildComplete={(newStatus) => setBuild(prev => prev ? { ...prev, status: newStatus } : prev)}
            />
          )}
        </div>
      </div>
    </div>
  );
};
