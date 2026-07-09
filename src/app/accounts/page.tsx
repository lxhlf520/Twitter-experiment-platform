'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth-context';

interface TwitterAccount {
  id: number;
  twitter_handle: string;
  nickname: string;
  avatar: string;
  api_key: string;
  api_secret: string;
  access_token: string;
  access_token_secret: string;
  status: string;
  daily_comment_count: number;
  max_daily_comments: number;
  last_used_at: string | null;
  created_at: string;
  can_comment?: boolean;
  comment_checked_at?: string;
  comment_ban_reason?: string;
}

export default function AccountsPage() {
  const { token, isAuthenticated } = useAuth();
  const [accounts, setAccounts] = useState<TwitterAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add account form
  const [showAddModal, setShowAddModal] = useState(false);
  const [formNickname, setFormNickname] = useState('');
  const [formHandle, setFormHandle] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formApiSecret, setFormApiSecret] = useState('');
  const [formAccessToken, setFormAccessToken] = useState('');
  const [formAccessSecret, setFormAccessSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchAccounts = useCallback(async () => {
    try {
      const resp = await fetch('/api/accounts', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (data.accounts) setAccounts(data.accounts);
    } catch {
      setError('Failed to fetch accounts');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isAuthenticated) fetchAccounts();
  }, [isAuthenticated, fetchAccounts]);

  const addAccount = async () => {
    if (!formApiKey || !formApiSecret || !formAccessToken || !formAccessSecret || !formHandle) {
      setError('All OAuth credential fields are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const resp = await fetch('/api/accounts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          nickname: formNickname || formHandle,
          twitter_handle: formHandle,
          api_key: formApiKey,
          api_secret: formApiSecret,
          access_token: formAccessToken,
          access_token_secret: formAccessSecret,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setShowAddModal(false);
        resetForm();
        fetchAccounts();
      } else {
        setError(data.error || 'Failed to add account');
      }
    } catch {
      setError('Network error');
    }
    setSaving(false);
  };

  const resetForm = () => {
    setFormNickname('');
    setFormHandle('');
    setFormApiKey('');
    setFormApiSecret('');
    setFormAccessToken('');
    setFormAccessSecret('');
  };

  const deleteAccount = async (id: number) => {
    if (!confirm('Delete this account?')) return;
    await fetch('/api/accounts', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id }),
    });
    fetchAccounts();
  };

  const toggleCanComment = async (acc: TwitterAccount) => {
    const newVal = acc.can_comment === false ? true : false;
    await fetch('/api/accounts', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id: acc.id, can_comment: newVal }),
    });
    fetchAccounts();
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-100 text-green-700';
      case 'expired': return 'bg-yellow-100 text-yellow-700';
      case 'banned': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const formatTime = (iso: string | null | undefined): string => {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  if (!isAuthenticated) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Twitter Account Management</h1>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setShowAddModal(true);
              setError('');
              resetForm();
            }}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition"
          >
            + Add OAuth Account
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4">{error}</div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl shadow-sm">
          <p className="text-gray-400 text-lg mb-4">No Twitter accounts yet</p>
          <p className="text-gray-400 text-sm">
            Click the button above to add OAuth 1.0a credentials (API Key, API Secret, Access Token, Access Token Secret)
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((acc) => (
            <div key={acc.id} className="bg-white rounded-xl shadow-sm p-5">
              <div className="flex items-center gap-3 mb-3">
                {acc.avatar && (
                  <img src={acc.avatar} alt="" className="w-10 h-10 rounded-full" />
                )}
                <div>
                  <p className="font-medium">{acc.nickname || 'Unknown'}</p>
                  <p className="text-xs text-gray-400">@{acc.twitter_handle || '-'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(acc.status)}`}>
                  {acc.status === 'active' ? 'Active' : acc.status === 'expired' ? 'Expired' : acc.status === 'banned' ? 'Banned' : 'Error'}
                </span>
                {acc.status === 'active' && (
                  acc.can_comment === false ? (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 cursor-pointer"
                      title={acc.comment_ban_reason || 'Comments disabled'} onClick={() => toggleCanComment(acc)}>
                      🚫 Banned
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-600 cursor-pointer"
                      title="Can comment" onClick={() => toggleCanComment(acc)}>
                      ✅ Active
                    </span>
                  )
                )}
                <span className="text-xs text-gray-500">
                  Today: {acc.daily_comment_count}/{acc.max_daily_comments}
                </span>
              </div>
              {acc.comment_checked_at && (
                <div className="text-xs text-gray-400 mb-2">
                  Checked: {formatTime(acc.comment_checked_at)}
                  {acc.comment_ban_reason && <span className="text-red-400 ml-2">({acc.comment_ban_reason})</span>}
                </div>
              )}
              <button
                onClick={() => deleteAccount(acc.id)}
                className="text-xs text-red-400 hover:text-red-600"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold mb-4">Add Twitter Account (OAuth 1.0a)</h2>
            <p className="text-sm text-gray-500 mb-4">
              Enter OAuth 1.0a credentials from the Twitter Developer Portal.
              The account will be used for tweet collection and comment posting.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nickname</label>
                <input
                  type="text" value={formNickname}
                  onChange={(e) => setFormNickname(e.target.value)}
                  placeholder="e.g. Account A"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Twitter Handle *</label>
                <input
                  type="text" value={formHandle}
                  onChange={(e) => setFormHandle(e.target.value)}
                  placeholder="@username"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API Key *</label>
                <input
                  type="password" value={formApiKey}
                  onChange={(e) => setFormApiKey(e.target.value)}
                  placeholder="Consumer API Key"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API Secret Key *</label>
                <input
                  type="password" value={formApiSecret}
                  onChange={(e) => setFormApiSecret(e.target.value)}
                  placeholder="Consumer API Secret"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Access Token *</label>
                <input
                  type="password" value={formAccessToken}
                  onChange={(e) => setFormAccessToken(e.target.value)}
                  placeholder="OAuth Access Token"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Access Token Secret *</label>
                <input
                  type="password" value={formAccessSecret}
                  onChange={(e) => setFormAccessSecret(e.target.value)}
                  placeholder="OAuth Access Token Secret"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={addAccount}
                disabled={saving}
                className="flex-1 bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Account'}
              </button>
              <button
                onClick={() => { setShowAddModal(false); resetForm(); }}
                className="flex-1 text-gray-500 hover:text-gray-700 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
