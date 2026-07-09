'use client';

import { useState, useEffect } from 'react';
import { useAuth } from './auth-context';
import { useRouter } from 'next/navigation';

interface ExperimentRun {
  id: string;
  experiment_date: string;
  status: string;
  qualified_count?: number;
}

interface TwitterAccount {
  id: string;
  status: string;
  daily_comment_count: number;
  max_daily_comments: number;
  can_comment?: boolean;
}

export default function HomePage() {
  const { isAuthenticated, login, userName, userId, token } = useAuth();
  const [tokenInput, setTokenInput] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [error, setError] = useState('');
  const [createMode, setCreateMode] = useState(false);
  const router = useRouter();

  // Dashboard real-time data
  const [stats, setStats] = useState({ running: 0, total: 0, activeAccounts: 0, totalAccounts: 0, usedComments: 0, maxComments: 0, commentableAccounts: 0 });
  useEffect(() => {
    if (!isAuthenticated) return;
    Promise.all([
      fetch('/api/experiment', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch('/api/accounts', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([expData, accData]) => {
      const exps: ExperimentRun[] = expData.experiments || [];
      const accounts: TwitterAccount[] = accData.accounts || [];
      const active = accounts.filter(a => a.status === 'active');
      setStats({
        running: exps.filter(e => e.status === 'running').length,
        total: exps.length,
        activeAccounts: active.length,
        totalAccounts: accounts.length,
        usedComments: active.reduce((s, a) => s + (a.daily_comment_count || 0), 0),
        maxComments: active.reduce((s, a) => s + (a.max_daily_comments || 0), 0),
        commentableAccounts: active.filter(a => a.can_comment !== false).length,
      });
    }).catch(() => {});
  }, [isAuthenticated, token]);

  const handleTokenLogin = async () => {
    setError('');
    if (!tokenInput.trim()) {
      setError('Please enter a token');
      return;
    }
    const ok = await login(tokenInput.trim());
    if (!ok) {
      setError('Invalid token, please check and try again');
    }
  };

  const handleCreateUser = async () => {
    setError('');
    if (!newUserName.trim() || newUserName.trim().length < 2) {
      setError('Username must be at least 2 characters');
      return;
    }

    const resp = await fetch('/api/auth/check', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName.trim() }),
    });

    const data = await resp.json();
    if (data.success && data.user) {
      await login(data.user.token);
    } else {
      setError(data.error || 'Failed to create user');
    }
  };

  if (!isAuthenticated) {
    // Login page
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8">
          <h1 className="text-2xl font-bold text-center mb-2">Twitter AI Comment Experiment Platform</h1>
          <p className="text-gray-500 text-center mb-6 text-sm">Social media AI comment interaction experiment</p>

          {!createMode ? (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-1">Experiment Token</label>
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Enter your experiment token"
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 mb-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                onKeyDown={(e) => e.key === 'Enter' && handleTokenLogin()}
              />
              {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
              <button
                onClick={handleTokenLogin}
                className="w-full bg-blue-600 text-white rounded-lg py-2.5 font-medium hover:bg-blue-700 transition"
              >
                Login
              </button>
              <p className="text-center mt-4 text-sm text-gray-500">
                No token?
                <button
                  onClick={() => { setCreateMode(true); setError(''); }}
                  className="text-blue-600 hover:underline ml-1"
                >
                  Create New User
                </button>
              </p>
            </>
          ) : (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-1">New Username</label>
              <input
                type="text"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="Enter username (e.g. Experimenter A)"
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 mb-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateUser()}
              />
              {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
              <button
                onClick={handleCreateUser}
                className="w-full bg-green-600 text-white rounded-lg py-2.5 font-medium hover:bg-green-700 transition mb-2"
              >
                Create & Login
              </button>
              <button
                onClick={() => { setCreateMode(false); setError(''); }}
                className="w-full text-gray-500 text-sm hover:underline"
              >
                Back to Token Login
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // Dashboard
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Experiment Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <DashboardCard title="Running Experiments" value={String(stats.running)} subtitle={`Total ${stats.total} experiments`} color="blue" />
        <DashboardCard title="Active Accounts" value={`${stats.activeAccounts}/${stats.totalAccounts}`} subtitle={`Commentable ${stats.commentableAccounts}`} color="green" />
        <DashboardCard title="Daily Comment Quota" value={`${stats.usedComments}/${stats.maxComments}`} subtitle="Used / Total" color="purple" />
        <DashboardCard title="Current Time" value={new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} subtitle={new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', weekday: 'short' })} color="blue" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Quick Actions</h2>
          <div className="space-y-3">
            <button
              onClick={() => router.push('/accounts')}
              className="w-full text-left px-4 py-3 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition"
            >
              Manage Twitter Accounts → Add OAuth credentials
            </button>
            <button
              onClick={() => router.push('/experiment')}
              className="w-full text-left px-4 py-3 bg-green-50 text-green-700 rounded-lg hover:bg-green-100 transition"
            >
              Create New Experiment → Screen tweets and group
            </button>
            <button
              onClick={() => router.push('/data')}
              className="w-full text-left px-4 py-3 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 transition"
            >
              View Experiment Data → Four data tables
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Experiment Rules</h2>
          <div className="space-y-2 text-sm text-gray-600">
            <p>- Groups: Control / Low-signal / High-signal, 1:1:1 random assignment</p>
            <p>- Collection batches: 16:00 / 18:00 / 20:00 incremental pool</p>
            <p>- Comments: Daily at 20:00 New York time (EST/EDT), permission check at 19:30</p>
            <p>- Monitoring: t0 / t2h / t4h / t8h / t12h / t24h / t48h / t72h</p>
            <p>- Multi-account rotation + dual-account retry, anti-rate-limit</p>
            <p>- Comments use preset templates only</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardCard({
  title,
  value,
  subtitle,
  color,
}: {
  title: string;
  value: string;
  subtitle: string;
  color: 'blue' | 'green' | 'purple';
}) {
  const colors = {
    blue: 'bg-blue-50 border-blue-200',
    green: 'bg-green-50 border-green-200',
    purple: 'bg-purple-50 border-purple-200',
  };

  return (
    <div className={`rounded-xl border p-5 ${colors[color]}`}>
      <h3 className="text-sm font-medium text-gray-600">{title}</h3>
      <p className="text-3xl font-bold mt-1">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}
