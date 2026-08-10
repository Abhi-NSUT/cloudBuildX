import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';

interface Build {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  createdAt: string;
  repository: {
    name: string;
    githubUrl: string;
  };
}

export const Dashboard: React.FC = () => {
  const [builds, setBuilds] = useState<Build[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [meta, setMeta] = useState<any>(null);
  const navigate = useNavigate();

  const fetchBuilds = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      
      const params = new URLSearchParams({ page: page.toString(), limit: '10' });
      if (statusFilter) params.append('status', statusFilter);

      const res = await axios.get(`http://localhost:3000/api/builds?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setBuilds(res.data.data);
      setMeta(res.data.meta);
    } catch (err) {
      console.error('Error fetching build history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBuilds();
  }, [page, statusFilter]);

  const handleTriggerBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repositoryId) return;

    setTriggering(true);
    try {
      const token = localStorage.getItem('token');
      const res = await axios.post(
        'http://localhost:3000/api/builds',
        { repositoryId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      navigate(`/builds/${res.data.buildId}`);
    } catch (err) {
      console.error('Failed to trigger build:', err);
      alert('Failed to trigger build. Verify repository ID.');
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      {/* Action Header */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-bold text-gray-800 mb-4">Trigger New Build</h2>
        <form onSubmit={handleTriggerBuild} className="flex gap-4">
          <input
            type="text"
            placeholder="Repository ID (e.g., repo_123456)"
            value={repositoryId}
            onChange={(e) => setRepositoryId(e.target.value)}
            className="flex-grow px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
            required
          />
          <button
            type="submit"
            disabled={triggering}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors disabled:opacity-50"
          >
            {triggering ? 'Queuing...' : 'Queue Build'}
          </button>
        </form>
      </div>

      {/* Build Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
          <h2 className="text-lg font-bold text-gray-800">Recent Build Executions</h2>
          <div className="flex items-center gap-4">
            <select 
              value={statusFilter} 
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Statuses</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILED">Failed</option>
              <option value="PENDING">Pending</option>
              <option value="RUNNING">Running</option>
            </select>
            <button onClick={fetchBuilds} className="text-sm text-blue-600 hover:text-blue-800 transition-colors">
              Refresh Table
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading pipeline records...</div>
        ) : builds.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No build records found. Trigger your first build above.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wider">
                  <th className="px-6 py-4 font-semibold">Build ID</th>
                  <th className="px-6 py-4 font-semibold">Repository</th>
                  <th className="px-6 py-4 font-semibold">Status</th>
                  <th className="px-6 py-4 font-semibold">Triggered At</th>
                  <th className="px-6 py-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {builds.map((build) => (
                  <tr key={build.id} className="hover:bg-blue-50/30 transition-colors">
                    <td className="px-6 py-4 font-mono text-sm text-gray-600">{build.id.substring(0, 8)}...</td>
                    <td className="px-6 py-4 font-medium text-gray-800">{build.repository.name}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        build.status === 'SUCCESS' ? 'bg-green-100 text-green-800' :
                        build.status === 'FAILED' ? 'bg-red-100 text-red-800' :
                        build.status === 'RUNNING' ? 'bg-blue-100 text-blue-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {build.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {new Date(build.createdAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link to={`/builds/${build.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-900 bg-blue-50 px-3 py-1 rounded hover:bg-blue-100 transition-colors">
                        View Logs →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Controls */}
        {meta && meta.totalPages > 1 && (
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-between items-center">
            <span className="text-sm text-gray-600">
              Showing page {meta.page} of {meta.totalPages} ({meta.total} total builds)
            </span>
            <div className="flex gap-2">
              <button 
                disabled={!meta.hasPreviousPage}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100 transition-colors font-medium text-gray-700"
              >
                Previous
              </button>
              <button 
                disabled={!meta.hasNextPage}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100 transition-colors font-medium text-gray-700"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
